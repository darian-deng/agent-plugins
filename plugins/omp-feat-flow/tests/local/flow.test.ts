import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { createFlow, effectOf, recoveryReceipt, type FlowController } from "../../src/flow";
import type { DeliveryPorts, PullRequestHandle } from "../../src/delivery";
import { inspectRepository, prepare } from "../../src/git";
import { openRun, RunKernel, saveProject, type ProjectDefaults } from "../../src/run";
import { git, gitFixture, type GitFixture } from "../support/git-fixture";

const fixtures: GitFixture[] = [];

const DEFAULTS: ProjectDefaults = {
	git: { remote: "origin", startRef: "origin/staging", prBase: "staging", worktreeRoot: "source-worktrees" },
	github: { host: "github.com", repository: "fixture/repository" },
	linear: { workspaceId: "workspace", teamId: "team",
		statusMapping: { inProgress: "In Progress", inReview: "In Review", done: "Done" } },
	models: { author: "fixture", helper: "fixture", reviewer: "fixture" },
	knowledge: { entryPaths: ["GLOSSARY.md", "docs/adr"] },
};

async function withDefaults(fixture: GitFixture): Promise<void> {
	// Project defaults live beside the repository's common dir, which is what the run reads.
	await saveProject((await inspectRepository(fixture.source)).commonDir, DEFAULTS, 0);
}
const flows: FlowController[] = [];
afterEach(async () => {
	for (const flow of flows.splice(0)) await flow.dispose();
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

function host(cwd: string) {
	return { cwd: () => cwd, sessionId: () => "flow-session", processInstanceId: "flow-process", buildId: "fixture-build",
		notify: (_text: string) => {},
		modelStatus: async () => ({ ready: true, reason: "ready" as const, provider: "fixture", model: "fixture", guidance: null }),
		confirm: async () => false,
		workspace: { enabled: false },
		installedRelease: async () => null,
		activeTools: () => [],
		helperSdk: () => { throw new Error("no helper sdk in this fixture"); },
		modelRegistry: () => undefined,
		model: () => undefined };
}

test("an unapproved write is denied by the public run view while reads and unknown tools stay honest", async () => {
	expect(effectOf("bash")).toBe("write");
	expect(effectOf("write")).toBe("write");
	expect(effectOf("some_future_tool")).toBe("write");
	expect(effectOf("read")).toBe("read");
	expect(effectOf("task")).toBe("spawn");
	expect(effectOf("feat_flow_request")).toBe("read");

	const fixture = await gitFixture();
	fixtures.push(fixture);
	const unstarted = createFlow(host(fixture.source));
	flows.push(unstarted);
	await unstarted.lifecycle({ type: "session_start" });
	expect(unstarted.beforeTool({ toolCallId: "t1", toolName: "bash" })).toMatchObject({ allow: false, reason: "run-not-initialized" });
	expect(unstarted.beforeTool({ toolCallId: "t2", toolName: "read" })).toMatchObject({ allow: true });

	const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
		runId: "flow", branch: "feat/flow", worktree: join(fixture.root, "flow") });
	// The starting session opens the run, which is what leaves the worktree locator behind.
	const starter = await openRun({ repo, runId: "flow", buildId: "fixture-build", mode: "owner",
		binding: { processInstanceId: "starter", sessionId: "starter", contextEpoch: 0 } });
	await starter.dispose();
	// A different live session taking over the run must not inherit the previous owner's authority.
	const flow = createFlow(host(repo.worktree));
	flows.push(flow);
	await flow.lifecycle({ type: "session_start" });
	expect(flow.context()).toMatchObject({ located: true, runId: "flow", readiness: "blocked", waitingReason: "owner-recovery", ownerStatus: "self" });
	expect(flow.beforeTool({ toolCallId: "t3", toolName: "edit" })).toMatchObject({ allow: false, reason: "owner-recovery" });
	expect(flow.beforeTool({ toolCallId: "t4", toolName: "read" })).toMatchObject({ allow: true });
	expect(flow.beforeTool({ toolCallId: "t5", toolName: "unknown_future_tool" })).toMatchObject({ allow: false, reason: "owner-recovery" });
	await expect(flow.request({ kind: "propose", content: "Bound a fixture change.", scope: "fixture only" }, "call-1"))
		.rejects.toBeInstanceOf(Error);
	expect(flow.context()).toMatchObject({ waitingReason: "owner-recovery", approvedScopeDigest: null });
	await expect(flow.command("start", "")).rejects.toBeInstanceOf(Error);
	await flow.command("status", "");
	await flow.rebindSession();
	expect(flow.context()).toMatchObject({ located: false, reason: "run-loading" });
});

