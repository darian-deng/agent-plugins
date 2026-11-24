import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { isFileLockHeld, tryAcquireFileLock, withFileLock, type FileLockHandle } from "@oh-my-pi/pi-utils/file-lock";
import { z } from "zod";
import {
	effectiveRemote,
	projectConfigSchemaV2,
	readProject,
	saveProject,
	sha256Hex,
	writeAtomic,
	type ProjectConfigV2,
	type ResolvedProject,
} from "./config";
import type { DeliveryStepStates } from "./delivery";
import type { ProofKind } from "./evidence";
import type { PreparedWorktree, RepositoryLocation } from "./git";
import type { BoundaryCategory, BoundaryDecision } from "./grilling";
import { validatePlan, type ImplementationPlan, type SliceStatus } from "./plan";
import { alignmentDocumentSchema, requirementProfileSchema, type AlignmentDocument, type RequirementProfile } from "./profile";

export { readProject, saveProject, type ProjectConfigV2, type ResolvedProject };
const OPERATION_TYPES = ["git-sync", "git-commit", "git-push", "github-pr", "linear-issue", "linear-state", "dependency-update"] as const;
export interface OperationDefinition { id: string; type: typeof OPERATION_TYPES[number]; target: string; intentDigest: string }
export interface OperationReceipt { target: string; intentDigest: string; reference: string }
export interface RunOperation extends OperationDefinition {
	status: "prepared" | "dispatched" | "unknown" | "settled";
	ownerEpoch: number;
	configDigest: string;
	inputRevision: number;
	approvalDigest: string | null;
	failureReason: string | null;
	outcome: "applied" | "not-applied" | null;
	receipt: OperationReceipt | null;
}

export interface HostBinding {
	processInstanceId: string;
	sessionId: string;
	contextEpoch: number;
}
export interface RunContext {
	project?: ResolvedProject | null;
	repo: PreparedWorktree;
	runId: string;
	buildId: string;
	methodDigest?: string | null;
	mode: "owner" | "inspect";
	binding: HostBinding;
}
export interface RunOwner extends HostBinding {
	epoch: number;
	cleanRelease?: boolean | undefined;
}
export interface RunCandidate {
	digest: string;
	revision: number;
	scope: string;
	contentPath: string;
	configDigest: string;
	inputRevision: number;
}
export interface ProofRecord {
	kind: ProofKind;
	name: string;
	worktree: string;
	base: string;
	head: string;
	candidateDigest: string;
	configDigest: string;
	inputRevision: number;
	detail: string;
}
export interface GrillingRecord {
	decided: BoundaryDecision[];
	open: BoundaryCategory[];
}
export type GateKind = "plan-approval" | "knowledge-approval" | "checkpoint-review" | "amendment-approval" | "delivery";
export interface GateToken {
	id: string;
	kind: GateKind;
	ownerEpoch: number;
	contextEpoch: number;
	gateRevision: number;
	candidateDigest: string;
}
export interface PendingGate {
	kind: GateKind;
	candidateDigest: string;
	afterSliceId?: string | null | undefined;
	summary?: string | null | undefined;
}
export interface PendingAmendment {
	candidate: RunCandidate;
	plan: ImplementationPlan;
	profile: RequirementProfile | null;
	alignmentDocPath: string | null;
	techDesignHtmlPath: string | null;
	readModelDigest: string | null;
	summary: string | null;
}
export interface ContextWrapUp {
	mode: "finalizing_slice" | "wrap_up";
	atPct: number;
	thresholdPct: number;
	latchedAtRevision: number;
	checkpointed: boolean;
}
export interface RunHandoff {
	updatedAtRevision: number;
	reason: "stage-boundary" | "between-slices" | "context-wrap-up" | "manual";
	activeSliceId: string | null;
	currentState: string;
	remainingInSlice: string | null;
	discoveries: string[];
	pendingQuestions: string[];
	lastVerification: string | null;
	gitHead: string | null;
	gitDirty: boolean;
}
export interface ColdReadProof {
	kind: "packet" | "alignment-doc";
	candidateDigest: string;
	readModelDigest: string;
	verdict: "PASS" | "FAIL_MISSING" | "FAIL_BLOAT";
	summary: string;
}
export interface AutoDeliverGrant {
	candidateDigest: string;
	declaredFiles: string[];
	grantedByHuman: true;
	revoked: boolean;
}
export interface DeliveryReceiptState {
	expectedRemoteTip: string | null;
	targetHead: string;
	repository: string;
	branch: string;
	prBase: string;
	steps: DeliveryStepStates;
	pr?: { number: number; url: string } | undefined;
}
export interface SyncContextState {
	preSyncHead: string;
	targetBase: string;
}
export type RequestIntent =
	| { kind: "task"; task: string }
	| { kind: "propose"; content: string; scope: string }
	| { kind: "knowledge"; path: string; reason: string; proposed: string }
	| { kind: "boundaries"; decided: BoundaryDecision[]; open: BoundaryCategory[] }
	| {
		kind: "plan";
		plan: ImplementationPlan;
		scope?: string;
		summary?: string;
		profile?: RequirementProfile;
		alignmentDoc?: AlignmentDocument;
	}
	| {
		kind: "plan.amend";
		plan: ImplementationPlan;
		scope?: string;
		summary?: string;
		profile?: RequirementProfile;
		alignmentDoc?: AlignmentDocument;
	}
	| {
		kind: "slice.update";
		sliceId: string;
		status: SliceStatus;
		commitSha?: string | null;
		testProof?: string | null;
		remaining?: string | null;
	}
	| {
		kind: "checkpoint";
		reason: "stage-boundary" | "between-slices" | "context-wrap-up" | "manual";
		activeSliceId: string | null;
		currentState: string;
		remainingInSlice?: string | null;
		discoveries?: string[];
		pendingQuestions?: string[];
		lastVerification?: string | null;
		gitHead?: string | null;
		gitDirty?: boolean;
	}
	| { kind: "ready_for_delivery"; summary?: string };

export interface OutboxRecord {
	runId: string;
	requestId: string;
	role: "executor";
	actor: RunOwner;
	ownerEpoch: number;
	revision: number;
	inputRevision: number;
	intentDigest: string;
	status: "consumed";
}
export interface ToolAttempt { toolCallId: string; effect: "read" | "write" | "spawn" }
export interface Admission { allow: boolean; reason: string; runId: string; revision: number | null; ownerEpoch: number | null }

export interface WorkspaceState {
	workspaceId: string | null;
	ownedByRun: boolean;
	launchNonce: string | null;
	verified: boolean;
	continuation: string;
	handoff: string;
}

export interface RunView {
	schemaVersion: 2;
	runId: string;
	repoIdentity: string;
	commonDir: string;
	worktree: string;
	branch: string;
	git: Pick<PreparedWorktree, "remote" | "prBase" | "privateStartRef" | "worktreeGitDir">;
	startSha: string;
	currentIntegrationSha: string;
	loadedBuildId: string;
	methodDigest: string | null;
	ownerEpoch: number;
	owner: RunOwner | null;
	ownerStatus: "self" | "other" | "unclaimed";
	revision: number;
	phase: "alignment" | "implementation" | "delivery" | "delivered";
	issue: string | null;
	issueId: string | null;
	workspace: WorkspaceState | null;
	initialTask: string | null;
	currentTask: string | null;
	knowledgeCandidate: { path: string; reason: string; proposed: string } | null;
	candidateRevision: number;
	candidate: RunCandidate | null;
	approvedScope: RunCandidate | null;
	project: ResolvedProject | null;
	operations: RunOperation[];
	lastIntentDigest: string | null;
	consumedIntents: string[];
	outbox: OutboxRecord | null;
	grilling: GrillingRecord | null;
	plan: ImplementationPlan | null;
	profile: RequirementProfile | null;
	alignmentDocPath: string | null;
	techDesignHtmlPath: string | null;
	gateToken: GateToken | null;
	pendingGate: PendingGate | null;
	midCheckpointAfterSliceId: string | null;
	midCheckpointCompleted: boolean;
	pendingAmendment: PendingAmendment | null;
	coldReadProof: ColdReadProof | null;
	autoDeliverGrant: AutoDeliverGrant | null;
	deliveryReceipt: DeliveryReceiptState | null;
	lastVerifiedCheckHead: string | null;
	syncContext: SyncContextState | null;
	contextWrapUp: ContextWrapUp | null;
	handoff: RunHandoff | null;
	proofs: ProofRecord[];
	historyProofs: ProofRecord[];
	deliveredAt: string | null;
	readiness: "ready" | "blocked";
	waitingReason: string | null;
	scopePolicyDigest: string;
	/** Alias kept for compatibility with callers reading configDigest. */
	configDigest: string;
	inputRevision: number;
}
type RunState = Omit<RunView, "ownerStatus" | "configDigest">;

export type RunInput =
	| { kind: "task"; task: string }
	| { kind: "propose"; content: string; scope: string }
	| { kind: "request.submit"; requestId: string; expectedRevision: number; intent: RequestIntent }
	| { kind: "approve"; source: "native-ui"; approved: true; runId: string; digest: string; candidateRevision: number; ownerEpoch: number; gateTokenId?: string }
	| { kind: "owner.authorize"; source: "native-ui"; approved: true; runId: string; digest: string; candidateRevision: number; ownerEpoch: number }
	| { kind: "rebind"; contextEpoch: number }
	| { kind: "context.handoff"; contextEpoch: number }
	| { kind: "context.wrapUp"; mode: "finalizing_slice" | "wrap_up"; atPct: number; thresholdPct: number }
	| { kind: "operation.prepare"; operation: OperationDefinition }
	| { kind: "operation.resume"; operationId: string; intentDigest: string }
	| { kind: "operation.dispatch"; operationId: string }
	| { kind: "operation.unknown"; operationId: string; reason: string }
	| { kind: "operation.settle"; operationId: string; outcome: "applied" | "not-applied"; receipt: OperationReceipt; boundIssue?: { identifier: string; id: string | null } }
	| { kind: "bindIssue"; issue: string; issueId?: string | null }
	| { kind: "workspace.record"; workspace: WorkspaceState | null }
	| { kind: "proof.record"; proof: ProofRecord }
	| { kind: "coldRead.record"; proof: ColdReadProof }
	| { kind: "techDesign.record"; alignmentDocPath: string; techDesignHtmlPath: string; candidateDigest?: string; readModelDigest?: string }
	| { kind: "amendment.record"; candidateDigest: string; alignmentDocPath: string; techDesignHtmlPath: string; readModelDigest: string }
	| { kind: "amendment.cancel" }
	| { kind: "cadence.set"; midCheckpointAfterSliceId: string | null }
	| { kind: "checkpoint.continue" }
	| { kind: "profile.override"; profile: RequirementProfile; autoDeliverGrant: AutoDeliverGrant | null }
	| { kind: "autoDeliver.revoke" }
	| { kind: "check.record"; head: string }
	| { kind: "delivery.checkpoint"; receipt: DeliveryReceiptState }
	| { kind: "sync.context"; syncContext: SyncContextState | null }
	| { kind: "beginDelivery" }
	| { kind: "returnToImplementation"; reason?: string }
	| { kind: "completeDelivery"; deliveredAt?: string }
	| { kind: "sync"; previousIntegrationSha: string; newIntegrationSha: string }
	| { kind: "restore" };
