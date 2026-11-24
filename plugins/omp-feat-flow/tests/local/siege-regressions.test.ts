import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readUserConfigSafe, saveProject } from "../../src/config";
import { createFlow, type FlowController } from "../../src/flow";
import { createFlowRuntime } from "../../src/flow-context";
import { inspectRepository } from "../../src/git";
import { REQUEST_INTENT_KEYS } from "../../src/intents";
import featFlow from "../../src/index";
import { proposeKnowledge } from "../../src/knowledge";
import { materializeMethodPack, openPinnedMethodPack } from "../../src/methods";
import { deriveRequirementProfile } from "../../src/profile";
import { locateRun, openRun } from "../../src/run";
import { git, gitFixture, type GitFixture } from "../support/git-fixture";

const fixtures: GitFixture[] = [];
const flows: FlowController[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
	for (const f of flows.splice(0)) await f.dispose();
	for (const fx of fixtures.splice(0)) await fx.cleanup();
	for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
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
		helperSdk: () => { throw new Error("not used"); },
		modelRegistry: () => undefined,
		model: () => undefined,
		contextUsage: () => undefined,
		...overrides,
	};
}

test("P0-1 & P0-2: cmux spawns only AFTER state/locator exist; non-feat-flow subagent bypasses & batch scout allowed", async () => {
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

	// Subagent in an uninitialized repo (fixture.source) MUST bypass completely.
	const plainSub = createFlow(makeHost(fixture.source, { agentKind: () => "sub" as const }));
	flows.push(plainSub);
	await plainSub.lifecycle({ type: "session_start" });
	expect(plainSub.beforeTool({ toolCallId: "w-plain", toolName: "write" })).toMatchObject({ allow: true, reason: "subagent-outside-feat-flow" });

	let stateExistedWhenCmuxSpawned = false;
	let locatorExistedWhenCmuxSpawned = false;
	const cmuxRunner = async (_cmd: string, args: string[]) => {
		const joined = args.join(" ");
		if (joined.includes("workspace list")) {
			return { code: 0, stdout: JSON.stringify([{ id: "ws-new", description: `feat-flow:${loc.repoIdentity.slice(0, 8)}` }]), stderr: "" };
		}
		if (joined.includes("workspace create")) {
			const wt = join(fixture.source, "..", "wts", "cmux-order");
			stateExistedWhenCmuxSpawned = existsSync(join(loc.commonDir, "omp-feat-flow", "runs", "cmux-order", "state.json"));
			locatorExistedWhenCmuxSpawned = locateRun(await inspectRepository(wt)) !== null;
			return { code: 0, stdout: JSON.stringify({ workspace_id: "ws-new" }), stderr: "" };
		}
		return { code: 0, stdout: "[]", stderr: "" };
	};
	const launcher = createFlow(makeHost(fixture.source, { workspace: { enabled: true, run: cmuxRunner } }));
	flows.push(launcher);
	await launcher.lifecycle({ type: "session_start" });
	await launcher.command("start", "cmux-order");
	expect(stateExistedWhenCmuxSpawned).toBe(true);
	expect(locatorExistedWhenCmuxSpawned).toBe(true);

	const wt = join(fixture.source, "..", "wts", "cmux-order");
	const child = createFlow(makeHost(wt));
	flows.push(child);
	await child.lifecycle({ type: "session_start" });
	// Batch task with all scout items allowed; mixed batch denied.
	expect(child.beforeTool({ toolCallId: "t1", toolName: "task", input: { context: "c", tasks: [{ agent: "scout", task: "x" }] } }))
		.toMatchObject({ allow: true, reason: "allowed-scout" });
	expect(child.beforeTool({ toolCallId: "t2", toolName: "task", input: { context: "c", tasks: [{ agent: "scout" }, { agent: "task" }] } }).allow)
		.toBe(false);
});

