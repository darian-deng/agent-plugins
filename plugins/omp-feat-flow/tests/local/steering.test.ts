import { expect, test } from "bun:test";
import type { RunView } from "../../src/run";
import { buildRecoveryBrief, buildStagePrompt, buildStageWidget } from "../../src/steering";

function baseView(overrides: Partial<RunView> = {}): RunView {
	return {
		schemaVersion: 2,
		runId: "desk-805",
		repoIdentity: "/repos/app/.git",
		commonDir: "/repos/app/.git",
		worktree: "/repos/app-wt/desk-805",
		branch: "feat/desk-805",
		git: { remote: "origin", prBase: "staging", privateStartRef: "refs/omp-feat-flow/start/desk-805", worktreeGitDir: "/repos/app/.git/worktrees/desk-805" },
		startSha: "a".repeat(40),
		currentIntegrationSha: "a".repeat(40),
		loadedBuildId: "b1",
		methodDigest: "m".repeat(64),
		ownerEpoch: 1,
		owner: { processInstanceId: "p1", sessionId: "s1", contextEpoch: 0, epoch: 1 },
		ownerStatus: "self",
		revision: 3,
		phase: "implementation",
		issue: "DESK-805",
		issueId: "uuid-805",
		workspace: null,
		initialTask: null,
		currentTask: "s2",
		knowledgeCandidate: null,
		candidateRevision: 1,
		candidate: null,
		approvedScope: {
			digest: "c".repeat(64),
			revision: 1,
			scope: "src/sync/*",
			contentPath: "/tmp/c.json",
			configDigest: "d".repeat(64),
			inputRevision: 1,
		},
		project: null,
		operations: [],
		lastIntentDigest: null,
		consumedIntents: [],
		coldReadProof: null,
		autoDeliverGrant: null,
		deliveryReceipt: null,
		lastVerifiedCheckHead: null,
		syncContext: null,
		outbox: null,
		grilling: {
			decided: [
				{ category: "goals", answer: "Offline sync queue" },
				{ category: "non-goals", answer: "No server schema rewrite" },
			],
			open: [],
		},
		plan: {
			activities: [],
			slices: [
				{ id: "s1", behavior: "Queue store", test: "queue.test.ts", dependsOn: [], status: "done", commitSha: "1111111" },
				{ id: "s2", behavior: "Retry backoff", test: "retry.test.ts", dependsOn: ["s1"], status: "in_progress" },
			],
			invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers",
		},
		profile: {
			tier: "medium",
			tierSource: "derived",
			signals: { expectedFiles: 4, distinctModules: 2, riskFlags: ["untrusted-input"], externalEffects: false, estimatedSlices: 2 },
			reviews: {
				security: { enabled: true, triggers: ["untrusted-input"], reason: "untrusted-input", overridden: false },
				performance: { enabled: false, triggers: [], reason: "none", overridden: false },
			},
			autoDeliver: false,
			declaredFiles: ["src/sync/queue.ts", "src/sync/retry.ts"],
		},
		alignmentDocPath: null,
		techDesignHtmlPath: "/tmp/tech-design.html",
		gateToken: null,
		pendingGate: null,
		midCheckpointAfterSliceId: null,
		midCheckpointCompleted: false,
		pendingAmendment: null,
		contextWrapUp: null,
		handoff: {
			updatedAtRevision: 2,
			reason: "between-slices",
			activeSliceId: "s2",
			currentState: "Starting retry backoff",
			remainingInSlice: null,
			discoveries: ["Use exponential jitter capped at 30s"],
			pendingQuestions: [],
			lastVerification: "queue.test.ts pass",
			gitHead: "1111111",
			gitDirty: false,
		},
		proofs: [],
		historyProofs: [],
		deliveredAt: null,
		readiness: "ready",
		waitingReason: null,
		scopePolicyDigest: "d".repeat(64),
		configDigest: "d".repeat(64),
		inputRevision: 1,
		...overrides,
	};
}

test("buildStageWidget renders 3 clear lines showing stage, slice, issue, ctx pct, and who acts next", () => {
	const implWidget = buildStageWidget(baseView(), { tokens: 34000, contextWindow: 100000, percent: 34 });
	expect(implWidget.lines).toHaveLength(3);
	expect(implWidget.lines[0]).toContain("DESK-805");
	expect(implWidget.lines[0]).toContain("34%");
	expect(implWidget.lines[1]).toContain("s2");
	expect(implWidget.lines[2]).toContain("AI");

	const gateView = baseView({
		phase: "alignment",
		approvedScope: null,
		gateToken: { id: "g1", kind: "plan-approval", ownerEpoch: 1, contextEpoch: 0, gateRevision: 2, candidateDigest: "c".repeat(64) },
	});
	const gateWidget = buildStageWidget(gateView, undefined);
	expect(gateWidget.lines[2]).toContain("Gate");
});

test("buildRecoveryBrief includes decided boundaries, approved scope, slice progress, git state, and discoveries", () => {
	const brief = buildRecoveryBrief(baseView(), { head: "1111111", logOneline: ["1111111 feat(s1): queue"], dirtyFiles: [] }, "/packs/m");
	expect(brief).toContain("Offline sync queue");
	expect(brief).toContain("No server schema rewrite");
	expect(brief).toContain("src/sync/*");
	expect(brief).toContain("[x] s1");
	expect(brief).toContain("[>] s2");
	expect(brief).toContain("Use exponential jitter capped at 30s");
	expect(brief).toContain("/packs/m/tdd/SKILL.md");
});

test("buildStagePrompt enforces non-gate autonomous flow vs gate stop rules and private pack path", () => {
	const alignPrompt = buildStagePrompt(baseView({
		phase: "alignment",
		approvedScope: null,
		grilling: { decided: [], open: ["goals", "acceptance"] },
	}), undefined, "/packs/m");
	expect(alignPrompt).toContain("/packs/m/grilling/SKILL.md");
	expect(alignPrompt).toContain("goals, acceptance");
	expect(alignPrompt).not.toContain("/skill:");

	const wrapUpPrompt = buildStagePrompt(baseView({
		contextWrapUp: { mode: "finalizing_slice", atPct: 61, thresholdPct: 60, latchedAtRevision: 3, checkpointed: false },
	}), { tokens: 61000, contextWindow: 100000, percent: 61 }, "/packs/m");
	expect(wrapUpPrompt).toContain("FINALIZING_SLICE");
	expect(wrapUpPrompt).toContain("checkpoint");
});
