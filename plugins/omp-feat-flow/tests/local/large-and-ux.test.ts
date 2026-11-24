import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import featFlow from "../../src/index";
import { createFlow, type FlowController } from "../../src/flow";
import { saveProject } from "../../src/config";
import { discoverRuns, inspectRepository } from "../../src/git";
import { deriveRequirementProfile, type AlignmentDocument } from "../../src/profile";
import { buildStagePrompt } from "../../src/steering";
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
		modelRegistry: () => undefined,
		helperSdk: (() => ({
			SessionManager: { inMemory: () => ({}) },
			createAgentSession: async () => {
				let p = "";
				return {
					session: {
						model: { provider: "p", id: "m" },
						prompt: async (t: string) => { p = t; return true; },
						waitForIdle: async () => {},
						getLastAssistantText: () => p.includes("questionResults")
							? JSON.stringify({
								verdict: "PASS",
								questionResults: [
									{ questionId: "q1", status: "ANSWERED", sectionId: "tldr", quote: "Refactor auth token refresh" },
									{ questionId: "q2", status: "ANSWERED", sectionId: "workflow", quote: "Tier:" },
									{ questionId: "q3", status: "ANSWERED", sectionId: "goals", quote: "Single-flight refresh lock" },
									{ questionId: "q4", status: "ANSWERED", sectionId: "placement", quote: "Auth module sits between" },
									{ questionId: "q5", status: "ANSWERED", sectionId: "mechanism", quote: "Coalesce concurrent refresh" },
									{ questionId: "q6", status: "ANSWERED", sectionId: "change-surface", quote: "src/auth.ts" },
									{ questionId: "q7", status: "ANSWERED", sectionId: "verification", quote: "bun test tests/auth.test.ts" },
								],
								missing: [],
								contradictions: [],
								bloat: [],
								summary: "All 7 core sections clear.",
							})
							: '{"verdict":"ACCEPT","findings":[],"summary":"Clean."}',
						dispose: () => {},
					},
				};
			},
		})) as never,
		model: () => undefined,
		contextUsage: () => undefined,
		...overrides,
	};
}

function sampleDoc(overrides: Partial<AlignmentDocument> = {}): AlignmentDocument {
	return {
		tldr: "Refactor auth token refresh with retry queue.",
		problem: "Concurrent 401 responses trigger duplicate refresh requests.",
		goals: ["Single-flight refresh lock", "Exponential retry on transient 5xx"],
		nonGoals: ["Do not rewrite session cookie storage"],
		placement: {
			summary: "Auth module sits between API client and token store.",
			upstreamDownstream: ["API client -> Auth module -> Token store"],
			constraints: ["Must remain backward compatible with offline cache"],
			nodes: [
				{ id: "client", label: "API Client", kind: "boundary" },
				{ id: "auth", label: "Auth Refresh", kind: "focal" },
				{ id: "store", label: "Token Store", kind: "store" },
			],
			edges: [
				{ from: "client", to: "auth", label: "getToken" },
				{ from: "auth", to: "store", label: "persist" },
			],
		},
		mechanism: {
			overview: "Coalesce concurrent refresh callers onto one in-flight promise.",
			contracts: ["refreshToken(): Promise<string> coalesces concurrent callers"],
			failureModes: ["On 401 invalid_grant, clear session and reject all waiters"],
			persistenceOrMigration: "No DB migration; token JSON format unchanged.",
		},
		changeSurface: [
			{ path: "src/auth.ts", action: "modify", summary: "Add single-flight refresh lock" },
			{ path: "src/client.ts", action: "modify", summary: "Retry once on 401" },
		],
		decisions: [{ decision: "Lock scope", choice: "In-memory promise", rejected: "File lock", rationale: "Single process", impact: "Simpler" }],
		risksAndAssumptions: ["Clock skew <= 30s"],
		verification: "bun test tests/auth.test.ts",
		...overrides,
	};
}

async function setupProject(fixture: GitFixture, linear: { mode: "disabled" | "required" | "optional" } = { mode: "disabled" }) {
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	const loc = await inspectRepository(fixture.source);
	await saveProject(loc.commonDir, {
		schemaVersion: 2,
		git: { prBase: "staging", remote: "origin", startRef: "origin/staging", worktreeRoot: "../wts" },
		github: { repository: "acme/app" },
		linear,
	}, 0);
	return loc;
}

