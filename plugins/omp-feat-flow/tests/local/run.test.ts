import { afterEach, expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { prepare, type PreparedWorktree } from "../../src/git";
import { openRun, readRunState, RunKernel, RunStateSchemaError, type RunContext, type RunInput } from "../../src/run";
import { gitFixture, type GitFixture } from "../support/git-fixture";
import { join } from "node:path";
import { tmpdir } from "node:os";

type ChildMessage = { kind: "ready"; view: { currentTask: string | null } } | { kind: "busy" } | { kind: "closed"; diagnostic: string };
class ChildRun {
  readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly stderr: Promise<string>;
  #buffer = "";
  constructor(context: RunContext, task: string, inputs: RunInput[] = []) {
    this.process = Bun.spawn([process.execPath, fileURLToPath(new URL("../support/run-process.ts", import.meta.url)), JSON.stringify({ context, task, inputs })], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.reader = this.process.stdout.getReader();
    this.stderr = new Response(this.process.stderr).text();
  }
  async next(): Promise<ChildMessage> {
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        return JSON.parse(line) as ChildMessage;
      }
      const chunk = await this.reader.read();
      if (chunk.done) return { kind: "closed", diagnostic: await this.stderr };
      this.#buffer += new TextDecoder().decode(chunk.value);
    }
  }
  async inspect(): Promise<ChildMessage> {
    this.process.stdin.write("inspect\n");
    await this.process.stdin.flush();
    return this.next();
  }
  async close(): Promise<void> {
    if (this.process.exitCode === null && this.process.signalCode === null) this.process.stdin.end();
    await this.process.exited;
    this.reader.releaseLock();
  }
}
const kernels: RunKernel[] = [];
const fixtures: GitFixture[] = [];
const children: ChildRun[] = [];
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.dispose();
  for (const child of children.splice(0)) await child.close();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});
function context(repo: PreparedWorktree, runId: string, rootId: string): RunContext {
  return { repo, runId, buildId: "fixture-build", mode: "owner", binding: { processInstanceId: rootId, sessionId: rootId, contextEpoch: 0 } };
}

test("second process cannot mutate an owned run while another requirement proceeds", async () => {
  const fixture = await gitFixture();
  fixtures.push(fixture);
  const repoA = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main", runId: "a", branch: "feat/a", worktree: join(fixture.root, "a") });
  const first = new ChildRun(context(repoA, "a", "first"), "held-by-first");
  children.push(first);
  expect(await first.next()).toMatchObject({ kind: "ready", view: { currentTask: "held-by-first" } });
  const intruder = new ChildRun(context(repoA, "a", "intruder"), "intruder-task");
  children.push(intruder);
  expect(await intruder.next()).toEqual({ kind: "busy" });
  const repoB = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main", runId: "b", branch: "feat/b", worktree: join(fixture.root, "b") });
  const other = new ChildRun(context(repoB, "b", "other"), "independent-task");
  children.push(other);
  expect(await other.next()).toMatchObject({ kind: "ready", view: { currentTask: "independent-task" } });
  expect(await first.inspect()).toMatchObject({ kind: "ready", view: { currentTask: "held-by-first" } });
}, 10000);

test("stale candidate and late epoch cannot grant writes", async () => {
  const fixture = await gitFixture();
  fixtures.push(fixture);
  const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "approval", branch: "feat/approval", worktree: join(fixture.root, "approval") });
  const ctx = context(repo, "approval", "owner");
  const kernel = await openRun(ctx);
  kernels.push(kernel);
  const write = { toolCallId: "write-1", effect: "write" as const };
  await kernel.apply({ kind: "propose", content: "Plan A", scope: "fixture A only" }, ctx.binding);
  const candidateA = kernel.inspect().candidate;
  if (!candidateA) throw new Error("Proposal was not made available for native review.");
  const oldDecision = { kind: "approve" as const, source: "native-ui" as const,
    runId: ctx.runId,
    approved: true as const,
    digest: candidateA.digest, candidateRevision: candidateA.revision, ownerEpoch: kernel.inspect().ownerEpoch };
  await kernel.apply({ kind: "propose", content: "Plan B", scope: "fixture B only" }, ctx.binding);
  await expect(kernel.apply(oldDecision, ctx.binding)).rejects.toBeInstanceOf(Error);
  expect(kernel.admit(write, ctx.binding).allow).toBe(false);
  const candidateB = kernel.inspect().candidate;
  if (!candidateB) throw new Error("Current native approval candidate is missing.");
  const decisionB = { kind: "approve" as const, source: "native-ui" as const,
    runId: ctx.runId,
    approved: true as const,
    digest: candidateB.digest, candidateRevision: candidateB.revision, ownerEpoch: kernel.inspect().ownerEpoch };
  await kernel.apply(decisionB, ctx.binding);
  expect(kernel.admit(write, ctx.binding).allow).toBe(true);
  await kernel.apply({ kind: "rebind", contextEpoch: 1 }, ctx.binding);
  const resumed = { ...ctx.binding, contextEpoch: 1 };
  expect(kernel.admit(write, ctx.binding).allow).toBe(false);
  expect(kernel.admit(write, resumed).allow).toBe(false);
  await kernel.apply({ kind: "restore" }, resumed);
  await expect(kernel.apply(decisionB, resumed)).rejects.toBeInstanceOf(Error);
  expect(kernel.admit(write, resumed).allow).toBe(true);
  expect(kernel.admit(write, ctx.binding).allow).toBe(false);
});

