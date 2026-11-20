import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isFileLockHeld, tryAcquireFileLock, withFileLock, type FileLockHandle } from "@oh-my-pi/pi-utils/file-lock";
import { z } from "zod";
import type { PreparedWorktree, RepositoryLocation } from "./git";
import type { BoundaryCategory, BoundaryDecision } from "./grilling";
import { validatePlan, type ImplementationPlan } from "./plan";
import type { ProofKind } from "./evidence";

const projectDefaultsSchema = z.object({
  git: z.object({ remote: z.string().min(1), startRef: z.string().min(1), prBase: z.string().min(1), worktreeRoot: z.string().min(1) }).strict(),
  github: z.object({ host: z.string().regex(/^[a-zA-Z0-9.-]+$/), repository: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/) }).strict(),
  linear: z.object({ workspaceId: z.string().min(1), teamId: z.string().min(1),
    statusMapping: z.object({ inProgress: z.string().min(1), inReview: z.string().min(1), done: z.string().min(1) }).strict() }).strict(),
  models: z.object({ author: z.string().min(1), helper: z.string().min(1), reviewer: z.string().min(1) }).strict(),
  knowledge: z.object({ entryPaths: z.array(z.string().min(1)).max(64) }).strict(),
}).strict();
const projectSnapshotSchema = z.object({ schemaVersion: z.literal(1), revision: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/), defaults: projectDefaultsSchema }).strict();
export type ProjectDefaults = z.infer<typeof projectDefaultsSchema>;
export type ProjectSnapshot = z.infer<typeof projectSnapshotSchema>;

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
  project?: ProjectSnapshot;
  repo: PreparedWorktree;
  runId: string;
  buildId: string;
  mode: "owner" | "inspect";
  binding: HostBinding;
}
export interface RunOwner extends HostBinding { epoch: number }
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
export type RequestIntent =
	| { kind: "task"; task: string }
	| { kind: "propose"; content: string; scope: string }
	| { kind: "knowledge"; path: string; reason: string; proposed: string }
	| { kind: "boundaries"; decided: BoundaryDecision[]; open: BoundaryCategory[] }
	| { kind: "plan"; plan: ImplementationPlan };
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

export interface RunView {
  schemaVersion: 1;
  runId: string;
  repoIdentity: string;
  commonDir: string;
  worktree: string;
  branch: string;
  git: Pick<PreparedWorktree, "remote" | "prBase" | "privateStartRef" | "worktreeGitDir">;
  startSha: string;
  currentIntegrationSha: string;
  loadedBuildId: string;
  ownerEpoch: number;
  owner: RunOwner | null;
  ownerStatus: "self" | "other" | "unclaimed";
  revision: number;
  phase: "alignment" | "implementation" | "delivery";
  /** The one requirement issue this run delivers; never created implicitly. */
  issue: string | null;
  /** The owned cmux workspace, so a later session can still close what this run created. */
  workspace: { workspaceId: string | null; verified: boolean; continuation: string; handoff: string } | null;
  currentTask: string | null;
  /** A knowledge correction awaiting its own native approval; never applied without one. */
  knowledgeCandidate: { path: string; reason: string; proposed: string } | null;
  candidateRevision: number;
  candidate: RunCandidate | null;
  approvedScope: RunCandidate | null;
  project: ProjectSnapshot | null;
  operations: RunOperation[];
  outbox: OutboxRecord | null;
  /** The last applied model intent, so a replay with a new request id is refused rather than re-applied. */
  lastIntentDigest: string | null;
  /** A bounded history, so a replay after other requests is still recognised. */
  consumedIntents: string[];
  /** What the material already decided and what stays open; both entries converge here. */
  grilling: GrillingRecord | null;
  plan: ImplementationPlan | null;
  /** Evidence recorded against an exact worktree/base/head/candidate; never rewritten by a sync. */
  proofs: ProofRecord[];
  readiness: "ready" | "blocked";
  waitingReason: string | null;
  configDigest: string;
  inputRevision: number;
}
type RunState = Omit<RunView, "ownerStatus">;
export type RunInput =
  | { kind: "task"; task: string }
  | { kind: "propose"; content: string; scope: string }
  | { kind: "knowledge"; path: string; reason: string; proposed: string }
  | { kind: "request.submit"; requestId: string; expectedRevision: number; intent: RequestIntent }
  | { kind: "approve"; source: "native-ui"; approved: true; runId: string; digest: string; candidateRevision: number; ownerEpoch: number }
  | { kind: "owner.authorize"; source: "native-ui"; approved: true; runId: string; digest: string; candidateRevision: number; ownerEpoch: number }
  | { kind: "rebind"; contextEpoch: number }
  | { kind: "operation.prepare"; operation: OperationDefinition }
  | { kind: "operation.resume"; operationId: string; intentDigest: string }
  | { kind: "operation.dispatch"; operationId: string }
  | { kind: "operation.unknown"; operationId: string; reason: string }
  | { kind: "operation.settle"; operationId: string; outcome: "applied" | "not-applied"; receipt: OperationReceipt }
  | { kind: "beginDelivery" }
  | { kind: "bindIssue"; issue: string }
  | { kind: "workspace.record"; workspace: { workspaceId: string | null; verified: boolean; continuation: string; handoff: string } | null }
  | { kind: "proof.record"; proof: ProofRecord }
  | { kind: "sync"; previousIntegrationSha: string; newIntegrationSha: string }
  | { kind: "proof.record"; proof: ProofRecord }
  | { kind: "restore" };