test("natural-language /feat-flow-start derives slug, resolves collisions, preserves initialTask across slices, and supports /feat-flow-start config", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	const loc = await setupProject(fixture);

	let reconfigured = 0;
	const launcher = createFlow(makeHost(fixture.source, {
		ui: {
			hasUI: true,
			notify: () => {},
			confirm: async () => true,
			select: async (_t: string, opts: string[]) => {
				if (opts.some(o => o.includes("修改个人"))) { reconfigured += 1; return undefined; }
				return opts[0];
			},
			input: async () => undefined,
		},
	}));
	flows.push(launcher);
	await launcher.lifecycle({ type: "session_start" });

	// 1) Pure non-ASCII Chinese NL requirement
	const chineseReq = "登录超时后自动重试并弹出错误提示";
	await launcher.command("start", chineseReq);
	const catalog1 = await discoverRuns(loc.commonDir, fixture.source);
	expect(catalog1.runs).toHaveLength(1);
	const r1 = catalog1.runs[0]!;
	expect(r1.runId).toMatch(/^req-[a-f0-9]{8}$/);
	expect(r1.initialTask).toBe(chineseReq);

	// 2) Same NL requirement deduplicates instead of creating a duplicate run
	await launcher.command("start", chineseReq);
	const catalog2 = await discoverRuns(loc.commonDir, fixture.source);
	expect(catalog2.runs).toHaveLength(1);

	// 3) Differing NL sharing ASCII prefix gets -2 collision suffix rather than adopting unrelated run
	await launcher.command("start", "Fix login");
	// Also test lowercase Linear URL normalization
	await launcher.command("start", "https://linear.app/acme/issue/desk-42/fix-bug");
	const catalog3 = await discoverRuns(loc.commonDir, fixture.source);
	expect(catalog3.runs.some(r => r.issue === "DESK-42" && r.runId === "desk-42")).toBe(true);

	// 4) Inside worktree: initialTask survives slice.update (which mutates currentTask) & appears in Recovery Brief
	const wtFlow = createFlow(makeHost(r1.worktree, {
		ui: {
			hasUI: true,
			notify: () => {},
			confirm: async () => true,
			select: async (_t: string, opts: string[]) => {
				if (opts.some(o => o.includes("个人本机"))) { reconfigured += 1; return undefined; }
				return opts[0];
			},
			input: async () => undefined,
		},
	}));
	flows.push(wtFlow);
	await wtFlow.lifecycle({ type: "session_start" });
	expect(wtFlow.context().view?.initialTask).toBe(chineseReq);
	await wtFlow.request({
		kind: "plan",
		scope: "src/auth.ts",
		summary: "Small retry fix",
		profile: deriveRequirementProfile({
			signals: { expectedFiles: 1, distinctModules: 1, riskFlags: [], externalEffects: false, estimatedSlices: 1 },
			declaredFiles: ["src/auth.ts"],
		}),
		plan: {
			activities: [],
			slices: [{ id: "s1", behavior: "retry on timeout", test: "bun test", dependsOn: [] }],
			invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
		},
	}, "p-nl");
	await wtFlow.command("approve", "");
	await wtFlow.request({ kind: "slice.update", sliceId: "s1", status: "in_progress" }, "su-1");
	expect(wtFlow.context().view?.currentTask).toBe("s1");
	expect(wtFlow.context().view?.initialTask).toBe(chineseReq);

	const brief = await wtFlow.recoveryBrief(false);
	expect(brief).toContain(chineseReq);

	// 5) /feat-flow-start config works even inside an active ready run (since /feat-flow-config was removed)
	await expect(wtFlow.command("start", "config")).resolves.toBeUndefined();
	expect(reconfigured).toBe(1);
});

test("commands prune feat-flow-design and feat-flow-config, and plan auto-opens tech-design.html once in interactive UI", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await setupProject(fixture);

	const registered: string[] = [];
	featFlow({
		zod: z,
		on: () => {},
		registerCommand: (name: string) => { registered.push(name); },
		registerTool: () => {},
		logger: { info: () => {} },
	} as never);
	expect(registered).toEqual([
		"feat-flow-status",
		"feat-flow-start",
		"feat-flow-approve",
		"feat-flow-sync",
		"feat-flow-finish",
		"feat-flow-update",
	]);
	expect(registered).not.toContain("feat-flow-design");
	expect(registered).not.toContain("feat-flow-config");

	const launcher = createFlow(makeHost(fixture.source));
	flows.push(launcher);
	await launcher.lifecycle({ type: "session_start" });
	await launcher.command("start", "Auto open html test");
	const catalog = await discoverRuns((await inspectRepository(fixture.source)).commonDir, fixture.source);
	const wt = catalog.runs[0]!.worktree;

	const openedPaths: string[] = [];
	const wtFlow = createFlow(makeHost(wt, {
		ui: {
			hasUI: true,
			notify: () => {},
			confirm: async () => true,
			select: async () => undefined,
			input: async () => undefined,
		},
		openExternal: async (path: string) => { openedPaths.push(path); return true; },
	}));
	flows.push(wtFlow);
	await wtFlow.lifecycle({ type: "session_start" });
	await wtFlow.request({
		kind: "plan",
		scope: "src/a.ts",
		summary: "Auto open check",
		profile: deriveRequirementProfile({
			signals: { expectedFiles: 1, distinctModules: 1, riskFlags: [], externalEffects: false, estimatedSlices: 1 },
			declaredFiles: ["src/a.ts"],
		}),
		plan: {
			activities: [],
			slices: [{ id: "s1", behavior: "do a", test: "bun test", dependsOn: [] }],
			invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
		},
	}, "p-open");
	expect(openedPaths).toHaveLength(1);
	expect(openedPaths[0]).toContain("tech-design-");
});

