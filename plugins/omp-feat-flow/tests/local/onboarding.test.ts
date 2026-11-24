import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProject, readUserConfig } from "../../src/config";
import { inspectRepository } from "../../src/git";
import { ensureProjectOnboarding, ensureUserOnboarding, type OnboardingUI } from "../../src/onboarding";
import { git, gitFixture } from "../support/git-fixture";

const tempDirs: string[] = [];
afterEach(async () => {
	for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

test("ensureUserOnboarding guides first-time setup, persists partial progress on cancel, and resumes cleanly", async () => {
	const dir = await mkdtemp(join(tmpdir(), "omp-ff-onboard-"));
	tempDirs.push(dir);
	const cfgPath = join(dir, "omp-feat-flow.json");
	const models = [
		{ spec: "proxy/fast-model", label: "proxy/fast-model" },
		{ spec: "proxy/review-model", label: "proxy/review-model" },
	];

	let step = 0;
	const interruptedUi: OnboardingUI = {
		hasUI: true,
		notify: () => {},
		confirm: async () => true,
		select: async title => {
			step += 1;
			if (title.includes("author")) return "跟随当前 omp 会话 /model（推荐，不强抢临时切换）";
			if (title.includes("Select model")) return step <= 4 ? "proxy/fast-model" : "proxy/review-model";
			if (title.includes("thinking effort")) return title.includes("reviewer") ? "high" : "medium";
			if (title.includes("Linear")) return undefined;
			return undefined;
		},
		input: async () => undefined,
	};

	const prevLin = process.env.LINEAR_API_KEY;
	const prevSkipKc = process.env.OMP_FEAT_FLOW_SKIP_KEYCHAIN;
	delete process.env.LINEAR_API_KEY;
	process.env.OMP_FEAT_FLOW_SKIP_KEYCHAIN = "1";
	try {
		await expect(ensureUserOnboarding({
			ui: interruptedUi,
			availableModels: models,
			resolveModel: spec => models.some(m => m.spec === spec),
			hasProviderKey: async () => true,
			configPath: cfgPath,
		})).rejects.toThrow(/Cancelled/);

		const partial = readUserConfig(cfgPath);
		expect(partial?.onboarding.status).toBe("in_progress");
		expect(partial?.onboarding.completedSteps).toEqual(["welcome", "models"]);
		expect(partial?.roles.reviewer).toEqual({ model: "proxy/review-model", effort: "high" });

		const askedTitles: string[] = [];
		const resumeUi: OnboardingUI = {
			hasUI: true,
			notify: () => {},
			confirm: async title => { askedTitles.push(title); return true; },
			select: async title => {
				askedTitles.push(title);
				if (title.includes("Linear")) return "暂时跳过 Linear（仅用 GitHub PR）";
				return undefined;
			},
			input: async () => undefined,
		};

		const completed = await ensureUserOnboarding({
			ui: resumeUi,
			availableModels: models,
			resolveModel: spec => models.some(m => m.spec === spec),
			hasProviderKey: async () => true,
			configPath: cfgPath,
		});
		expect(completed.onboarding.status).toBe("completed");
		expect(askedTitles.some(t => t.includes("欢迎首次使用"))).toBe(false);
		expect(askedTitles.some(t => t.includes("Select model"))).toBe(false);
		expect(askedTitles.some(t => t.includes("Linear"))).toBe(true);

		const repaired = await ensureUserOnboarding({
			ui: {
				hasUI: true,
				notify: () => {},
				confirm: async () => true,
				select: async title => (title.includes("thinking effort") ? "high" : "proxy/fast-model"),
				input: async () => undefined,
			},
			availableModels: [{ spec: "proxy/fast-model", label: "proxy/fast-model" }],
			resolveModel: spec => spec === "proxy/fast-model",
			hasProviderKey: async () => true,
			configPath: cfgPath,
		});
		expect(repaired.roles.reviewer).toEqual({ model: "proxy/fast-model", effort: "high" });
	} finally {
		if (prevLin !== undefined) process.env.LINEAR_API_KEY = prevLin;
		if (prevSkipKc === undefined) delete process.env.OMP_FEAT_FLOW_SKIP_KEYCHAIN;
		else process.env.OMP_FEAT_FLOW_SKIP_KEYCHAIN = prevSkipKc;
	}
});

test("ensureUserOnboarding and ensureProjectOnboarding support single-shot ui.formDialog and reject silent Linear downgrade", async () => {
	const dir = await mkdtemp(join(tmpdir(), "omp-ff-form-"));
	tempDirs.push(dir);
	const cfgPath = join(dir, "user.json");
	const models = [{ spec: "proxy/fast", label: "proxy/fast" }, { spec: "proxy/strong", label: "proxy/strong" }];

	const prevLin = process.env.LINEAR_API_KEY;
	delete process.env.LINEAR_API_KEY;
	process.env.OMP_FEAT_FLOW_SKIP_KEYCHAIN = "1";
	try {
		let userFormCalls = 0;
		const userCfg = await ensureUserOnboarding({
			ui: {
				hasUI: true,
				notify: () => {},
				confirm: async () => true,
				select: async () => undefined,
				input: async () => undefined,
				formDialog: async html => {
					userFormCalls += 1;
					expect(html).toContain("<form>");
					return {
						authorModel: "follow-session",
						authorEffort: "high",
						scoutModel: "proxy/fast",
						scoutEffort: "medium",
						coldReaderModel: "proxy/fast",
						coldReaderEffort: "medium",
						reviewerModel: "proxy/strong",
						reviewerEffort: "high",
						linearMode: "skip",
						cmuxPreference: "disabled",
					};
				},
			},
			availableModels: models,
			resolveModel: spec => models.some(m => m.spec === spec),
			hasProviderKey: async () => true,
			configPath: cfgPath,
		});
		expect(userFormCalls).toBe(1);
		expect(userCfg.roles.author).toBeNull();
		expect(userCfg.integrations.cmuxPreference).toBe("disabled");

		const fixture = await gitFixture();
		try {
			await git(fixture.seed, ["push", "origin", "main:staging"]);
			await git(fixture.source, ["fetch", "origin"]);
			await git(fixture.source, ["remote", "set-url", "origin", "https://github.com/acme/demo-repo.git"]);
			const loc = await inspectRepository(fixture.source);

			// If user enabled Linear but key is missing/offline, cancelling confirmation aborts instead of silent downgrade!
			const enabledLinearUser = { ...userCfg, integrations: { ...userCfg.integrations, linear: { enabled: true, credentialSource: "env" as const } } };
			await expect(ensureProjectOnboarding({
				cwd: fixture.source,
				commonDir: loc.commonDir,
				userConfig: enabledLinearUser,
				ui: {
					hasUI: true,
					notify: () => {},
					confirm: async () => false,
					select: async () => undefined,
					input: async () => undefined,
				},
			})).rejects.toThrow(/aborted/i);

			let projectFormCalls = 0;
			const proj = await ensureProjectOnboarding({
				cwd: fixture.source,
				commonDir: loc.commonDir,
				userConfig: userCfg,
				ui: {
					hasUI: true,
					notify: () => {},
					confirm: async () => true,
					select: async () => undefined,
					input: async () => undefined,
					formDialog: async html => {
						projectFormCalls += 1;
						expect(html).toContain("acme/demo-repo");
						return { prBase: "staging", worktreeRoot: "../wts", repository: "acme/demo-repo", linearMode: "disabled" };
					},
				},
			});
			expect(projectFormCalls).toBe(1);
			expect(proj.config.github?.repository).toBe("acme/demo-repo");
			expect(readProject(loc.commonDir)?.config.git.prBase).toBe("staging");
		} finally {
			await fixture.cleanup();
		}
	} finally {
		if (prevLin !== undefined) process.env.LINEAR_API_KEY = prevLin;
		delete process.env.OMP_FEAT_FLOW_SKIP_KEYCHAIN;
	}
});