test("unknown external operation is not dispatched again", async () => {
  const fixture = await gitFixture(); fixtures.push(fixture);
  const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "journal", branch: "feat/journal", worktree: join(fixture.root, "journal") });
  const ctx = context(repo, "journal", "first");
  const kernel = await openRun(ctx); kernels.push(kernel);
  const operation = { id: "create-pr", type: "github-pr" as const, target: "fixture://owned-repository/feature",
    intentDigest: "a".repeat(64) };
  await kernel.apply({ kind: "operation.prepare", operation }, ctx.binding);
  await kernel.apply({ kind: "operation.dispatch", operationId: operation.id }, ctx.binding);
  await kernel.apply({ kind: "operation.unknown", operationId: operation.id, reason: "result connection closed" }, ctx.binding);
  expect(kernel.inspect().operations).toEqual([expect.objectContaining({ ...operation, status: "unknown" })]);
  await expect(kernel.apply({ kind: "operation.dispatch", operationId: operation.id }, ctx.binding)).rejects.toBeInstanceOf(Error);
  await expect(kernel.apply({ kind: "operation.prepare", operation: { ...operation, id: "blind-retry" } }, ctx.binding)).rejects.toBeInstanceOf(Error);
  await expect(kernel.apply({ kind: "restore" }, ctx.binding)).rejects.toBeInstanceOf(Error);
  await kernel.dispose();
  const next = context(repo, "journal", "second");
  const recovered = await openRun(next); kernels.push(recovered);
  expect(recovered.inspect().operations[0]?.status).toBe("unknown");
  await expect(recovered.apply({ kind: "operation.dispatch", operationId: operation.id }, next.binding)).rejects.toBeInstanceOf(Error);
  const receipt = { target: operation.target, intentDigest: operation.intentDigest, reference: "fixture-reconciliation-receipt" };
  await expect(recovered.apply({ kind: "operation.settle", operationId: operation.id, outcome: "applied",
    receipt: { ...receipt, target: "fixture://unrelated-repository" } }, next.binding)).rejects.toBeInstanceOf(Error);
  await recovered.apply({ kind: "operation.settle", operationId: operation.id, outcome: "applied", receipt }, next.binding);
  await recovered.apply({ kind: "restore" }, next.binding);
  expect(recovered.inspect().readiness).toBe("ready");
  await expect(recovered.apply({ kind: "operation.dispatch", operationId: operation.id }, next.binding)).rejects.toBeInstanceOf(Error);
});

test("failed durable replacement cannot expose an unpersisted grant", async () => {
  const fixture = await gitFixture(); fixtures.push(fixture);
  const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "storage", branch: "feat/storage", worktree: join(fixture.root, "storage") });
  const ctx = context(repo, "storage", "owner");
  const kernel = await openRun(ctx); kernels.push(kernel);
  await kernel.apply({ kind: "propose", content: "Change the owned fixture only.", scope: "fixture implementation" }, ctx.binding);
  const candidate = kernel.inspect().candidate;
  if (!candidate) throw new Error("No candidate available for the native decision.");
  const directory = join(repo.commonDir, "omp-feat-flow", "runs", "storage");
  await chmod(directory, 0o500);
  try {
    await expect(kernel.apply({ kind: "approve", source: "native-ui", approved: true, runId: ctx.runId, digest: candidate.digest,
      candidateRevision: candidate.revision, ownerEpoch: kernel.inspect().ownerEpoch }, ctx.binding)).rejects.toBeInstanceOf(Error);
  } finally { await chmod(directory, 0o700); }
  expect(kernel.inspect()).toMatchObject({ phase: "alignment", approvedScope: null, ownerStatus: "self", readiness: "blocked" });
  expect(kernel.admit({ toolCallId: "after-failed-grant", effect: "write" }, ctx.binding).allow).toBe(false);
  await kernel.dispose();
  const next = context(repo, "storage", "recovery");
  const recovered = await openRun(next); kernels.push(recovered);
  await recovered.apply({ kind: "restore" }, next.binding);
  expect(recovered.inspect()).toMatchObject({ phase: "alignment", approvedScope: null });
  expect(recovered.admit({ toolCallId: "recovered-without-grant", effect: "write" }, next.binding).allow).toBe(false);
});

test("runs retain independent project snapshots after shared defaults change", async () => {
  const fixture = await gitFixture(); fixtures.push(fixture);
  const repoA = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "defaults-a", branch: "feat/defaults-a", worktree: join(fixture.root, "defaults-a") });
  const { readProject, saveProject } = await import("../../src/run");
  const defaults = {
    git: { remote: "origin", startRef: "main", prBase: "main", worktreeRoot: join(fixture.root, "features") },
    github: { repository: "fixture/owned" },
    linear: { mode: "required" as const, teamId: "fixture-team", reviewState: "fixture-review" },
    knowledge: { entryPaths: ["CLAUDE.md", ".claude/rules", ".claude/skills"] },
  };
  const first = await saveProject(repoA.commonDir, defaults, 0);
  const ctxA = { ...context(repoA, "defaults-a", "first"), project: first };
  const a = await openRun(ctxA); kernels.push(a);
  await a.apply({ kind: "task", task: "work on A" }, ctxA.binding);
  const changed = { ...defaults, linear: { ...defaults.linear, reviewState: "In QA" } };
  const second = await saveProject(repoA.commonDir, changed, first.revision);
  const repoB = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "defaults-b", branch: "feat/defaults-b", worktree: join(fixture.root, "defaults-b") });
  const ctxB = { ...context(repoB, "defaults-b", "second"), project: second };
  const b = await openRun(ctxB); kernels.push(b);
  await b.apply({ kind: "task", task: "work on B" }, ctxB.binding);
  expect(a.inspect()).toMatchObject({ currentTask: "work on A", project: { config: { linear: { reviewState: "fixture-review" } } } });
  expect(b.inspect()).toMatchObject({ currentTask: "work on B", project: { config: { linear: { reviewState: "In QA" } } } });
  await expect(saveProject(repoA.commonDir, defaults, first.revision)).rejects.toBeInstanceOf(Error);
  expect(readProject(repoA.commonDir)?.config.linear?.reviewState).toBe("In QA");
});