test("gate state machine enforces write locks, blocks unguarded propose, persists across restart, and validates sequential slices", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await setupProject(fixture);

	const launcher = createFlow(makeHost(fixture.source));
	flows.push(launcher);
	await launcher.lifecycle({ type: "session_start" });
	await launcher.command("start", "Gate invariants");
	const catalog = await discoverRuns((await inspectRepository(fixture.source)).commonDir, fixture.source);
	const wt = catalog.runs[0]!.worktree;

	const sess1 = createFlow(makeHost(wt));
	await sess1.lifecycle({ type: "session_start" });
	await sess1.request({
		kind: "boundaries",
		decided: [
			{ category: "goals", answer: "g" }, { category: "non-goals", answer: "n" },
			{ category: "business-boundary", answer: "b" }, { category: "error-path", answer: "e" }, { category: "acceptance", answer: "a" },
		],
		open: [],
	}, "b1");
	await sess1.request({
		kind: "plan",
		scope: "src/auth.ts, src/client.ts",
		summary: "4-slice Large auth refactor",
		profile: deriveRequirementProfile({
			signals: { expectedFiles: 5, distinctModules: 2, riskFlags: ["auth"], externalEffects: false, estimatedSlices: 4 },
			declaredFiles: ["src/auth.ts", "src/client.ts"],
		}),
		alignmentDoc: sampleDoc(),
		plan: {
			activities: [],
			slices: [
				{ id: "s1", behavior: "add lock", test: "bun test 1", dependsOn: [] },
				{ id: "s2", behavior: "add retry", test: "bun test 2", dependsOn: ["s1"] },
				{ id: "s3", behavior: "wire client", test: "bun test 3", dependsOn: ["s2"] },
				{ id: "s4", behavior: "cleanup", test: "bun test 4", dependsOn: ["s3"] },
			],
			invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
		},
	}, "p-large");

	// Restart before Gate 1 approval: pendingGate must survive & re-mint gateToken!
	await sess1.dispose({ clean: true });
	const sess2 = createFlow(makeHost(wt, {
		sessionId: () => "sess-2",
		ui: {
			hasUI: true,
			notify: () => {},
			confirm: async () => true,
			select: async () => undefined,
			input: async () => undefined,
			formDialog: async (html: string) => {
				expect(html).toContain("cadence");
				return { decision: "approve", cadence: "mid", securityReview: "keep", performanceReview: "keep" };
			},
		},
	}));
	flows.push(sess2);
	await sess2.lifecycle({ type: "session_start" });
	expect(sess2.context().gateToken?.kind).toBe("plan-approval");
	await sess2.command("approve", "");
	expect(sess2.context().phase).toBe("implementation");
	// Mid-checkpoint set after slice 2 (ceil(4/2) -> index 1 -> s2)
	expect(sess2.context().view?.midCheckpointAfterSliceId).toBe("s2");

	// Unguarded propose during implementation MUST be rejected!
	await expect(sess2.request({ kind: "propose", content: "hijack", scope: "other" }, "bad-prop"))
		.rejects.toThrow(/alignment/i);

	// Out-of-order slice.update: marking s2 done before s1 MUST fail!
	await writeFile(join(wt, "f1.txt"), "1\n");
	await git(wt, ["add", "f1.txt"]);
	await git(wt, ["-c", "user.name=F", "-c", "user.email=f@e.invalid", "commit", "-m", "s1"]);
	sess2.recordToolOutcome("chk1", "bash", { command: "bun test" }, false);
	await expect(sess2.request({ kind: "slice.update", sliceId: "s2", status: "done" }, "oob-s2"))
		.rejects.toThrow(/s1/);

	// Complete s1 properly
	await sess2.request({ kind: "slice.update", sliceId: "s1", status: "done" }, "ok-s1");

	// Complete s2 -> triggers checkpoint-review gate AND locks writes!
	await writeFile(join(wt, "f2.txt"), "2\n");
	await git(wt, ["add", "f2.txt"]);
	await git(wt, ["-c", "user.name=F", "-c", "user.email=f@e.invalid", "commit", "-m", "s2"]);
	sess2.recordToolOutcome("chk2", "bash", { command: "bun test" }, false);
	await sess2.request({ kind: "slice.update", sliceId: "s2", status: "done" }, "ok-s2");

	expect(sess2.context().gateToken?.kind).toBe("checkpoint-review");
	expect(sess2.beforeTool({ toolCallId: "w-locked", toolName: "write", input: { path: "f3.txt" } }))
		.toMatchObject({ allow: false, reason: "gate-pending" });

	// Restart during checkpoint-review MUST stay paused & gate-locked!
	await sess2.dispose({ clean: true });
	const sess3 = createFlow(makeHost(wt, { sessionId: () => "sess-3" }));
	flows.push(sess3);
	await sess3.lifecycle({ type: "session_start" });
	expect(sess3.context().gateToken?.kind).toBe("checkpoint-review");
	expect(sess3.beforeTool({ toolCallId: "w-locked-2", toolName: "write", input: { path: "f3.txt" } }))
		.toMatchObject({ allow: false, reason: "gate-pending" });
});