export interface RunOutcome { view: Readonly<RunView> }

const runIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const locatorSchema = z.object({ schemaVersion: z.literal(1), runId: runIdSchema, commonDir: z.string() }).strict();
const bindingSchema = z.object({ processInstanceId: z.string().min(1), sessionId: z.string().min(1), contextEpoch: z.number().int().nonnegative() }).strict();
const ownerSchema = bindingSchema.extend({ epoch: z.number().int().positive(), cleanRelease: z.boolean().optional() }).strict();
const requestIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const boundaryCategorySchema = z.enum(["goals", "non-goals", "business-boundary", "error-path", "acceptance"]);
const grillingSchema = z.object({
	decided: z.array(z.object({ category: boundaryCategorySchema, answer: z.string().min(1) }).strict()).max(8),
	open: z.array(boundaryCategorySchema).max(8),
}).strict();
const proofSchema = z.object({
	kind: z.enum(["check", "review"]),
	name: z.string().min(1).max(200),
	worktree: z.string().min(1),
	base: z.string().regex(/^[a-f0-9]{40}$/),
	head: z.string().regex(/^[a-f0-9]{40}$/),
	candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
	configDigest: z.string(),
	inputRevision: z.number().int().positive(),
	detail: z.string().max(4000),
}).strict();
const sliceStatusSchema = z.enum(["pending", "in_progress", "partial", "done"]);
const planSliceSchema = z.object({
	id: z.string().min(1),
	behavior: z.string().min(1),
	test: z.string().min(1),
	dependsOn: z.array(z.string()),
	status: sliceStatusSchema.optional(),
	commitSha: z.string().nullable().optional(),
	testProof: z.string().nullable().optional(),
	remaining: z.string().nullable().optional(),
}).strict();
const planSchema = z.object({
	activities: z.array(z.object({ kind: z.enum(["prototype", "research", "spec", "ticket", "wizard"]), seam: z.string().min(1), reason: z.string().min(1) }).strict()).max(8),
	slices: z.array(planSliceSchema).min(1).max(64),
	invariant: z.string(),
}).strict();

const requestIntentSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("task"), task: z.string().min(1) }).strict(),
	z.object({ kind: z.literal("propose"), content: z.string().min(1), scope: z.string().min(1) }).strict(),
	z.object({ kind: z.literal("knowledge"), path: z.string().min(1).max(512), reason: z.string().min(1).max(4000), proposed: z.string().max(131072) }).strict(),
	z.object({ kind: z.literal("boundaries"), decided: grillingSchema.shape.decided, open: grillingSchema.shape.open }).strict(),
	z.object({
		kind: z.literal("plan"),
		plan: planSchema,
		scope: z.string().min(1).optional(),
		summary: z.string().min(1).optional(),
		profile: requirementProfileSchema.optional(),
		alignmentDoc: alignmentDocumentSchema.optional(),
	}).strict(),
	z.object({
		kind: z.literal("plan.amend"),
		plan: planSchema,
		scope: z.string().min(1).optional(),
		summary: z.string().min(1).optional(),
		profile: requirementProfileSchema.optional(),
		alignmentDoc: alignmentDocumentSchema.optional(),
	}).strict(),
	z.object({
		kind: z.literal("slice.update"),
		sliceId: z.string().min(1),
		status: sliceStatusSchema,
		commitSha: z.string().nullable().optional(),
		testProof: z.string().nullable().optional(),
		remaining: z.string().max(1000).nullable().optional(),
	}).strict(),
	z.object({
		kind: z.literal("checkpoint"),
		reason: z.enum(["stage-boundary", "between-slices", "context-wrap-up", "manual"]),
		activeSliceId: z.string().nullable(),
		currentState: z.string().min(1).max(1000),
		remainingInSlice: z.string().max(1000).nullable().optional(),
		discoveries: z.array(z.string().max(400)).max(12).optional(),
		pendingQuestions: z.array(z.string().max(400)).max(8).optional(),
		lastVerification: z.string().max(500).nullable().optional(),
		gitHead: z.string().nullable().optional(),
		gitDirty: z.boolean().optional(),
	}).strict(),
	z.object({ kind: z.literal("ready_for_delivery"), summary: z.string().max(4000).optional() }).strict(),
]);

const outboxSchema = z.object({
	runId: runIdSchema, requestId: requestIdSchema, role: z.literal("executor"),
	actor: bindingSchema.extend({ epoch: z.number().int().positive() }), ownerEpoch: z.number().int().positive(),
	revision: z.number().int().nonnegative(), inputRevision: z.number().int().positive(),
	intentDigest: z.string().regex(/^[a-f0-9]{64}$/), status: z.literal("consumed"),
}).strict();
const candidateSchema = z.object({
	digest: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive(),
	scope: z.string(), contentPath: z.string(), configDigest: z.string(), inputRevision: z.number().int().positive(),
}).strict();

