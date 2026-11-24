import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFlow, type FlowController } from "../../src/flow";
import { inspectRepository } from "../../src/git";
import { saveProject } from "../../src/config";
import { deriveRequirementProfile } from "../../src/profile";
import { git, gitFixture, type GitFixture } from "../support/git-fixture";

const fixtures: GitFixture[] = [];
const flows: FlowController[] = [];

afterEach(async () => {
	for (const f of flows.splice(0)) await f.dispose();
	for (const fx of fixtures.splice(0)) await fx.cleanup();
});

function makeHost(cwd: string, overrides: Record<string, unknown> = {}) {
	return {
		cwd: () => cwd,
		sessionId: () => "main-sess",
		processInstanceId: "main-proc",
		buildId: "v2-build",
		agentKind: () => "main" as const,
		notify: () => {},
		modelStatus: async () => ({ ready: true, reason: "ready" as const, provider: "p", model: "m", guidance: null }),
		confirm: async () => true,
		workspace: { enabled: false },
		installedRelease: async () => null,
		activeTools: () => [],
		helperSdk: () => { throw new Error("not used in local unit test"); },
		modelRegistry: () => undefined,
		model: () => undefined,
		contextUsage: () => undefined,
		...overrides,
	};
}

test("subagent sessions never open run ownership and scout is strictly read-only", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	const loc = await inspectRepository(fixture.source);
	await saveProject(loc.commonDir, {
		schemaVersion: 2,
		git: { prBase: "staging", remote: "origin", startRef: "origin/staging", worktreeRoot: "../wts" },
		github: { repository: "acme/app" },
		linear: { mode: "disabled" },
	}, 0);

	const launcher = createFlow(makeHost(fixture.source));
	flows.push(launcher);
	await launcher.lifecycle({ type: "session_start" });
	await launcher.command("start", "sub-test");
	const wt = join(fixture.source, "..", "wts", "sub-test");

	const main = createFlow(makeHost(wt));
	flows.push(main);
	await main.lifecycle({ type: "session_start" });
	expect(main.context().worktree).toBeTruthy();

	// Subagent factory rebound in the same worktree MUST NOT steal owner or admit writes.
	const sub = createFlow(makeHost(wt, { agentKind: () => "sub" as const, sessionId: () => "scout-1" }));
	flows.push(sub);
	await sub.lifecycle({ type: "session_start" });
	expect(sub.context().located).toBe(false);
	expect(sub.beforeTool({ toolCallId: "sr", toolName: "read" }).allow).toBe(true);
	expect(sub.beforeTool({ toolCallId: "sw", toolName: "write" })).toMatchObject({ allow: false, reason: "subagent-read-only" });
	expect(sub.beforeTool({ toolCallId: "sb", toolName: "bash" })).toMatchObject({ allow: false, reason: "subagent-read-only" });
});

test("linear.mode=required blocks Plan Gate approval when no Linear issue is bound", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	const loc = await inspectRepository(fixture.source);
	await saveProject(loc.commonDir, {
		schemaVersion: 2,
		git: { prBase: "staging", remote: "origin", startRef: "origin/staging", worktreeRoot: "../wts" },
		github: { repository: "acme/app" },
		linear: { mode: "required", teamId: "team-1", teamKey: "DESK", reviewState: "In QA" },
	}, 0);

	const launcher = createFlow(makeHost(fixture.source));
	flows.push(launcher);
	await launcher.lifecycle({ type: "session_start" });
	await launcher.command("start", "no-issue-yet");
	const wt = join(fixture.source, "..", "wts", "no-issue-yet");

	const flow = createFlow(makeHost(wt));
	flows.push(flow);
	await flow.lifecycle({ type: "session_start" });
	await flow.request({
		kind: "boundaries",
		decided: [
			{ category: "goals", answer: "Fix bug" },
			{ category: "non-goals", answer: "None" },
			{ category: "business-boundary", answer: "Desktop only" },
			{ category: "error-path", answer: "Throw typed error" },
			{ category: "acceptance", answer: "Unit test passes" },
		],
		open: [],
	}, "req-b");

	await flow.request({
		kind: "plan",
		scope: "src/a.ts",
		summary: "Fix bug in src/a.ts",
		profile: deriveRequirementProfile({
			signals: { expectedFiles: 1, distinctModules: 1, riskFlags: [], externalEffects: false, estimatedSlices: 1 },
		}),
		plan: {
			activities: [],
			slices: [{ id: "s1", behavior: "Fix bug", test: "a.test.ts", dependsOn: [] }],
			invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
		},
	}, "req-p");

	// Without linear issue creation/bind (offline & no resolver), approval MUST refuse unlocking implementation.
	const prevOffline = process.env.OMP_FEAT_FLOW_LINEAR_OFFLINE;
	process.env.OMP_FEAT_FLOW_LINEAR_OFFLINE = "1";
	try {
		await expect(flow.command("approve", "")).rejects.toThrow(/Linear issue required/i);
		expect(flow.context().phase).toBe("alignment");
		expect(flow.beforeTool({ toolCallId: "w1", toolName: "write" }).allow).toBe(false);
	} finally {
		if (prevOffline === undefined) delete process.env.OMP_FEAT_FLOW_LINEAR_OFFLINE;
		else process.env.OMP_FEAT_FLOW_LINEAR_OFFLINE = prevOffline;
	}
});