test("P0-3: blocked foreign session cannot launder authorization via dispose({ clean: true })", async () => {
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
	await launcher.lifecycle({ type: "session_start" });
	await launcher.command("start", "launder-1");
	await launcher.dispose();
	const wt = join(fixture.source, "..", "wts", "launder-1");
	const wtRepo = (await inspectRepository(wt));
	const runLoc = locateRun(wtRepo)!;

	// Owner approves scope and crashes (unclean dispose).
	const owner = await openRun({ repo: runLoc.repo, runId: runLoc.runId, buildId: "b", mode: "owner", binding: { processInstanceId: "p1", sessionId: "s1", contextEpoch: 0 } });
	await owner.apply({ kind: "propose", content: "Plan", scope: "a.ts" }, { processInstanceId: "p1", sessionId: "s1", contextEpoch: 0 });
	const cand = owner.inspect().candidate!;
	await owner.apply({ kind: "approve", source: "native-ui", approved: true, runId: runLoc.runId, digest: cand.digest, candidateRevision: cand.revision, ownerEpoch: owner.inspect().ownerEpoch }, { processInstanceId: "p1", sessionId: "s1", contextEpoch: 0 });
	await owner.dispose(); // unclean!

	// Foreign session opens blocked, exits WITH clean:true, then re-opens with its own sessionId: MUST stay blocked!
	const intruder1 = await openRun({ repo: runLoc.repo, runId: runLoc.runId, buildId: "b", mode: "owner", binding: { processInstanceId: "p2", sessionId: "intruder", contextEpoch: 0 } });
	expect(intruder1.inspect().waitingReason).toBe("owner-authorization-required");
	await intruder1.dispose({ clean: true });

	const intruder2 = await openRun({ repo: runLoc.repo, runId: runLoc.runId, buildId: "b", mode: "owner", binding: { processInstanceId: "p3", sessionId: "intruder", contextEpoch: 0 } });
	expect(intruder2.inspect()).toMatchObject({ readiness: "blocked", waitingReason: "owner-authorization-required" });
	await intruder2.dispose();
});