export interface RunOutcome { view: Readonly<RunView> }

const runIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const locatorSchema = z.object({ schemaVersion: z.literal(1), runId: runIdSchema, commonDir: z.string() }).strict();
const bindingSchema = z.object({ processInstanceId: z.string().min(1), sessionId: z.string().min(1), contextEpoch: z.number().int().nonnegative() }).strict();
const requestIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const boundaryCategorySchema = z.enum(["goals", "non-goals", "business-boundary", "error-path", "acceptance"]);
const grillingSchema = z.object({ decided: z.array(z.object({ category: boundaryCategorySchema, answer: z.string().min(1) }).strict()).max(8),
  open: z.array(boundaryCategorySchema).max(8) }).strict();
const proofSchema = z.object({ kind: z.enum(["check", "review"]), name: z.string().min(1).max(200),
  worktree: z.string().min(1),
  base: z.string().regex(/^[a-f0-9]{40}$/), head: z.string().regex(/^[a-f0-9]{40}$/),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/), configDigest: z.string(), inputRevision: z.number().int().positive(),
  detail: z.string().max(4000) }).strict();
const planSchema = z.object({
  activities: z.array(z.object({ kind: z.enum(["prototype", "research", "spec", "ticket", "wizard"]), seam: z.string().min(1), reason: z.string().min(1) }).strict()).max(8),
  slices: z.array(z.object({ id: z.string().min(1), behavior: z.string().min(1), test: z.string().min(1), dependsOn: z.array(z.string()) }).strict()).min(1).max(64),
  invariant: z.string(),
}).strict();
const requestIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), task: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("propose"), content: z.string().min(1), scope: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("knowledge"), path: z.string().min(1).max(512), reason: z.string().min(1).max(4000),
    proposed: z.string().max(131072) }).strict(),
  z.object({ kind: z.literal("boundaries"), decided: grillingSchema.shape.decided, open: grillingSchema.shape.open }).strict(),
  z.object({ kind: z.literal("plan"), plan: planSchema }).strict(),
]);
const outboxSchema = z.object({ runId: runIdSchema, requestId: requestIdSchema, role: z.literal("executor"),
  actor: bindingSchema.extend({ epoch: z.number().int().positive() }), ownerEpoch: z.number().int().positive(),
  revision: z.number().int().nonnegative(), inputRevision: z.number().int().positive(),
  intentDigest: z.string().regex(/^[a-f0-9]{64}$/), status: z.literal("consumed") }).strict();
const candidateSchema = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive(), scope: z.string(), contentPath: z.string(), configDigest: z.string(), inputRevision: z.number().int().positive() }).strict();

const operationDefinitionSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/), type: z.enum(OPERATION_TYPES), target: z.string().min(1).max(2048), intentDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const operationReceiptSchema = z.object({ target: z.string(), intentDigest: z.string(), reference: z.string().min(1).max(4096) }).strict();
const operationSchema: z.ZodType<RunOperation> = operationDefinitionSchema.extend({
  status: z.enum(["prepared", "dispatched", "unknown", "settled"]), ownerEpoch: z.number().int().positive(),
  configDigest: z.string(), inputRevision: z.number().int().positive(), approvalDigest: z.string().nullable(),
  failureReason: z.string().nullable(), outcome: z.enum(["applied", "not-applied"]).nullable(), receipt: operationReceiptSchema.nullable(),
}).strict();

const stateSchema: z.ZodType<RunState> = z.object({
  schemaVersion: z.literal(1), runId: runIdSchema, repoIdentity: z.string(),
  commonDir: z.string(), worktree: z.string(), branch: z.string(),
  git: z.object({ remote: z.string(), prBase: z.string(), privateStartRef: z.string(), worktreeGitDir: z.string() }).strict(),
  startSha: z.string(), currentIntegrationSha: z.string(), loadedBuildId: z.string(),
  ownerEpoch: z.number().int().nonnegative(), owner: bindingSchema.extend({ epoch: z.number().int().positive() }).nullable(),
  revision: z.number().int().nonnegative(), phase: z.enum(["alignment", "implementation", "delivery"]),
  issue: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/).nullable(),
  workspace: z.object({ workspaceId: z.string().nullable(), verified: z.boolean(), continuation: z.string(), handoff: z.string() }).strict().nullable(),
  currentTask: z.string().nullable(),
  knowledgeCandidate: z.object({ path: z.string().min(1).max(512), reason: z.string().min(1).max(4000),
    proposed: z.string().max(131072) }).strict().nullable(),
  candidateRevision: z.number().int().nonnegative(),
  candidate: candidateSchema.nullable(), approvedScope: candidateSchema.nullable(),
  project: projectSnapshotSchema.nullable(),
  operations: z.array(operationSchema).max(128),
  lastIntentDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  consumedIntents: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(64),
  outbox: outboxSchema.nullable(),
  grilling: grillingSchema.nullable(),
  plan: planSchema.nullable(),
  proofs: z.array(proofSchema).max(64),
  readiness: z.enum(["ready", "blocked"]), waitingReason: z.string().nullable(),
  configDigest: z.string(), inputRevision: z.number().int().positive(),
}).strict();
const inputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), task: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("propose"), content: z.string().min(1), scope: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("knowledge"), path: z.string().min(1).max(512), reason: z.string().min(1).max(4000),
    proposed: z.string().max(131072) }).strict(),
  z.object({ kind: z.literal("request.submit"), requestId: requestIdSchema, expectedRevision: z.number().int().nonnegative(), intent: requestIntentSchema }).strict(),
  z.object({ kind: z.literal("approve"), source: z.literal("native-ui"), approved: z.literal(true), runId: z.string().min(1), digest: z.string(), candidateRevision: z.number().int(), ownerEpoch: z.number().int() }).strict(),
  z.object({ kind: z.literal("owner.authorize"), source: z.literal("native-ui"), approved: z.literal(true), runId: z.string().min(1), digest: z.string(), candidateRevision: z.number().int(), ownerEpoch: z.number().int() }).strict(),
  z.object({ kind: z.literal("rebind"), contextEpoch: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("operation.prepare"), operation: operationDefinitionSchema }).strict(),
  z.object({ kind: z.literal("operation.resume"), operationId: z.string(), intentDigest: z.string() }).strict(),
  z.object({ kind: z.literal("operation.dispatch"), operationId: z.string() }).strict(),
  z.object({ kind: z.literal("operation.unknown"), operationId: z.string(), reason: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal("operation.settle"), operationId: z.string(), outcome: z.enum(["applied", "not-applied"]), receipt: operationReceiptSchema }).strict(),
  z.object({ kind: z.literal("proof.record"), proof: proofSchema }).strict(),
  z.object({ kind: z.literal("beginDelivery") }).strict(),
  z.object({ kind: z.literal("bindIssue"), issue: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/) }).strict(),
  z.object({ kind: z.literal("workspace.record"), workspace: z.object({ workspaceId: z.string().nullable(),
    verified: z.boolean(), continuation: z.string(), handoff: z.string() }).strict().nullable() }).strict(),
  z.object({ kind: z.literal("sync"), previousIntegrationSha: z.string().regex(/^[a-f0-9]{40}$/), newIntegrationSha: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  z.object({ kind: z.literal("restore") }).strict(),
]);

