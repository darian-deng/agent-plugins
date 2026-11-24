import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	detectProjectDrift,
	detectUserDrift,
	pendingOnboardingSteps,
	readProject,
	readUserConfig,
	resolveWorktreeRoot,
	saveProject,
	saveUserConfig,
	type UserConfigV1,
} from "../../src/config";
import { inspectRepository, prepare } from "../../src/git";
import { git, gitFixture, type GitFixture } from "../support/git-fixture";

const tempDirs: string[] = [];
const fixtures: GitFixture[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

test("user config resumes partial onboarding and detects role/linear drift without catalog noise", async () => {
	const dir = await mkdtemp(join(tmpdir(), "omp-ff-user-"));
	tempDirs.push(dir);
	const file = join(dir, "omp-feat-flow.json");

	expect(readUserConfig(file)).toBeNull();

	const partial: UserConfigV1 = {
		schemaVersion: 1,
		onboarding: { status: "in_progress", completedSteps: ["welcome", "models"] },
		roles: {
			author: null,
			scout: { model: "proxy/fast-model", effort: "medium" },
			coldReader: { model: "proxy/reader-model", effort: "medium" },
			reviewer: { model: "proxy/review-model", effort: "high" },
		},
		integrations: {
			linear: { enabled: true, credentialSource: "keychain" },
			githubCliChecked: false,
			cmuxPreference: "auto",
		},
	};
	await saveUserConfig(partial, file);
	const loaded = readUserConfig(file);
	expect(loaded).not.toBeNull();
	expect(pendingOnboardingSteps(loaded)).toEqual(["linear", "github", "cmux"]);

	// Unrelated new models in the catalog must not trigger drift when configured roles resolve and authenticate.
	const clean = await detectUserDrift(loaded!, {
		resolveModel: spec => ["proxy/fast-model", "proxy/reader-model", "proxy/review-model", "proxy/brand-new-unrelated"].includes(spec),
		hasProviderKey: async () => true,
		hasLinearKey: async () => true,
	});
	expect(clean).toEqual({ drifted: false, missingModels: [], unauthenticatedModels: [], linearMissing: false });

	// Removing reviewer model or Linear key surfaces exact drift reasons.
	const drifted = await detectUserDrift(loaded!, {
		resolveModel: spec => spec !== "proxy/review-model",
		hasProviderKey: async spec => spec !== "proxy/reader-model",
		hasLinearKey: async () => false,
	});
	expect(drifted).toEqual({
		drifted: true,
		missingModels: ["reviewer:proxy/review-model"],
		unauthenticatedModels: ["coldReader:proxy/reader-model"],
		linearMissing: true,
	});
});

test("project config v2 needs no disk digest, migrates v1, resolves worktreeRoot from main root, and enforces CAS", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	const loc = await inspectRepository(fixture.source);

	// Hand-written v2 JSON without digest or revision is accepted cleanly.
	const configDir = join(loc.commonDir, "omp-feat-flow");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "project.json"), JSON.stringify({
		schemaVersion: 2,
		git: { prBase: "staging" },
		linear: null,
	}, null, 2));

	const handEdited = readProject(loc.commonDir);
	expect(handEdited).not.toBeNull();
	expect(handEdited!.config.git.prBase).toBe("staging");
	expect(handEdited!.config.linear).toBeNull();
	expect(handEdited!.policyDigest).toMatch(/^[a-f0-9]{64}$/);

	// Saving enforces CAS revision and omits disk digest.
	const saved = await saveProject(loc.commonDir, {
		schemaVersion: 2,
		git: { prBase: "staging", worktreeRoot: "../custom-wts" },
		linear: { mode: "required", teamId: "team-1", teamKey: "DESK", reviewState: "In QA" },
		knowledge: { entryPaths: ["GLOSSARY.md"] },
	}, handEdited!.revision);
	expect(saved.revision).toBe(2);
	const rawSaved = JSON.parse(await readFile(join(configDir, "project.json"), "utf8")) as Record<string, unknown>;
	expect("digest" in rawSaved).toBe(false);
	await expect(saveProject(loc.commonDir, { schemaVersion: 2, git: { prBase: "main" } }, 1)).rejects.toThrow(/changed/);

	// Worktree root resolves relative to main checkout root even when invoked inside a linked worktree (no double ..).
	const wt = await prepare({
		repo: fixture.source, remote: "origin", startRef: "origin/staging", prBase: "staging",
		runId: "wt-check", branch: "feat/wt-check", worktree: join(fixture.root, "nested", "wt-check"),
	});
	expect(await resolveWorktreeRoot(wt.worktree, saved.config)).toBe(resolve(realpathSync(fixture.source), "..", "custom-wts"));

	// Legacy v1 snapshot auto-migrates in memory without failing on dead fields.
	await writeFile(join(configDir, "project.json"), JSON.stringify({
		schemaVersion: 1,
		revision: 4,
		digest: "0".repeat(64),
		defaults: {
			git: { remote: "origin", startRef: "origin/staging", prBase: "staging", worktreeRoot: "../legacy-wts" },
			github: { host: "github.com", repository: "acme/app" },
			linear: { workspaceId: "ws", teamId: "t1", statusMapping: { inProgress: "In Dev", inReview: "In QA", done: "Done" } },
			models: { author: "a", helper: "b", reviewer: "c" },
			knowledge: { entryPaths: ["docs/adr"] },
		},
	}));
	const migrated = readProject(loc.commonDir);
	expect(migrated).not.toBeNull();
	expect(migrated!.legacyV1).toBe(true);
	expect(migrated!.config.git.prBase).toBe("staging");
	expect(migrated!.config.linear).toMatchObject({ mode: "required", teamId: "t1", reviewState: "In QA" });

	// Drift check catches missing prBase ref or missing Linear reviewState.
	const drift = await detectProjectDrift(fixture.source, migrated!.config, {
		hasRemoteBranch: async (_remote, branch) => branch === "main",
		verifyLinear: async () => ({ teamExists: true, reviewStateExists: false }),
	});
	expect(drift).toEqual({
		drifted: true,
		missingPrBase: true,
		missingLinearTeam: false,
		missingLinearReviewState: true,
	});
});