test("implementation enforces bash workflow guard, FINALIZING_SLICE wrap-up, host-verified slice.update, and seamless /clear", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	const loc = await inspectRepository(fixture.source);
	await saveProject(loc.commonDir, {
		schemaVersion: 2,
		git: { prBase: "staging", remote: "origin", startRef: "origin/staging", worktreeRoot: "../wts" },
		github: { repository: "acme/app" },
		linear: { mode: "disabled" },
	}, 0);

	let pct = 20;
	const launcher = createFlow(makeHost(fixture.source));
	flows.push(launcher);
	await launcher.lifecycle({ type: "session_start" });
	await launcher.command("start", "guard-test");
	const wt = join(fixture.source, "..", "wts", "guard-test");

	const flow = createFlow(makeHost(wt, {
		contextUsage: () => ({ tokens: pct * 1000, contextWindow: 100000, percent: pct }),
	}));
	flows.push(flow);
	await flow.lifecycle({ type: "session_start" });
	await flow.request({
		kind: "boundaries",
		decided: [
			{ category: "goals", answer: "g" },
			{ category: "non-goals", answer: "n" },
			{ category: "business-boundary", answer: "b" },
			{ category: "error-path", answer: "e" },
			{ category: "acceptance", answer: "a" },
		],
		open: [],
	}, "req-b");
	await flow.request({
		kind: "plan",
		scope: "src/a.ts",
		summary: "Do s1",
		profile: deriveRequirementProfile({ signals: { expectedFiles: 1, distinctModules: 1, riskFlags: [], externalEffects: false, estimatedSlices: 1 } }),
		plan: {
			activities: [],
			slices: [
				{ id: "s1", behavior: "b1", test: "t1", dependsOn: [] },
				{ id: "s2", behavior: "b2", test: "t2", dependsOn: ["s1"] },
			],
			invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
		},
	}, "req-p");
	await flow.command("approve", "");
	expect(flow.context().phase).toBe("implementation");

	// Bash workflow guard blocks remote push/PR creation during implementation.
	expect(flow.beforeTool({ toolCallId: "b-push", toolName: "bash", input: { command: "git push origin feat/guard-test" } })).toMatchObject({
		allow: false,
		reason: "workflow-guard",
	});
	expect(flow.beforeTool({ toolCallId: "b-pr", toolName: "bash", input: { command: "gh pr create --title x" } })).toMatchObject({
		allow: false,
		reason: "workflow-guard",
	});
	expect(flow.beforeTool({ toolCallId: "b-test", toolName: "bash", input: { command: "bun test" } }).allow).toBe(true);

	// Crossing 60% latches FINALIZING_SLICE: denies new edit/write, still allows bash (tests/commit) and checkpoint!
	pct = 62;
	await flow.onContextSample();
	expect(flow.beforeTool({ toolCallId: "e-latched", toolName: "edit" })).toMatchObject({ allow: false, reason: "finalizing-slice" });
	expect(flow.beforeTool({ toolCallId: "b-latched", toolName: "bash", input: { command: "git commit -m s1" } }).allow).toBe(true);

	// Host-verified slice.update rejects dirty worktree!
	await writeFile(join(wt, "a.ts"), "dirty\n");
	await expect(flow.request({ kind: "slice.update", sliceId: "s1", status: "done" }, "s1-dirty")).rejects.toThrow(/clean/i);

	// Commit + observed passing test allows slice.update(done).
	await git(wt, ["add", "a.ts"]);
	await git(wt, ["-c", "user.name=F", "-c", "user.email=f@e.invalid", "commit", "-m", "feat(s1): done"]);
	flow.recordToolOutcome("b-test", "bash", { command: "bun test" }, false);
	const sha = (await git(wt, ["rev-parse", "HEAD"])).trim();
	await flow.request({ kind: "slice.update", sliceId: "s1", status: "done", commitSha: sha, testProof: "bun test pass" }, "s1-ok");

	// Same-process /clear keeps writes unlocked and clears wrap-up latch once checkpointed!
	await flow.request({
		kind: "checkpoint",
		reason: "context-wrap-up",
		activeSliceId: "s2",
		currentState: "s1 committed, s2 pending",
	}, "chk-1");
	pct = 8;
	await flow.lifecycle({ type: "session_clear" });
	expect(flow.context().readiness).toBe("ready");
	expect(flow.beforeTool({ toolCallId: "w-after-clear", toolName: "write" }).allow).toBe(true);
});