export class RunBusyError extends Error {
  constructor() { super("This run has an active owner; inspect it without taking over."); this.name = "RunBusyError"; }
}
export class RunOwnershipError extends Error {
  constructor() { super("This action does not belong to the active run owner and context."); this.name = "RunOwnershipError"; }
}
function missing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
export class RunStateSchemaError extends Error {
  constructor(readonly path: string, readonly found: unknown) {
    super(`run state at ${path} has unsupported schemaVersion ${JSON.stringify(found)}; this build reads schema 1 and refuses to guess`);
    this.name = "RunStateSchemaError";
  }
}
export function readRunState(path: string): RunState | null {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (missing(error)) return null; throw error; }
  // An unknown schema is a refusal, not a parse failure: the message must say what was found.
  const version = raw !== null && typeof raw === "object" && "schemaVersion" in raw ? (raw as { schemaVersion: unknown }).schemaVersion : undefined;
  if (version !== 1) throw new RunStateSchemaError(path, version);
  return stateSchema.parse(raw);
}
function readLocator(path: string): z.infer<typeof locatorSchema> | null {
  try { return locatorSchema.parse(JSON.parse(readFileSync(path, "utf8"))); }
  catch (error) { if (missing(error)) return null; throw error; }
}

function proposalBody(configDigest: string, inputRevision: number, content: string, scope: string): string {
  return JSON.stringify({ content, scope, configDigest, inputRevision }) + "\n";
}
function digest(content: string): string { return createHash("sha256").update(content).digest("hex"); }
async function sealMaterial(directory: string, body: string): Promise<{ digest: string; path: string }> {
  const hash = digest(body);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, hash + ".json");
  await writeAtomic(path, body);
  return { digest: hash, path };
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(content); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}
function sameBinding(owner: RunOwner | null, binding: HostBinding): boolean {
  return owner !== null && owner.processInstanceId === binding.processInstanceId
    && owner.sessionId === binding.sessionId && owner.contextEpoch === binding.contextEpoch;
}

export function readProject(commonDir: string): ProjectSnapshot | null {
  let snapshot: ProjectSnapshot;
  try { snapshot = projectSnapshotSchema.parse(JSON.parse(readFileSync(join(commonDir, "omp-feat-flow", "project.json"), "utf8"))); }
  catch (error) { if (missing(error)) return null; throw error; }
  if (snapshot.digest !== digest(JSON.stringify(snapshot.defaults))) throw new Error("Project defaults do not match their recorded digest.");
  return snapshot;
}
export async function saveProject(commonDir: string, defaults: ProjectDefaults, expectedRevision: number): Promise<ProjectSnapshot> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("A valid expected project revision is required.");
  const validated = projectDefaultsSchema.parse(defaults);
  const directory = join(await realpath(commonDir), "omp-feat-flow");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "project.json");
  return withFileLock(path, async () => {
    const current = readProject(commonDir);
    if ((current?.revision ?? 0) !== expectedRevision) throw new Error("Project defaults changed while this choice was pending; reload before saving.");
    const snapshot: ProjectSnapshot = { schemaVersion: 1, revision: expectedRevision + 1,
      defaults: validated, digest: digest(JSON.stringify(validated)) };
    await writeAtomic(path, JSON.stringify(snapshot) + "\n");
    return snapshot;
  }, { retries: 50, retryDelayMs: 10 });
}