test("plan.amend preserves approvedScope on rejection/restart, enforces immutable done prefix & review-flag integrity, and injects contracts into Recovery Brief + reviewer", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await setupProject(fixture);

	const reviewPrompts: string[] = [];
	const launcher = createFlow(makeHost(fixture.source));
	flows.push(launcher);
	await launcher.lifecycle({ type: "session_start" });
	await launcher.command("start", "Large amend lifecycle");
	const catalog = await discoverRuns((await inspectRepository(fixture.source)).commonDir, fixture.source);
	const wt = catalog.runs[0]!.worktree;

	let approveDecision: Record<string, unknown> = { decision: "approve", cadence: "full", securityReview: "keep", performanceReview: "keep" };
	const wtFlow = createFlow(makeHost(wt, {
		contextUsage: () => ({ tokens: 48_000, contextWindow: 100_000, percent: 48 }),
		helperSdk: (() => ({
			SessionManager: { inMemory: () => ({}) },
			createAgentSession: async () => {
				let p = "";
				return {
					session: {
						model: { provider: "p", id: "m" },
						prompt: async (t: string) => { p = t; if (t.includes("Review this change") || t.includes("Security/Performance")) reviewPrompts.push(t); return true; },
						waitForIdle: async () => {},
						getLastAssistantText: () => p.includes("questionResults")
							? JSON.stringify({
								verdict: "PASS",
								questionResults: [
									{ questionId: "q1", status: "ANSWERED", sectionId: "tldr", quote: "Refactor auth token refresh" },
									{ questionId: "q2", status: "ANSWERED", sectionId: "workflow", quote: "Tier:" },
									{ questionId: "q3", status: "ANSWERED", sectionId: "goals", quote: "Single-flight refresh lock" },
									{ questionId: "q4", status: "ANSWERED", sectionId: "placement", quote: "Auth module sits between" },
									{ questionId: "q5", status: "ANSWERED", sectionId: "mechanism", quote: "Coalesce concurrent refresh" },
									{ questionId: "q6", status: "ANSWERED", sectionId: "change-surface", quote: "src/auth.ts" },
									{ questionId: "q7", status: "ANSWERED", sectionId: "verification", quote: "bun test tests/auth.test.ts" },
								],
								missing: [],
								contradictions: [],
								bloat: [],
								summary: "Clear.",
							})
							: '{"verdict":"ACCEPT","findings":[],"summary":"Clean."}',
						dispose: () => {},
					},
				};
			},
		})) as never,
		ui: {
			hasUI: true,
			notify: () => {},
			confirm: async () => true,
			select: async () => undefined,
			input: async () => undefined,
			formDialog: async () => approveDecision,
		},
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
		kind: "plan",
		scope: "src/auth.ts, src/client.ts",
		summary: "Large plan",
		profile: deriveRequirementProfile({
			signals: { expectedFiles: 5, distinctModules: 2, riskFlags: ["auth"], externalEffects: false, estimatedSlices: 2 },
			declaredFiles: ["src/auth.ts", "src/client.ts"],
		}),
		alignmentDoc: sampleDoc(),
		plan: {
			activities: [],
			slices: [
				{ id: "s1", behavior: "add lock", test: "bun test 1", dependsOn: [] },
				{ id: "s2", behavior: "add retry", test: "bun test 2", dependsOn: ["s1"] },
			],
			invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
		},
	}, "p1");
	await wtFlow.command("approve", "");

	// Check Recovery Brief includes contracts & failureModes
	const brief = await wtFlow.recoveryBrief(false);
	expect(brief).toContain("refreshToken(): Promise<string> coalesces concurrent callers");
	expect(brief).toContain("invalid_grant");
	expect(buildStagePrompt(wtFlow.context().view!, undefined, null)).toContain("scout");

	// Complete s1 and verify 45% advisory is visible on outcome/flow
	await writeFile(join(wt, "s1.txt"), "s1\n");
	await git(wt, ["add", "s1.txt"]);
	await git(wt, ["-c", "user.name=F", "-c", "user.email=f@e.invalid", "commit", "-m", "s1"]);
	wtFlow.recordToolOutcome("chk1", "bash", { command: "bun test" }, false);
	const s1Outcome = await wtFlow.request({ kind: "slice.update", sliceId: "s1", status: "done" }, "su1");
	expect(s1Outcome.advisory).toContain("48%");

	// Reject mutating a completed slice in plan.amend
	await expect(wtFlow.request({
		kind: "plan.amend",
		scope: "src/auth.ts",
		summary: "Try rewrite s1",
		alignmentDoc: sampleDoc(),
		plan: {
			activities: [],
			slices: [
				{ id: "s1", behavior: "CHANGED BEHAVIOR", test: "bun test 1", dependsOn: [] },
				{ id: "s2", behavior: "add retry", test: "bun test 2", dependsOn: ["s1"] },
			],
			invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
		},
	}, "amend-bad")).rejects.toThrow(/completed slice/i);

	// Propose amendment and REJECT it -> original approvedScope & 2 slices remain untouched and writable!
	const approvedBefore = wtFlow.context().approvedScopeDigest;
	await wtFlow.request({
		kind: "plan.amend",
		scope: "src/auth.ts, src/client.ts",
		summary: "Draft rejected split",
		alignmentDoc: sampleDoc(),
		plan: {
			activities: [],
			slices: [
				{ id: "s1", behavior: "add lock", test: "bun test 1", dependsOn: [] },
				{ id: "s2a", behavior: "add retry backoff", test: "bun test 2a", dependsOn: ["s1"] },
				{ id: "s2b", behavior: "wire client", test: "bun test 2b", dependsOn: ["s2a"] },
			],
			invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
		},
	}, "amend-reject");
	expect(wtFlow.context().gateToken?.kind).toBe("amendment-approval");
	expect(wtFlow.context().approvedScopeDigest).toBe(approvedBefore);
	expect(wtFlow.context().planSlices).toBe(2);

	approveDecision = { decision: "reject" };
	await wtFlow.command("approve", "");
	expect(wtFlow.context().gateToken).toBeNull();
	expect(wtFlow.context().approvedScopeDigest).toBe(approvedBefore);
	expect(wtFlow.context().planSlices).toBe(2);
	expect(wtFlow.beforeTool({ toolCallId: "w-after-rej", toolName: "write", input: { path: "s2.txt" } }).allow).toBe(true);

	// Re-propose valid amendment & APPROVE it -> atomically promotes s2a + s2b while preserving s1 done + commitSha!
	await wtFlow.request({
		kind: "plan.amend",
		scope: "src/auth.ts, src/client.ts",
		summary: "Split s2 into s2a and s2b",
		alignmentDoc: sampleDoc(),
		plan: {
			activities: [],
			slices: [
				{ id: "s1", behavior: "add lock", test: "bun test 1", dependsOn: [] },
				{ id: "s2a", behavior: "add retry backoff", test: "bun test 2a", dependsOn: ["s1"] },
				{ id: "s2b", behavior: "wire client", test: "bun test 2b", dependsOn: ["s2a"] },
			],
			invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
		},
	}, "amend-ok");
	approveDecision = { decision: "approve", securityReview: "keep", performanceReview: "keep" };
	await wtFlow.command("approve", "");
	expect(wtFlow.context().planSlices).toBe(3);
	expect(wtFlow.context().view?.plan?.slices[0]?.status).toBe("done");
	expect(wtFlow.context().view?.plan?.slices[0]?.commitSha).toBeTruthy();
	expect(wtFlow.context().view?.profile?.reviews.security.enabled).toBe(true);
});