test("recovery resumes only an unstarted operation after a real owner crash", async () => {
  const fixture = await gitFixture(); fixtures.push(fixture);
  const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "crash", branch: "feat/crash", worktree: join(fixture.root, "crash") });
  const prepared = { id: "unstarted", type: "github-pr" as const, target: "fixture://owned/unstarted", intentDigest: "b".repeat(64) };
  const inFlight = { id: "in-flight", type: "github-pr" as const, target: "fixture://owned/in-flight", intentDigest: "c".repeat(64) };
  const child = new ChildRun(context(repo, "crash", "before-crash"), "crash barrier", [
    { kind: "operation.prepare", operation: prepared }, { kind: "operation.prepare", operation: inFlight },
    { kind: "operation.dispatch", operationId: inFlight.id },
  ]);
  children.push(child);
  expect(await child.next()).toMatchObject({ kind: "ready" });
  child.process.kill("SIGKILL");
  await child.process.exited;
  expect(child.process.signalCode).toBe("SIGKILL");
  const next = context(repo, "crash", "after-crash");
  const recovered = await openRun(next); kernels.push(recovered);
  expect(recovered.inspect().operations).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: prepared.id, status: "prepared" }),
    expect.objectContaining({ id: inFlight.id, status: "unknown" }),
  ]));
  await recovered.apply({ kind: "operation.resume", operationId: prepared.id, intentDigest: prepared.intentDigest }, next.binding);
  await expect(recovered.apply({ kind: "operation.dispatch", operationId: prepared.id }, next.binding)).rejects.toBeInstanceOf(Error);
  await expect(recovered.apply({ kind: "restore" }, next.binding)).rejects.toBeInstanceOf(Error);
  await recovered.apply({ kind: "operation.settle", operationId: inFlight.id, outcome: "not-applied",
    receipt: { target: inFlight.target, intentDigest: inFlight.intentDigest, reference: "fixture-definitive-nonapplication" } }, next.binding);
  await recovered.apply({ kind: "restore" }, next.binding);
  await recovered.apply({ kind: "operation.dispatch", operationId: prepared.id }, next.binding);
  expect(recovered.inspect().operations.find(operation => operation.id === prepared.id)?.status).toBe("dispatched");
}, 10000);

test("prepared-only recovery cannot dispatch before restore", async () => {
  const fixture = await gitFixture(); fixtures.push(fixture);
  const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "prepared-only", branch: "feat/prepared-only", worktree: join(fixture.root, "prepared-only") });
  const ctx = context(repo, "prepared-only", "first");
  const first = await openRun(ctx); kernels.push(first);
  const operation = { id: "prepared", type: "github-pr" as const, target: "fixture://owned/prepared", intentDigest: "d".repeat(64) };
  await first.apply({ kind: "operation.prepare", operation }, ctx.binding);
  await first.dispose();
  const next = context(repo, "prepared-only", "next");
  const recovered = await openRun(next); kernels.push(recovered);
  await recovered.apply({ kind: "operation.resume", operationId: operation.id, intentDigest: operation.intentDigest }, next.binding);
  await expect(recovered.apply({ kind: "operation.dispatch", operationId: operation.id }, next.binding)).rejects.toBeInstanceOf(Error);
  expect(recovered.inspect().operations[0]?.status).toBe("prepared");
  await recovered.apply({ kind: "restore" }, next.binding);
  await recovered.apply({ kind: "operation.dispatch", operationId: operation.id }, next.binding);
  expect(recovered.inspect().operations[0]?.status).toBe("dispatched");
});

test("a native decision for one run cannot authorize an identical second run", async () => {
  const fixture = await gitFixture(); fixtures.push(fixture);
  const repoA = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "same-a", branch: "feat/same-a", worktree: join(fixture.root, "same-a") });
  const repoB = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "same-b", branch: "feat/same-b", worktree: join(fixture.root, "same-b") });
  const ctxA = context(repoA, "same-a", "a"), ctxB = context(repoB, "same-b", "b");
  const a = await openRun(ctxA), b = await openRun(ctxB); kernels.push(a, b);
  const proposal = { kind: "propose" as const, content: "The same proposed change.", scope: "owned fixture only" };
  await a.apply(proposal, ctxA.binding); await b.apply(proposal, ctxB.binding);
  const candidate = a.inspect().candidate;
  if (!candidate) throw new Error("Native review candidate is missing.");
  const decision = { kind: "approve" as const, source: "native-ui" as const, approved: true as const,
    runId: ctxA.runId,
    digest: candidate.digest, candidateRevision: candidate.revision, ownerEpoch: a.inspect().ownerEpoch };
  await a.apply(decision, ctxA.binding);
  expect(a.admit({ toolCallId: "a-write", effect: "write" }, ctxA.binding).allow).toBe(true);
  await expect(b.apply(decision, ctxB.binding)).rejects.toBeInstanceOf(Error);
  expect(b.inspect()).toMatchObject({ phase: "alignment", approvedScope: null });
  expect(b.admit({ toolCallId: "b-write", effect: "write" }, ctxB.binding).allow).toBe(false);
});