test("P0-4 & E2: Gate 1 formDialog grants human autoDeliver & sec/perf override, and post-slice out-of-scope file revokes autoDeliver", async () => {
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
	await launcher.command("start", "autodeliv-1");
	const wt = join(fixture.source, "..", "wts", "autodeliv-1");

	let confirmCalled = false;
	const flow = createFlow(makeHost(wt, {
		confirm: async () => { confirmCalled = true; return false; },
		ui: {
			hasUI: true,
			notify: () => {},
			confirm: async () => { confirmCalled = true; return false; },
			select: async () => undefined,
			input: async () => undefined,
			formDialog: async () => ({ decision: "approve_auto", securityReview: "force_on", performanceReview: "keep" }),
		},
	}));
	flows.push(flow);
	await flow.lifecycle({ type: "session_start" });

	const smallProfile = deriveRequirementProfile({
		signals: { expectedFiles: 1, distinctModules: 1, riskFlags: [], externalEffects: false, estimatedSlices: 1 },
		declaredFiles: ["a.txt"],
	});
	await flow.request({
		kind: "plan",
		scope: "a.txt",
		summary: "Small fix",
		profile: smallProfile,
		plan: { activities: [], slices: [{ id: "s1", behavior: "Update a.txt", test: "bun test", dependsOn: [] }], invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers" },
	}, "p1");

	await flow.command("approve", "");
	const approved = flow.context().view!;
	expect(approved.autoDeliverGrant).toMatchObject({ grantedByHuman: true, revoked: false, declaredFiles: ["a.txt"] });
	expect(approved.profile?.reviews.security.enabled).toBe(true);
	expect(approved.profile?.reviews.security.overridden).toBe(true);

	// Slice 1 stays within declaredFiles.
	await writeFile(join(wt, "a.txt"), "ok\n");
	await git(wt, ["add", "a.txt"]);
	await git(wt, ["-c", "user.name=F", "-c", "user.email=f@e.invalid", "commit", "-m", "feat: a"]);
	flow.recordToolOutcome("t1", "bash", { command: "bun test" }, false);
	await flow.request({ kind: "slice.update", sliceId: "s1", status: "done" }, "s1");

	// Out-of-scope commit AFTER last slice done MUST still be caught at decideGate(silentAuto)!
	await writeFile(join(wt, "undeclared.txt"), "sneaky\n");
	await git(wt, ["add", "undeclared.txt"]);
	await git(wt, ["-c", "user.name=F", "-c", "user.email=f@e.invalid", "commit", "-m", "feat: extra"]);
	flow.recordToolOutcome("t2", "bash", { command: "bun test" }, false);
	await flow.request({ kind: "ready_for_delivery" }, "rfd");

	const decided = await flow.decideGate({ silentAuto: true });
	expect(decided).toBe(false);
	expect(confirmCalled).toBe(true);
	expect(flow.context().view?.autoDeliverGrant?.revoked).toBe(true);
});

test("P0-5 & P0-8: containment blocks symlink escapes & outside paths; workflow guard catches git -C . push & read-only MCPs", async () => {
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

	const extDir = await mkdtemp(join(tmpdir(), "omp-ff-secret-"));
	tempDirs.push(extDir);
	await writeFile(join(extDir, "secret.txt"), "SUPER_SECRET_KEY");

	const launcher = createFlow(makeHost(fixture.source));
	flows.push(launcher);
	await launcher.lifecycle({ type: "session_start" });
	await launcher.command("start", "contain-1");
	const wt = join(fixture.source, "..", "wts", "contain-1");

	// Create symlink inside worktree pointing to outside secret.
	await symlink(extDir, join(wt, "escape-link"));
	await expect(proposeKnowledge({
		root: wt,
		candidates: [{ path: "escape-link/secret.txt", reason: "leak", proposed: "hijacked" }],
	})).rejects.toThrow(/symlink|escapes/i);

	const rt = createFlowRuntime(makeHost(wt));
	const vocab = await rt.projectVocabulary(wt, ["../../etc/passwd", "escape-link/secret.txt"]);
	expect(vocab).not.toContain("SUPER_SECRET_KEY");

	const flow = createFlow(makeHost(wt, {
		isReadOnlyMcpTool: (name: string) => name === "mcp__linear_get_issue",
	}));
	flows.push(flow);
	await flow.lifecycle({ type: "session_start" });
	await flow.request({
		kind: "plan",
		scope: "a.txt",
		summary: "Small",
		profile: deriveRequirementProfile({ signals: { expectedFiles: 1, distinctModules: 1, riskFlags: [], externalEffects: false, estimatedSlices: 1 }, declaredFiles: ["a.txt"] }),
		plan: { activities: [], slices: [{ id: "s1", behavior: "b", test: "t", dependsOn: [] }], invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers" },
	}, "p1");
	await flow.command("approve", "");

	expect(flow.beforeTool({ toolCallId: "w-out", toolName: "write", input: { path: join(extDir, "out.txt") } }))
		.toMatchObject({ allow: false, reason: "path-outside-worktree" });
	expect(flow.beforeTool({ toolCallId: "g-push", toolName: "bash", input: { command: "git -C . push origin HEAD" } }))
		.toMatchObject({ allow: false, reason: "workflow-guard" });
	expect(flow.beforeTool({ toolCallId: "mcp-ro", toolName: "mcp__linear_get_issue", input: { id: "DESK-1" } }).allow).toBe(true);
	expect(flow.beforeTool({ toolCallId: "mcp-rw", toolName: "mcp__linear_save_comment", input: {} }))
		.toMatchObject({ allow: false, reason: "workflow-guard" });

	// /feat-flow-finish refuses pending slices!
	await expect(flow.command("finish", "")).rejects.toThrow(/slices must be done/i);
});

test("P0-7: detached HEAD rebase recovers locateRun with branch name", async () => {
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
	await launcher.command("start", "rebase-pin");
	const wt = join(fixture.source, "..", "wts", "rebase-pin");

	// Simulate detached HEAD during active rebase-merge -> inspectRepository & locateRun MUST still resolve branch!
	const headSha = (await git(wt, ["rev-parse", "HEAD"])).trim();
	const wtGitDir = (await git(wt, ["rev-parse", "--absolute-git-dir"])).trim();
	await git(wt, ["checkout", "--detach", headSha]);
	await mkdir(join(wtGitDir, "rebase-merge"), { recursive: true });
	await writeFile(join(wtGitDir, "rebase-merge", "head-name"), "refs/heads/feat/rebase-pin\n");
	const midRebaseLoc = await inspectRepository(wt);
	expect(midRebaseLoc.branch).toBe("feat/rebase-pin");
	expect(locateRun(midRebaseLoc)?.runId).toBe("rebase-pin");
	await rm(join(wtGitDir, "rebase-merge"), { recursive: true, force: true });
	await git(wt, ["checkout", "feat/rebase-pin"]);
});

test("P0-6 & P1: REQUEST_INTENTS schema rejects drifted keys, MethodPack honors pinned digest & opt-in, corrupt user config never crashes tool_call", async () => {
	const badCfgDir = await mkdtemp(join(tmpdir(), "omp-ff-badcfg-"));
	tempDirs.push(badCfgDir);
	const badCfg = join(badCfgDir, "omp-feat-flow.json");
	await writeFile(badCfg, "{ not valid json");
	expect(readUserConfigSafe(badCfg).ok).toBe(false);

	// MethodPack ignores overrideDirs unless explicitly opted in.
	const commonDir = await mkdtemp(join(tmpdir(), "omp-ff-pin-"));
	const ovrDir = await mkdtemp(join(tmpdir(), "omp-ff-ovr-"));
	tempDirs.push(commonDir, ovrDir);
	await mkdir(join(ovrDir, "tdd"), { recursive: true });
	await writeFile(join(ovrDir, "tdd", "SKILL.md"), "# Overridden\n");

	const defaultPack = await materializeMethodPack(commonDir);
	expect(defaultPack.overriddenMethods).toEqual([]);
	const optedInPack = await materializeMethodPack(commonDir, { allowUserOverrides: true, overrideDirs: [ovrDir] });
	expect(optedInPack.overriddenMethods).toEqual(["tdd"]);
	expect(optedInPack.methodDigest).not.toBe(defaultPack.methodDigest);
	expect((await openPinnedMethodPack(commonDir, defaultPack.methodDigest)).overriddenMethods).toEqual([]);

	// Verify feat_flow_request tool schema rejects drifted ready_for_delivery / autoDeliver.
	let registeredTool: { execute: (id: string, params: unknown) => Promise<unknown>; parameters: z.ZodTypeAny } | null = null;
	featFlow({
		on: () => {},
		registerCommand: () => {},
		registerTool: (def: { execute: (id: string, params: unknown) => Promise<unknown>; parameters: z.ZodTypeAny }) => { registeredTool = def; },
		getActiveTools: () => [],
		logger: { info: () => {} },
		zod: z,
		pi: {},
	} as never);
	expect(REQUEST_INTENT_KEYS).toContain("readyForDelivery");
	expect(() => registeredTool!.parameters.parse({ ready_for_delivery: true })).toThrow();
	expect(() => registeredTool!.parameters.parse({ autoDeliver: true })).toThrow();
});

test("Neon sign-off blockers: restart between plan & approve succeeds, MCP mutator allowed outside feat-flow, Linear GraphQL braces balanced, readyForDelivery:false rejected", async () => {
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

	// 1) MCP delivery mutators MUST bypass in plain non-feat-flow repos.
	const plainMain = createFlow(makeHost(fixture.source));
	flows.push(plainMain);
	await plainMain.lifecycle({ type: "session_start" });
	expect(plainMain.beforeTool({ toolCallId: "m1", toolName: "mcp__linear_save_comment", input: {} }))
		.toMatchObject({ allow: true, reason: "run-not-initialized" });

	// 2) Submit plan in Session 1 -> clean dispose -> reopen in Session 2 -> /feat-flow-approve MUST succeed!
	await plainMain.command("start", "restart-before-approve");
	const wt = join(fixture.source, "..", "wts", "restart-before-approve");
	const sess1 = createFlow(makeHost(wt, { sessionId: () => "sess-1" }));
	await sess1.lifecycle({ type: "session_start" });
	await sess1.request({
		kind: "plan",
		scope: "a.txt",
		summary: "Small plan",
		profile: deriveRequirementProfile({ signals: { expectedFiles: 1, distinctModules: 1, riskFlags: [], externalEffects: false, estimatedSlices: 1 }, declaredFiles: ["a.txt"] }),
		plan: { activities: [], slices: [{ id: "s1", behavior: "b", test: "t", dependsOn: [] }], invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers" },
	}, "p1");
	expect(sess1.context().gateToken?.kind).toBe("plan-approval");
	await sess1.dispose({ clean: true });

	const sess2 = createFlow(makeHost(wt, { sessionId: () => "sess-2" }));
	flows.push(sess2);
	await sess2.lifecycle({ type: "session_start" });
	expect(sess2.context().gateToken?.kind).toBe("plan-approval");
	await sess2.command("approve", "");
	expect(sess2.context().phase).toBe("implementation");
	// 3) Linear fetchTeamMetadata GraphQL query has balanced braces.
	const { linearClient } = await import("../../src/linear");
	const origFetch = globalThis.fetch;
	let capturedQuery = "";
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		capturedQuery = JSON.parse(String(init?.body ?? "{}")).query ?? "";
		return new Response(JSON.stringify({
			data: {
				viewer: { id: "v1", name: "Viewer" },
				team: { id: "t1", key: "DESK", name: "Desktop", states: { nodes: [] }, labels: { nodes: [] }, projects: { nodes: [] }, activeCycle: null },
			},
		}));
	}) as unknown as typeof fetch;
	try {
		await linearClient("k").fetchTeamMetadata!("t1");
		const opens = (capturedQuery.match(/\{/g) ?? []).length;
		const closes = (capturedQuery.match(/\}/g) ?? []).length;
		expect(opens).toBe(closes);
	} finally {
		globalThis.fetch = origFetch;
	}

	// 4) readyForDelivery: false throws; STEERING_INTENT_HINTS uses real schema keys.
	const { STEERING_INTENT_HINTS } = await import("../../src/intents");
	expect(STEERING_INTENT_HINTS.knowledge).toContain("knowledgePath");
	expect(STEERING_INTENT_HINTS.knowledge).toContain("knowledgeReason");
	expect(STEERING_INTENT_HINTS.knowledge).toContain("knowledgeProposed");
	let registeredTool: { execute: (id: string, params: unknown) => Promise<unknown> } | null = null;
	featFlow({
		on: () => {}, registerCommand: () => {},
		registerTool: (def: { execute: (id: string, params: unknown) => Promise<unknown> }) => { registeredTool = def; },
		getActiveTools: () => [], logger: { info: () => {} }, zod: z, pi: {},
	} as never);
	await expect(registeredTool!.execute("rfd-false", { readyForDelivery: false })).rejects.toThrow(/readyForDelivery cannot be false/);
});