const operationDefinitionSchema = z.object({
	id: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/),
	type: z.enum(OPERATION_TYPES),
	target: z.string().min(1).max(2048),
	intentDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const operationReceiptSchema = z.object({ target: z.string(), intentDigest: z.string(), reference: z.string().min(1).max(4096) }).strict();
const operationSchema: z.ZodType<RunOperation> = operationDefinitionSchema.extend({
	status: z.enum(["prepared", "dispatched", "unknown", "settled"]),
	ownerEpoch: z.number().int().positive(),
	configDigest: z.string(),
	inputRevision: z.number().int().positive(),
	approvalDigest: z.string().nullable(),
	failureReason: z.string().nullable(),
	outcome: z.enum(["applied", "not-applied"]).nullable(),
	receipt: operationReceiptSchema.nullable(),
}).strict();

const workspaceSchema: z.ZodType<WorkspaceState> = z.object({
	workspaceId: z.string().nullable(),
	ownedByRun: z.boolean(),
	launchNonce: z.string().nullable(),
	verified: z.boolean(),
	continuation: z.string(),
	handoff: z.string(),
}).strict();

const gateKindSchema = z.enum(["plan-approval", "knowledge-approval", "checkpoint-review", "amendment-approval", "delivery"]);
const gateTokenSchema: z.ZodType<GateToken> = z.object({
	id: z.string().min(1),
	kind: gateKindSchema,
	ownerEpoch: z.number().int().nonnegative(),
	contextEpoch: z.number().int().nonnegative(),
	gateRevision: z.number().int().nonnegative(),
	candidateDigest: z.string(),
}).strict();
const pendingGateSchema: z.ZodType<PendingGate> = z.object({
	kind: gateKindSchema,
	candidateDigest: z.string(),
	afterSliceId: z.string().nullable().optional(),
	summary: z.string().nullable().optional(),
}).strict();
const contextWrapUpSchema: z.ZodType<ContextWrapUp> = z.object({
	mode: z.enum(["finalizing_slice", "wrap_up"]),
	atPct: z.number().min(0).max(100),
	thresholdPct: z.number().min(0).max(100),
	latchedAtRevision: z.number().int().nonnegative(),
	checkpointed: z.boolean(),
}).strict();

const handoffSchema: z.ZodType<RunHandoff> = z.object({
	updatedAtRevision: z.number().int().nonnegative(),
	reason: z.enum(["stage-boundary", "between-slices", "context-wrap-up", "manual"]),
	activeSliceId: z.string().nullable(),
	currentState: z.string(),
	remainingInSlice: z.string().nullable(),
	discoveries: z.array(z.string()),
	pendingQuestions: z.array(z.string()),
	lastVerification: z.string().nullable(),
	gitHead: z.string().nullable(),
	gitDirty: z.boolean(),
}).strict();

const coldReadProofSchema: z.ZodType<ColdReadProof> = z.object({
	kind: z.enum(["packet", "alignment-doc"]),
	candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
	readModelDigest: z.string().regex(/^[a-f0-9]{64}$/),
	verdict: z.enum(["PASS", "FAIL_MISSING", "FAIL_BLOAT"]),
	summary: z.string().max(4000),
}).strict();

const autoDeliverGrantSchema: z.ZodType<AutoDeliverGrant> = z.object({
	candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
	declaredFiles: z.array(z.string().min(1)).max(256),
	grantedByHuman: z.literal(true),
	revoked: z.boolean(),
}).strict();

const deliveryStepStatusSchema = z.enum(["not-started", "in-flight", "settled"]);
const deliveryReceiptStateSchema: z.ZodType<DeliveryReceiptState> = z.object({
	expectedRemoteTip: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
	targetHead: z.string().regex(/^[a-f0-9]{40}$/),
	repository: z.string().min(1),
	branch: z.string().min(1),
	prBase: z.string().min(1),
	steps: z.object({
		push: deliveryStepStatusSchema,
		pr: deliveryStepStatusSchema,
		linearState: deliveryStepStatusSchema,
		linearComment: deliveryStepStatusSchema,
		prNumber: z.number().int().positive().optional(),
		prUrl: z.string().min(1).optional(),
	}).strict(),
	pr: z.object({ number: z.number().int().positive(), url: z.string().min(1) }).strict().optional(),
}).strict();

const syncContextSchema: z.ZodType<SyncContextState> = z.object({
	preSyncHead: z.string().regex(/^[a-f0-9]{40}$/),
	targetBase: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();

const resolvedProjectSchema: z.ZodType<ResolvedProject, z.ZodTypeDef, unknown> = z.object({
	config: projectConfigSchemaV2,
	revision: z.number().int().nonnegative(),
	policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
	legacyV1: z.boolean(),
}).strict();
const stateSchemaV2: z.ZodType<RunState, z.ZodTypeDef, unknown> = z.object({
	schemaVersion: z.literal(2),
	runId: runIdSchema,
	repoIdentity: z.string(),
	commonDir: z.string(),
	worktree: z.string(),
	branch: z.string(),
	git: z.object({ remote: z.string(), prBase: z.string(), privateStartRef: z.string(), worktreeGitDir: z.string() }).strict(),
	startSha: z.string(),
	currentIntegrationSha: z.string(),
	loadedBuildId: z.string(),
	methodDigest: z.string().nullable(),
	ownerEpoch: z.number().int().nonnegative(),
	owner: ownerSchema.nullable(),
	revision: z.number().int().nonnegative(),
	phase: z.enum(["alignment", "implementation", "delivery", "delivered"]),
	issue: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/).nullable(),
	issueId: z.string().nullable(),
	workspace: workspaceSchema.nullable(),
	initialTask: z.string().max(1200).nullable().default(null),
	currentTask: z.string().nullable(),
	knowledgeCandidate: z.object({ path: z.string().min(1).max(512), reason: z.string().min(1).max(4000), proposed: z.string().max(131072) }).strict().nullable(),
	candidateRevision: z.number().int().nonnegative(),
	candidate: candidateSchema.nullable(),
	approvedScope: candidateSchema.nullable(),
	project: resolvedProjectSchema.nullable(),
	operations: z.array(operationSchema).max(128),
	lastIntentDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
	consumedIntents: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(64),
	outbox: outboxSchema.nullable(),
	grilling: grillingSchema.nullable(),
	plan: planSchema.nullable(),
	profile: requirementProfileSchema.nullable(),
	alignmentDocPath: z.string().nullable(),
	techDesignHtmlPath: z.string().nullable(),
	gateToken: gateTokenSchema.nullable(),
	pendingGate: pendingGateSchema.nullable().default(null),
	midCheckpointAfterSliceId: z.string().nullable().default(null),
	midCheckpointCompleted: z.boolean().default(false),
	pendingAmendment: z.object({
		candidate: candidateSchema,
		plan: planSchema,
		profile: requirementProfileSchema.nullable(),
		alignmentDocPath: z.string().nullable(),
		techDesignHtmlPath: z.string().nullable(),
		readModelDigest: z.string().nullable(),
		summary: z.string().nullable(),
	}).strict().nullable().default(null),
	coldReadProof: coldReadProofSchema.nullable(),
	autoDeliverGrant: autoDeliverGrantSchema.nullable().default(null),
	deliveryReceipt: deliveryReceiptStateSchema.nullable().default(null),
	lastVerifiedCheckHead: z.string().regex(/^[a-f0-9]{40}$/).nullable().default(null),
	syncContext: syncContextSchema.nullable().default(null),
	contextWrapUp: contextWrapUpSchema.nullable(),
	handoff: handoffSchema.nullable(),
	proofs: z.array(proofSchema).max(64),
	historyProofs: z.array(proofSchema).max(256),
	deliveredAt: z.string().nullable(),
	readiness: z.enum(["ready", "blocked"]),
	waitingReason: z.string().nullable(),
	scopePolicyDigest: z.string(),
	inputRevision: z.number().int().positive(),
}).strict();

const inputSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("task"), task: z.string().min(1) }).strict(),
	z.object({ kind: z.literal("propose"), content: z.string().min(1), scope: z.string().min(1) }).strict(),
	z.object({ kind: z.literal("request.submit"), requestId: requestIdSchema, expectedRevision: z.number().int().nonnegative(), intent: requestIntentSchema }).strict(),
	z.object({ kind: z.literal("approve"), source: z.literal("native-ui"), approved: z.literal(true), runId: z.string().min(1), digest: z.string(), candidateRevision: z.number().int(), ownerEpoch: z.number().int(), gateTokenId: z.string().optional() }).strict(),
	z.object({ kind: z.literal("owner.authorize"), source: z.literal("native-ui"), approved: z.literal(true), runId: z.string().min(1), digest: z.string(), candidateRevision: z.number().int(), ownerEpoch: z.number().int() }).strict(),
	z.object({ kind: z.literal("rebind"), contextEpoch: z.number().int().nonnegative() }).strict(),
	z.object({ kind: z.literal("context.handoff"), contextEpoch: z.number().int().nonnegative() }).strict(),
	z.object({ kind: z.literal("context.wrapUp"), mode: z.enum(["finalizing_slice", "wrap_up"]), atPct: z.number().min(0).max(100), thresholdPct: z.number().min(0).max(100) }).strict(),
	z.object({ kind: z.literal("operation.prepare"), operation: operationDefinitionSchema }).strict(),
	z.object({ kind: z.literal("operation.resume"), operationId: z.string(), intentDigest: z.string() }).strict(),
	z.object({ kind: z.literal("operation.dispatch"), operationId: z.string() }).strict(),
	z.object({ kind: z.literal("operation.unknown"), operationId: z.string(), reason: z.string().min(1).max(4096) }).strict(),
	z.object({
		kind: z.literal("operation.settle"), operationId: z.string(), outcome: z.enum(["applied", "not-applied"]), receipt: operationReceiptSchema,
		boundIssue: z.object({ identifier: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/), id: z.string().nullable() }).strict().optional(),
	}).strict(),
	z.object({ kind: z.literal("proof.record"), proof: proofSchema }).strict(),
	z.object({ kind: z.literal("coldRead.record"), proof: coldReadProofSchema }).strict(),
	z.object({ kind: z.literal("techDesign.record"), alignmentDocPath: z.string().min(1), techDesignHtmlPath: z.string().min(1), candidateDigest: z.string().optional(), readModelDigest: z.string().optional() }).strict(),
	z.object({ kind: z.literal("amendment.record"), candidateDigest: z.string().regex(/^[a-f0-9]{64}$/), alignmentDocPath: z.string().min(1), techDesignHtmlPath: z.string().min(1), readModelDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
	z.object({ kind: z.literal("amendment.cancel") }).strict(),
	z.object({ kind: z.literal("cadence.set"), midCheckpointAfterSliceId: z.string().min(1).nullable() }).strict(),
	z.object({ kind: z.literal("checkpoint.continue") }).strict(),
	z.object({ kind: z.literal("profile.override"), profile: requirementProfileSchema, autoDeliverGrant: autoDeliverGrantSchema.nullable() }).strict(),
	z.object({ kind: z.literal("autoDeliver.revoke") }).strict(),
	z.object({ kind: z.literal("check.record"), head: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
	z.object({ kind: z.literal("delivery.checkpoint"), receipt: deliveryReceiptStateSchema }).strict(),
	z.object({ kind: z.literal("sync.context"), syncContext: syncContextSchema.nullable() }).strict(),
	z.object({ kind: z.literal("beginDelivery") }).strict(),
	z.object({ kind: z.literal("returnToImplementation"), reason: z.string().optional() }).strict(),
	z.object({ kind: z.literal("completeDelivery"), deliveredAt: z.string().optional() }).strict(),
	z.object({ kind: z.literal("bindIssue"), issue: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/), issueId: z.string().nullable().optional() }).strict(),
	z.object({ kind: z.literal("workspace.record"), workspace: workspaceSchema.nullable() }).strict(),
	z.object({ kind: z.literal("sync"), previousIntegrationSha: z.string().regex(/^[a-f0-9]{40}$/), newIntegrationSha: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
	z.object({ kind: z.literal("restore") }).strict(),
]);

export class RunBusyError extends Error {
	constructor() { super("This run has an active owner; inspect it without taking over."); this.name = "RunBusyError"; }
}
export class RunOwnershipError extends Error {
	constructor() { super("This action does not belong to the active run owner and context."); this.name = "RunOwnershipError"; }
}
export class RunStateSchemaError extends Error {
	constructor(readonly path: string, readonly found: unknown) {
		super(`run state at ${path} has unsupported schemaVersion ${JSON.stringify(found)}; this build reads schema 1 or 2 and refuses to guess`);
		this.name = "RunStateSchemaError";
	}
}

function missing(error: unknown): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function digest(content: string): string { return sha256Hex(content); }

function proposalBody(scopePolicyDigest: string, inputRevision: number, content: string, scope: string): string {
	return JSON.stringify({ content, scope, configDigest: scopePolicyDigest, inputRevision }) + "\n";
}

async function sealMaterial(directory: string, body: string): Promise<{ digest: string; path: string }> {
	const hash = digest(body);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, hash + ".json");
	await writeAtomic(path, body);
	return { digest: hash, path };
}

function readLocator(path: string): z.infer<typeof locatorSchema> | null {
	try { return locatorSchema.parse(JSON.parse(readFileSync(path, "utf8"))); }
	catch (error) { if (missing(error)) return null; throw error; }
}

function migrateV1ToV2(raw: Record<string, unknown>): RunState {
	const oldPlan = raw.plan as ImplementationPlan | null;
	const migratedPlan: ImplementationPlan | null = oldPlan
		? {
			...oldPlan,
			slices: oldPlan.slices.map(s => ({
				...s,
				status: s.status ?? "pending",
				commitSha: s.commitSha ?? null,
				testProof: s.testProof ?? null,
				remaining: s.remaining ?? null,
			})),
		}
		: null;
	const oldWs = raw.workspace as { workspaceId: string | null; verified: boolean; continuation: string; handoff: string } | null;
	const oldProject = raw.project as {
		revision?: number;
		digest?: string;
		defaults?: {
			git: { remote: string; startRef: string; prBase: string; worktreeRoot: string };
			github: { repository: string };
			linear?: { teamId: string; statusMapping: { inReview: string } } | null;
			knowledge?: { entryPaths: string[] };
		};
	} | null;
	const migratedProject: ResolvedProject | null = oldProject?.defaults
		? {
			config: projectConfigSchemaV2.parse({
				schemaVersion: 2,
				revision: oldProject.revision ?? 1,
				git: {
					prBase: oldProject.defaults.git.prBase,
					remote: oldProject.defaults.git.remote,
					startRef: oldProject.defaults.git.startRef,
					worktreeRoot: oldProject.defaults.git.worktreeRoot,
				},
				github: { repository: oldProject.defaults.github.repository },
				linear: oldProject.defaults.linear
					? {
						mode: "required",
						teamId: oldProject.defaults.linear.teamId,
						reviewState: oldProject.defaults.linear.statusMapping.inReview,
					}
					: null,
				knowledge: oldProject.defaults.knowledge,
			}),
			revision: oldProject.revision ?? 1,
			policyDigest: oldProject.digest ?? digest(JSON.stringify(oldProject.defaults)),
			legacyV1: true,
		}
		: null;
	return stateSchemaV2.parse({
		schemaVersion: 2,
		runId: raw.runId,
		repoIdentity: raw.repoIdentity,
		commonDir: raw.commonDir,
		worktree: raw.worktree,
		branch: raw.branch,
		git: raw.git,
		startSha: raw.startSha,
		currentIntegrationSha: raw.currentIntegrationSha,
		loadedBuildId: raw.loadedBuildId,
		methodDigest: null,
		ownerEpoch: raw.ownerEpoch,
		owner: raw.owner ? { ...raw.owner, cleanRelease: false } : null,
		revision: raw.revision,
		phase: raw.phase,
		issue: raw.issue ?? null,
		issueId: null,
		workspace: oldWs ? { ...oldWs, ownedByRun: Boolean(oldWs.workspaceId && oldWs.verified), launchNonce: null } : null,
		initialTask: null,
		currentTask: raw.currentTask ?? null,
		knowledgeCandidate: raw.knowledgeCandidate ?? null,
		candidateRevision: raw.candidateRevision ?? 0,
		candidate: raw.candidate ?? null,
		approvedScope: raw.approvedScope ?? null,
		project: migratedProject,
		operations: raw.operations ?? [],
		lastIntentDigest: raw.lastIntentDigest ?? null,
		consumedIntents: raw.consumedIntents ?? [],
		outbox: raw.outbox ?? null,
		grilling: raw.grilling ?? null,
		plan: migratedPlan,
		profile: null,
		alignmentDocPath: null,
		techDesignHtmlPath: null,
		gateToken: null,
		pendingGate: null,
		midCheckpointAfterSliceId: null,
		midCheckpointCompleted: false,
		pendingAmendment: null,
		coldReadProof: null,
		autoDeliverGrant: null,
		deliveryReceipt: null,
		lastVerifiedCheckHead: null,
		syncContext: null,
		contextWrapUp: null,
		handoff: null,
		proofs: (raw.proofs as ProofRecord[] | undefined) ?? [],
		historyProofs: raw.proofs ?? [],
		deliveredAt: null,
		readiness: raw.readiness,
		waitingReason: raw.waitingReason ?? null,
		scopePolicyDigest: raw.configDigest,
		inputRevision: raw.inputRevision,
	});
}

export function readRunState(path: string): RunState | null {
	let raw: unknown;
	try { raw = JSON.parse(readFileSync(path, "utf8")); }
	catch (error) { if (missing(error)) return null; throw error; }
	const version = raw !== null && typeof raw === "object" && "schemaVersion" in raw ? (raw as { schemaVersion: unknown }).schemaVersion : undefined;
	if (version === 1) return migrateV1ToV2(raw as Record<string, unknown>);
	if (version !== 2) throw new RunStateSchemaError(path, version);
	return stateSchemaV2.parse(raw);
}

function sameBinding(owner: RunOwner | null, binding: HostBinding): boolean {
	return owner !== null && owner.processInstanceId === binding.processInstanceId
		&& owner.sessionId === binding.sessionId && owner.contextEpoch === binding.contextEpoch;
}

export function locateRun(location: RepositoryLocation): { runId: string; repo: PreparedWorktree } | null {
	const locator = readLocator(join(location.worktreeGitDir, "omp-feat-flow.json"));
	if (!locator) return null;
	if (locator.commonDir !== location.commonDir) throw new Error("Worktree locator points to another repository.");
	const state = readRunState(join(location.commonDir, "omp-feat-flow", "runs", locator.runId, "state.json"));
	if (!state || state.runId !== locator.runId || state.repoIdentity !== location.repoIdentity
		|| state.commonDir !== location.commonDir || state.worktree !== location.repo || state.branch !== location.branch
		|| state.git.worktreeGitDir !== location.worktreeGitDir) throw new Error("The locator does not identify this actual Git worktree; no authority was inherited.");
	return {
		runId: state.runId,
		repo: {
			runId: state.runId, repo: location.repo, repoIdentity: state.repoIdentity, commonDir: state.commonDir,
			worktree: state.worktree, worktreeGitDir: state.git.worktreeGitDir, branch: state.branch,
			remote: state.git.remote, prBase: state.git.prBase, privateStartRef: state.git.privateStartRef,
			startSha: state.startSha, currentIntegrationSha: state.currentIntegrationSha,
		},
	};
}

export interface ProvisionInput {
	repo: PreparedWorktree;
	runId: string;
	buildId: string;
	methodDigest?: string | null;
	project?: ResolvedProject | null;
	workspace?: WorkspaceState | null;
	issue?: string | null;
	issueId?: string | null;
	initialTask?: string | null;
	skipLock?: boolean;
}
/**
 * Provision a run worktree state without acquiring its RunOwner lease (`owner: null`).
 * Used when a launcher (e.g. main checkout -> cmux workspace or non-cmux handoff) initializes a run for a child top-level session to claim.
 */
export async function provisionRun(input: ProvisionInput): Promise<RunState> {
	runIdSchema.parse(input.runId);
	if (input.repo.runId !== input.runId) throw new Error("Prepared worktree belongs to a different run.");
	const writeProvisioned = async (): Promise<RunState> => {
		const runDirectory = join(input.repo.commonDir, "omp-feat-flow", "runs", input.runId);
		await mkdir(runDirectory, { recursive: true, mode: 0o700 });
		const statePath = join(runDirectory, "state.json");
		const locatorPath = join(input.repo.worktreeGitDir, "omp-feat-flow.json");
		if (readRunState(statePath) || readLocator(locatorPath)) {
			throw new Error("This worktree already has a run; open it instead of provisioning again.");
		}
		const project = input.project === undefined ? readProject(input.repo.commonDir) : input.project;
		if (project && (effectiveRemote(project.config) !== input.repo.remote || project.config.git.prBase !== input.repo.prBase)) {
			throw new Error("Project snapshot does not match the prepared run.");
		}
		const scopePolicyDigest = digest(JSON.stringify({
			repoIdentity: input.repo.repoIdentity,
			projectDigest: project?.policyDigest ?? null,
			remote: input.repo.remote,
			prBase: input.repo.prBase,
		}));
		const state: RunState = stateSchemaV2.parse({
			schemaVersion: 2,
			runId: input.runId,
			repoIdentity: input.repo.repoIdentity,
			commonDir: input.repo.commonDir,
			worktree: input.repo.worktree,
			branch: input.repo.branch,
			git: { remote: input.repo.remote, prBase: input.repo.prBase, privateStartRef: input.repo.privateStartRef, worktreeGitDir: input.repo.worktreeGitDir },
			startSha: input.repo.startSha,
			currentIntegrationSha: input.repo.currentIntegrationSha,
			loadedBuildId: input.buildId,
			methodDigest: input.methodDigest ?? null,
			ownerEpoch: 0,
			owner: null,
			revision: 1,
			phase: "alignment",
			issue: input.issue ?? null,
			issueId: input.issueId ?? null,
			workspace: input.workspace ?? null,
			initialTask: input.initialTask ?? null,
			currentTask: null,
			knowledgeCandidate: null,
			candidateRevision: 0,
			candidate: null,
			approvedScope: null,
			project: project ?? null,
			operations: [],
			lastIntentDigest: null,
			consumedIntents: [],
			outbox: null,
			grilling: null,
			plan: null,
			profile: null,
			alignmentDocPath: null,
			techDesignHtmlPath: null,
			gateToken: null,
			pendingGate: null,
			midCheckpointAfterSliceId: null,
			midCheckpointCompleted: false,
			pendingAmendment: null,
			coldReadProof: null,
			autoDeliverGrant: null,
			deliveryReceipt: null,
			lastVerifiedCheckHead: null,
			syncContext: null,
			contextWrapUp: null,
			handoff: null,
			proofs: [],
			historyProofs: [],
			deliveredAt: null,
			readiness: "ready",
			waitingReason: null,
			scopePolicyDigest,
			inputRevision: 1,
		});
		await writeAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
		await writeAtomic(locatorPath, JSON.stringify({ schemaVersion: 1, runId: input.runId, commonDir: input.repo.commonDir }) + "\n");
		return state;
	};
	if (input.skipLock) return writeProvisioned();
	const lockPath = join(input.repo.commonDir, "omp-feat-flow", "provisioning.lock");
	await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
	return withFileLock(lockPath, writeProvisioned, { retries: 50, retryDelayMs: 10 });
}

/** Update workspace metadata on disk under state lock without acquiring an owner lease. */
export async function recordProvisionedWorkspace(commonDir: string, runId: string, workspace: WorkspaceState | null): Promise<void> {
	runIdSchema.parse(runId);
	const statePath = join(commonDir, "omp-feat-flow", "runs", runId, "state.json");
	await withFileLock(statePath, async () => {
		const state = readRunState(statePath);
		if (!state) return;
		state.workspace = workspace;
		state.revision += 1;
		await writeAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
	}, { retries: 50, retryDelayMs: 10 });
}

export class RunKernel {
	readonly #context: RunContext;
	readonly #statePath: string;
	readonly #ownerPath: string;
	#lease: FileLockHandle | null;
	#ownerEpoch = 0;
	#storageFailed = false;
	#authorizedScopeDigest: string | null = null;
	#binding: HostBinding;

	private constructor(context: RunContext, statePath: string, ownerPath: string, lease: FileLockHandle | null) {
		this.#context = context; this.#statePath = statePath; this.#ownerPath = ownerPath; this.#lease = lease;
		this.#binding = bindingSchema.parse(context.binding);
	}

	static async open(context: RunContext): Promise<RunKernel> {
		runIdSchema.parse(context.runId);
		if (context.repo.runId !== context.runId) throw new Error("Prepared worktree belongs to a different run.");
		bindingSchema.parse(context.binding);
		const runDirectory = join(context.repo.commonDir, "omp-feat-flow", "runs", context.runId);
		if (context.mode === "owner") await mkdir(runDirectory, { recursive: true, mode: 0o700 });
		const statePath = join(runDirectory, "state.json");
		const ownerPath = join(runDirectory, "owner");
		const lease = context.mode === "owner" ? tryAcquireFileLock(ownerPath) : null;
		if (context.mode === "owner" && !lease) throw new RunBusyError();
		const kernel = new RunKernel(context, statePath, ownerPath, lease);
		try {
			if (context.mode === "inspect") {
				if (!readRunState(statePath)) throw new Error("Run not found.");
			} else {
				const locatorPath = join(context.repo.worktreeGitDir, "omp-feat-flow.json");
				const locator = readLocator(locatorPath);
				if (locator && (locator.runId !== context.runId || locator.commonDir !== context.repo.commonDir)) {
					throw new Error("This worktree already locates a different run.");
				}
				await withFileLock(statePath, async () => {
					const rawBefore = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) as { schemaVersion?: unknown } : null;
					if (rawBefore?.schemaVersion === 1) {
						const bakPath = join(runDirectory, "state.v1.bak.json");
						if (!existsSync(bakPath)) await writeAtomic(bakPath, readFileSync(statePath, "utf8"));
					}
					const previous = readRunState(statePath);
					const state = previous ?? kernel.#initialState();
					if (state.runId !== context.runId || state.commonDir !== context.repo.commonDir
						|| state.worktree !== context.repo.worktree || state.branch !== context.repo.branch
						|| state.startSha !== context.repo.startSha || state.git.worktreeGitDir !== context.repo.worktreeGitDir
						|| state.git.remote !== context.repo.remote || state.git.prBase !== context.repo.prBase
						|| state.git.privateStartRef !== context.repo.privateStartRef) {
						throw new Error("Run identity does not match this worktree.");
					}
					let autoAuthorizedScope: string | null = null;
					if (previous) {
						for (const operation of state.operations) {
							if (operation.status === "dispatched") {
								operation.status = "unknown";
								operation.failureReason = "Previous owner ended before settlement.";
							}
						}
						const hasUnsettled = state.operations.some(op => op.status === "dispatched" || op.status === "unknown");
						// Decision B: On a dedicated single-user feat-flow worktree, any clean release with 0 unsettled ops
						// and intact materials auto-claims implementation authority regardless of sessionId.
						const isCleanResume = previous.owner !== null
							&& previous.owner.cleanRelease === true
							&& !hasUnsettled;
						const awaitingClaim = previous.owner === null && !hasUnsettled;
						let materialOk = true;
						try {
							if (state.candidate) kernel.#verifyMaterial(state.candidate);
							if (state.approvedScope && state.approvedScope.digest !== state.candidate?.digest) {
								kernel.#verifyMaterial(state.approvedScope);
							}
							if (state.pendingAmendment) kernel.#verifyMaterial(state.pendingAmendment.candidate);
						} catch {
							materialOk = false;
						}
						if ((awaitingClaim || isCleanResume) && materialOk) {
							state.readiness = "ready";
							state.waitingReason = null;
							if (state.approvedScope) autoAuthorizedScope = state.approvedScope.digest;
						} else {
							state.readiness = "blocked";
							state.waitingReason = hasUnsettled ? "operation-result-unknown" : "owner-recovery";
						}
					}
					state.ownerEpoch += 1;
					state.owner = { ...context.binding, epoch: state.ownerEpoch, cleanRelease: false };
					// Re-mint gateToken from durable pendingGate on reopen so restarts/session switches never erase pending gates!
					if (!state.pendingGate) {
						if (state.knowledgeCandidate) {
							state.pendingGate = { kind: "knowledge-approval", candidateDigest: digest(JSON.stringify(state.knowledgeCandidate)), afterSliceId: null, summary: null };
						} else if (state.phase === "alignment" && state.candidate && !state.approvedScope) {
							state.pendingGate = { kind: "plan-approval", candidateDigest: state.candidate.digest, afterSliceId: null, summary: state.candidate.scope };
						}
					}
					state.gateToken = state.pendingGate
						? {
							id: `gate-${state.pendingGate.kind}-${state.revision + 1}-${state.pendingGate.candidateDigest.slice(0, 12)}`,
							kind: state.pendingGate.kind,
							ownerEpoch: state.ownerEpoch,
							contextEpoch: context.binding.contextEpoch,
							gateRevision: state.revision + 1,
							candidateDigest: state.pendingGate.candidateDigest,
						}
						: null;
					state.loadedBuildId = context.buildId;
					state.revision += 1;
					if (!locator) await writeAtomic(locatorPath, JSON.stringify({ schemaVersion: 1, runId: context.runId, commonDir: context.repo.commonDir }) + "\n");
					await writeAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
					kernel.#ownerEpoch = state.ownerEpoch;
					kernel.#authorizedScopeDigest = autoAuthorizedScope;
				}, { retries: 50, retryDelayMs: 10 });
			}
			return kernel;
		} catch (error) { lease?.release(); throw error; }
	}

	static async create(context: RunContext): Promise<RunKernel> {
		runIdSchema.parse(context.runId);
		if (context.repo.runId !== context.runId) throw new Error("Prepared worktree belongs to a different run.");
		bindingSchema.parse(context.binding);
		const runDirectory = join(context.repo.commonDir, "omp-feat-flow", "runs", context.runId);
		await mkdir(runDirectory, { recursive: true, mode: 0o700 });
		const statePath = join(runDirectory, "state.json");
		const ownerPath = join(runDirectory, "owner");
		const lease = tryAcquireFileLock(ownerPath);
		if (!lease) throw new RunBusyError();
		const kernel = new RunKernel(context, statePath, ownerPath, lease);
		try {
			const locatorPath = join(context.repo.worktreeGitDir, "omp-feat-flow.json");
			await withFileLock(statePath, async () => {
				if (readRunState(statePath) || readLocator(locatorPath)) throw new Error("This worktree already has a run; open it instead of starting again.");
				const state = kernel.#initialState();
				state.ownerEpoch = 1;
				state.owner = { ...context.binding, epoch: 1, cleanRelease: false };
				state.revision = 1;
				await writeAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
				await writeAtomic(locatorPath, JSON.stringify({ schemaVersion: 1, runId: context.runId, commonDir: context.repo.commonDir }) + "\n");
				kernel.#ownerEpoch = 1;
			}, { retries: 50, retryDelayMs: 10 });
			return kernel;
		} catch (error) { lease.release(); throw error; }
	}

	#initialState(): RunState {
		const { repo, runId, buildId, methodDigest } = this.#context;
		const project = this.#context.project === undefined ? readProject(repo.commonDir) : this.#context.project;
		if (project && (effectiveRemote(project.config) !== repo.remote || project.config.git.prBase !== repo.prBase)) {
			throw new Error("Project snapshot does not match the prepared run.");
		}
		const scopePolicyDigest = digest(JSON.stringify({
			repoIdentity: repo.repoIdentity,
			projectDigest: project?.policyDigest ?? null,
			remote: repo.remote,
			prBase: repo.prBase,
		}));
		return {
			schemaVersion: 2,
			runId,
			repoIdentity: repo.repoIdentity,
			commonDir: repo.commonDir,
			worktree: repo.worktree,
			branch: repo.branch,
			startSha: repo.startSha,
			workspace: null,
			git: { remote: repo.remote, prBase: repo.prBase, privateStartRef: repo.privateStartRef, worktreeGitDir: repo.worktreeGitDir },
			currentIntegrationSha: repo.currentIntegrationSha,
			loadedBuildId: buildId,
			methodDigest: methodDigest ?? null,
			lastIntentDigest: null,
			consumedIntents: [],
			knowledgeCandidate: null,
			outbox: null,
			grilling: null,
			plan: null,
			profile: null,
			alignmentDocPath: null,
			techDesignHtmlPath: null,
			gateToken: null,
			pendingGate: null,
			midCheckpointAfterSliceId: null,
			midCheckpointCompleted: false,
			pendingAmendment: null,
			coldReadProof: null,
			autoDeliverGrant: null,
			deliveryReceipt: null,
			lastVerifiedCheckHead: null,
			syncContext: null,
			contextWrapUp: null,
			handoff: null,
			proofs: [],
			historyProofs: [],
			deliveredAt: null,
			ownerEpoch: 0,
			owner: null,
			revision: 0,
			phase: "alignment",
			issue: null,
			issueId: null,
			initialTask: null,
			currentTask: null,
			candidateRevision: 0,
			candidate: null,
			approvedScope: null,
			project: project ?? null,
			operations: [],
			readiness: "ready",
			waitingReason: null,
			scopePolicyDigest,
			inputRevision: 1,
		};
	}

	#read(): RunState {
		const state = readRunState(this.#statePath);
		if (!state) throw new Error("Run state is missing; writes are blocked.");
		return state;
	}

	#owned(state: RunState, binding: HostBinding): void {
		if (!this.#lease || this.#storageFailed || state.ownerEpoch !== this.#ownerEpoch || !sameBinding(state.owner, binding)) {
			throw new RunOwnershipError();
		}
	}

	async #propose(state: RunState, content: string, scope: string, kind: "plan-approval" | "delivery" = "plan-approval"): Promise<void> {
		const body = proposalBody(state.scopePolicyDigest, state.inputRevision, content, scope);
		let material: { digest: string; path: string };
		try { material = await sealMaterial(join(dirname(this.#statePath), "materials"), body); }
		catch (error) { this.#storageFailed = true; throw error; }
		state.candidateRevision += 1;
		state.candidate = {
			digest: material.digest,
			contentPath: material.path,
			revision: state.candidateRevision,
			scope,
			configDigest: state.scopePolicyDigest,
			inputRevision: state.inputRevision,
		};
		state.approvedScope = null;
		state.phase = "alignment";
		state.pendingGate = {
			kind,
			candidateDigest: material.digest,
			afterSliceId: null,
			summary: scope,
		};
		state.gateToken = {
			id: `gate-${state.candidateRevision}-${material.digest.slice(0, 12)}`,
			kind,
			ownerEpoch: state.ownerEpoch,
			contextEpoch: state.owner?.contextEpoch ?? 0,
			gateRevision: state.revision + 1,
			candidateDigest: material.digest,
		};
	}

	#verifyMaterial(candidate: RunCandidate): void {
		if (candidate.contentPath !== join(dirname(this.#statePath), "materials", candidate.digest + ".json")
			|| digest(readFileSync(candidate.contentPath, "utf8")) !== candidate.digest) {
			throw new Error("A bound candidate material is missing or changed.");
		}
	}

	inspect(): Readonly<RunView> {
		const state = this.#read();
		const ownerStatus = this.#lease && state.ownerEpoch === this.#ownerEpoch && sameBinding(state.owner, this.#binding)
			? "self" : isFileLockHeld(this.#ownerPath) ? "other" : "unclaimed";
		let reason = this.#storageFailed ? "durable-state-write-failed" : state.waitingReason;
		if (!this.#storageFailed && state.approvedScope && this.#authorizedScopeDigest !== state.approvedScope.digest
			&& !state.operations.some(operation => operation.status === "dispatched" || operation.status === "unknown")) {
			reason = "owner-authorization-required";
		}
		try {
			if (state.candidate) this.#verifyMaterial(state.candidate);
			if (state.approvedScope && state.approvedScope.digest !== state.candidate?.digest) this.#verifyMaterial(state.approvedScope);
			if (state.pendingAmendment) this.#verifyMaterial(state.pendingAmendment.candidate);
		} catch { reason = "bound-material-unavailable"; }
		return { ...state, ownerStatus, configDigest: state.scopePolicyDigest, readiness: reason ? "blocked" : state.readiness, waitingReason: reason };
	}
	#deliveryEvidence(state: RunState): boolean {
		const scope = state.approvedScope;
		if (!scope) return false;
		return state.proofs.some(proof => proof.kind === "review" && proof.worktree === state.worktree
			&& proof.base === state.currentIntegrationSha
			&& proof.candidateDigest === scope.digest && proof.configDigest === state.scopePolicyDigest
			&& proof.inputRevision === state.inputRevision);
	}

	admit(attempt: ToolAttempt, binding: HostBinding): Admission {
		let state: RunState | undefined;
		let reason = "run-state-unavailable";
		try {
			state = this.#read();
			this.#owned(state, binding);
			if (state.readiness !== "ready") reason = state.waitingReason ?? "recovery-not-ready";
			else if (attempt.effect === "read") reason = "allowed";
			else if (attempt.effect === "write" && state.phase === "implementation" && state.approvedScope) {
				this.#verifyMaterial(state.approvedScope);
				reason = (state.gateToken !== null || state.pendingGate !== null) ? "gate-pending"
					: this.#authorizedScopeDigest !== state.approvedScope.digest ? "owner-authorization-required"
						: state.approvedScope.configDigest === state.scopePolicyDigest && state.approvedScope.inputRevision === state.inputRevision
							? "allowed" : "approval-object-changed";
			} else reason = "scope-not-approved";
		} catch (error) {
			reason = this.#storageFailed ? "durable-state-write-failed"
				: error instanceof RunOwnershipError ? "owner-or-context-mismatch" : "bound-material-or-state-unavailable";
		}
		return { allow: reason === "allowed", reason, runId: this.#context.runId, revision: state?.revision ?? null, ownerEpoch: state?.ownerEpoch ?? null };
	}

	async apply(input: RunInput, binding: HostBinding): Promise<RunOutcome> {
		const request = inputSchema.parse(input);
		let certificate: string | null | undefined;
		let durableMutation = false;
		await withFileLock(this.#statePath, async () => {
			const state = this.#read();
			this.#owned(state, binding);
			let rebound: HostBinding | undefined;
			switch (request.kind) {
				case "task": state.currentTask = request.task; break;
				case "propose": {
					let corruptApproved = false;
					if (state.approvedScope) {
						try { this.#verifyMaterial(state.approvedScope); } catch { corruptApproved = true; }
					}
					if (!corruptApproved && (state.phase !== "alignment" || state.approvedScope || (state.pendingGate && state.pendingGate.kind !== "plan-approval"))) {
						throw new Error("Proposals are only permitted during unapproved alignment without a non-plan gate.");
					}
					await this.#propose(state, request.content, request.scope);
					break;
				}
				case "request.submit": {
					if (state.readiness !== "ready") throw new Error("Recovery is blocked; a model request cannot bypass it.");
					if (request.expectedRevision !== state.revision) throw new Error("This model request observed a stale revision; inspect the run and submit it again.");
					const intent = request.intent;
					const intentDigest = digest(JSON.stringify(intent));
					const repeat = intent.kind === "task" ? state.currentTask === intent.task
						: intent.kind === "propose"
							? state.candidate?.digest === digest(proposalBody(state.scopePolicyDigest, state.inputRevision, intent.content, intent.scope))
							: state.consumedIntents.includes(intentDigest);
					if (state.outbox?.requestId === request.requestId || repeat) {
						throw new Error("An identical model request was already consumed; no further advance is permitted.");
					}
					if (intent.kind === "task") {
						state.currentTask = intent.task;
					} else if (intent.kind === "knowledge") {
						if (state.pendingGate) throw new Error(`Cannot request knowledge approval while gate "${state.pendingGate.kind}" is pending.`);
						state.knowledgeCandidate = { path: intent.path, reason: intent.reason, proposed: intent.proposed };
						const kDigest = digest(JSON.stringify(state.knowledgeCandidate));
						state.pendingGate = { kind: "knowledge-approval", candidateDigest: kDigest, afterSliceId: null, summary: intent.path };
						state.gateToken = {
							id: `gate-knowledge-${state.revision + 1}`,
							kind: "knowledge-approval",
							ownerEpoch: state.ownerEpoch,
							contextEpoch: state.owner?.contextEpoch ?? 0,
							gateRevision: state.revision + 1,
							candidateDigest: kDigest,
						};
					} else if (intent.kind === "boundaries") {
						if (state.phase !== "alignment" || state.approvedScope) throw new Error("Boundaries can only change while the design is unapproved.");
						if (state.pendingGate) throw new Error(`Cannot change boundaries while gate "${state.pendingGate.kind}" is pending.`);
						state.grilling = { decided: intent.decided, open: intent.open };
						state.plan = null;
					} else if (intent.kind === "plan") {
						if (state.phase !== "alignment" || state.approvedScope) throw new Error("Plan can only change while the design is unapproved.");
						if (state.pendingGate && state.pendingGate.kind !== "plan-approval") {
							throw new Error(`Cannot submit plan while gate "${state.pendingGate.kind}" is pending.`);
						}
						if (!state.grilling || state.grilling.open.length > 0) {
							if (intent.profile?.tier === "small") {
								state.grilling = {
									decided: [
										{ category: "goals", answer: intent.summary ?? intent.plan.invariant },
										{ category: "non-goals", answer: "Scoped strictly to declared small fix files." },
										{ category: "business-boundary", answer: intent.scope ?? "Single small requirement" },
										{ category: "error-path", answer: "Preserve existing fail-closed guards." },
										{ category: "acceptance", answer: intent.plan.slices.map(s => s.test).join("; ") },
									],
									open: [],
								};
							} else {
								throw new Error("A plan needs every boundary resolved first.");
							}
						}
						validatePlan(intent.plan);
						state.plan = {
							...intent.plan,
							slices: intent.plan.slices.map(s => ({
								...s,
								status: s.status ?? "pending",
								commitSha: s.commitSha ?? null,
								testProof: s.testProof ?? null,
								remaining: s.remaining ?? null,
							})),
						};
						if (intent.profile) state.profile = intent.profile;
						// If inline plan also provides scope + summary (or alignmentDoc), seal candidate directly (eliminating double propose step).
						if (intent.scope && (intent.summary || intent.alignmentDoc)) {
							const payloadContent = JSON.stringify({
								summary: intent.summary ?? intent.alignmentDoc?.tldr ?? "",
								decisions: state.grilling.decided,
								plan: state.plan,
								profile: state.profile,
								alignmentDoc: intent.alignmentDoc ?? null,
							}, null, 2);
							await this.#propose(state, payloadContent, intent.scope, "plan-approval");
						}
					} else if (intent.kind === "plan.amend") {
						if (state.phase !== "implementation" || !state.approvedScope || !state.plan) {
							throw new Error("Plan amendments are only permitted during approved implementation.");
						}
						if (state.pendingGate && state.pendingGate.kind !== "checkpoint-review" && state.pendingGate.kind !== "amendment-approval") {
							throw new Error(`Cannot amend plan while gate "${state.pendingGate.kind}" is pending.`);
						}
						validatePlan(intent.plan);
						const doneSlices = state.plan.slices.filter(s => s.status === "done");
						if (intent.plan.slices.length < doneSlices.length) {
							throw new Error(`Amended plan must preserve all ${doneSlices.length} completed slice(s) verbatim at its prefix.`);
						}
						for (let i = 0; i < doneSlices.length; i += 1) {
							const prev = doneSlices[i]!;
							const next = intent.plan.slices[i]!;
							const depsMatch = prev.dependsOn.length === next.dependsOn.length
								&& prev.dependsOn.every((dep, idx) => dep === next.dependsOn[idx]);
							if (prev.id !== next.id || prev.behavior !== next.behavior || prev.test !== next.test || !depsMatch) {
								throw new Error(`Cannot rewrite completed slice "${prev.id}" in plan.amend; preserve completed slices verbatim.`);
							}
						}
						const stagedSlices = intent.plan.slices.map((s, idx) => {
							const donePrev = idx < doneSlices.length ? doneSlices[idx]! : null;
							return donePrev
								? {
									...s,
									status: "done" as const,
									commitSha: donePrev.commitSha ?? null,
									testProof: donePrev.testProof ?? null,
									remaining: donePrev.remaining ?? null,
								}
								: {
									...s,
									status: "pending" as const,
									commitSha: null,
									testProof: null,
									remaining: null,
								};
						});
						const stagedPlan: ImplementationPlan = { ...intent.plan, slices: stagedSlices };
						const stagedProfile = intent.profile ?? state.profile;
						const scopeStr = intent.scope ?? state.approvedScope.scope;
						const summaryStr = intent.summary ?? intent.alignmentDoc?.tldr ?? state.pendingAmendment?.summary ?? scopeStr;
						const payloadContent = JSON.stringify({
							amendment: true,
							summary: summaryStr,
							decisions: state.grilling?.decided ?? [],
							plan: stagedPlan,
							profile: stagedProfile,
							alignmentDoc: intent.alignmentDoc ?? null,
						}, null, 2);
						const body = proposalBody(state.scopePolicyDigest, state.inputRevision, payloadContent, scopeStr);
						let material: { digest: string; path: string };
						try { material = await sealMaterial(join(dirname(this.#statePath), "materials"), body); }
						catch (error) { this.#storageFailed = true; throw error; }
						state.candidateRevision += 1;
						const cand: RunCandidate = {
							digest: material.digest,
							contentPath: material.path,
							revision: state.candidateRevision,
							scope: scopeStr,
							configDigest: state.scopePolicyDigest,
							inputRevision: state.inputRevision,
						};
						// Keep approvedScope, state.plan, state.profile, and active artifacts untouched until human approves!
						state.candidate = cand;
						state.pendingAmendment = {
							candidate: cand,
							plan: stagedPlan,
							profile: stagedProfile,
							alignmentDocPath: null,
							techDesignHtmlPath: null,
							readModelDigest: null,
							summary: summaryStr,
						};
						state.pendingGate = {
							kind: "amendment-approval",
							candidateDigest: cand.digest,
							afterSliceId: null,
							summary: summaryStr,
						};
						state.gateToken = {
							id: `gate-amend-${state.candidateRevision}-${cand.digest.slice(0, 12)}`,
							kind: "amendment-approval",
							ownerEpoch: state.ownerEpoch,
							contextEpoch: state.owner?.contextEpoch ?? 0,
							gateRevision: state.revision + 1,
							candidateDigest: cand.digest,
						};
					} else if (intent.kind === "slice.update") {
						if (state.phase !== "implementation" || !state.plan) throw new Error("Slices can only update during implementation with an active plan.");
						if (state.pendingGate) throw new Error(`Cannot update slices while gate "${state.pendingGate.kind}" is pending.`);
						const sliceIdx = state.plan.slices.findIndex(s => s.id === intent.sliceId);
						if (sliceIdx < 0) throw new Error(`Unknown slice: ${intent.sliceId}`);
						const slice = state.plan.slices[sliceIdx]!;
						const firstIncompleteIdx = state.plan.slices.findIndex(s => s.status !== "done");
						if (intent.status === "done") {
							if (firstIncompleteIdx >= 0 && sliceIdx !== firstIncompleteIdx) {
								const expectedId = state.plan.slices[firstIncompleteIdx]!.id;
								throw new Error(`Slices must complete sequentially; finish slice "${expectedId}" before marking "${intent.sliceId}" done.`);
							}
							if (intent.commitSha) {
								const duplicateCommit = state.plan.slices.some(other => other.id !== slice.id && other.status === "done" && other.commitSha === intent.commitSha);
								if (duplicateCommit) {
									throw new Error(`Slice ${intent.sliceId} cannot reuse commit ${intent.commitSha.slice(0, 12)} already claimed by another slice.`);
								}
							}
						}
						slice.status = intent.status;
						if (intent.commitSha !== undefined) slice.commitSha = intent.commitSha;
						if (intent.testProof !== undefined) slice.testProof = intent.testProof;
						if (intent.remaining !== undefined) slice.remaining = intent.remaining;
						state.currentTask = intent.status === "done" ? null : intent.sliceId;
						if (intent.status === "done" && state.midCheckpointAfterSliceId === slice.id && !state.midCheckpointCompleted && state.approvedScope) {
							const hasRemaining = state.plan.slices.some(s => s.status !== "done");
							if (hasRemaining) {
								state.pendingGate = {
									kind: "checkpoint-review",
									candidateDigest: state.approvedScope.digest,
									afterSliceId: slice.id,
									summary: `Mid-implementation checkpoint after slice ${slice.id}`,
								};
								state.gateToken = {
									id: `gate-checkpoint-${state.revision + 1}-${slice.id}`,
									kind: "checkpoint-review",
									ownerEpoch: state.ownerEpoch,
									contextEpoch: state.owner?.contextEpoch ?? 0,
									gateRevision: state.revision + 1,
									candidateDigest: state.approvedScope.digest,
								};
							} else {
								state.midCheckpointCompleted = true;
							}
						}
					} else if (intent.kind === "checkpoint") {
						state.handoff = {
							updatedAtRevision: state.revision + 1,
							reason: intent.reason,
							activeSliceId: intent.activeSliceId,
							currentState: intent.currentState,
							remainingInSlice: intent.remainingInSlice ?? null,
							discoveries: intent.discoveries ?? [],
							pendingQuestions: intent.pendingQuestions ?? [],
							lastVerification: intent.lastVerification ?? null,
							gitHead: intent.gitHead ?? null,
							gitDirty: intent.gitDirty ?? false,
						};
						if (state.contextWrapUp) state.contextWrapUp.checkpointed = true;
					} else if (intent.kind === "ready_for_delivery") {
						if (state.phase !== "implementation" || !state.approvedScope) throw new Error("Delivery readiness requires an active implementation.");
						if (state.pendingGate) throw new Error(`Cannot request delivery while gate "${state.pendingGate.kind}" is pending.`);
						if (state.plan && state.plan.slices.some(s => s.status !== "done")) {
							throw new Error("All planned slices must be done before requesting delivery.");
						}
						state.pendingGate = {
							kind: "delivery",
							candidateDigest: state.approvedScope.digest,
							afterSliceId: null,
							summary: intent.summary ?? null,
						};
						state.gateToken = {
							id: `gate-delivery-${state.revision + 1}`,
							kind: "delivery",
							ownerEpoch: state.ownerEpoch,
							contextEpoch: state.owner?.contextEpoch ?? 0,
							gateRevision: state.revision + 1,
							candidateDigest: state.approvedScope.digest,
						};
					} else {
						if (state.phase !== "alignment" || state.approvedScope || (state.pendingGate && state.pendingGate.kind !== "plan-approval")) {
							throw new Error("Proposals are only permitted during unapproved alignment without a non-plan gate.");
						}
						await this.#propose(state, intent.content, intent.scope);
					}
					state.outbox = {
						runId: state.runId, requestId: request.requestId, role: "executor",
						actor: { ...binding, epoch: state.ownerEpoch }, ownerEpoch: state.ownerEpoch,
						revision: request.expectedRevision, inputRevision: state.inputRevision,
						intentDigest, status: "consumed",
					};
					state.lastIntentDigest = intentDigest;
					state.consumedIntents = [...state.consumedIntents, intentDigest].slice(-64);
					break;
				}
				case "approve": {
					if (state.readiness !== "ready" || request.runId !== state.runId || request.ownerEpoch !== state.ownerEpoch) {
						throw new Error("This native approval is stale or recovery is blocked.");
					}
					if (state.gateToken && request.gateTokenId && (state.gateToken.id !== request.gateTokenId
						|| state.gateToken.ownerEpoch !== state.ownerEpoch
						|| state.gateToken.contextEpoch !== binding.contextEpoch)) {
						throw new Error("Gate token epoch mismatch; re-inspect the current candidate.");
					}
					const gateKind = state.pendingGate?.kind ?? state.gateToken?.kind
						?? (state.knowledgeCandidate ? "knowledge-approval" : "plan-approval");
					if (gateKind === "knowledge-approval") {
						const knowledge = state.knowledgeCandidate;
						if (!knowledge || request.digest !== digest(JSON.stringify(knowledge))) {
							throw new Error("This knowledge approval is stale: the diff changed while you were deciding.");
						}
						const root = realpathSync(resolve(state.worktree));
						const target = resolve(join(root, knowledge.path));
						if (!target.startsWith(root + sep)) throw new Error(`${knowledge.path} escapes the project root.`);
						let probe = target;
						while (probe !== root && probe !== dirname(probe)) {
							try {
								lstatSync(probe);
								const realTarget = realpathSync(probe);
								if (realTarget !== root && !realTarget.startsWith(root + sep)) {
									throw new Error(`${knowledge.path} escapes the project root via symlink.`);
								}
								break;
							} catch (err) {
								if (!missing(err)) throw err;
							}
							probe = dirname(probe);
						}
						await mkdir(dirname(target), { recursive: true, mode: 0o700 });
						await writeAtomic(target, knowledge.proposed);
						state.knowledgeCandidate = null;
						state.pendingGate = null;
						if (state.gateToken?.kind === "knowledge-approval") state.gateToken = null;
						break;
					}
					if (gateKind === "amendment-approval") {
						const amend = state.pendingAmendment;
						if (state.phase !== "implementation" || !amend
							|| request.digest !== amend.candidate.digest || request.candidateRevision !== amend.candidate.revision) {
							throw new Error("This amendment approval is stale or missing.");
						}
						this.#verifyMaterial(amend.candidate);
						state.approvedScope = amend.candidate;
						state.candidate = amend.candidate;
						state.plan = amend.plan;
						if (amend.profile) state.profile = amend.profile;
						if (amend.alignmentDocPath) state.alignmentDocPath = amend.alignmentDocPath;
						if (amend.techDesignHtmlPath) state.techDesignHtmlPath = amend.techDesignHtmlPath;
						if (state.autoDeliverGrant && state.autoDeliverGrant.candidateDigest !== amend.candidate.digest) {
							state.autoDeliverGrant = { ...state.autoDeliverGrant, revoked: true };
						}
						if (state.midCheckpointAfterSliceId) {
							const ckSlice = state.plan.slices.find(s => s.id === state.midCheckpointAfterSliceId);
							if (ckSlice && ckSlice.status !== "done") {
								state.midCheckpointCompleted = false;
							} else {
								state.midCheckpointCompleted = true;
							}
						}
						state.pendingAmendment = null;
						state.pendingGate = null;
						state.gateToken = null;
						break;
					}
					if (gateKind !== "plan-approval") {
						throw new Error(`Gate "${gateKind}" cannot be resolved via design approve.`);
					}
					if (state.phase !== "alignment") {
						throw new Error(`Cannot approve design while run is in phase "${state.phase}".`);
					}
					if (!state.candidate || request.digest !== state.candidate.digest || request.candidateRevision !== state.candidate.revision) {
						throw new Error("This native approval is stale or recovery is blocked.");
					}
					this.#verifyMaterial(state.candidate);
					state.approvedScope = state.candidate;
					state.phase = "implementation";
					state.pendingGate = null;
					state.gateToken = null;
					break;
				}
				case "owner.authorize": {
					const scope = state.approvedScope;
					const candidateOk = Boolean(state.candidate && (state.candidate.digest === scope?.digest || state.pendingAmendment?.candidate.digest === state.candidate.digest));
					if (state.readiness !== "blocked" || (state.waitingReason !== "owner-recovery" && state.waitingReason !== "context-rebind")
						|| state.phase === "alignment" || !scope || !candidateOk
						|| request.runId !== state.runId || request.ownerEpoch !== state.ownerEpoch
						|| request.digest !== scope.digest || request.candidateRevision !== scope.revision
						|| scope.configDigest !== state.scopePolicyDigest || scope.inputRevision !== state.inputRevision
						|| state.operations.some(operation => operation.status === "dispatched" || operation.status === "unknown")) {
						throw new Error("Current native owner authorization is stale or recovery still has unresolved facts.");
					}
					this.#verifyMaterial(scope);
					state.readiness = "ready"; state.waitingReason = null;
					break;
				}
				case "workspace.record": {
					state.workspace = request.workspace;
					break;
				}
				case "bindIssue": {
					if (state.issue && state.issue !== request.issue) throw new Error(`This run already delivers ${state.issue}.`);
					state.issue = request.issue;
					if (request.issueId !== undefined) state.issueId = request.issueId;
					break;
				}
				case "beginDelivery": {
					if (state.phase !== "implementation" || !state.approvedScope) throw new Error("Delivery starts only from an approved implementation.");
					if (state.pendingGate && state.pendingGate.kind !== "delivery") {
						throw new Error(`Cannot enter delivery while gate "${state.pendingGate.kind}" is pending.`);
					}
					if (!this.#deliveryEvidence(state)) {
						throw new Error("Delivery needs a review proof recorded for the current worktree and integration base.");
					}
					state.phase = "delivery";
					state.pendingGate = null;
					state.gateToken = null;
					break;
				}
				case "returnToImplementation": {
					if (state.phase !== "delivery" || !state.approvedScope) throw new Error("Can only return from delivery to approved implementation.");
					state.phase = "implementation";
					break;
				}
				case "completeDelivery": {
					if (state.phase !== "delivery") throw new Error("Can only complete delivery from delivery phase.");
					state.phase = "delivered";
					state.deliveredAt = request.deliveredAt ?? new Date().toISOString();
					state.pendingGate = null;
					state.gateToken = null;
					break;
				}
				case "rebind": {
					if (request.contextEpoch <= binding.contextEpoch) throw new Error("Context generation must advance.");
					rebound = { ...binding, contextEpoch: request.contextEpoch };
					state.ownerEpoch += 1;
					state.owner = { ...rebound, epoch: state.ownerEpoch, cleanRelease: false };
					if (state.gateToken) {
						state.gateToken = { ...state.gateToken, ownerEpoch: state.ownerEpoch, contextEpoch: rebound.contextEpoch };
					}
					state.readiness = "blocked";
					state.waitingReason = "context-rebind";
					break;
				}
				case "context.handoff": {
					if (request.contextEpoch <= binding.contextEpoch) throw new Error("Context generation must advance.");
					if (state.readiness !== "ready" || (state.approvedScope && this.#authorizedScopeDigest !== state.approvedScope.digest)) {
						throw new Error("Cannot seamlessly hand off context from an unauthorized or blocked state.");
					}
					if (state.operations.some(op => op.status === "dispatched" || op.status === "unknown")) {
						throw new Error("Cannot seamlessly hand off context while external operations remain unsettled.");
					}
					if (state.candidate) this.#verifyMaterial(state.candidate);
					if (state.approvedScope && state.approvedScope.digest !== state.candidate?.digest) this.#verifyMaterial(state.approvedScope);
					rebound = { ...binding, contextEpoch: request.contextEpoch };
					state.ownerEpoch += 1;
					state.owner = { ...rebound, epoch: state.ownerEpoch, cleanRelease: false };
					if (state.gateToken) {
						state.gateToken = { ...state.gateToken, ownerEpoch: state.ownerEpoch, contextEpoch: rebound.contextEpoch };
					}
					state.contextWrapUp = null;
					state.readiness = "ready";
					state.waitingReason = null;
					if (state.approvedScope) certificate = state.approvedScope.digest;
					break;
				}
				case "context.wrapUp": {
					state.contextWrapUp = {
						mode: request.mode,
						atPct: request.atPct,
						thresholdPct: request.thresholdPct,
						latchedAtRevision: state.revision + 1,
						checkpointed: false,
					};
					break;
				}
				case "operation.prepare": {
					if (state.operations.length >= 128) throw new Error("Run operation budget exhausted; no history was discarded.");
					if (state.operations.some(operation => operation.id === request.operation.id || (operation.type === request.operation.type
						&& operation.target === request.operation.target && (operation.status !== "settled"
							|| (operation.outcome === "applied" && operation.intentDigest === request.operation.intentDigest))))) {
						throw new Error("This operation already exists or requires reconciliation.");
					}
					state.operations.push({
						...request.operation, status: "prepared", ownerEpoch: state.ownerEpoch,
						configDigest: state.scopePolicyDigest, inputRevision: state.inputRevision, approvalDigest: state.approvedScope?.digest ?? null,
						failureReason: null, outcome: null, receipt: null,
					});
					break;
				}
				case "operation.resume": {
					const operation = state.operations.find(item => item.id === request.operationId);
					if (!operation || operation.status !== "prepared" || operation.intentDigest !== request.intentDigest
						|| operation.configDigest !== state.scopePolicyDigest || operation.inputRevision !== state.inputRevision
						|| operation.approvalDigest !== (state.approvedScope?.digest ?? null)) {
						throw new Error("Only an unchanged, definitely unstarted operation may resume.");
					}
					operation.ownerEpoch = state.ownerEpoch;
					break;
				}
				case "operation.dispatch": {
					if (state.readiness !== "ready") throw new Error("Restore readiness before dispatching an operation.");
					const operation = state.operations.find(item => item.id === request.operationId);
					if (!operation || operation.status !== "prepared" || operation.ownerEpoch !== state.ownerEpoch
						|| operation.configDigest !== state.scopePolicyDigest || operation.inputRevision !== state.inputRevision
						|| operation.approvalDigest !== (state.approvedScope?.digest ?? null)
						|| state.operations.some(item => item.status === "dispatched" || item.status === "unknown")) {
						throw new Error("Operation cannot dispatch: identity changed, already dispatched, or reconciliation is pending.");
					}
					operation.status = "dispatched";
					state.readiness = "blocked"; state.waitingReason = "operation-in-flight";
					break;
				}
				case "operation.unknown": {
					const operation = state.operations.find(item => item.id === request.operationId);
					if (!operation || operation.status !== "dispatched") throw new Error("Only an unsettled dispatched operation can become unknown.");
					operation.status = "unknown"; operation.failureReason = request.reason;
					state.readiness = "blocked"; state.waitingReason = "operation-result-unknown";
					break;
				}
				case "operation.settle": {
					const operation = state.operations.find(item => item.id === request.operationId);
					if (!operation || (operation.status !== "dispatched" && operation.status !== "unknown")
						|| operation.target !== request.receipt.target || operation.intentDigest !== request.receipt.intentDigest) {
						throw new Error("Settlement does not identify the outstanding owned operation.");
					}
					operation.status = "settled"; operation.outcome = request.outcome; operation.receipt = request.receipt; operation.failureReason = null;
					if (request.boundIssue && request.outcome === "applied") {
						if (state.issue && state.issue !== request.boundIssue.identifier) {
							throw new Error(`This run already delivers ${state.issue}.`);
						}
						state.issue = request.boundIssue.identifier;
						state.issueId = request.boundIssue.id;
					}
					if (!state.operations.some(item => item.status === "dispatched" || item.status === "unknown")) {
						state.readiness = "ready"; state.waitingReason = null;
					}
					break;
				}
				case "proof.record": {
					if (state.readiness !== "ready") throw new Error("Recovery is blocked; a proof cannot be recorded.");
					state.historyProofs = [...state.historyProofs, request.proof].slice(-256);
					state.proofs = [...state.proofs.filter(proof => !(proof.kind === request.proof.kind && proof.name === request.proof.name)),
						request.proof].slice(-64);
					break;
				}
				case "coldRead.record": {
					state.coldReadProof = request.proof;
					break;
				}
				case "techDesign.record": {
					if (request.candidateDigest && state.candidate?.digest !== request.candidateDigest) {
						throw new Error("Design artifact candidate mismatch; stale techDesign.record refused.");
					}
					state.alignmentDocPath = request.alignmentDocPath;
					state.techDesignHtmlPath = request.techDesignHtmlPath;
					break;
				}
				case "amendment.record": {
					if (!state.pendingAmendment || state.pendingAmendment.candidate.digest !== request.candidateDigest) {
						throw new Error("Amendment artifact candidate mismatch; stale amendment.record refused.");
					}
					state.pendingAmendment = {
						...state.pendingAmendment,
						alignmentDocPath: request.alignmentDocPath,
						techDesignHtmlPath: request.techDesignHtmlPath,
						readModelDigest: request.readModelDigest,
					};
					break;
				}
				case "amendment.cancel": {
					state.pendingAmendment = null;
					if (state.approvedScope) state.candidate = state.approvedScope;
					if (state.pendingGate?.kind === "amendment-approval") {
						const checkpointSliceDone = Boolean(
							state.midCheckpointAfterSliceId
							&& !state.midCheckpointCompleted
							&& state.plan?.slices.some(s => s.id === state.midCheckpointAfterSliceId && s.status === "done")
							&& state.plan.slices.some(s => s.status !== "done"),
						);
						if (checkpointSliceDone && state.approvedScope) {
							state.pendingGate = {
								kind: "checkpoint-review",
								candidateDigest: state.approvedScope.digest,
								afterSliceId: state.midCheckpointAfterSliceId!,
								summary: `Mid-implementation checkpoint after slice ${state.midCheckpointAfterSliceId!}`,
							};
							state.gateToken = {
								id: `gate-checkpoint-${state.revision + 1}-${state.midCheckpointAfterSliceId!}`,
								kind: "checkpoint-review",
								ownerEpoch: state.ownerEpoch,
								contextEpoch: state.owner?.contextEpoch ?? 0,
								gateRevision: state.revision + 1,
								candidateDigest: state.approvedScope.digest,
							};
						} else {
							state.pendingGate = null;
							state.gateToken = null;
						}
					}
					break;
				}
				case "cadence.set": {
					state.midCheckpointAfterSliceId = request.midCheckpointAfterSliceId;
					state.midCheckpointCompleted = false;
					break;
				}
				case "checkpoint.continue": {
					if (state.pendingGate?.kind !== "checkpoint-review") {
						throw new Error("No mid-implementation checkpoint is pending.");
					}
					state.midCheckpointCompleted = true;
					state.pendingGate = null;
					state.gateToken = null;
					break;
				}
				case "profile.override": {
					if (state.pendingAmendment && state.pendingGate?.kind === "amendment-approval") {
						state.pendingAmendment = { ...state.pendingAmendment, profile: request.profile };
					} else {
						state.profile = request.profile;
						state.autoDeliverGrant = request.autoDeliverGrant;
					}
					break;
				}
				case "autoDeliver.revoke": {
					if (state.autoDeliverGrant) state.autoDeliverGrant = { ...state.autoDeliverGrant, revoked: true };
					if (state.profile) state.profile = { ...state.profile, autoDeliver: false };
					break;
				}
				case "check.record": {
					state.lastVerifiedCheckHead = request.head;
					break;
				}
				case "delivery.checkpoint": {
					state.deliveryReceipt = request.receipt;
					break;
				}
				case "sync.context": {
					state.syncContext = request.syncContext;
					break;
				}
				case "sync": {
					if (request.previousIntegrationSha !== state.currentIntegrationSha) {
						throw new Error("The reviewed base changed; inspect the run before recording a sync.");
					}
					state.currentIntegrationSha = request.newIntegrationSha;
					break;
				}
				case "restore": {
					if (state.operations.some(operation => operation.status === "dispatched" || operation.status === "unknown")) {
						throw new Error("Reconcile outstanding effects before restoring writes.");
					}
					if (state.candidate) this.#verifyMaterial(state.candidate);
					if (state.approvedScope && state.approvedScope.digest !== state.candidate?.digest) this.#verifyMaterial(state.approvedScope);
					if (state.approvedScope && this.#authorizedScopeDigest !== state.approvedScope.digest) {
						throw new Error("Current owner authorization is required; the saved business scope is unchanged.");
					}
					state.readiness = "ready";
					state.waitingReason = null;
					break;
				}
			}
			state.revision += 1;
			try { await writeAtomic(this.#statePath, JSON.stringify(state, null, 2) + "\n"); }
			catch (error) { this.#storageFailed = true; throw error; }
			durableMutation = true;
			if (request.kind === "approve" || request.kind === "owner.authorize") certificate = state.approvedScope?.digest ?? null;
			else if (request.kind === "propose") certificate = null;
			if (rebound) { this.#binding = rebound; this.#ownerEpoch = state.ownerEpoch; }
		}, { retries: 50, retryDelayMs: 10 }).catch(error => {
			if (durableMutation) this.#storageFailed = true;
			throw error;
		});
		if (certificate !== undefined) this.#authorizedScopeDigest = certificate;
		return { view: this.inspect() };
	}

	async dispose(options?: { clean?: boolean }): Promise<void> {
		if (options?.clean && this.#lease && !this.#storageFailed) {
			await withFileLock(this.#statePath, async () => {
				const state = readRunState(this.#statePath);
				if (!state || !state.owner || state.ownerEpoch !== this.#ownerEpoch || !sameBinding(state.owner, this.#binding)) return;
				// P0-3: never mark cleanRelease for an unauthorized or blocked session (prevents authorization laundering).
				const hasUnsettled = state.operations.some(op => op.status === "dispatched" || op.status === "unknown");
				const authorized = !state.approvedScope || this.#authorizedScopeDigest === state.approvedScope.digest;
				if (state.readiness !== "ready" || hasUnsettled || !authorized) return;
				state.owner.cleanRelease = true;
				await writeAtomic(this.#statePath, JSON.stringify(state, null, 2) + "\n");
			}, { retries: 20, retryDelayMs: 10 }).catch(() => {});
		}
		this.#lease?.release();
		this.#lease = null;
	}
}

export function openRun(context: RunContext): Promise<RunKernel> { return RunKernel.open(context); }