test("resuming a bound run re-grants ownership only on an explicit native answer", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	// The run is created and approved by a session that then goes away.
	const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "origin/staging", prBase: "staging",
		runId: "desk-resume", branch: "feat/desk-resume", worktree: join(fixture.root, "source-worktrees", "desk-resume") });
	const creatorBinding = { processInstanceId: "creator", sessionId: "creator", contextEpoch: 0 };
	const kernel = await RunKernel.create({ repo, runId: "desk-resume", buildId: "fixture-build", mode: "owner", binding: creatorBinding });
	await kernel.apply({ kind: "request.submit", requestId: "c1", expectedRevision: kernel.inspect().revision,
		intent: { kind: "propose", content: "Bound a change.", scope: "fixture only" } }, creatorBinding);
	const candidate = kernel.inspect().candidate;
	if (!candidate) throw new Error("no candidate");
	await kernel.apply({ kind: "approve", source: "native-ui", approved: true, runId: "desk-resume",
		digest: candidate.digest, candidateRevision: candidate.revision, ownerEpoch: kernel.inspect().ownerEpoch }, creatorBinding);
	await kernel.dispose();

	const worktree = repo.worktree;
	const cancelled = createFlow({ ...host(worktree), confirm: async () => false });
	flows.push(cancelled);
	await cancelled.lifecycle({ type: "session_start" });
	await expect(cancelled.command("start", "desk-resume")).rejects.toBeInstanceOf(Error);
	expect(cancelled.context()).toMatchObject({ located: true, readiness: "blocked" });
	await cancelled.dispose();
	flows.splice(flows.indexOf(cancelled), 1);

	const resumed = createFlow({ ...host(worktree), confirm: async () => true });
	flows.push(resumed);
	await resumed.lifecycle({ type: "session_start" });
	await resumed.command("start", "desk-resume");
	expect(resumed.context()).toMatchObject({ located: true, runId: "desk-resume", readiness: "ready" });
	expect(resumed.beforeTool({ toolCallId: "w", toolName: "write" }).allow).toBe(true);
});

test("start creates the isolated worktree and its ready run once", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await withDefaults(fixture);
	const flow = createFlow(host(fixture.source));
	flows.push(flow);
	await flow.lifecycle({ type: "session_start" });
	await flow.command("start", "desk-demo");
	const view = flow.context();
	expect(view).toMatchObject({ located: true, runId: "desk-demo", phase: "alignment", readiness: "ready", ownerStatus: "self" });
	expect(flow.beforeTool({ toolCallId: "t1", toolName: "bash" })).toMatchObject({ allow: false, reason: "scope-not-approved" });
	const receipt = recoveryReceipt(flow.context());
	expect(flow.context().located).toBe(true);
	expect(receipt).toContain("phase alignment");
	expect(receipt).toContain("approved no");
	expect(receipt).not.toContain("dispatched effect");
	expect(recoveryReceipt({ ...flow.context(), located: false, reason: "run-not-initialized" })).toBe("no run: run-not-initialized");
	await expect(flow.command("start", "desk-demo")).rejects.toBeInstanceOf(Error);
	await expect(flow.command("start", "Bad Slug")).rejects.toBeInstanceOf(Error);
	await expect(flow.command("approve", "")).rejects.toBeInstanceOf(Error);
});