test("post-sync rebase revokes autoDeliver and reviewer/sec-perf prompts receive alignment contracts", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await setupProject(fixture);

	const launcher = createFlow(makeHost(fixture.source));
	flows.push(launcher);
	await launcher.lifecycle({ type: "session_start" });
	await launcher.command("start", "AutoDeliver rebase check");
	const catalog = await discoverRuns((await inspectRepository(fixture.source)).commonDir, fixture.source);
	const wt = catalog.runs[0]!.worktree;

	const reviewPrompts: string[] = [];
	const wtFlow = createFlow(makeHost(wt, {
		helperSdk: (() => ({
			SessionManager: { inMemory: () => ({}) },
			createAgentSession: async () => {
				return {
					session: {
						model: { provider: "p", id: "m" },
						prompt: async (t: string) => { if (t.includes("Review this change") || t.includes("Perform an independent")) reviewPrompts.push(t); return true; },
						waitForIdle: async () => {},
						getLastAssistantText: () => '{"verdict":"ACCEPT","findings":[],"summary":"Clean."}',
						dispose: () => {},
					},
				};
			},
		})) as never,
		ui: {
			hasUI: true,
			notify: () => {},
			confirm: async () => true,
			select: async () => undefined,
			input: async () => undefined,
			formDialog: async () => ({ decision: "approve_auto", securityReview: "force_on", performanceReview: "keep" }),
		},
		deliveryPorts: ({ worktree }: { worktree: string }) => ({
			git: async (args: string[]) => {
				const r = Bun.spawnSync(["git", "-C", worktree, ...args]);
				return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
			},
			github: {
				findPullRequests: async () => [],
				createPullRequest: async (inp: { head: string; base: string; title: string; body: string }) => {
					const h = (await git(worktree, ["rev-parse", "HEAD"])).trim();
					return { number: 7, url: "https://example.invalid/pr/7", headRefOid: h, body: inp.body, base: inp.base, state: "OPEN" };
				},
			},
			linear: { getIssue: async () => null, updateIssue: async () => {} },
		}),
	}));
	flows.push(wtFlow);
	await wtFlow.lifecycle({ type: "session_start" });
	await wtFlow.request({
		kind: "plan",
		scope: "a.txt",
		summary: "Small auto-deliver plan",
		alignmentDoc: sampleDoc(),
		profile: deriveRequirementProfile({
			signals: { expectedFiles: 1, distinctModules: 1, riskFlags: [], externalEffects: false, estimatedSlices: 1 },
			declaredFiles: ["a.txt"],
		}),
		plan: {
			activities: [],
			slices: [{ id: "s1", behavior: "edit a.txt", test: "bun test", dependsOn: [] }],
			invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
		},
	}, "p-ad");
	await wtFlow.command("approve", "");
	await writeFile(join(wt, "a.txt"), "feature change\n");
	await git(wt, ["add", "a.txt"]);
	await git(wt, ["-c", "user.name=F", "-c", "user.email=f@e.invalid", "commit", "-m", "feat: a"]);
	wtFlow.recordToolOutcome("chk-ad", "bash", { command: "bun test" }, false);
	await wtFlow.request({ kind: "slice.update", sliceId: "s1", status: "done" }, "su-ad");
	await wtFlow.request({ kind: "ready_for_delivery" }, "rfd-ad");

	// Advance origin/staging behind our back so silentAuto sync rebases HEAD -> MUST revoke autoDeliver instead of auto-shipping untested rebased HEAD!
	await writeFile(join(fixture.seed, "upstream.txt"), "upstream commit\n");
	await git(fixture.seed, ["add", "upstream.txt"]);
	await git(fixture.seed, ["-c", "user.name=U", "-c", "user.email=u@e.invalid", "commit", "-m", "upstream"]);
	await git(fixture.seed, ["push", "origin", "HEAD:staging"]);

	await expect(wtFlow.decideGate({ silentAuto: true })).rejects.toThrow(/Auto-deliver revoked after base sync/i);
	expect(wtFlow.context().view?.autoDeliverGrant?.revoked).toBe(true);

	// Manual /feat-flow-approve on pending delivery gate delivers cleanly without throwing!
	await wtFlow.command("approve", "");
	expect(wtFlow.context().phase).toBe("delivered");
	expect(reviewPrompts.some(p => p.includes("coalesces concurrent callers") && p.includes("Do not rewrite session cookie storage"))).toBe(true);
	expect(reviewPrompts.some(p => p.includes("Security") && p.includes("invalid_grant"))).toBe(true);
});

