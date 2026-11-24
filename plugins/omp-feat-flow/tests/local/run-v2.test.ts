import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepare, type PreparedWorktree } from "../../src/git";
import {
	openRun,
	provisionRun,
	readRunState,
	RunKernel,
	RunStateSchemaError,
	type RunContext,
} from "../../src/run";
import { gitFixture, type GitFixture } from "../support/git-fixture";

const kernels: RunKernel[] = [];
const fixtures: GitFixture[] = [];

afterEach(async () => {
	for (const kernel of kernels.splice(0)) await kernel.dispose();
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

function ctxFor(repo: PreparedWorktree, runId: string, procId: string, sessionId = procId): RunContext {
	return { repo, runId, buildId: "v2-build", mode: "owner", binding: { processInstanceId: procId, sessionId, contextEpoch: 0 } };
}

test("provisionRun leaves run awaiting_claim with no owner lock so child main session claims cleanly", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	const repo = await prepare({
		repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
		runId: "prov-1", branch: "feat/prov-1", worktree: join(fixture.root, "prov-1"),
	});

	const provisioned = await provisionRun({
		repo,
		runId: "prov-1",
		buildId: "v2-build",
		methodDigest: "m".repeat(64),
		workspace: { workspaceId: "ws-1", ownedByRun: true, launchNonce: "nonce-1", verified: true, continuation: "cd w && omp", handoff: "switched" },
	});
	expect(provisioned.owner).toBeNull();
	expect(provisioned.readiness).toBe("ready");

	// Child top-level session opens and claims ownership immediately with readiness=ready.
	const child = await openRun(ctxFor(repo, "prov-1", "child-proc", "child-sess"));
	kernels.push(child);
	expect(child.inspect()).toMatchObject({
		runId: "prov-1",
		ownerStatus: "self",
		readiness: "ready",
		waitingReason: null,
		ownerEpoch: 1,
		methodDigest: "m".repeat(64),
	});
});

test("clean shutdown auto-restores approved writes across local sessions while unclean shutdown stays blocked", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	const repo = await prepare({
		repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
		runId: "resume-1", branch: "feat/resume-1", worktree: join(fixture.root, "resume-1"),
	});

	const first = await openRun(ctxFor(repo, "resume-1", "proc-1", "same-session"));
	await first.apply({ kind: "propose", content: "Plan", scope: "src/a.ts" }, { processInstanceId: "proc-1", sessionId: "same-session", contextEpoch: 0 });
	const cand = first.inspect().candidate!;
	await first.apply({
		kind: "approve", source: "native-ui", approved: true, runId: "resume-1",
		digest: cand.digest, candidateRevision: cand.revision, ownerEpoch: first.inspect().ownerEpoch,
	}, { processInstanceId: "proc-1", sessionId: "same-session", contextEpoch: 0 });
	expect(first.admit({ toolCallId: "w1", effect: "write" }, { processInstanceId: "proc-1", sessionId: "same-session", contextEpoch: 0 }).allow).toBe(true);

	// Clean shutdown marks cleanRelease=true.
	await first.dispose({ clean: true });

	// Decision B: fresh local session entering the dedicated worktree after clean shutdown auto-inherits implementation authority.
	const resumed = await openRun(ctxFor(repo, "resume-1", "proc-2", "fresh-local-session"));
	kernels.push(resumed);
	expect(resumed.inspect()).toMatchObject({ readiness: "ready", waitingReason: null, phase: "implementation" });
	expect(resumed.admit({ toolCallId: "w2", effect: "write" }, { processInstanceId: "proc-2", sessionId: "fresh-local-session", contextEpoch: 0 }).allow).toBe(true);

	// Unclean shutdown (crash without { clean: true }) MUST stay fail-closed behind owner-authorization-required.
	await resumed.dispose();
	kernels.pop();
	const crashedResume = await openRun(ctxFor(repo, "resume-1", "proc-3", "after-crash"));
	kernels.push(crashedResume);
	expect(crashedResume.inspect()).toMatchObject({ readiness: "blocked", waitingReason: "owner-authorization-required" });
	expect(crashedResume.admit({ toolCallId: "w3", effect: "write" }, { processInstanceId: "proc-3", sessionId: "after-crash", contextEpoch: 0 }).allow).toBe(false);
});

test("same-process context.handoff clears wrap-up latch and keeps writes authorized without re-lockout", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	const repo = await prepare({
		repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
		runId: "clear-1", branch: "feat/clear-1", worktree: join(fixture.root, "clear-1"),
	});
	const b0 = { processInstanceId: "proc", sessionId: "sess", contextEpoch: 0 };
	const kernel = await openRun({ repo, runId: "clear-1", buildId: "v2-build", mode: "owner", binding: b0 });
	kernels.push(kernel);
	await kernel.apply({ kind: "propose", content: "Plan", scope: "src/a.ts" }, b0);
	const cand = kernel.inspect().candidate!;
	await kernel.apply({
		kind: "approve", source: "native-ui", approved: true, runId: "clear-1",
		digest: cand.digest, candidateRevision: cand.revision, ownerEpoch: kernel.inspect().ownerEpoch,
	}, b0);
	await kernel.apply({ kind: "context.wrapUp", mode: "finalizing_slice", atPct: 61, thresholdPct: 60 }, b0);
	expect(kernel.inspect().contextWrapUp).toMatchObject({ mode: "finalizing_slice", atPct: 61, checkpointed: false });

	const b1 = (await kernel.apply({ kind: "context.handoff", contextEpoch: 1 }, b0)).view;
	expect(b1.readiness).toBe("ready");
	expect(b1.contextWrapUp).toBeNull();
	expect(kernel.admit({ toolCallId: "w-after-clear", effect: "write" }, { ...b0, contextEpoch: 1 }).allow).toBe(true);
});