test("omitted linear section defaults consistently to required at Plan Gate and failed background cold-read does not crash", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	const loc = await inspectRepository(fixture.source);
	// Omit linear section entirely -> must default consistently to "required" at Plan Gate!
	await saveProject(loc.commonDir, {
		schemaVersion: 2,
		git: { prBase: "staging", remote: "origin", startRef: "origin/staging", worktreeRoot: "../wts" },
		github: { repository: "acme/app" },
	}, 0);

	let coldJson = "PROSE NOT JSON";
	const launcher = createFlow(makeHost(fixture.source));
	flows.push(launcher);
	await launcher.lifecycle({ type: "session_start" });
	await launcher.command("start", "omitted-linear");
	const wt = join(fixture.source, "..", "wts", "omitted-linear");

	const flow = createFlow(makeHost(wt, {
		helperSdk: () => ({
			SessionManager: { inMemory: () => ({}) },
			createAgentSession: async () => ({
				session: {
					model: { provider: "p", id: "cold" },
					prompt: async () => true,
					waitForIdle: async () => {},
					getLastAssistantText: () => coldJson,
					dispose: () => {},
				},
			}),
		}),
	}));
	flows.push(flow);
	await flow.lifecycle({ type: "session_start" });

	await flow.request({
		kind: "boundaries",
		decided: [
			{ category: "goals", answer: "g" },
			{ category: "non-goals", answer: "n" },
			{ category: "business-boundary", answer: "b" },
			{ category: "error-path", answer: "e" },
			{ category: "acceptance", answer: "a" },
		],
		open: [],
	}, "b1");
	const medProfile = deriveRequirementProfile({
		signals: { expectedFiles: 4, distinctModules: 2, riskFlags: [], externalEffects: false, estimatedSlices: 1 },
	});
	const planned = await flow.request({
		kind: "plan",
		scope: "src/a.ts",
		summary: "Do a",
		profile: medProfile,
		plan: {
			activities: [],
			slices: [{ id: "s1", behavior: "b1", test: "t1", dependsOn: [] }],
			invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
		},
	}, "p1");
	await Promise.resolve();
	expect(planned.view.techDesignHtmlPath).toBeTruthy();
	const html = await Bun.file(planned.view.techDesignHtmlPath!).text();
	expect(html).toContain("Linear: required");
	await expect(flow.command("approve", "")).rejects.toThrow(/cold reader|JSON/i);

	coldJson = JSON.stringify({
		verdict: "PASS",
		questionResults: [
			{ questionId: "tldr", status: "ANSWERED", sectionId: "tldr", quote: "Do a v2" },
			{ questionId: "workflow", status: "ANSWERED", sectionId: "workflow", quote: "Gate 1" },
			{ questionId: "goals", status: "ANSWERED", sectionId: "goals", quote: "g" },
			{ questionId: "placement", status: "ANSWERED", sectionId: "placement", quote: "src/a.ts" },
			{ questionId: "mechanism", status: "ANSWERED", sectionId: "mechanism", quote: "Do a v2" },
			{ questionId: "change-surface", status: "ANSWERED", sectionId: "change-surface", quote: "src/a.ts" },
			{ questionId: "verification", status: "ANSWERED", sectionId: "verification", quote: "t1" },
		],
		missing: [], contradictions: [], bloat: [], summary: "clear",
	});
	await flow.request({
		kind: "plan",
		scope: "src/a.ts",
		summary: "Do a v2",
		profile: medProfile,
		plan: {
			activities: [],
			slices: [{ id: "s1", behavior: "b1", test: "t1", dependsOn: [] }],
			invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
		},
	}, "p2");
	await expect(flow.command("approve", "")).rejects.toThrow(/Linear issue required/i);
});