test("new owner cannot inherit a persisted grant without current native authorization", async () => {
  const fixture = await gitFixture(); fixtures.push(fixture);
  const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "owner-auth", branch: "feat/owner-auth", worktree: join(fixture.root, "owner-auth") });
  const ctx = context(repo, "owner-auth", "first");
  const first = await openRun(ctx); kernels.push(first);
  await first.apply({ kind: "propose", content: "Continue only the saved fixture change.", scope: "fixture only" }, ctx.binding);
  const candidate = first.inspect().candidate;
  if (!candidate) throw new Error("Saved native review material is missing.");
  const decision = { kind: "approve" as const, source: "native-ui" as const, approved: true as const, runId: ctx.runId,
    digest: candidate.digest, candidateRevision: candidate.revision, ownerEpoch: first.inspect().ownerEpoch };
  await first.apply(decision, ctx.binding);
  expect(first.admit({ toolCallId: "acknowledged", effect: "write" }, ctx.binding).allow).toBe(true);
  await first.dispose();
  const next = context(repo, "owner-auth", "second");
  const recovered = await openRun(next); kernels.push(recovered);
  await expect(recovered.apply({ kind: "restore" }, next.binding)).rejects.toBeInstanceOf(Error);
  expect(recovered.inspect()).toMatchObject({ phase: "implementation", approvedScope: candidate,
    readiness: "blocked", waitingReason: "owner-authorization-required" });
  expect(recovered.admit({ toolCallId: "before-current-authorization", effect: "write" }, next.binding).allow).toBe(false);
  await expect(recovered.apply({ ...decision, kind: "owner.authorize" }, next.binding)).rejects.toBeInstanceOf(Error);
  await recovered.apply({ ...decision, kind: "owner.authorize", ownerEpoch: recovered.inspect().ownerEpoch }, next.binding);
  expect(recovered.inspect()).toMatchObject({ phase: "implementation", approvedScope: candidate, readiness: "ready" });
  expect(recovered.admit({ toolCallId: "authorized-current-owner", effect: "write" }, next.binding).allow).toBe(true);
});

test("definitive nonapplication permits a new operation with the same real intent", async () => {
  const fixture = await gitFixture(); fixtures.push(fixture);
  const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "retry", branch: "feat/retry", worktree: join(fixture.root, "retry") });
  const ctx = context(repo, "retry", "owner");
  const kernel = await openRun(ctx); kernels.push(kernel);
  const operation = { id: "original", type: "github-pr" as const, target: "fixture://owned/retry", intentDigest: "e".repeat(64) };
  await kernel.apply({ kind: "operation.prepare", operation }, ctx.binding);
  await kernel.apply({ kind: "operation.dispatch", operationId: operation.id }, ctx.binding);
  await kernel.apply({ kind: "operation.unknown", operationId: operation.id, reason: "response connection lost" }, ctx.binding);
  const receipt = { target: operation.target, intentDigest: operation.intentDigest, reference: "fixture-definitive-reconciliation" };
  await kernel.apply({ kind: "operation.settle", operationId: operation.id, outcome: "not-applied", receipt }, ctx.binding);
  await kernel.apply({ kind: "restore" }, ctx.binding);
  const retry = { ...operation, id: "explicit-retry" };
  await kernel.apply({ kind: "operation.prepare", operation: retry }, ctx.binding);
  await kernel.apply({ kind: "operation.dispatch", operationId: retry.id }, ctx.binding);
  expect(kernel.inspect().operations.find(item => item.id === retry.id)?.status).toBe("dispatched");
  await kernel.apply({ kind: "operation.settle", operationId: retry.id, outcome: "applied", receipt }, ctx.binding);
  await kernel.apply({ kind: "restore" }, ctx.binding);
  await expect(kernel.apply({ kind: "operation.prepare", operation: { ...operation, id: "duplicate-applied" } }, ctx.binding)).rejects.toBeInstanceOf(Error);
});