test("migrates v1 state.json to v2 with backup while preserving approvedScope", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	const repo = await prepare({
		repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
		runId: "mig-1", branch: "feat/mig-1", worktree: join(fixture.root, "mig-1"),
	});
	const runDir = join(repo.commonDir, "omp-feat-flow", "runs", "mig-1");
	const statePath = join(runDir, "state.json");
	const kernel = await openRun(ctxFor(repo, "mig-1", "p1"));
	await kernel.apply({ kind: "propose", content: "Legacy Plan", scope: "src/legacy.ts" }, { processInstanceId: "p1", sessionId: "p1", contextEpoch: 0 });
	const cand = kernel.inspect().candidate!;
	await kernel.apply({
		kind: "approve", source: "native-ui", approved: true, runId: "mig-1",
		digest: cand.digest, candidateRevision: cand.revision, ownerEpoch: kernel.inspect().ownerEpoch,
	}, { processInstanceId: "p1", sessionId: "p1", contextEpoch: 0 });
	await kernel.dispose();

	// Overwrite state.json with a v1 schema snapshot.
	const v2State = readRunState(statePath)!;
	const v1Raw = {
		schemaVersion: 1,
		runId: v2State.runId,
		repoIdentity: v2State.repoIdentity,
		commonDir: v2State.commonDir,
		worktree: v2State.worktree,
		branch: v2State.branch,
		git: v2State.git,
		startSha: v2State.startSha,
		currentIntegrationSha: v2State.currentIntegrationSha,
		loadedBuildId: "v1-build",
		ownerEpoch: v2State.ownerEpoch,
		owner: { processInstanceId: "p1", sessionId: "p1", contextEpoch: 0, epoch: 1 },
		revision: v2State.revision,
		phase: "implementation",
		issue: "DESK-99",
		workspace: { workspaceId: null, verified: false, continuation: "cd w && omp", handoff: "not-switched" },
		currentTask: null,
		knowledgeCandidate: null,
		candidateRevision: v2State.candidateRevision,
		candidate: {
			digest: cand.digest, revision: cand.revision, scope: cand.scope, contentPath: cand.contentPath,
			configDigest: v2State.scopePolicyDigest, inputRevision: v2State.inputRevision,
		},
		approvedScope: {
			digest: cand.digest, revision: cand.revision, scope: cand.scope, contentPath: cand.contentPath,
			configDigest: v2State.scopePolicyDigest, inputRevision: v2State.inputRevision,
		},
		project: null,
		operations: [],
		lastIntentDigest: v2State.lastIntentDigest,
		consumedIntents: v2State.consumedIntents,
		outbox: v2State.outbox,
		grilling: null,
		plan: {
			activities: [],
			slices: [{ id: "s1", behavior: "b", test: "t", dependsOn: [] }],
			invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
		},
		proofs: [],
		readiness: "ready",
		waitingReason: null,
		configDigest: v2State.scopePolicyDigest,
		inputRevision: v2State.inputRevision,
	};
	await writeFile(statePath, JSON.stringify(v1Raw) + "\n");

	const reopened = await openRun(ctxFor(repo, "mig-1", "p2"));
	kernels.push(reopened);
	expect(existsSync(join(runDir, "state.v1.bak.json"))).toBe(true);
	const view = reopened.inspect();
	expect(view.schemaVersion).toBe(2);
	expect(view.issue).toBe("DESK-99");
	expect(view.approvedScope?.digest).toBe(cand.digest);
	expect(view.plan?.slices[0]?.status).toBe("pending");

	// Unknown schemaVersion still throws RunStateSchemaError.
	await writeFile(statePath, JSON.stringify({ ...v1Raw, schemaVersion: 99 }));
	expect(() => readRunState(statePath)).toThrow(RunStateSchemaError);
});

test("linear-issue operation.settle binds issue and issueId atomically inside one transaction", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	const repo = await prepare({
		repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
		runId: "lin-1", branch: "feat/lin-1", worktree: join(fixture.root, "lin-1"),
	});
	const b = { processInstanceId: "p", sessionId: "p", contextEpoch: 0 };
	const kernel = await openRun(ctxFor(repo, "lin-1", "p"));
	kernels.push(kernel);
	const op = { id: "linear-issue-lin-1", type: "linear-issue" as const, target: "team-1", intentDigest: "a".repeat(64) };
	await kernel.apply({ kind: "operation.prepare", operation: op }, b);
	await kernel.apply({ kind: "operation.dispatch", operationId: op.id }, b);
	await kernel.apply({
		kind: "operation.settle",
		operationId: op.id,
		outcome: "applied",
		receipt: { target: op.target, intentDigest: op.intentDigest, reference: "DESK-42" },
		boundIssue: { identifier: "DESK-42", id: "uuid-42" },
	}, b);
	expect(kernel.inspect()).toMatchObject({ issue: "DESK-42", issueId: "uuid-42", readiness: "ready" });
});
