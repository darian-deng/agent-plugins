import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { saveProject } from "../../src/config";
import { inspectRepository } from "../../src/git";
import featFlow from "../../src/index";
import { git, gitFixture, type GitFixture } from "../support/git-fixture";

const fixtures: GitFixture[] = [];
afterEach(async () => {
	for (const f of fixtures.splice(0)) await f.cleanup();
});

function createFakePi() {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	let toolDef: { name: string; execute: (id: string, params: unknown) => Promise<unknown> } | null = null;
	const pi = {
		on: (name: string, fn: (...args: unknown[]) => unknown) => { handlers.set(name, fn); },
		registerCommand: (name: string, def: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, def);
		},
		registerTool: (def: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) => {
			toolDef = def;
		},
		getActiveTools: () => [],
		setModel: async () => true,
		setThinkingLevel: () => {},
		sendMessage: () => {},
		logger: { info: () => {} },
		zod: z,
		pi: {},
	};
	featFlow(pi as never);
	return { handlers, commands, toolDef: toolDef! };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
	return {
		hasUI: false,
		agent: { kind: "main" as const, id: "Main", name: "main", depth: 0 },
		sessionManager: { getSessionId: () => "ext-session-1" },
		models: {
			current: () => ({ provider: "p", id: "m" }),
			list: () => [{ provider: "p", id: "m" }],
			resolve: () => ({ provider: "p", id: "m" }),
		},
		modelRegistry: { getApiKeyForProvider: async () => "sk-test" },
		getContextUsage: () => ({ tokens: 20000, contextWindow: 100000, percent: 20 }),
		isIdle: () => true,
		ui: {
			notify: () => {},
			confirm: async () => true,
			select: async () => undefined,
			input: async () => undefined,
			setStatus: () => {},
			setWidget: () => {},
		},
		...overrides,
	};
}

test("extension registers expected commands (no feat-flow-continue) and isolates subagents", async () => {
	const { commands, handlers } = createFakePi();
	expect(commands.has("feat-flow-continue")).toBe(false);
	expect(commands.has("feat-flow-design")).toBe(false);
	expect(commands.has("feat-flow-config")).toBe(false);
	for (const name of ["feat-flow-start", "feat-flow-status", "feat-flow-approve", "feat-flow-finish", "feat-flow-sync", "feat-flow-update"]) {
		expect(commands.has(name)).toBe(true);
	}
	const beforeAgentStart = handlers.get("before_agent_start") as (e: unknown, ctx: unknown) => Promise<unknown>;
	const subRes = await beforeAgentStart({ type: "before_agent_start", reason: "prompt", prompt: "hi", systemPrompt: ["base"] }, makeCtx({
		agent: { kind: "sub", id: "0-Scout", name: "scout", depth: 1 },
	}));
	expect(subRes).toBeUndefined();
});