export function locateRun(location: RepositoryLocation): { runId: string; repo: PreparedWorktree } | null {
  const locator = readLocator(join(location.worktreeGitDir, "omp-feat-flow.json"));
  if (!locator) return null;
  if (locator.commonDir !== location.commonDir) throw new Error("Worktree locator points to another repository.");
  const state = readRunState(join(location.commonDir, "omp-feat-flow", "runs", locator.runId, "state.json"));
  if (!state || state.runId !== locator.runId || state.repoIdentity !== location.repoIdentity
    || state.commonDir !== location.commonDir || state.worktree !== location.repo || state.branch !== location.branch
    || state.git.worktreeGitDir !== location.worktreeGitDir) throw new Error("The locator does not identify this actual Git worktree; no authority was inherited.");
  return { runId: state.runId, repo: { runId: state.runId, repo: location.repo, repoIdentity: state.repoIdentity, commonDir: state.commonDir,
    worktree: state.worktree, worktreeGitDir: state.git.worktreeGitDir, branch: state.branch,
    remote: state.git.remote, prBase: state.git.prBase, privateStartRef: state.git.privateStartRef,
    startSha: state.startSha, currentIntegrationSha: state.currentIntegrationSha } };
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
        if (locator && (locator.runId !== context.runId || locator.commonDir !== context.repo.commonDir)) throw new Error("This worktree already locates a different run.");
        await withFileLock(statePath, async () => {
          const previous = readRunState(statePath);
          const state = previous ?? kernel.#initialState();
          if (previous) {
            state.readiness = "blocked"; state.waitingReason = "owner-recovery";
            for (const operation of state.operations) if (operation.status === "dispatched") {
              operation.status = "unknown"; operation.failureReason = "Previous owner ended before settlement.";
            }
          }
          if (state.runId !== context.runId || state.commonDir !== context.repo.commonDir
            || state.worktree !== context.repo.worktree || state.branch !== context.repo.branch
            || state.startSha !== context.repo.startSha || state.git.worktreeGitDir !== context.repo.worktreeGitDir
            || state.git.remote !== context.repo.remote || state.git.prBase !== context.repo.prBase
            || state.git.privateStartRef !== context.repo.privateStartRef) throw new Error("Run identity does not match this worktree.");
          state.ownerEpoch += 1;
          state.owner = { ...context.binding, epoch: state.ownerEpoch };
          state.loadedBuildId = context.buildId;
          state.revision += 1;
          // The locator is written under the same lock as the state: a crash cannot leave a run no
          // locator can find, and a concurrent opener cannot observe half of the pair.
          if (!locator) await writeAtomic(locatorPath, JSON.stringify({ schemaVersion: 1, runId: context.runId, commonDir: context.repo.commonDir }) + "\n");
          await writeAtomic(statePath, JSON.stringify(state) + "\n");
          kernel.#ownerEpoch = state.ownerEpoch;
        }, { retries: 50, retryDelayMs: 10 });
      }
      return kernel;
    } catch (error) { lease?.release(); throw error; }
  }
  /** Create the run for this worktree. The creating session owns it; an existing run is never overwritten. */
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
        state.owner = { ...context.binding, epoch: 1 };
        state.revision = 1;
        await writeAtomic(statePath, JSON.stringify(state) + "\n");
        await writeAtomic(locatorPath, JSON.stringify({ schemaVersion: 1, runId: context.runId, commonDir: context.repo.commonDir }) + "\n");
        kernel.#ownerEpoch = 1;
      }, { retries: 50, retryDelayMs: 10 });
      return kernel;
    } catch (error) { lease.release(); throw error; }
  }
  #initialState(): RunState {
    const { repo, runId, buildId } = this.#context;
    const project = this.#context.project === undefined ? readProject(repo.commonDir) : projectSnapshotSchema.parse(this.#context.project);
    if (project && (project.digest !== digest(JSON.stringify(project.defaults)) || project.defaults.git.remote !== repo.remote
      || project.defaults.git.prBase !== repo.prBase)) throw new Error("Project snapshot does not match the prepared run.");
    return { schemaVersion: 1, runId, repoIdentity: repo.repoIdentity, commonDir: repo.commonDir,
      worktree: repo.worktree, branch: repo.branch, startSha: repo.startSha, workspace: null,
      git: { remote: repo.remote, prBase: repo.prBase, privateStartRef: repo.privateStartRef, worktreeGitDir: repo.worktreeGitDir },
      currentIntegrationSha: repo.currentIntegrationSha, loadedBuildId: buildId,
      lastIntentDigest: null, consumedIntents: [], knowledgeCandidate: null, outbox: null, grilling: null, plan: null, proofs: [],
  ownerEpoch: 0, owner: null, revision: 0, phase: "alignment", issue: null, currentTask: null,
      candidateRevision: 0, candidate: null, approvedScope: null, project, operations: [], readiness: "ready", waitingReason: null,
      configDigest: digest(JSON.stringify({ repoIdentity: repo.repoIdentity, projectDigest: project?.digest ?? null, remote: repo.remote, prBase: repo.prBase })), inputRevision: 1 };
  }
  #read(): RunState {
    const state = readRunState(this.#statePath);
    if (!state) throw new Error("Run state is missing; writes are blocked.");
    return state;
  }
  #owned(state: RunState, binding: HostBinding): void {
    if (!this.#lease || this.#storageFailed || state.ownerEpoch !== this.#ownerEpoch || !sameBinding(state.owner, binding)) throw new RunOwnershipError();
  }
  async #propose(state: RunState, content: string, scope: string): Promise<void> {
    const body = proposalBody(state.configDigest, state.inputRevision, content, scope);
    let material;
    try { material = await sealMaterial(join(dirname(this.#statePath), "materials"), body); }
    catch (error) { this.#storageFailed = true; throw error; }
    state.candidateRevision += 1;
    state.candidate = { digest: material.digest, contentPath: material.path, revision: state.candidateRevision,
      scope, configDigest: state.configDigest, inputRevision: state.inputRevision };
    state.approvedScope = null;
    state.phase = "alignment";
  }
  #verifyMaterial(candidate: RunCandidate): void {
    if (candidate.contentPath !== join(dirname(this.#statePath), "materials", candidate.digest + ".json")
      || digest(readFileSync(candidate.contentPath, "utf8")) !== candidate.digest) throw new Error("A bound candidate material is missing or changed.");
  }
  inspect(): Readonly<RunView> {
    const state = this.#read();
    const ownerStatus = this.#lease && state.ownerEpoch === this.#ownerEpoch && sameBinding(state.owner, this.#binding)
      ? "self" : isFileLockHeld(this.#ownerPath) ? "other" : "unclaimed";
    let reason = this.#storageFailed ? "durable-state-write-failed" : state.waitingReason;
    if (!this.#storageFailed && state.approvedScope && this.#authorizedScopeDigest !== state.approvedScope.digest
      && !state.operations.some(operation => operation.status === "dispatched" || operation.status === "unknown")) reason = "owner-authorization-required";
    try {
      if (state.candidate) this.#verifyMaterial(state.candidate);
      if (state.approvedScope && state.approvedScope.digest !== state.candidate?.digest) this.#verifyMaterial(state.approvedScope);
    } catch { reason = "bound-material-unavailable"; }
    return { ...state, ownerStatus, readiness: reason ? "blocked" : state.readiness, waitingReason: reason };
  }
  /**
   * The delivery gate is the full recorded identity: a review proof for this worktree, the current
   * integration base, the observed HEAD, the approved candidate and the current configuration.
   */
  #deliveryEvidence(state: RunState): boolean {
    const scope = state.approvedScope;
    if (!scope) return false;
    return state.proofs.some(proof => proof.kind === "review" && proof.worktree === state.worktree
      && proof.base === state.currentIntegrationSha
      && proof.candidateDigest === scope.digest && proof.configDigest === state.configDigest
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
        reason = this.#authorizedScopeDigest !== state.approvedScope.digest ? "owner-authorization-required"
          : state.approvedScope.configDigest === state.configDigest && state.approvedScope.inputRevision === state.inputRevision ? "allowed" : "approval-object-changed";
      } else reason = "scope-not-approved";
    } catch (error) { reason = this.#storageFailed ? "durable-state-write-failed" : error instanceof RunOwnershipError ? "owner-or-context-mismatch" : "bound-material-or-state-unavailable"; }
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
        case "propose": await this.#propose(state, request.content, request.scope); break;
        case "request.submit": {
          if (state.readiness !== "ready") throw new Error("Recovery is blocked; a model request cannot bypass it.");
          if (request.expectedRevision !== state.revision) throw new Error("This model request observed a stale revision; inspect the run and submit it again.");
          const intent = request.intent;
          const intentDigest = digest(JSON.stringify(intent));
          const repeat = intent.kind === "task" ? state.currentTask === intent.task
            : intent.kind === "propose"
              ? state.candidate?.digest === digest(proposalBody(state.configDigest, state.inputRevision, intent.content, intent.scope))
              // A replayed boundaries/plan request with a fresh id must not re-apply or clear a plan,
              // even when other requests happened in between.
              : state.consumedIntents.includes(intentDigest);
          if (state.outbox?.requestId === request.requestId || repeat) throw new Error("An identical model request was already consumed; no further advance is permitted.");
          if (intent.kind === "task") state.currentTask = intent.task;
          else if (intent.kind === "knowledge") {
            // A knowledge correction is a candidate for approval, never an applied write.
            state.knowledgeCandidate = { path: intent.path, reason: intent.reason, proposed: intent.proposed };
          }
          else if (intent.kind === "boundaries") {
            if (state.phase !== "alignment" || state.approvedScope) throw new Error("Boundaries can only change while the design is unapproved.");
            state.grilling = { decided: intent.decided, open: intent.open };
            state.plan = null;
          } else if (intent.kind === "plan") {
            if (!state.grilling || state.grilling.open.length > 0) throw new Error("A plan needs every boundary resolved first.");
            if (intent.plan.slices.length === 0) throw new Error("A plan needs at least one slice.");
            state.plan = intent.plan;
          } else await this.#propose(state, intent.content, intent.scope);
          state.outbox = { runId: state.runId, requestId: request.requestId, role: "executor",
            actor: { ...binding, epoch: state.ownerEpoch }, ownerEpoch: state.ownerEpoch,
            revision: request.expectedRevision, inputRevision: state.inputRevision,
            intentDigest, status: "consumed" };
          state.lastIntentDigest = intentDigest;
          state.consumedIntents = [...state.consumedIntents, intentDigest].slice(-64);
          break;
        }
        case "approve": {
          if (state.readiness !== "ready" || request.runId !== state.runId || request.ownerEpoch !== state.ownerEpoch) throw new Error("This native approval is stale or recovery is blocked.");
          const knowledge = state.knowledgeCandidate;
          if (knowledge && !state.candidate) {
            if (request.digest !== digest(JSON.stringify(knowledge))) throw new Error("This knowledge approval is stale: the diff changed while you were deciding.");
            // Applied inside the same durable transaction as the approval itself.
            // The correction targets a file in the run's own worktree, never the main checkout.
            const root = resolve(state.worktree);
            const target = resolve(join(root, knowledge.path));
            if (!target.startsWith(root + "/")) throw new Error(`${knowledge.path} escapes the project root.`);
            mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await writeAtomic(target, knowledge.proposed);
            state.knowledgeCandidate = null;
            break;
          }
          if (!state.candidate || request.digest !== state.candidate.digest || request.candidateRevision !== state.candidate.revision) throw new Error("This native approval is stale or recovery is blocked.");
          this.#verifyMaterial(state.candidate);
          state.approvedScope = state.candidate;
          state.phase = "implementation";
          break;
        }
        case "owner.authorize": {
          const scope = state.approvedScope;
          if (state.readiness !== "blocked" || (state.waitingReason !== "owner-recovery" && state.waitingReason !== "context-rebind")
            || state.phase === "alignment" || !scope || !state.candidate
            || request.runId !== state.runId || request.ownerEpoch !== state.ownerEpoch
            || request.digest !== scope.digest || request.candidateRevision !== scope.revision
            || state.candidate.digest !== scope.digest || state.candidate.revision !== scope.revision
            || scope.configDigest !== state.configDigest || scope.inputRevision !== state.inputRevision
            || state.operations.some(operation => operation.status === "dispatched" || operation.status === "unknown")) throw new Error("Current native owner authorization is stale or recovery still has unresolved facts.");
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
          break;
        }
        case "beginDelivery": {
          if (state.phase !== "implementation" || !state.approvedScope) throw new Error("Delivery starts only from an approved implementation.");
          if (!this.#deliveryEvidence(state))
            throw new Error("Delivery needs a review proof recorded for the current worktree and integration base.");
          state.phase = "delivery";
          break;
        }
        case "rebind": {
          if (request.contextEpoch <= binding.contextEpoch) throw new Error("Context generation must advance.");
          rebound = { ...binding, contextEpoch: request.contextEpoch };
          state.ownerEpoch += 1;
          state.owner = { ...rebound, epoch: state.ownerEpoch };
          state.readiness = "blocked";
          state.waitingReason = "context-rebind";
          break;
        }
        case "operation.prepare": {
          if (state.operations.length >= 128) throw new Error("Run operation budget exhausted; no history was discarded.");
          if (state.operations.some(operation => operation.id === request.operation.id || (operation.type === request.operation.type
            && operation.target === request.operation.target && (operation.status !== "settled"
              || (operation.outcome === "applied" && operation.intentDigest === request.operation.intentDigest))))) throw new Error("This operation already exists or requires reconciliation.");
          state.operations.push({ ...request.operation, status: "prepared", ownerEpoch: state.ownerEpoch,
            configDigest: state.configDigest, inputRevision: state.inputRevision, approvalDigest: state.approvedScope?.digest ?? null,
            failureReason: null, outcome: null, receipt: null });
          break;
        }
        case "operation.resume": {
          const operation = state.operations.find(item => item.id === request.operationId);
          if (!operation || operation.status !== "prepared" || operation.intentDigest !== request.intentDigest
            || operation.configDigest !== state.configDigest || operation.inputRevision !== state.inputRevision
            || operation.approvalDigest !== (state.approvedScope?.digest ?? null)) throw new Error("Only an unchanged, definitely unstarted operation may resume.");
          operation.ownerEpoch = state.ownerEpoch;
          break;
        }
        case "operation.dispatch": {
          if (state.readiness !== "ready") throw new Error("Restore readiness before dispatching an operation.");
          const operation = state.operations.find(item => item.id === request.operationId);
          if (!operation || operation.status !== "prepared" || operation.ownerEpoch !== state.ownerEpoch
            || operation.configDigest !== state.configDigest || operation.inputRevision !== state.inputRevision
            || operation.approvalDigest !== (state.approvedScope?.digest ?? null)
            || state.operations.some(item => item.status === "dispatched" || item.status === "unknown")) throw new Error("Operation cannot dispatch: identity changed, already dispatched, or reconciliation is pending.");
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
            || operation.target !== request.receipt.target || operation.intentDigest !== request.receipt.intentDigest) throw new Error("Settlement does not identify the outstanding owned operation.");
          operation.status = "settled"; operation.outcome = request.outcome; operation.receipt = request.receipt; operation.failureReason = null;
          // A settled ledger is no longer a reason to stay blocked; ownership or material problems
          // still surface through inspect().
          if (!state.operations.some(item => item.status === "dispatched" || item.status === "unknown")) {
            state.readiness = "ready"; state.waitingReason = null;
          }
          break;
        }
        case "proof.record": {
          if (state.readiness !== "ready") throw new Error("Recovery is blocked; a proof cannot be recorded.");
          state.proofs = [...state.proofs.filter(proof => !(proof.kind === request.proof.kind && proof.name === request.proof.name)),
            request.proof].slice(-64);
          break;
        }
        case "sync": {
          // The review base moves only for an observed sync; the origin start SHA and the approval stay.
          if (request.previousIntegrationSha !== state.currentIntegrationSha) throw new Error("The reviewed base changed; inspect the run before recording a sync.");
          state.currentIntegrationSha = request.newIntegrationSha;
          break;
        }
        case "restore": {
          if (state.operations.some(operation => operation.status === "dispatched" || operation.status === "unknown")) throw new Error("Reconcile outstanding effects before restoring writes.");
          if (state.candidate) this.#verifyMaterial(state.candidate);
          if (state.approvedScope && state.approvedScope.digest !== state.candidate?.digest) this.#verifyMaterial(state.approvedScope);
          if (state.approvedScope && this.#authorizedScopeDigest !== state.approvedScope.digest) throw new Error("Current owner authorization is required; the saved business scope is unchanged.");
          state.readiness = "ready";
          state.waitingReason = null;
          break;
        }
      }
      state.revision += 1;
      try { await writeAtomic(this.#statePath, JSON.stringify(state) + "\n"); }
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
  async dispose(): Promise<void> {
    this.#lease?.release();
    this.#lease = null;
  }
}

export function openRun(context: RunContext): Promise<RunKernel> { return RunKernel.open(context); }