test("foreign session cannot bypass owner-authorization-required via /clear", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	const loc = await inspectRepository(fixture.source);
	await saveProject(loc.commonDir, {
		schemaVersion: 2,
		git: { prBase: "staging", remote: "origin", startRef: "origin/staging", worktreeRoot: "../wts" },
		github: { repository: "acme/app" },
		linear: { mode: "disabled" },
	}, 0);

	const coldSdk = () => ({
		SessionManager: { inMemory: () => ({}) },
		createAgentSession: async () => ({
			session: {
				model: { provider: "p", id: "cold" }, prompt: async () => true, waitForIdle: async () => {},
				getLastAssistantText: () => JSON.stringify({
					verdict: "PASS", selectedOptionId: "approve",
					answers: { decision: "ok", permissions: "ok" }, missing: [], contradictions: [], bloat: [], rationale: "ok",
				}),
				dispose: () => {},
			},
		}),
	});
	const launcher = createFlow(makeHost(fixture.source));
	await launcher.lifecycle({ type: "session_start" });
	await launcher.command("start", "sec-clear");
	await launcher.dispose();
	const wt = join(fixture.source, "..", "wts", "sec-clear");
	const first = createFlow(makeHost(wt, { helperSdk: coldSdk }));
	await first.lifecycle({ type: "session_start" });
	await first.request({
		kind: "boundaries",
		decided: [
			{ category: "goals", answer: "g" }, { category: "non-goals", answer: "n" },
			{ category: "business-boundary", answer: "b" }, { category: "error-path", answer: "e" }, { category: "acceptance", answer: "a" },
		],
		open: [],
	}, "b1");
	await first.request({
		kind: "plan", scope: "src/a.ts", summary: "Do a",
		profile: deriveRequirementProfile({ signals: { expectedFiles: 1, distinctModules: 1, riskFlags: [], externalEffects: false, estimatedSlices: 1 } }),
		plan: { activities: [], slices: [{ id: "s1", behavior: "b", test: "t", dependsOn: [] }], invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers" },
	}, "p1");
	await first.command("approve", "");
	await first.dispose();

	const foreign = createFlow(makeHost(wt, { sessionId: () => "intruder-sess", processInstanceId: "intruder-proc", helperSdk: coldSdk }));
	flows.push(foreign);
	await foreign.lifecycle({ type: "session_start" });
	expect(foreign.context().waitingReason).toBe("owner-authorization-required");
	await foreign.lifecycle({ type: "session_clear" });
	expect(foreign.beforeTool({ toolCallId: "w-intruder", toolName: "write" }).allow).toBe(false);
});