test("extension supports inline alignment submission, spreads systemPrompt, guards subagent spawn, and handles compacting", async () => {
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

	const prevCmux = process.env.OMP_FEAT_FLOW_CMUX;
	const prevSkipOnboarding = process.env.OMP_FEAT_FLOW_SKIP_USER_ONBOARDING;
	process.env.OMP_FEAT_FLOW_CMUX = "0";
	process.env.OMP_FEAT_FLOW_SKIP_USER_ONBOARDING = "1";
	const origCwd = process.cwd();
	process.chdir(fixture.source);
	try {
		const { commands, handlers, toolDef } = createFakePi();
		const ctx = makeCtx();
		await commands.get("feat-flow-start")!.handler("ext-run", ctx);

		// Child omp session opens inside the provisioned worktree and claims ownership cleanly.
		const wt = join(fixture.source, "..", "wts", "ext-run");
		process.chdir(wt);
		const childPi = createFakePi();
		const childCtx = makeCtx({ sessionManager: { getSessionId: () => "child-ext-session" } });
		const childStart = childPi.handlers.get("session_start") as (e: unknown, ctx: unknown) => Promise<void>;
		await childStart({ type: "session_start" }, childCtx);

		const beforeAgentStart = childPi.handlers.get("before_agent_start") as (e: unknown, ctx: unknown) => Promise<{ systemPrompt?: string[]; message?: { customType: string } } | undefined>;
		const bas = await beforeAgentStart({ type: "before_agent_start", reason: "prompt", prompt: "hello", systemPrompt: ["HOST_SYS"] }, childCtx);
		expect(bas?.systemPrompt?.[0]).toBe("HOST_SYS");
		expect(bas?.systemPrompt?.length).toBe(2);
		expect(bas?.message?.customType).toBe("feat-flow-recovery");

		const beforeSpawn = childPi.handlers.get("before_subagent_spawn") as (e: unknown, ctx: unknown) => Promise<{ block?: boolean } | undefined>;
		expect(await beforeSpawn({ type: "before_subagent_spawn", agent: "task", invocationKind: "task", patterns: [] }, childCtx)).toMatchObject({ block: true });
		const scoutSpawn = await beforeSpawn({ type: "before_subagent_spawn", agent: "scout", invocationKind: "task", patterns: [] }, childCtx);
		expect(scoutSpawn?.block).not.toBe(true);
		void handlers;
		void toolDef;

		const sessionStop = childPi.handlers.get("session_stop") as (e: unknown, ctx: unknown) => { continue?: boolean } | undefined;
		expect(sessionStop({ type: "session_stop", stop_hook_active: false }, childCtx)).toBeUndefined();

		const bRes = await childPi.toolDef.execute("call-b", {
			boundaries: {
				decided: [
					{ category: "goals", answer: "g" },
					{ category: "non-goals", answer: "n" },
					{ category: "business-boundary", answer: "b" },
					{ category: "error-path", answer: "e" },
					{ category: "acceptance", answer: "a" },
				],
				open: [],
			},
		}) as { content: Array<{ text: string }> };
		expect(bRes.content[0]?.text).toContain("accepted:");

		const compacting = childPi.handlers.get("session.compacting") as (e: unknown, ctx: unknown) => Promise<{ context?: string[] } | undefined>;
		const compRes = await compacting({ type: "session.compacting", sessionId: "child-ext-session", messages: [] }, childCtx);
		expect(compRes?.context?.[0]).toContain("Recovery Brief");

		// Trigger wrap-up latch via tool_result at >= 60% and verify session_stop bounces once!
		const toolResult = childPi.handlers.get("tool_result") as (e: unknown, ctx: unknown) => Promise<{ additionalContext?: string } | undefined>;
		const highCtx = makeCtx({ sessionManager: { getSessionId: () => "child-ext-session" }, getContextUsage: () => ({ tokens: 65000, contextWindow: 100000, percent: 65 }) });
		const trRes = await toolResult({ type: "tool_result", toolCallId: "r1", toolName: "read", input: {}, isError: false }, highCtx);
		expect(trRes?.additionalContext).toContain("WRAP_UP");
		expect(sessionStop({ type: "session_stop", stop_hook_active: false }, highCtx)).toMatchObject({ continue: true });
		expect(sessionStop({ type: "session_stop", stop_hook_active: true }, highCtx)).toBeUndefined();
		await (childPi.handlers.get("session_shutdown") as (e: unknown, ctx: unknown) => Promise<void>)({ type: "session_shutdown" }, childCtx);
	} finally {
		process.chdir(origCwd);
		if (prevCmux === undefined) delete process.env.OMP_FEAT_FLOW_CMUX;
		else process.env.OMP_FEAT_FLOW_CMUX = prevCmux;
		if (prevSkipOnboarding === undefined) delete process.env.OMP_FEAT_FLOW_SKIP_USER_ONBOARDING;
		else process.env.OMP_FEAT_FLOW_SKIP_USER_ONBOARDING = prevSkipOnboarding;
		await rm(join(fixture.source, "..", "wts"), { recursive: true, force: true }).catch(() => {});
	}
});