test("a partial material can be reproposed without reviving the old grant", async () => {
  const fixture = await gitFixture(); fixtures.push(fixture);
  const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "material", branch: "feat/material", worktree: join(fixture.root, "material") });
  const ctx = context(repo, "material", "owner");
  const kernel = await openRun(ctx); kernels.push(kernel);
  const proposal = { kind: "propose" as const, content: "The original bounded fixture plan.", scope: "fixture only" };
  await kernel.apply(proposal, ctx.binding);
  const candidate = kernel.inspect().candidate;
  if (!candidate) throw new Error("Native review material is missing.");
  const decision = { kind: "approve" as const, source: "native-ui" as const, approved: true as const, runId: ctx.runId,
    digest: candidate.digest, candidateRevision: candidate.revision, ownerEpoch: kernel.inspect().ownerEpoch };
  await kernel.apply(decision, ctx.binding);
  await writeFile(candidate.contentPath, "interrupted material");
  expect(kernel.admit({ toolCallId: "corrupted-material", effect: "write" }, ctx.binding).allow).toBe(false);
  await expect(kernel.apply({ kind: "restore" }, ctx.binding)).rejects.toBeInstanceOf(Error);
  await kernel.apply(proposal, ctx.binding);
  expect(kernel.inspect()).toMatchObject({ phase: "alignment", approvedScope: null });
  expect(kernel.admit({ toolCallId: "repaired-but-unapproved", effect: "write" }, ctx.binding).allow).toBe(false);
  await expect(kernel.apply(decision, ctx.binding)).rejects.toBeInstanceOf(Error);
  const replacement = kernel.inspect().candidate;
  if (!replacement) throw new Error("Replacement proposal is missing.");
  await kernel.apply({ ...decision, digest: replacement.digest, candidateRevision: replacement.revision }, ctx.binding);
  expect(kernel.admit({ toolCallId: "newly-approved-material", effect: "write" }, ctx.binding).allow).toBe(true);
});

test("a copied locator cannot let another worktree adopt the run", async () => {
  const fixture = await gitFixture(); fixtures.push(fixture);
  const repoA = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "locator-a", branch: "feat/locator-a", worktree: join(fixture.root, "locator-a") });
  const ctx = context(repoA, "locator-a", "owner");
  const owner = await openRun(ctx); kernels.push(owner);
  await owner.apply({ kind: "task", task: "retain owned A" }, ctx.binding);
  const { inspectRepository } = await import("../../src/git");
  const { locateRun } = await import("../../src/run");
  const located = locateRun(await inspectRepository(repoA.worktree));
  if (!located) throw new Error("The current real worktree could not locate its run.");
  const reader = await openRun({ ...context(located.repo, located.runId, "inspector"), mode: "inspect" }); kernels.push(reader);
  expect(reader.inspect()).toMatchObject({ currentTask: "retain owned A", ownerStatus: "other" });
  await expect(reader.apply({ kind: "task", task: "not authorized" }, context(located.repo, located.runId, "inspector").binding)).rejects.toBeInstanceOf(Error);
  const repoB = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "locator-b", branch: "feat/locator-b", worktree: join(fixture.root, "locator-b") });
  await copyFile(join(repoA.worktreeGitDir, "omp-feat-flow.json"), join(repoB.worktreeGitDir, "omp-feat-flow.json"));
  const unrelated = await inspectRepository(repoB.worktree);
  expect(() => locateRun(unrelated)).toThrow();
  expect(owner.inspect().currentTask).toBe("retain owned A");
});

test("opening cannot substitute another run identity for the prepared worktree", async () => {
  const fixture = await gitFixture(); fixtures.push(fixture);
  const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "prepared-owner", branch: "feat/prepared-owner", worktree: join(fixture.root, "prepared-owner") });
  const wrong = openRun(context(repo, "substituted-owner", "wrong")).then(kernel => { kernels.push(kernel); return kernel; });
  await expect(wrong).rejects.toBeInstanceOf(Error);
  const legitimate = await openRun(context(repo, "prepared-owner", "right")); kernels.push(legitimate);
  expect(legitimate.inspect()).toMatchObject({ runId: "prepared-owner", worktree: repo.worktree, ownerStatus: "self" });
});

test("model requests are consumed once and cannot supply native approval", async () => {
  const fixture = await gitFixture(); fixtures.push(fixture);
  const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "signal", branch: "feat/signal", worktree: join(fixture.root, "signal") });
  const ctx = context(repo, "signal", "owner");
  const kernel = await openRun(ctx); kernels.push(kernel);
  const request = { kind: "request.submit" as const, requestId: "native-call-1", expectedRevision: kernel.inspect().revision,
    intent: { kind: "propose" as const, content: "A bounded fixture change.", scope: "fixture only" } };
  const forged = JSON.parse(JSON.stringify({ ...request, intent: { kind: "approve", source: "native-ui", approved: true } }));
  await expect(kernel.apply(forged, ctx.binding)).rejects.toBeInstanceOf(Error);
  expect(kernel.admit({ toolCallId: "forged-request", effect: "write" }, ctx.binding).allow).toBe(false);
  await kernel.apply(request, ctx.binding);
  expect(kernel.inspect().outbox?.status).toBe("consumed");
  const candidate = kernel.inspect().candidate;
  if (!candidate) throw new Error("Consumed proposal is unavailable for native review.");
  expect(kernel.admit({ toolCallId: "proposal-is-not-approval", effect: "write" }, ctx.binding).allow).toBe(false);
  await kernel.apply({ kind: "approve", source: "native-ui", approved: true, runId: ctx.runId,
    digest: candidate.digest, candidateRevision: candidate.revision, ownerEpoch: kernel.inspect().ownerEpoch }, ctx.binding);
  await expect(kernel.apply({ ...request, expectedRevision: kernel.inspect().revision }, ctx.binding)).rejects.toBeInstanceOf(Error);
  await expect(kernel.apply({ ...request, requestId: "late-call", expectedRevision: kernel.inspect().revision }, ctx.binding)).rejects.toBeInstanceOf(Error);
  expect(kernel.inspect()).toMatchObject({ phase: "implementation", candidate: { revision: candidate.revision } });
  expect(kernel.admit({ toolCallId: "legitimately-approved", effect: "write" }, ctx.binding).allow).toBe(true);
});