test("fake-green verification commands are rejected and amendment cancel restores pending mid-checkpoint gate", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await setupProject(fixture);

	const launcher = createFlow(makeHost(fixture.source));
	flows.push(launcher);
	await launcher.lifecycle({ type: "session_start" });
	await launcher.command("start", "Fake-green & mid-checkpoint restore");
	const catalog = await discoverRuns((await inspectRepository(fixture.source)).commonDir, fixture.source);
	const wt = catalog.runs[0]!.worktree;

	let dialogCount = 0;
	const wtFlow = createFlow(makeHost(wt, {
		ui: {
			hasUI: true,
			notify: () => {},
			confirm: async () => true,
			select: async () => undefined,
			input: async () => undefined,
			formDialog: async () => {
				dialogCount += 1;
				if (dialogCount === 1) return { decision: "approve", cadence: "mid", securityReview: "keep", performanceReview: "keep" };
				return { decision: "reject" };
			},
		},
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
		kind: "plan",
		scope: "a.txt",
		summary: "2-slice mid-checkpoint plan",
		alignmentDoc: sampleDoc(),
		profile: deriveRequirementProfile({
			signals: { expectedFiles: 2, distinctModules: 1, riskFlags: [], externalEffects: false, estimatedSlices: 2 },
			declaredFiles: ["a.txt", "b.txt"],
		}),
		plan: {
			activities: [{ kind: "prototype", seam: "sdk-timeout", reason: "verify sdk behavior" }],
			slices: [
				{ id: "s1", behavior: "step 1", test: "bun test", dependsOn: [] },
				{ id: "s2", behavior: "step 2", test: "bun test", dependsOn: ["s1"] },
			],
			invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
		},
	}, "p-fg");
	await wtFlow.command("approve", "");
	expect(wtFlow.context().view?.midCheckpointAfterSliceId).toBe("s1");

	await writeFile(join(wt, "a.txt"), "1\n");
	await git(wt, ["add", "a.txt"]);
	await git(wt, ["-c", "user.name=F", "-c", "user.email=f@e.invalid", "commit", "-m", "s1"]);

	// Fake-green commands MUST NOT count as verification!
	for (const fakeCmd of ["bun test || echo done", "bun test | true", "test -d .", "bun test; true", "bun test; echo done", "bun test\ntrue", "true bun test"]) {
		wtFlow.recordToolOutcome("fg", "bash", { command: fakeCmd }, false);
		await expect(wtFlow.request({ kind: "slice.update", sliceId: "s1", status: "done" }, `fail-${fakeCmd}`))
			.rejects.toThrow(/verification/i);
	}

	// Real verification succeeds and triggers checkpoint-review
	wtFlow.recordToolOutcome("real-chk", "bash", { command: "bun test" }, false);
	await wtFlow.request({ kind: "slice.update", sliceId: "s1", status: "done" }, "s1-ok");
	expect(wtFlow.context().gateToken?.kind).toBe("checkpoint-review");

	// Propose plan.amend while checkpoint-review is active, then REJECT -> checkpoint-review MUST be restored!
	await wtFlow.request({
		kind: "plan.amend",
		scope: "a.txt",
		summary: "Bypass attempt",
		alignmentDoc: sampleDoc(),
		plan: {
			activities: [],
			slices: [
				{ id: "s1", behavior: "step 1", test: "bun test", dependsOn: [] },
				{ id: "s2", behavior: "step 2", test: "bun test", dependsOn: ["s1"] },
			],
			invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
		},
	}, "amend-bypass");
	expect(wtFlow.context().gateToken?.kind).toBe("amendment-approval");
	await wtFlow.command("approve", "");
	expect(wtFlow.context().gateToken?.kind).toBe("checkpoint-review");
	expect(wtFlow.beforeTool({ toolCallId: "w-still-locked", toolName: "write", input: { path: "b.txt" } }))
		.toMatchObject({ allow: false, reason: "gate-pending" });
});