test("session_switch updates sessionId and agent_end clears promptedGateId when gate fails or cancels", async () => {
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

	const prevCmux = process.env.OMP_FEAT_FLOW_CMUX;
	const prevSkipOnboarding = process.env.OMP_FEAT_FLOW_SKIP_USER_ONBOARDING;
	const prevSkipOpen = process.env.OMP_FEAT_FLOW_SKIP_OPEN;
	process.env.OMP_FEAT_FLOW_CMUX = "0";
	process.env.OMP_FEAT_FLOW_SKIP_USER_ONBOARDING = "1";
	process.env.OMP_FEAT_FLOW_SKIP_OPEN = "1";
	const origCwd = process.cwd();
	process.chdir(fixture.source);
	try {
		const launcher = createFakePi();
		await launcher.commands.get("feat-flow-start")!.handler("switch-run", makeCtx());
		const wt = join(fixture.source, "..", "wts", "switch-run");
		process.chdir(wt);

		let currentSess = "sess-A";
		let confirmAnswer = false;
		const notifyTexts: string[] = [];
		let gateSettled!: () => void;
		let waitGate = new Promise<void>(r => { gateSettled = r; });
		const resetGateWait = () => { waitGate = new Promise<void>(r => { gateSettled = r; }); };
		const { handlers, toolDef } = createFakePi();
		const dynCtx = () => makeCtx({
			hasUI: true,
			sessionManager: { getSessionId: () => currentSess },
			ui: {
				notify: (msg: string) => {
					notifyTexts.push(msg);
					if (msg.includes("Cancelled") || msg.includes("approved")) gateSettled();
				},
				confirm: async () => confirmAnswer,
				select: async () => undefined,
				input: async () => undefined,
				setStatus: () => {},
				setWidget: () => {},
			},
		});

		await (handlers.get("session_start") as (e: unknown, c: unknown) => Promise<void>)({ type: "session_start" }, dynCtx());
		currentSess = "sess-B";
		await (handlers.get("session_switch") as (e: unknown, c: unknown) => Promise<void>)({ type: "session_switch", reason: "resume" }, dynCtx());

		// Submit small-tier plan -> gateToken minted; first agent_end confirm=false must reset promptedGateId so second agent_end retries!
		await toolDef.execute("req-1", {
			signals: { expectedFiles: 1, distinctModules: 1, riskFlags: [], externalEffects: false, estimatedSlices: 1 },
			declaredFiles: ["a.txt"],
			plan: {
				activities: [],
				slices: [{ id: "s1", behavior: "b", test: "t", dependsOn: [] }],
				invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
			},
		});
		const agentEnd = handlers.get("agent_end") as (e: unknown, c: unknown) => void;
		agentEnd({ type: "agent_end", willContinue: false, awaitingAsyncWork: false }, dynCtx());
		await waitGate;
		expect(notifyTexts.some(t => t.includes("Cancelled"))).toBe(true);

		resetGateWait();
		confirmAnswer = true;
		agentEnd({ type: "agent_end", willContinue: false, awaitingAsyncWork: false }, dynCtx());
		await waitGate;
		expect(notifyTexts.some(t => t.includes("approved"))).toBe(true);
		await (handlers.get("session_shutdown") as (e: unknown, c: unknown) => Promise<void>)({ type: "session_shutdown" }, dynCtx());

		const locRepo = await inspectRepository(wt);
		const runLoc = (await import("../../src/run")).locateRun(locRepo)!;
		const k = await (await import("../../src/run")).openRun({
			repo: runLoc.repo, runId: runLoc.runId, buildId: "v", mode: "inspect",
			binding: { processInstanceId: "p", sessionId: "s", contextEpoch: 0 },
		});
		expect(k.inspect().phase).toBe("implementation");
		expect(k.inspect().owner?.sessionId).toBe("sess-B");
	} finally {
		process.chdir(origCwd);
		if (prevCmux === undefined) delete process.env.OMP_FEAT_FLOW_CMUX;
		else process.env.OMP_FEAT_FLOW_CMUX = prevCmux;
		if (prevSkipOnboarding === undefined) delete process.env.OMP_FEAT_FLOW_SKIP_USER_ONBOARDING;
		else process.env.OMP_FEAT_FLOW_SKIP_USER_ONBOARDING = prevSkipOnboarding;
		if (prevSkipOpen === undefined) delete process.env.OMP_FEAT_FLOW_SKIP_OPEN;
		else process.env.OMP_FEAT_FLOW_SKIP_OPEN = prevSkipOpen;
		await rm(join(fixture.source, "..", "wts"), { recursive: true, force: true }).catch(() => {});
	}
});