test("a run is created once as ready and owned by its creator", async () => {
  const fixture = await gitFixture(); fixtures.push(fixture);
  const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "created", branch: "feat/created", worktree: join(fixture.root, "created") });
  const creator = await RunKernel.create(context(repo, "created", "creator")); kernels.push(creator);
  expect(creator.inspect()).toMatchObject({ runId: "created", readiness: "ready", ownerStatus: "self", revision: 1, phase: "alignment" });
  const { locateRun } = await import("../../src/run");
  const { inspectRepository } = await import("../../src/git");
  expect(locateRun(await inspectRepository(repo.worktree))).toMatchObject({ runId: "created" });
  await expect(RunKernel.create(context(repo, "created", "second"))).rejects.toBeInstanceOf(Error);
  await creator.dispose();
  kernels.splice(kernels.indexOf(creator), 1);
  const intruder = await openRun({ repo, runId: "created", buildId: "fixture-build", mode: "owner",
    binding: { processInstanceId: "other", sessionId: "other", contextEpoch: 0 } });
  kernels.push(intruder);
  expect(intruder.inspect()).toMatchObject({ readiness: "blocked", waitingReason: "owner-recovery" });
});

test("a proposed candidate is reviewable but never transitions on its own", async () => {
  const fixture = await gitFixture(); fixtures.push(fixture);
  const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "ready-only", branch: "feat/ready-only", worktree: join(fixture.root, "ready-only") });
  const ctx = context(repo, "ready-only", "owner");
  const kernel = await RunKernel.create(ctx); kernels.push(kernel);
  await kernel.apply({ kind: "request.submit", requestId: "call-1", expectedRevision: kernel.inspect().revision,
    intent: { kind: "propose", content: "Bound a change.", scope: "fixture only" } }, ctx.binding);
  const view = kernel.inspect();
  expect(view).toMatchObject({ phase: "alignment", approvedScope: null, candidateRevision: 1 });
  expect(kernel.admit({ toolCallId: "write-1", effect: "write" }, ctx.binding)).toMatchObject({ allow: false, reason: "scope-not-approved" });
  // Re-opening does not carry an approval either.
  await kernel.dispose();
  kernels.splice(kernels.indexOf(kernel), 1);
  const reopened = await openRun({ repo, runId: "ready-only", buildId: "fixture-build", mode: "owner", binding: ctx.binding });
  kernels.push(reopened);
  expect(reopened.inspect()).toMatchObject({ readiness: "blocked", waitingReason: "owner-recovery", approvedScope: null });
});

test("propose during implementation is rejected; plan.amend closes writes until re-approved", async () => {
  const fixture = await gitFixture(); fixtures.push(fixture);
  const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "stale", branch: "feat/stale", worktree: join(fixture.root, "stale") });
  const ctx = context(repo, "stale", "owner");
  const kernel = await RunKernel.create(ctx); kernels.push(kernel);
  await kernel.apply({ kind: "request.submit", requestId: "call-1", expectedRevision: kernel.inspect().revision,
    intent: {
      kind: "plan",
      scope: "fixture only",
      summary: "First design.",
      profile: (await import("../../src/profile")).deriveRequirementProfile({
        signals: { expectedFiles: 1, distinctModules: 1, riskFlags: [], externalEffects: false, estimatedSlices: 1 },
        declaredFiles: ["a.txt"],
      }),
      plan: { activities: [], slices: [{ id: "s1", behavior: "first", test: "t1", dependsOn: [] }], invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers" },
    } }, ctx.binding);
  const first = kernel.inspect().candidate;
  if (!first) throw new Error("No candidate was stored.");
  await kernel.apply({ kind: "approve", source: "native-ui", approved: true, runId: ctx.runId,
    digest: first.digest, candidateRevision: first.revision, ownerEpoch: kernel.inspect().ownerEpoch }, ctx.binding);
  expect(kernel.admit({ toolCallId: "write-1", effect: "write" }, ctx.binding).allow).toBe(true);
  await expect(kernel.apply({ kind: "request.submit", requestId: "call-bad", expectedRevision: kernel.inspect().revision,
    intent: { kind: "propose", content: "Second design.", scope: "fixture only" } }, ctx.binding)).rejects.toThrow(/alignment/i);
  await kernel.apply({ kind: "request.submit", requestId: "call-2", expectedRevision: kernel.inspect().revision,
    intent: {
      kind: "plan.amend",
      scope: "fixture only",
      summary: "Second design.",
      plan: { activities: [], slices: [{ id: "s1", behavior: "second", test: "t1", dependsOn: [] }], invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers" },
    } }, ctx.binding);
  expect(kernel.inspect().gateToken?.kind).toBe("amendment-approval");
  expect(kernel.admit({ toolCallId: "write-2", effect: "write" }, ctx.binding)).toMatchObject({ allow: false, reason: "gate-pending" });
});