test("finish refuses to clean up before the delivery stage and never closes by name", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await withDefaults(fixture);
	const calls: string[][] = [];
	const runner = async (command: string, args: string[]) => {
		calls.push([command, ...args]);
		const joined = args.join(" ");
		if (joined.includes("workspace list")) return { code: 0, stdout: '{"workspaces":[{"id":"OWNED","custom_title":"feat-flow:desk-finish"}]}', stderr: "" };
		if (joined.includes("workspace create")) return { code: 0, stdout: '{"workspace_id":"OWNED","surface_id":"SURF"}', stderr: "" };
		return { code: 0, stdout: "OK", stderr: "" };
	};
	const flow = createFlow({ ...host(fixture.source), workspace: { enabled: true, run: runner } });
	flows.push(flow);
	await flow.lifecycle({ type: "session_start" });
	await flow.command("start", "desk-finish");
	expect(calls.some(call => call.includes("workspace") && call.includes("create"))).toBe(true);
	// Cleanup follows delivery: an unapproved run is refused before any workspace is touched.
	await expect(flow.command("finish", "")).rejects.toThrow(/approved scope/);
	expect(calls.some(call => call.includes("close"))).toBe(false);
});

test("clearing the session revokes write readiness until a human re-authorizes", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await withDefaults(fixture);
	const flow = createFlow({ ...host(fixture.source), workspace: { enabled: false } });
	flows.push(flow);
	await flow.lifecycle({ type: "session_start" });
	await flow.command("start", "desk-clear");
	// Reads stay allowed; a write needs an approved, owned run.
	expect(flow.beforeTool({ toolCallId: "t1", toolName: "bash" }).reason).toBe("scope-not-approved");

	await flow.lifecycle({ type: "session_clear" });
	await flow.lifecycle({ type: "session_start" });
	expect(flow.context().located).toBe(true);
	expect(flow.beforeTool({ toolCallId: "t2", toolName: "write" }).reason).toBe("context-cleared");
	// Reads still work; only writes wait for the human re-authorization.
	expect(flow.beforeTool({ toolCallId: "t3", toolName: "read" }).allow).toBe(true);
});

test("start with a Linear identifier binds that one issue and derives the slug", async () => {
	// The local suite never calls Linear; the live cases cover the verified path.
	process.env.OMP_FEAT_FLOW_LINEAR_OFFLINE = "1";
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await withDefaults(fixture);
	const flow = createFlow(host(fixture.source));
	flows.push(flow);
	await flow.lifecycle({ type: "session_start" });
	await flow.command("start", "DESK-1234");
	expect(flow.context()).toMatchObject({ located: true, runId: "desk-1234", issue: "DESK-1234" });
	delete process.env.OMP_FEAT_FLOW_LINEAR_OFFLINE;
});

test("a trailing identifier inside a sentence is not treated as a binding", async () => {
	process.env.OMP_FEAT_FLOW_LINEAR_OFFLINE = "1";
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await withDefaults(fixture);
	const flow = createFlow(host(fixture.source));
	flows.push(flow);
	await flow.lifecycle({ type: "session_start" });
	await expect(flow.command("start", "fix DESK-999 now")).rejects.toThrow(/lowercase requirement slug/);
	delete process.env.OMP_FEAT_FLOW_LINEAR_OFFLINE;
});