test("quote-aware verification classifier allows real monorepo commands, blocks chained/subshell/tampered bypasses, and preserves 3-way git commit state", async () => {
	const { classifyVerificationCommand } = await import("../../src/admission");
	const allowed = [
		"pnpm --filter @plaud/web test",
		"bun run test:local",
		"npm run typecheck:web",
		"bun test -t \"foo|bar\"",
		"bun test -t \"rm\"",
		"bun test 2>&1",
		"cd packages/web && pnpm --cwd apps/web run check:all",
		"NODE_ENV=test bun test",
		"npm --prefix apps/desktop run verify:ci",
		"yarn workspace desktop test:unit",
	];
	for (const cmd of allowed) {
		expect(classifyVerificationCommand(cmd)).toBe("verifier");
	}

	const blocked = [
		"bun test && node evil.js",
		"bun test && python -c 'print(1)'",
		"bun test && bash evil.sh",
		"bun test && cat <(node evil.js)",
		"bun test && (true)",
		"bun test && { true; }",
		"bun test && echo ok \\\nnode evil.js",
		"npx evil-pkg test",
		"bunx evil-pkg test",
		"bun test || echo done",
		"bun test | true",
		"bun test; true",
		"bun test\ntrue",
		"true bun test",
		"test -d .",
		"cd packages/web && true",
	];
	for (const cmd of blocked) {
		expect(classifyVerificationCommand(cmd)).not.toBe("verifier");
	}

	expect(classifyVerificationCommand("touch hijack.txt")).toBe("mutator");
	expect(classifyVerificationCommand("bun test && rm -rf tmp")).toBe("mutator");
	expect(classifyVerificationCommand("npm i")).toBe("mutator");
	expect(classifyVerificationCommand("pnpm rm left-pad")).toBe("mutator");
	expect(classifyVerificationCommand("git commit -m 'feat: x'")).toBe("other");

	// Trivial package.json scripts.test tampering (including trailing comment) MUST be rejected by verifySliceDone
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await setupProject(fixture);
	const launcher = createFlow(makeHost(fixture.source));
	flows.push(launcher);
	await launcher.lifecycle({ type: "session_start" });
	await launcher.command("start", "Package script tamper test");
	const catalog = await discoverRuns((await inspectRepository(fixture.source)).commonDir, fixture.source);
	const wt = catalog.runs[0]!.worktree;
	const wtFlow = createFlow(makeHost(wt));
	flows.push(wtFlow);
	await wtFlow.lifecycle({ type: "session_start" });
	await wtFlow.request({
		kind: "plan",
		scope: "package.json",
		summary: "Tamper check",
		profile: deriveRequirementProfile({
			signals: { expectedFiles: 1, distinctModules: 1, riskFlags: [], externalEffects: false, estimatedSlices: 1 },
			declaredFiles: ["package.json"],
		}),
		plan: { activities: [], slices: [{ id: "s1", behavior: "b", test: "bun test", dependsOn: [] }], invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers" },
	}, "p-tamp");
	await wtFlow.command("approve", "");
	await writeFile(join(wt, "package.json"), JSON.stringify({ name: "x", scripts: { test: "exit 0 # all good" } }));
	await git(wt, ["add", "package.json"]);
	await git(wt, ["-c", "user.name=F", "-c", "user.email=f@e.invalid", "commit", "-m", "tamper"]);
	wtFlow.recordToolOutcome("chk-t", "bash", { command: "npm test" }, false);
	await expect(wtFlow.request({ kind: "slice.update", sliceId: "s1", status: "done" }, "s1-tamp"))
		.rejects.toThrow(/trivial|tamper|verification/i);
	expect(wtFlow.beforeTool({ toolCallId: "gp-q", toolName: "bash", input: { command: 'git "push" origin HEAD' } }))
		.toMatchObject({ allow: false, reason: "workflow-guard" });
});

test("large diffs (>60KB) emit truncated/omitted file pointers to reviewer & sec-perf and parseHtmlForm accepts every production dialog", async () => {
	const { parseHtmlForm } = await import("@oh-my-pi/pi-tui/html-form/parse");
	const { ensureUserOnboarding, ensureProjectOnboarding } = await import("../../src/onboarding");
	const { tmpdir } = await import("node:os");

	const capturedForms: Array<{ name: string; html: string }> = [];
	const tmpUserCfg = join(tmpdir(), `ff-user-${Date.now()}.json`);
	const fixture = await gitFixture();
	fixtures.push(fixture);
	const loc = await setupProject(fixture);

	// Capture user + project onboarding forms
	await ensureUserOnboarding({
		configPath: tmpUserCfg,
		forceReconfigure: true,
		availableModels: [{ spec: "p/m1", label: "p/m1" }, { spec: "p/m2", label: "p/m2" }],
		resolveModel: () => true,
		hasProviderKey: async () => true,
		ui: {
			hasUI: true,
			notify: () => {},
			confirm: async () => true,
			select: async () => undefined,
			input: async () => undefined,
			formDialog: async (html: string) => {
				capturedForms.push({ name: "user-onboarding", html });
				return {
					authorModel: "follow-session", authorEffort: "high",
					scoutModel: "p/m1", scoutEffort: "medium",
					coldReaderModel: "p/m1", coldReaderEffort: "medium",
					reviewerModel: "p/m2", reviewerEffort: "high",
					linearMode: "skip", cmuxPreference: "auto",
				};
			},
		},
	});
	await ensureProjectOnboarding({
		cwd: fixture.source,
		commonDir: loc.commonDir,
		forceReconfigure: true,
		userConfig: {
			schemaVersion: 1,
			onboarding: { status: "completed", completedSteps: ["welcome", "models", "linear", "github", "cmux"] },
			roles: { author: null, scout: { model: "p/m1", effort: "medium" }, coldReader: { model: "p/m1", effort: "medium" }, reviewer: { model: "p/m2", effort: "high" } },
			integrations: { linear: { enabled: false, credentialSource: "none" }, githubCliChecked: true, cmuxPreference: "auto" },
		},
		ui: {
			hasUI: true,
			notify: () => {},
			confirm: async () => true,
			select: async () => undefined,
			input: async () => undefined,
			formDialog: async (html: string) => {
				capturedForms.push({ name: "project-onboarding", html });
				return {
					remote: "origin", repository: "acme/app", prBase: "staging",
					worktreeRoot: "../wts", knowledgePaths: "GLOSSARY.md", linearMode: "disabled",
				};
			},
		},
	});

	// Run large diff (>60KB) + capture Gate 1, checkpoint-review, amendment-approval HTML forms
	const launcher = createFlow(makeHost(fixture.source));
	flows.push(launcher);
	await launcher.lifecycle({ type: "session_start" });
	await launcher.command("start", "Large diff & form parser check");
	const catalog = await discoverRuns(loc.commonDir, fixture.source);
	const wt = catalog.runs[0]!.worktree;

	const reviewPrompts: string[] = [];
	let phaseDialog = 0;
	const wtFlow = createFlow(makeHost(wt, {
		helperSdk: (() => ({
			SessionManager: { inMemory: () => ({}) },
			createAgentSession: async () => {
				let p = "";
				return {
					session: {
						model: { provider: "p", id: "m" },
						prompt: async (t: string) => { p = t; if (t.includes("Review this change") || t.includes("Perform an independent")) reviewPrompts.push(t); return true; },
						waitForIdle: async () => {},
						getLastAssistantText: () => p.includes("questionResults")
							? JSON.stringify({
								verdict: "PASS",
								questionResults: [
									{ questionId: "q1", status: "ANSWERED", sectionId: "tldr", quote: "Refactor auth token refresh" },
									{ questionId: "q2", status: "ANSWERED", sectionId: "workflow", quote: "Tier:" },
									{ questionId: "q3", status: "ANSWERED", sectionId: "goals", quote: "Single-flight refresh lock" },
									{ questionId: "q4", status: "ANSWERED", sectionId: "placement", quote: "Auth module sits between" },
									{ questionId: "q5", status: "ANSWERED", sectionId: "mechanism", quote: "Coalesce concurrent refresh" },
									{ questionId: "q6", status: "ANSWERED", sectionId: "change-surface", quote: "src/auth.ts" },
									{ questionId: "q7", status: "ANSWERED", sectionId: "verification", quote: "bun test tests/auth.test.ts" },
								],
								missing: [], contradictions: [], bloat: [], summary: "ok",
							})
							: '{"verdict":"ACCEPT","findings":[],"summary":"Clean."}',
						dispose: () => {},
					},
				};
			},
		})) as never,
		ui: {
			hasUI: true,
			notify: () => {},
			confirm: async () => true,
			select: async () => undefined,
			input: async () => undefined,
			formDialog: async (html: string) => {
				phaseDialog += 1;
				if (phaseDialog === 1) {
					capturedForms.push({ name: "gate1", html });
					return { decision: "approve", cadence: "mid", securityReview: "force_on", performanceReview: "keep" };
				}
				if (phaseDialog === 2) {
					capturedForms.push({ name: "checkpoint-review", html });
					return { decision: "amend" };
				}
				capturedForms.push({ name: "amendment-approval", html });
				return { decision: "approve", securityReview: "keep", performanceReview: "keep" };
			},
		},
		deliveryPorts: ({ worktree }: { worktree: string }) => ({
			git: async (args: string[]) => {
				const r = Bun.spawnSync(["git", "-C", worktree, ...args]);
				return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
			},
			github: {
				findPullRequests: async () => [],
				createPullRequest: async (inp: { head: string; base: string; title: string; body: string }) => {
					const h = (await git(worktree, ["rev-parse", "HEAD"])).trim();
					return { number: 9, url: "https://example.invalid/pr/9", headRefOid: h, body: inp.body, base: inp.base, state: "OPEN" };
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
		kind: "plan",
		scope: "big-a.ts, big-b.ts",
		summary: "Large diff test",
		alignmentDoc: sampleDoc(),
		profile: deriveRequirementProfile({
			signals: { expectedFiles: 2, distinctModules: 1, riskFlags: ["auth"], externalEffects: false, estimatedSlices: 4 },
			declaredFiles: ["big-a.ts", "big-b.ts"],
		}),
		plan: {
			activities: [],
			slices: [
				{ id: "s1", behavior: "step 1", test: "bun test", dependsOn: [] },
				{ id: "s2", behavior: "step 2", test: "bun test", dependsOn: ["s1"] },
				{ id: "s3", behavior: "step 3", test: "bun test", dependsOn: ["s2"] },
				{ id: "s4", behavior: "step 4", test: "bun test", dependsOn: ["s3"] },
			],
			invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
		},
	}, "p-big");
	await wtFlow.command("approve", "");

	// Write >62KB in big-a.ts so big-a.ts is truncated AND big-b.ts is completely omitted after 60KB!
	await writeFile(join(wt, "big-a.ts"), Array.from({ length: 1600 }, (_, i) => `export const line_${i} = "padding_${i}_内容";`).join("\n") + "\n");
	await git(wt, ["add", "big-a.ts"]);
	await git(wt, ["-c", "user.name=F", "-c", "user.email=f@e.invalid", "commit", "-m", "s1"]);
	wtFlow.recordToolOutcome("c1", "bash", { command: "bun test" }, false);
	await wtFlow.request({ kind: "slice.update", sliceId: "s1", status: "done" }, "su1");

	await writeFile(join(wt, "big-b.ts"), "export const b = 1;\n");
	await git(wt, ["add", "big-b.ts"]);
	await git(wt, ["-c", "user.name=F", "-c", "user.email=f@e.invalid", "commit", "-m", "s2"]);
	wtFlow.recordToolOutcome("c2", "bash", { command: "bun test" }, false);
	await wtFlow.request({ kind: "slice.update", sliceId: "s2", status: "done" }, "su2");
	await wtFlow.command("approve", ""); // checkpoint-review -> amend

	await wtFlow.request({
		kind: "plan.amend",
		scope: "big-a.ts, big-b.ts",
		summary: "Merge s3+s4",
		alignmentDoc: sampleDoc(),
		plan: {
			activities: [],
			slices: [
				{ id: "s1", behavior: "step 1", test: "bun test", dependsOn: [] },
				{ id: "s2", behavior: "step 2", test: "bun test", dependsOn: ["s1"] },
				{ id: "s3", behavior: "finish rest", test: "bun test", dependsOn: ["s2"] },
			],
			invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
		},
	}, "amend-big");
	await wtFlow.command("approve", ""); // amendment-approval -> approve

	await writeFile(join(wt, "big-b.ts"), "export const b = 2;\n");
	await git(wt, ["add", "big-b.ts"]);
	await git(wt, ["-c", "user.name=F", "-c", "user.email=f@e.invalid", "commit", "-m", "s3"]);
	wtFlow.recordToolOutcome("c3", "bash", { command: "bun test" }, false);
	await wtFlow.request({ kind: "slice.update", sliceId: "s3", status: "done" }, "su3");
	await wtFlow.command("finish", "");

	// Verify all captured forms parse cleanly with real pi-tui parseHtmlForm
	expect(capturedForms.map(f => f.name)).toEqual([
		"user-onboarding", "project-onboarding", "gate1", "checkpoint-review", "amendment-approval",
	]);
	for (const entry of capturedForms) {
		const parsed = parseHtmlForm(entry.html);
		expect(parsed.fields.length).toBeGreaterThan(0);
	}

	// Verify both independent & sec-perf prompts highlight files truncated/omitted past 60KB
	expect(reviewPrompts.some(p => p.includes("Truncated/omitted") && p.includes("big-a.ts") && p.includes("big-b.ts"))).toBe(true);
	expect(reviewPrompts.some(p => p.includes("Perform an independent Security audit") && p.includes("big-b.ts"))).toBe(true);
});