test("boundaries persist, and a plan is refused while any boundary is open", async () => {
  const fixture = await gitFixture(); fixtures.push(fixture);
  const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "grill", branch: "feat/grill", worktree: join(fixture.root, "grill") });
  const ctx = context(repo, "grill", "owner");
  const kernel = await RunKernel.create(ctx); kernels.push(kernel);
  const plan = { activities: [], slices: [{ id: "s1", behavior: "a", test: "ta", dependsOn: [] }], invariant: "one failing behavioral slice, then minimal green, then review; no parallel writers" };
  await kernel.apply({ kind: "request.submit", requestId: "b1", expectedRevision: kernel.inspect().revision,
    intent: { kind: "boundaries", decided: [{ category: "non-goals", answer: "No new table." }], open: ["business-boundary", "error-path"] } }, ctx.binding);
  expect(kernel.inspect()).toMatchObject({ grilling: { open: ["business-boundary", "error-path"] }, plan: null, approvedScope: null });
  await expect(kernel.apply({ kind: "request.submit", requestId: "p1", expectedRevision: kernel.inspect().revision,
    intent: { kind: "plan", plan } }, ctx.binding)).rejects.toBeInstanceOf(Error);
  await kernel.apply({ kind: "request.submit", requestId: "b2", expectedRevision: kernel.inspect().revision,
    intent: { kind: "boundaries", decided: [{ category: "business-boundary", answer: "Owning team." }, { category: "error-path", answer: "503." },
      { category: "non-goals", answer: "No new table." }, { category: "acceptance", answer: "Under two minutes." }], open: [] } }, ctx.binding);
  await kernel.apply({ kind: "request.submit", requestId: "p2", expectedRevision: kernel.inspect().revision,
    intent: { kind: "plan", plan } }, ctx.binding);
  expect(kernel.inspect().plan).toMatchObject({ slices: [{ id: "s1" }] });
  expect(kernel.admit({ toolCallId: "w", effect: "write" }, ctx.binding)).toMatchObject({ allow: false, reason: "scope-not-approved" });
});

test("a recorded proof is replaced by name and survives an approval but not a sync base change", async () => {
  const fixture = await gitFixture(); fixtures.push(fixture);
  const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "proof", branch: "feat/proof", worktree: join(fixture.root, "proof") });
  const ctx = context(repo, "proof", "owner");
  const kernel = await RunKernel.create(ctx); kernels.push(kernel);
  await kernel.apply({ kind: "request.submit", requestId: "p1", expectedRevision: kernel.inspect().revision,
    intent: { kind: "propose", content: "Bound a change.", scope: "fixture only" } }, ctx.binding);
  const candidate = kernel.inspect().candidate;
  if (!candidate) throw new Error("no candidate");
  await kernel.apply({ kind: "approve", source: "native-ui", approved: true, runId: "proof",
    digest: candidate.digest, candidateRevision: candidate.revision, ownerEpoch: kernel.inspect().ownerEpoch }, ctx.binding);
  const view = kernel.inspect();
  const proof = { kind: "check" as const, name: "unit", worktree: view.worktree, base: view.currentIntegrationSha, head: view.currentIntegrationSha,
    candidateDigest: candidate.digest, configDigest: view.configDigest, inputRevision: view.inputRevision, detail: "exit 0" };
  await kernel.apply({ kind: "proof.record", proof }, ctx.binding);
  await kernel.apply({ kind: "proof.record", proof: { ...proof, detail: "exit 0 (rerun)" } }, ctx.binding);
  expect(kernel.inspect().proofs).toHaveLength(1);
  expect(kernel.inspect().proofs[0]?.detail).toContain("rerun");
  await kernel.apply({ kind: "sync", previousIntegrationSha: view.currentIntegrationSha, newIntegrationSha: "9".repeat(40) }, ctx.binding);
  const after = kernel.inspect();
  expect(after.currentIntegrationSha).toBe("9".repeat(40));
  expect(after.startSha).toBe(view.startSha);
  expect(after.approvedScope?.digest).toBe(candidate.digest);
  expect(after.proofs[0]?.base).toBe(view.currentIntegrationSha);
});

test("an unsupported run schema is refused with a truthful message", async () => {
	const file = join(await mkdtemp(join(tmpdir(), "feat-state-")), "state.json");
	await writeFile(file, JSON.stringify({ schemaVersion: 3, runId: "x" }) + "\n");
	expect(() => readRunState(file)).toThrow(RunStateSchemaError);
	expect(() => readRunState(file)).toThrow("unsupported schemaVersion 3");
	await writeFile(file, JSON.stringify({ schemaVersion: 2 }) + "\n");
	// Schema 2 with missing fields is a different failure, and it must not be reported as a version problem.
	expect(() => readRunState(file)).toThrow();
	expect(() => readRunState(join(file, "..", "absent.json"))).not.toThrow();
});

test("settling the last operation restores readiness, so the next step is not dead", async () => {
	const fixture = await gitFixture(); fixtures.push(fixture);
	const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
		runId: "settle", branch: "feat/settle", worktree: join(fixture.root, "settle") });
	const ctx = context(repo, "settle", "owner");
	const kernel = await openRun(ctx); kernels.push(kernel);
	const operation = { id: "op-1", type: "git-sync" as const, target: "main", intentDigest: "a".repeat(64) };
	await kernel.apply({ kind: "operation.prepare", operation }, ctx.binding);
	await kernel.apply({ kind: "operation.dispatch", operationId: operation.id }, ctx.binding);
	expect(kernel.inspect().readiness).toBe("blocked");
	await kernel.apply({ kind: "operation.settle", operationId: operation.id, outcome: "not-applied",
		receipt: { target: "main", intentDigest: operation.intentDigest, reference: "unchanged" } }, ctx.binding);
	// No separate restore call: the settled ledger is enough to be ready again.
	expect(kernel.inspect().readiness).toBe("ready");
	await expect(kernel.apply({ kind: "proof.record", proof: { kind: "check", name: "unit", worktree: repo.worktree,
		base: repo.currentIntegrationSha, head: repo.currentIntegrationSha, candidateDigest: "c".repeat(64),
		configDigest: kernel.inspect().configDigest, inputRevision: kernel.inspect().inputRevision, detail: "ok" } }, ctx.binding))
		.resolves.toBeDefined();
});