test("finish syncs, reviews the synced state, records proof, delivers once, then cleans up", async () => {
	process.env.OMP_FEAT_FLOW_LINEAR_OFFLINE = "1";
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await withDefaults(fixture);

	const created: PullRequestHandle[] = [];
	let linearUpdates = 0;
	let markerApplied = false;
	let reviewPrompts: string[] = [];
	const fakeSdk = {
		SessionManager: { inMemory: () => ({}) as never },
		createAgentSession: async () => ({
			session: {
				model: { provider: "fixture", id: "reviewer" },
				prompt: async (text: string) => { reviewPrompts.push(text); return true; },
				waitForIdle: async () => {},
				getLastAssistantText: () => "ACCEPT\n## Standards\nNo standards violations.\n## Spec\nThe change matches the approved scope.",
				dispose: () => {},
			},
		}),
	};
	const deliveryPorts = ({ worktree }: { worktree: string }): DeliveryPorts => ({
		git: async (command) => {
			const result = Bun.spawnSync(["git", "-C", worktree, ...command]);
			return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
		},
		github: {
			findPullRequests: async () => created,
			createPullRequest: async (input) => {
				const head = Bun.spawnSync(["git", "-C", worktree, "rev-parse", "HEAD"]).stdout.toString().trim();
				const handle: PullRequestHandle = { number: created.length + 1, url: "https://example.invalid/pr/1",
					headRefOid: head, body: input.body, base: input.base, state: "OPEN" };
				created.push(handle);
				return handle;
			},
		},
		linear: {
			getIssue: async () => ({ identifier: "DESK-1", state: markerApplied ? "In Review" : "Todo", hasMarker: markerApplied }),
			updateIssue: async () => { linearUpdates += 1; markerApplied = true; },
		},
	});
	const flow = createFlow({ ...host(fixture.source), confirm: async () => true,
		helperSdk: () => fakeSdk as never, deliveryPorts, activeTools: () => ["mcp__linear_get_issue", "mcp__linear_update_issue"] });
	flows.push(flow);
	await flow.lifecycle({ type: "session_start" });
	await flow.command("start", "DESK-1");
	// Propose, then approve through the flow so the run is really in implementation.
	await flow.request({ kind: "propose", content: "Change only the fixture file.", scope: "fixture" }, "r1");
	await flow.command("approve", "");

	const worktree = join(fixture.source, "..", "source-worktrees", "desk-1");
	// The reviewer has no file access, so the project vocabulary has to arrive in its prompt.
	await writeFile(join(worktree, "GLOSSARY.md"), "# Glossary\n\n- **delivery**: the single PR handoff\n");
	await writeFile(join(worktree, "change.txt"), "delivered\n");
	await git(worktree, ["add", "-A"]);
	await git(worktree, ["-c", "user.email=f@e", "-c", "user.name=f", "commit", "-m", "change"]);

	await flow.command("finish", "");
	expect(created).toHaveLength(1);
	expect(linearUpdates).toBe(1);
	// One cold read at approval, one review at delivery; the review judged the post-sync change
	// with the project's own vocabulary (knowledge.entryPaths) in its prompt.
	const reviews = reviewPrompts.filter(prompt => prompt.includes("Changed files:"));
	expect(reviews).toHaveLength(1);
	expect(reviews[0]).toContain("change.txt");
	expect(reviews[0]).toContain("Project context");
	expect(reviews[0]).toContain("delivery**: the single PR handoff");
	expect(flow.context().phase).toBe("delivery");

	// A second finish reconciles instead of duplicating the PR or the backwrite.
	await flow.command("finish", "");
	expect(created).toHaveLength(1);
	expect(linearUpdates).toBe(1);
	delete process.env.OMP_FEAT_FLOW_LINEAR_OFFLINE;
});

test("a knowledge correction becomes a candidate, needs native approval, and grants no write scope", async () => {
	process.env.OMP_FEAT_FLOW_LINEAR_OFFLINE = "1";
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await withDefaults(fixture);
	const fakeSdk = {
		SessionManager: { inMemory: () => ({}) as never },
		createAgentSession: async () => ({
			session: { model: { provider: "fixture", id: "reader" }, prompt: async () => true, waitForIdle: async () => {},
				getLastAssistantText: () => "ANSWERABLE approve", dispose: () => {} },
		}),
	};
	const flow = createFlow({ ...host(fixture.source), confirm: async () => true, helperSdk: () => fakeSdk as never });
	flows.push(flow);
	await flow.lifecycle({ type: "session_start" });
	await flow.command("start", "DESK-7");

	await flow.request({ kind: "knowledge", path: "GLOSSARY.md", reason: "The session kept calling the export a 'dump'.", proposed: "# Glossary\n\n- **export**: the bounded artifact the service stores on disk\n" }, "k1");
	// Before approval the file does not exist and no write is permitted.
	const worktree = join(fixture.source, "..", "source-worktrees", "desk-7");
	expect(await Bun.file(join(worktree, "GLOSSARY.md")).exists()).toBe(false);
	expect(flow.beforeTool({ toolCallId: "w1", toolName: "write" }).reason).toBe("scope-not-approved");

	await flow.command("approve", "");
	expect(await Bun.file(join(worktree, "GLOSSARY.md")).text()).toContain("**export**");
	// The approval granted exactly the knowledge write and nothing else.
	expect(flow.beforeTool({ toolCallId: "w2", toolName: "write" }).reason).toBe("scope-not-approved");
	delete process.env.OMP_FEAT_FLOW_LINEAR_OFFLINE;
});