test("git commit does not count as verification and thrown delivery ports reconcile cleanly on retry", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	const loc = await inspectRepository(fixture.source);
	await saveProject(loc.commonDir, {
		schemaVersion: 2,
		git: { prBase: "staging", remote: "origin", startRef: "origin/staging", worktreeRoot: "../wts" },
		github: { repository: "acme/app" },
		linear: { mode: "disabled" },
	}, 0);

	let failPrListOnce = true;
	const prs: Array<{ number: number; url: string; headRefOid: string; body: string; base?: string; state?: string }> = [];
	const flow = createFlow(makeHost(fixture.source, {
		helperSdk: () => ({
			SessionManager: { inMemory: () => ({}) },
			createAgentSession: async () => {
				let p = "";
				return {
					session: {
						model: { provider: "p", id: "m" },
						prompt: async (t: string) => { p = t; return true; },
						waitForIdle: async () => {},
						getLastAssistantText: () => p.includes("cold reader")
							? JSON.stringify({ verdict: "PASS", selectedOptionId: "approve", answers: { decision: "ok", permissions: "ok" }, missing: [], contradictions: [], bloat: [], rationale: "ok" })
							: "ACCEPT\n## Standards\nClean.\n## Spec\nMatches.",
						dispose: () => {},
					},
				};
			},
		}),
		deliveryPorts: ({ worktree }: { worktree: string }) => ({
			git: async (args: string[]) => {
				const r = Bun.spawnSync(["git", "-C", worktree, ...args]);
				return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
			},
			github: {
				findPullRequests: async () => {
					if (failPrListOnce) { failPrListOnce = false; throw new Error("transient gh network error"); }
					return prs;
				},
				createPullRequest: async (inp: { head: string; base: string; title: string; body: string }) => {
					const h = (await git(worktree, ["rev-parse", "HEAD"])).trim();
					const pr = { number: 1, url: "https://example.invalid/pr/1", headRefOid: h, body: inp.body, base: inp.base, state: "OPEN" };
					prs.push(pr);
					return pr;
				},
			},
			linear: { getIssue: async () => null, updateIssue: async () => {} },
		}),
	}));
	flows.push(flow);
	await flow.lifecycle({ type: "session_start" });
	await flow.command("start", "retry-deliv");
	const wt = join(fixture.source, "..", "wts", "retry-deliv");
	const wtFlow = createFlow(makeHost(wt, {
		helperSdk: () => ({
			SessionManager: { inMemory: () => ({}) },
			createAgentSession: async () => {
				let p = "";
				return {
					session: {
						model: { provider: "p", id: "m" },
						prompt: async (t: string) => { p = t; return true; },
						waitForIdle: async () => {},
						getLastAssistantText: () => p.includes("cold reader")
							? JSON.stringify({ verdict: "PASS", selectedOptionId: "approve", answers: { decision: "ok", permissions: "ok" }, missing: [], contradictions: [], bloat: [], rationale: "ok" })
							: '{"verdict":"ACCEPT","findings":[],"summary":"Clean."}',
						dispose: () => {},
					},
				};
			},
		}),
		deliveryPorts: ({ worktree }: { worktree: string }) => ({
			git: async (args: string[]) => {
				const r = Bun.spawnSync(["git", "-C", worktree, ...args]);
				return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
			},
			github: {
				findPullRequests: async () => {
					if (failPrListOnce) { failPrListOnce = false; throw new Error("transient gh network error"); }
					return prs;
				},
				createPullRequest: async (inp: { head: string; base: string; title: string; body: string }) => {
					const h = (await git(worktree, ["rev-parse", "HEAD"])).trim();
					const pr = { number: 1, url: "https://example.invalid/pr/1", headRefOid: h, body: inp.body, base: inp.base, state: "OPEN" };
					prs.push(pr);
					return pr;
				},
			},
			linear: { getIssue: async () => null, updateIssue: async () => {} },
		}),
	}));
	flows.push(wtFlow);
	await wtFlow.lifecycle({ type: "session_start" });
	await wtFlow.request({
		kind: "boundaries",
		decided: [
			{ category: "goals", answer: "g" }, { category: "non-goals", answer: "n" },
			{ category: "business-boundary", answer: "b" }, { category: "error-path", answer: "e" }, { category: "acceptance", answer: "a" },
		],
		open: [],
	}, "b1");
	await wtFlow.request({
		kind: "plan", scope: "a.txt", summary: "Do a",
		profile: deriveRequirementProfile({ signals: { expectedFiles: 1, distinctModules: 1, riskFlags: [], externalEffects: false, estimatedSlices: 1 } }),
		plan: { activities: [], slices: [{ id: "s1", behavior: "b", test: "t", dependsOn: [] }], invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers" },
	}, "p1");
	await wtFlow.command("approve", "");

	await writeFile(join(wt, "a.txt"), "one\n");
	await git(wt, ["add", "a.txt"]);
	await git(wt, ["-c", "user.name=F", "-c", "user.email=f@e.invalid", "commit", "-m", "feat: a"]);
	wtFlow.recordToolOutcome("gc", "bash", { command: "git commit -m x" }, false);
	await expect(wtFlow.request({ kind: "slice.update", sliceId: "s1", status: "done" }, "s1-fail")).rejects.toThrow(/verification/i);

	wtFlow.recordToolOutcome("bt", "bash", { command: "echo start && bun test" }, false);
	await wtFlow.request({ kind: "slice.update", sliceId: "s1", status: "done" }, "s1-pass");

	await expect(wtFlow.command("finish", "")).rejects.toThrow(/transient gh network error/);
	expect(wtFlow.context().view?.operations.some(op => op.type === "github-pr" && op.status === "unknown")).toBe(true);

	await wtFlow.command("finish", "");
	expect(wtFlow.context().phase).toBe("delivered");
	expect(prs).toHaveLength(1);
});