test("an unchanged sync settled as not-applied can be prepared again; an applied one cannot", async () => {
	const fixture = await gitFixture(); fixtures.push(fixture);
	const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
		runId: "retry", branch: "feat/retry", worktree: join(fixture.root, "retry") });
	const ctx = context(repo, "retry", "owner");
	const kernel = await openRun(ctx); kernels.push(kernel);
	const operation = { id: "op-1", type: "git-sync" as const, target: "main", intentDigest: "b".repeat(64) };
	await kernel.apply({ kind: "operation.prepare", operation }, ctx.binding);
	await kernel.apply({ kind: "operation.dispatch", operationId: operation.id }, ctx.binding);
	await kernel.apply({ kind: "operation.settle", operationId: operation.id, outcome: "not-applied",
		receipt: { target: "main", intentDigest: operation.intentDigest, reference: "unchanged" } }, ctx.binding);
	await kernel.apply({ kind: "operation.prepare", operation: { ...operation, id: "op-2" } }, ctx.binding);
	await kernel.apply({ kind: "operation.dispatch", operationId: "op-2" }, ctx.binding);
	await kernel.apply({ kind: "operation.settle", operationId: "op-2", outcome: "applied",
		receipt: { target: "main", intentDigest: operation.intentDigest, reference: "f".repeat(40) } }, ctx.binding);
	await expect(kernel.apply({ kind: "operation.prepare", operation: { ...operation, id: "op-3" } }, ctx.binding))
		.rejects.toThrow(/already exists/);
});

test("a replayed boundaries request after an unrelated request does not clear the plan", async () => {
	const fixture = await gitFixture(); fixtures.push(fixture);
	const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
		runId: "replay", branch: "feat/replay", worktree: join(fixture.root, "replay") });
	const ctx = context(repo, "replay", "owner");
	const kernel = await openRun(ctx); kernels.push(kernel);
	const boundaries = { kind: "boundaries" as const, decided: [{ category: "non-goals" as const, answer: "No new table." }],
		open: ["business-boundary", "error-path"] };
	const submit = async (intent: unknown, id: string) => kernel.apply({ kind: "request.submit", requestId: id,
		expectedRevision: kernel.inspect().revision, intent: intent as never }, ctx.binding);
	await submit(boundaries, "b1");
	await submit({ kind: "task", task: "implement the seam" }, "t1");
	await expect(submit(boundaries, "b2")).rejects.toThrow(/already consumed/);
	expect(kernel.inspect().grilling?.decided).toHaveLength(1);
});

test("plan validation rejects short invariant, parallel writers, and post-approval mutation", async () => {
	const fixture = await gitFixture(); fixtures.push(fixture);
	const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
		runId: "plan-guard", branch: "feat/plan-guard", worktree: join(fixture.root, "plan-guard") });
	const ctx = context(repo, "plan-guard", "owner");
	const kernel = await openRun(ctx); kernels.push(kernel);
	const submit = (intent: unknown, id: string) => kernel.apply({ kind: "request.submit", requestId: id,
		expectedRevision: kernel.inspect().revision, intent: intent as never }, ctx.binding);
	await submit({ kind: "boundaries", decided: [{ category: "goals", answer: "Ship." }, { category: "non-goals", answer: "None." },
		{ category: "business-boundary", answer: "Desk." }, { category: "error-path", answer: "Fail." }, { category: "acceptance", answer: "Green." }], open: [] }, "b1");
	await expect(submit({ kind: "plan", plan: { activities: [], slices: [{ id: "s1", behavior: "a", test: "ta", dependsOn: [] }], invariant: "short" } }, "p-short"))
		.rejects.toThrow(/one-line invariant/);
	await expect(submit({ kind: "plan", plan: { activities: [], slices: [
		{ id: "s1", behavior: "a", test: "ta", dependsOn: [] },
		{ id: "s2", behavior: "b", test: "tb", dependsOn: [] },
	], invariant: "one failing behavioral slice, then minimal green" } }, "p-parallel")).rejects.toThrow(/parallel writers/);
	await submit({ kind: "plan", plan: { activities: [], slices: [{ id: "s1", behavior: "a", test: "ta", dependsOn: [] }],
		invariant: "one failing behavioral slice, then minimal green" } }, "p-ok");
	await submit({ kind: "propose", content: "Change", scope: "a" }, "prop");
	const candidate = kernel.inspect().candidate!;
	await kernel.apply({ kind: "approve", source: "native-ui", approved: true, runId: "plan-guard",
		digest: candidate.digest, candidateRevision: candidate.revision, ownerEpoch: kernel.inspect().ownerEpoch }, ctx.binding);
	await expect(submit({ kind: "plan", plan: { activities: [], slices: [{ id: "s2", behavior: "b", test: "tb", dependsOn: [] }],
		invariant: "one failing behavioral slice, then minimal green" } }, "p-late")).rejects.toThrow(/unapproved/);
});
