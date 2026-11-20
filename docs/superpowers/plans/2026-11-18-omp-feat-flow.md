# omp-feat-flow implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. If the developer instead selects serial fresh implementation agents, use `subagent-driven-development`. No parallel writers. The repository forbids automatic commits and pushes; omit the skill's default commit steps.

**Goal:** Build a standard, reusable OMP plugin that carries a requirement through complete boundary clarification, explicit design approval, serial implementation, independently checked acceptance, and one PR linked to one Linear issue, without depending on compressed chat history.

**Architecture:** A native extension owns six flat commands and a small run controller. A durable per-run module owns authority, OS leases, short transactions, request consumption, and evidence; Git, questions, external methods, knowledge, cmux, and delivery remain focused modules. Native OMP remains the conversation, UI, installation, and restart runtime.

**Tech Stack:** TypeScript; OMP public SDK and native file locks; Bun test/runtime; real Git; native GitHub CLI and captured native Linear MCP connection; esbuild-generated single-module release artifact. Initial source evidence: OMP 18.22.2. Test runtime/build must still be frozen before execution.

**Spec:** [Technical candidate](../specs/omp-feat-flow-design.md), with the [39-skill audit](../specs/omp-feat-flow-skills-audit.md), [knowledge policy](../specs/omp-feat-flow-knowledge-policy.md), and [native recovery evidence](../specs/omp-feat-flow-native-recovery-evidence.md). Portable references are normalized; spec §14 additionally clarifies historical resource permission versus the current A/B execution decision. The preceding sealed input remains in the private bootstrap index and does not override the current action grant.

**Status:** Planning candidate, not implementation approval. No product code, test, installation, commit, push, PR, or publication has been executed for this plugin. DESK-1358 is the substantive Desktop tracking issue, not a disposable test issue.

## Global constraints

These constraints apply to every task, including test fixtures.

- Source: `plugins/omp-feat-flow`. New OMP catalog: `.omp-plugin/marketplace.json`, named `darian-omp-plugins`, containing only this new plugin. Leave the Claude catalog, old plugins, caches, existing run state, and bug-controller untouched.
- OMP prefers the OMP catalog over the Claude fallback. This intentionally changes future OMP discovery for this repository; it does not uninstall existing legacy packages. Do not claim the old entries remain discoverable through the new catalog.
- Commands: `/feat-flow-start`, `/feat-flow-status`, `/feat-flow-approve`, `/feat-flow-sync`, `/feat-flow-update`, `/feat-flow-finish`. Program registration only; no nested command aliases or prompt-command copies.
- Both entries cover the full grilling boundary: existing Linear/PRD and in-session exploration. Reuse reliable answers; never infer that a PRD or size label means approval.
- Exactly three permission stages: alignment, implementation, delivery. Waiting, recovery, and conflict handling do not become extra business stages. No automatic size classifier, fixed six-stage pipeline, fixed artifact count, or mandatory helper headcount.
- Product writes require approval of the actual current candidate. Human UI waits have no timeout/default approval. Native tool approval, a model signal, stale responses, cancellation, and ordinary chat are not flow approval.
- This development run uses `origin/main` → PR base `main`. Plaud Web's staging → staging is a configurable project example, never a generic default.
- Worktree: `.worktrees/omp-feat-flow`, branch `feat/omp-feat-flow`, immutable start SHA `8b4e44656883c51f5279dc3a71652bccef5e98c2`. Preserve the source checkout and the independent dev worktree.
- Shared project defaults live in the Git common directory. Run authority, owner, baseline, approvals, unresolved operations, and evidence are per-run, never a shared currentRun/currentSHA.
- Use the native OS lease for ownership and a separate short state lock. No stale-PID/mtime/TTL authority, no unlinking lock sidecars, no network/model/UI wait while holding a short lock.
- One durable request outbox, one authoritative run state, and a bounded operation journal. No second flow DSL, upgrade supervisor, old-kernel loader, or cross-product private-state protocol.
- Every controlled tool entry rechecks authority. Context hooks are not security barriers; their swallowed failures cannot open write permission. This is a workflow gate, not an OS sandbox for arbitrary hostile code.
- Auto compact, manual compact, real TUI `/clear`, and new session/fresh process have separate native contracts and live acceptance cases. `/clear` preserving the durable session ID is not a reason to reuse old write credentials.
- One author within a requirement. Independent Standards and Spec review, and real cold-reading of the actual native question packet, earn their place through distinct failure classes; no voting or reviewer-count quality claim.
- Core external methods: `grilling`, `tdd`, `code-review`. Conditional: `research`, `prototype`, `codebase-design`, `to-spec`, `to-tickets`, `wizard`, `wayfinder`, `diagnosing-bugs`, `to-questionnaire`. Do not bundle upstream skill copies or require grill-with-docs. Use the existing 39-skill audit, not another full audit.
- Native helpers use fresh in-memory sessions and private registries, explicit authorized models, no fallback, no ambient history/extensions/context/skills/commands/MCP, and no writes. Cold reader has no tools. Dispose only resources owned by that helper.
- Runtime uses static imports from the host's public SDK and one bundled immutable module/resources. No lazy runtime reads/imports from an installation directory that upgrades can replace.
- `/reload-plugins` does not re-evaluate TypeScript. Upgrade uses the native installer and a quiescent native `/restart`; schema migration and operation reconciliation precede resumed write permission.
- Maintain only relevant existing project guidance: CLAUDE/path rules/project skills/ADRs. No forced docs, glossary, broad knowledge sweep, or speculative rules. Human approval binds the actual necessary knowledge diff.
- No automatic merge, publication, background PR/CI monitoring, global account switch, unapproved cleanup, or git commit/push. Dedicated remote-test permission is not permission to push the product repository.

## Review focus

The following consumer-visible failures must be pinned at their owning seams, not inspected through private implementation state.

1. Two simultaneous requirements and a source checkout with user dirt: isolation, ownership, settings, baselines, and cleanup must remain independent. Tasks 1, 2, 8, 9, and 13.
2. Native lifecycle or a late async completion invalidates the request that began work: no stale context, answer, helper result, or admission can reopen authority. Tasks 2, 3, 5, 7, 10, and 12.
3. The remote operation succeeded but its response or the local receipt was lost: reconcile the exact owned object; never blindly repeat create/push/PR/Linear writes. Tasks 2, 9, 11, and 13.
4. A previously approved plan/evidence/knowledge diff no longer matches the worktree or current integration base: invalidate only the affected grant/proof, without calling a changed SHA a new business requirement. Tasks 5, 9, 10, and 12.
5. A UI action returned, but the page/TTY did not actually perform it, or package installation changed code without restarting the loaded module: verify the real displayed/effective result and build identity. Tasks 5, 8, 12, and 13.

## Current facts and approval boundary

These are observations, not plugin-generated guarantees.

- The actual isolated worktree and private fetch anchor exist. No source checkout switch, stash, or reset was requested.
- [DESK-1358](https://linear.app/plaud/issue/DESK-1358) exists in Desktop, `Planning`, with only the `Epic` issue type. It has no child issues. `Epic` matches the developer's explicit description of bulk work; Desktop's `Feature` description says under five mandays.
- A newly owned non-Bug `Feature` probe, DESK-1357, was deleted through the authenticated native Linear UI. Native Delete has 30-day Recently deleted retention; it is not immediate permanent purge. A relation automatically created by mentioning the example issue in the probe description was removed before deletion. Do not put existing issue identifiers in disposable descriptions unless a relation is intended.
- Current GitHub CLI viewer permission on the product repository was observed as READ. Future authenticated delivery uses a separately authorized, scoped account/token path; never flip global auth or expose tokens. No product push/PR is authorized now.
- The manual bootstrap record in the Git common directory is an evidence index, not a working feat-flow controller. Source inspection and design review are not product E2E results.

## Public test seams requiring explicit confirmation

The first five lanes preserve the previously agreed external surfaces. S2 is now a concrete Git module interface. S6 and S7 are explicit additions; do not write tests against any of them before the developer confirms this table.

| Seam | What the test crosses and catches | What it does not establish |
|---|---|---|
| S1 Native OMP RPC | Actual registered commands, tool admission, real model requests, lifecycle events, and truthful status through the public SDK with the real exported native RPC mode. | Actual TUI focus/rendering or cross-platform terminal behavior. |
| S2 Git module and real Git | `prepare`, `sync`, and `inspectCleanup` against temporary repositories/remotes; inspect real Git/files visible to a developer. Catches source dirt loss, wrong baseline, foreign dirt, and unsafe cleanup. | GitHub/Linear side effects or native UI approval. |
| S3 Native OMP TUI and cmux | Real native InteractiveMode/ordinary native CLI, actual keys, actual question fields, group/workspace identity, clear, receipts, and safe cleanup. | A fake UI, a screenshot of docs, or printed commands cannot satisfy it. |
| S4 Native package manager | Real local Git catalog installation, user-scope discovery, upgrade, reinstall, loaded-build identity, reload versus restart, and no install-time compilation. | Publication or installation into the developer's production profile without separate permission. |
| S5 Real dedicated GitHub/Linear objects | One actual owned PR/issue, exact target/state, response-loss reconciliation, partial success, and authorized deletion of new disposable objects. | Production-repository push/PR, merging, or deleting the retained tracking issue. |
| S6 Run module, proposed addition | The same `openRun`/`inspect`/`apply`/`admit` interface used by the native controller, with real OS locks and two processes. Catches leases, stale epochs, late operations, and persistence failures without tests of private JSON fields. | This alone does not prove native lifecycle timing or actual provider context. |
| S7 Live-model network measurement, proposed addition | A loopback, fixed-upstream transparent test proxy forwards unchanged requests to the approved real provider and real responses back. It counts every forwarded request, enforces declared output/body limits, records redacted wire evidence, and can drop a test connection. | No custom/fake model provider, generated answer, cached success, credential-store copy, or production-model routing change is allowed. SDK/native integration is still tested at S1/S3/S4. |

Tests may read public module results, native RPC/TUI output, actual temporary Git/files, and actual remote objects. Do not assert source strings, private methods, registry wiring, echoes, default lengths, or internal database/JSON fields. A test-only observer records real events/payloads; it never emits lifecycle events or injects expected recovery content.

## File and interface map

All paths below are relative to the worktree. Create a file only in its owning task; this is not permission to scaffold all tests first.

| Path under `plugins/omp-feat-flow/` | Responsibility |
|---|---|
| `src/git.ts` | Real Git preparation, controlled sync, and cleanup inspection. |
| `src/run.ts` | Per-run authority, OS leases, atomic short transactions, request/outbox consumption, and evidence/operation bookkeeping. |
| `src/flow.ts` | Native command/tool orchestration using the run module; no second durable authority. |
| `src/index.ts` | One native extension factory and lifecycle/tool registration. |
| `src/questions.ts` | Render and cold-read the actual native field packet; consume only a current explicit native approval. |
| `src/helpers.ts` | Fresh bounded native SDK jobs for cold reading and read-only review. |
| `src/methods.ts` | Resolve external methods, snapshots/assets, provenance, and permitted dependency updates. |
| `src/workspace.ts` | Own cmux group/workspace handoff and optional non-cmux path. |
| `src/knowledge.ts` | Relevant existing guidance decisions and actual diff proposals. |
| `src/delivery.ts` | Captured native Linear handle, GitHub operations, exact-object reconciliation, and status backwrite. |
| `src/update.ts` | Installed-versus-loaded build checks, quiescence, native restart handoff, and schema migration. |
| `resources/` | Alignment/implementation/delivery and distinct reviewer prompts, statically bundled. Not a skill mirror or flow DSL. |
| `scripts/build.ts`, `scripts/check-release.ts` | Reproducible generation and comparison of the single release module, build fingerprint, and small release metadata. |
| `tests/local/` | Only confirmed S2/S6 behavioral tests using temporary real repositories/processes. No model/network test in default `npm test`. |
| `tests/live/`, `tests/support/` | Confirmed real native RPC/TUI/install/remote acceptance and owned fixture cleanup. |
| `runtime/index.mjs`, `release.json` | Generated, committed release inputs for native installation. Never edit by hand. |
| `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `README.md` | Standalone package/build/test/typecheck and user instructions. |

Shared interface vocabulary is deliberately small:

```ts
// src/git.ts: consumed by the controller, not a test-only adapter.
prepare(input: PrepareInput): Promise<PreparedWorktree>;
sync(input: SyncInput): Promise<SyncResult>;
inspectCleanup(input: CleanupInput): Promise<CleanupAssessment>;
// PrepareInput: repo, remote, startRef, prBase, runId, branch, worktree.
// PreparedWorktree: repoIdentity, commonDir, worktree, worktreeGitDir,
//                  branch, startSha, currentIntegrationSha, privateStartRef.
// SyncResult: clean | needsResolution | unknown, exact observed base/head,
//             touched owned paths, and stale proof identifiers.
// CleanupAssessment: exact owned resource IDs and blockers, never a delete grant.

// src/run.ts: ordinary production callers use this same interface.
openRun(context: RunContext): Promise<RunKernel>;
interface RunKernel {
  inspect(): Readonly<RunView>;
  apply(input: RunInput, binding: HostBinding): Promise<RunOutcome>;
  admit(attempt: ToolAttempt, binding: HostBinding): Admission;
  dispose(): Promise<void>;
}
// RunContext: repo/worktree/run locator, captured host/build identity, open mode.
// HostBinding: program-captured root/session/epoch identity, never model fields.
// RunView: runId, schemaVersion, revision, phase, owner status, approved scope,
//          current task, unresolved operations, material pointers, stale proofs,
//          current integration base, loaded build, and recovery readiness.
// RunInput is a closed union of native-command, host-lifecycle, and model-request
// events; only the native-command path can carry a real current UserDecision.
// Admission: allow or deny with a stable reason and current run/epoch/revision.

// src/flow.ts: native index and native modes consume the same controller.
createFlow(host: NativeHost): FlowController;
interface FlowController {
  command(name: FlowCommand, args: string): Promise<void>;
  lifecycle(event: NativeLifecycleEvent): Promise<void>;
  context(): RecoveryProjection; // synchronous validated snapshot only
  beforeTool(call: NativeToolAttempt): Admission;
  dispose(): Promise<void>;
}
// NativeHost binds actual public OMP context/UI/model registry/root MCP access.
// It is not a fake conversation runtime or an alternate model-facing protocol.
```

Other modules export one focused caller interface: `resolveMethods(request)`, `runHelper(job)`, `presentQuestion(packet)`, `ensureWorkspace(request)`, `proposeKnowledge(request)`, `deliver(request)`, and `inspectUpdate(request)`. Their request/result types carry the run operation identity and current revision where effects occur; they cannot mutate run authority directly.

## Execution and evidence protocol

Every task is a meaningful reviewable slice. Within a task, perform exactly one tracer test → observe RED → minimal implementation → observe GREEN, then choose the next listed uncertain edge and repeat. The listed cases are a sequence, not permission to write a batch of imagined tests. Refactoring belongs to review after the green slice. Test steps intentionally give names and external assertions, not test source: no test code is written before human seam confirmation.

- Before the first test, record the actual human-approved spec/plan/seams and their hashes. Freeze native OMP version/build, Bun version, the approved real model selector, and the exact external method snapshots.
- Initial tooling reuses the repository's locked TypeScript 5.9.3, esbuild 0.25.12, and Node types 22.19.19. Bun 1.4.4 matches the current test runtime; lock matching Bun types and SDK development metadata during approved setup. The host SDK is external in the bundle, not a private runtime copy.
- Native source is Bun-based; use `bun test` for real native locks/SDK imports rather than mocking them to fit a Node-only runner. Keep repository entrypoints `npm run typecheck` and `npm test`; commit `package-lock.json`, not installed dependencies.
- `npm test` means `bun test tests/local`. `npm run test:live -- --case <name>` runs one named live case; `--campaign <id>` shares one explicit bounded live acceptance allowance. Skipped/missing prerequisites never produce full-acceptance PASS.
- After each significant slice, retain command, actual RED/GREEN output, code/worktree fingerprint including uncommitted content, actual review result/model, and unresolved operations in the private bootstrap index. Update it before compact or handoff. An old ACCEPT does not attest new code.
- Independent Spec and Standards review use fresh contexts and the actual files/approved scope. Adversarial design/CR routing is `adversarial-review`, resolved selector `llm-proxy-v2/kimi-k3.1-pro`; unavailable means stop the review, not substitute. Review findings cite actual evidence. Fix defects, do not vote.
- The author stays serial. Prefer a fresh implementation root session with this bounded packet over continuing the exploratory chat; it is not a guarantee against bugs. Do not start the new writer before human plan/seam approval.
- No mid-flight formatter/build/full suite per tiny edit. Run the narrow red/green test for the current behavior; typecheck once after the completed coherent slice. Build only when the next native installed-surface check needs it. Final narrow local suite and coherent live campaign run after integration.

## Task 1: Safe worktree preparation at the real Git seam

This slice establishes the first usable behavior without importing the old engine.

**Files:** Create package/tooling and `src/git.ts`; create `tests/local/git.test.ts` and `tests/support/git-fixture.ts`. No catalog or product publication yet.

**Interfaces:** Produces `prepare(PrepareInput): Promise<PreparedWorktree>` and the shared Git result types above. The controller later consumes the returned immutable `startSha` and private fetch anchor.

- [ ] Write `prepare preserves dirty source and starts from freshly fetched main`: fixture has a dirty source checkout on another branch and a remote main commit absent locally. Assert the returned worktree is on the requested new branch at that actual remote commit, source bytes/staging/branch are unchanged, and start/base values identify the actual repository.
- [ ] Run `bun test tests/local/git.test.ts -t 'prepare preserves dirty source'` from the package. Observe a behavior failure, not an unrelated missing tool/dependency failure.
- [ ] Implement only `prepare`: resolve actual common/worktree Git dirs; validate ownership/path collisions; fetch the configured branch into a run-private ref; add the worktree without checking out/stashing/resetting the source. Use argument arrays, not shell-interpolated commands.
- [ ] Run the same case to GREEN. Next vertical cycle: `two preparations do not share a mutable fetch anchor`; then `existing unrelated path is not adopted or deleted`. Each case gets its own RED/minimal GREEN cycle.
- [ ] Run `npm run typecheck` once and retain proof. No test executes against the developer's existing worktree.

## Task 2: Per-run authority, real ownership, and durable operations

This slice makes the run module the only authority; prompts and signals cannot substitute for it.

**Files:** Create `src/run.ts`, `tests/local/run.test.ts`, and a real child-process fixture in `tests/support/run-process.ts`. Extend shared types only where production callers require them.

**Interfaces:** Produces `openRun`, `RunKernel`, `RunView`, `RunInput`, `HostBinding`, `Admission`, and operation/evidence result types from the map. Consumes actual paths from Task 1 and public `acquireFileLock`/`tryAcquireFileLock` from the host utility module.

- [ ] Write `second process cannot mutate an owned run`: one child holds the real native OS owner lease; another attempts the public module operation. Assert Busy and no changed public view, then allow a different run concurrently. Coordinate processes through explicit barriers, not sleeps/fake clocks.
- [ ] Run `bun test tests/local/run.test.ts -t 'second process'` to RED; implement owner lease and separate bounded short transaction lock, atomic replacement, and read-only inspection; run to GREEN.
- [ ] Next vertical cycle: `stale candidate and late epoch cannot grant writes`. Approve one exact candidate through a native-origin decision input, advance its revision/epoch, submit the old response/request, and assert denial through `admit` and unchanged public approval.
- [ ] Next cycle: `unknown external operation is not dispatched again`. Use real operation input/results through `apply`; a lost settlement must expose Unknown, not silently reissue it. A definitely unstarted prepared operation may be resumed; dispatched/unknown requires reconciliation.
- [ ] Next cycle: `failed durable replacement cannot expose an unpersisted grant`. Use an actual unwritable/failed temporary storage condition; observe rejection through the public interface. Never unlink a lock sidecar or treat a PID/timeout as a lease.
- [ ] Persist schema/revisioned shared project defaults separately from run facts: Git remote/startRef/prBase/worktree root, GitHub repository, Linear workspace/team/status mapping, explicit model policy, and relevant existing knowledge entry paths. Never store credentials or a shared active run/baseline/owner. First start asks only for facts tools cannot establish, and saves actual developer choices; subsequent concurrent runs snapshot defaults independently. Write only a non-authoritative worktree locator. Test two runs through the public interface, not by asserting internal JSON layout. Run the owning local cases and typecheck once.

## Task 3: Native commands and every-tool admission

This slice connects authority to actual OMP execution. Recovery acceptance follows real method loading, questioning, and approval in Task 7; do not seed private run state to fake that setup.

**Files:** Create `src/index.ts`, `src/flow.ts`, `resources/stages/`; create `scripts/build.ts`; create `tests/live/admission.test.ts`, `tests/support/native-host.ts`, and a passive native observer. Add only the live harness support needed for this slice, including the approved S7 meter.

**Interfaces:** Produces `createFlow` and the controller interface above, a single `package.json` `omp.extensions` entry to `runtime/index.mjs`, and native registered start/status commands and controlled signal tools. Register each further command only when its real behavior is implemented, not as a working-looking stub. Capture the concrete root MCP handle before creating any helper; binding/target validation is completed in Task 11. Consumes Tasks 1–2. Registered model signal tools fill actor/run/epoch/revision/request identity programmatically; model arguments carry requests, never identity or approval.

- [ ] First native tracer: `an unapproved controlled write is actually intercepted`. Launch the actual native RPC mode with the real extension in an owned fixture. Obtain an actual native `tool_call` attempting the fixture write. Assert the actual deny reason and unchanged real files/Git. No tool attempt means NO_TOOL_ATTEMPT failure, not a successful guard test.
- [ ] Run `npm run test:live -- --campaign <approved-id> --case unapproved-write` to RED; implement command registration, safe start/status, and fail-closed admission through the public run view; rerun only that case to GREEN.

## Task 4: Real external methods and bounded dependency maintenance

This slice provides the actual methods, not stubs copied into stage prompts.

**Files:** Create `src/methods.ts`, initial `src/helpers.ts`, and `tests/live/methods.test.ts`; extend native start/update handling.

**Interfaces:** `resolveMethods(request: MethodRequest): Promise<MethodSnapshotSet>` returns exact selected paths, upstream/provenance/content digests, referenced assets, and permitted update outcomes. `runHelper(job: HelperJob): Promise<HelperReceipt>` owns one fresh isolated SDK session and terminal disposal.

- [ ] Native tracer: `missing core method stops before issue branch worktree or workspace creation`. In a dedicated profile, remove one actual core method and invoke native start. Observe static dependency guidance and use actual Git, dedicated Linear search, and cmux inspection to prove no issue, branch/worktree, or workspace was created; source bytes remain unchanged. No fake method stub may make this green.
- [ ] Run `npm run test:live -- --campaign <approved-id> --case methods-missing` to RED; place method/model/credential preflight before `prepare`, remote issue creation, and workspace creation; implement actual resolver/snapshot/provenance; run the same case to GREEN.
- [ ] Next independent cycle: `missing model or credential gives static login model guidance without inference`. Use a genuine empty-credential or unavailable-selector native fixture; assert native `/login` and `/model` guidance, no question UI/uncold-read wizard, no fallback, zero S7-forwarded requests, and no issue/branch/worktree/workspace creation. Run `--case model-missing` to RED, implement only this fail-closed preflight, then GREEN.
- [ ] Next cycle: `a modified method is preserved and not silently updated`. A fixture global copy differs from its known-source baseline. Native update must report the difference and preserve it; approved, known-source unmodified copies may update. No blanket all-skills or ambient package update.
- [ ] Snapshot actual used method content and referenced assets into the run; retain in-flight revision semantics when upstream changes. Resolve the three core plus selected conditional methods using their actual metadata/provenance; `grill-me` is not an extra runtime method or required compatibility alias. At dependency inspection, check known upstream versions and apply only the already permitted selected, known-source, unmodified updates; do not rewrite an in-flight method snapshot.
- [ ] Build helper sessions with explicit cwd/model/registry/auth and private in-memory registries, disabled ambient resources, MCP, process-state binding, warming, writes, and fallback. Cold reader: no tools. Review jobs: bounded read-only tools. Await terminal completion, bind receipt to task/epoch/snapshot, and dispose only the child.
- [ ] Test isolation through actual request/tool evidence at S1/S7, not private registry inspection or a fake model answer. Run the narrow owning case and typecheck.

## Task 5: Cold-readable questions and exact native approval

This slice prevents hidden-context questions and accidental default approval.

**Files:** Create `src/questions.ts`, cold-reader resources, and `tests/live/questions.test.ts`; connect helpers and the native approve command.

**Interfaces:** `presentQuestion(packet: NativeQuestionPacket): Promise<HumanDecision | Cancelled>` renders the same packet the cold reader received. The packet includes purpose, facts, options/tradeoffs, recommendation, missing information, and the exact permission consequences in the actual native field titles/descriptions/options. `UserDecision` binds native provenance plus candidate/packet digest, current run/epoch/revision, and explicit selected action.

- [ ] First cycle: `a cold reader can resolve the actual native packet without author context`. Observe real RPC question frames and the actual TUI fields; compare the submitted choice with its permission explanation. Raw HTML alone is not the cold-read object.
- [ ] Run `npm run test:live -- --campaign <approved-id> --case question-packet` to RED; implement packet construction, one fresh cold-read job per version, and exact replay; rerun to GREEN.
- [ ] Next cycle: `cancel and stale native approval leave implementation closed`. Present candidate A, change to B, respond/cancel A through the actual native UI path, and assert a real refused write. No UI timeout is supplied; no default/partial answer completes missing decisions.
- [ ] Next cycle: `ready is not a transition`. A model proposes readiness; the visible candidate is available for review, but no approval dialog or implementation/write transition is forced. Only the user invoking the native approve command can grant its current explicit action.
- [ ] Show a native approval that really opens the approved scope, then change a relevant candidate or knowledge diff and observe the appropriate grant become stale. Do not add a separate mandatory human code-diff/reset/squash gate.

## Task 6: Complete grilling and an adaptive implementation plan

This slice supplies the product experience rather than a hardcoded stage template.

**Files:** Extend `src/flow.ts` and bundled alignment/implementation resources; create `tests/live/entries.test.ts`. Use upstream snapshots from Task 4, not duplicate skills.

**Interfaces:** Both entry requests converge to the same persisted scope/candidate/material model. Optional prototype/research/spec/ticket/wizard activities carry their actual reason and output; they do not create new permission stages or additional requirement issues.

- [ ] Tracer: `unclear existing PRD still exposes an unresolved boundary before approval`. Use a fixture PRD with a specific missing authorization/error-path decision. Through the actual native flow and cold-readable question, resolve that gap and preserve reliable existing answers; observe that implementation was closed until real approval.
- [ ] Run `npm run test:live -- --campaign <approved-id> --case entry-prd-boundary` to RED; implement the shared grilling/candidate path and only required conditional activity; rerun to GREEN.
- [ ] Next cycle: `conversation entry covers the same boundary without a repeated full interview`. Give a small, fully bounded fixture request and previously supplied answers; confirm no forced prototype/spec/ticket pipeline and no automatic approval.
- [ ] In a larger fixture, require a concrete uncertain seam/prototype and serial test slices; ensure these actually reduce the declared uncertainty instead of creating fixed stage-6 paperwork. Record the approved public seams before any test.
- [ ] The implementation prompt enforces one failing behavioral slice → minimal green → review, actual proof and material pointers, and no parallel writers. Do not create a second task DSL or retry supervisor.

## Task 7: Four native recovery entries after real approval

This slice requires Tasks 3–6: its approved fixture is built through the actual native question/approval path, never by patching run files or fabricating a human decision. It is separate from basic admission because native recovery timing can fail while ordinary tool gating works.

**Files:** Extend `src/index.ts`, `src/flow.ts`, and `src/run.ts`; create `tests/live/recovery.test.ts`; reuse the actual native modes and passive observer from Task 3.

**Interfaces:** Consumes `FlowController.lifecycle/context/beforeTool`, the public run view, and actual native question approval. Produces validated ready/blocked projections, truthful visible receipts, and revalidated session/epoch binding at the native lifecycle entries documented in the recovery appendix.

- [ ] First tracer: `automatic compaction continuation receives its recovery context`. Trigger native automatic compaction from real accumulated fixture material/tool results, including direct tool-loop continuation without another `before_agent_start`. Capture the first actual following business request at the native observer and real provider wire. Assert literal approved scope, stage, current task, unresolved/stale proof facts, and material pointers; never inject the expected projection through the harness.
- [ ] Run `npm run test:live -- --campaign <approved-id> --case recovery-auto` to RED; implement automatic continuation recovery, then run only that case to GREEN. Next independent cycle: `manual compaction restores the first following request`. Drive actual RPC `compact`, with automatic compaction disabled in that fixture. Then independently cover actual TUI `/compact`, including native completion/cancellation. Check each first following request, truthful receipt, and real denied stale write; do not emit a hook manually or call prompt acknowledgement compaction completion.
- [ ] Next independent cycle at S3: `real TUI clear invalidates old write binding although durable session ID remains`. Type the actual `/clear` in the real native TUI. Verify the native event, first following request, revalidated ownership, receipt, and denial of an old credential/operation. RPC literal `/clear` or `new_session` is not this case.
- [ ] Next independent cycle: `new session and same-cwd fresh process relocate but do not inherit authority`. Exercise native `/new`/RPC new-session and a separate process. Show actual owner conflict/rebind outcomes, not a fake session_start event.
- [ ] Next negative cycle: corrupt/remove required material or hold recovery beyond its cancellation boundary; verify blocked projection/receipt and an actual refused controlled write. A late recovery completion cannot change readiness back to ready.
- [ ] `context()` uses only the latest validated synchronous snapshot. Async recovery happens at observable lifecycle boundaries; no model/network/long wait inside the context hook. Produce a truthful ready/blocked receipt from persisted facts; unknown PR state must say unknown. Record source timing separately from actual live proof.
- [ ] Run manual RPC and TUI, clear, new-session, fresh-process, and recovery-failure cases individually with `--case recovery-manual-rpc`, `recovery-manual-tui`, `recovery-clear`, `recovery-new`, `recovery-fresh-process`, and `recovery-failure`. Each gets its own observed RED/minimal GREEN cycle. None is replaced by a source assertion or manually emitted lifecycle event.

## Task 8: Optional cmux handoff and parallel requirement isolation

This slice gives each requirement its own workspace without touching another developer's terminal.

**Files:** Create `src/workspace.ts` and `tests/live/workspace.test.ts`; extend the native start/finish/status paths.

**Interfaces:** `ensureWorkspace(request: WorkspaceRequest): Promise<WorkspaceReceipt>` returns exact window/group/workspace/surface IDs, ownership marker, and verified handoff outcome. Absence of cmux returns the explicitly supported non-cmux path, not a pretend successful switch.

- [ ] Tracer: `two requirements get distinct groups and workspaces and preserve a foreign group`. Create owned temporary cmux resources plus a foreign fixture resource. Each requirement uses its own `feat: <short title>` group, with its own requirement workspace; an existing corresponding bug workspace may be in that same requirement group without a new bug-controller protocol. Verify actual UUIDs/cwd/native context, not printed commands or a shared group named features.
- [ ] Run `npm run test:live -- --campaign <approved-id> --case workspace-isolation` to RED; implement public cmux IPC/CLI identity-based create/select and real context handoff; run to GREEN.
- [ ] Next cycle: `finish refuses to close or delete a foreign or dirty resource`. Observe developer-visible cleanup blockers; final cleanup removes only exact owned, safe resources. A reused group is never owned merely because its title matches. Measure whether closing the owned workspace actually terminates its owned descendant processes; closing a window alone is not process cleanup proof.
- [ ] Exercise non-cmux in an actual subprocess without the cmux connection; show the worktree path and truthful handoff instructions. Never auto-start a second writer while the original owner is active.

## Task 9: Mid-flow sync and proof invalidation

This slice separates immutable origin history from the current integration/review base.

**Files:** Extend `src/git.ts`, native sync orchestration, and run evidence handling; extend `tests/local/git.test.ts` and native sync acceptance.

**Interfaces:** Implements `sync(SyncInput): Promise<SyncResult>` using the current run revision, configured remote/base, exact known run-owned changes, and an operation ID. Returns explicit resolution/unknown outcomes; the controller records the new integration base only after observed success.

- [ ] Tracer: `sync advances review base but not start SHA and preserves only the feature diff`. Remote main advances; the feature has owned committed work. Sync through the production interface; compare real developer-visible branch/diff and ensure only affected proofs become stale.
- [ ] Run `bun test tests/local/git.test.ts -t 'sync advances review base'` to RED; implement fetch into the run's private ref and controlled rebase/integration; run to GREEN.
- [ ] Next cycle: `known owned dirt can be checkpointed but foreign dirt is refused`. No add-A, autostash, reset, or guessed file ownership. The actual checkpoint and its lineage must be visible and recoverable.
- [ ] Next cycle: `conflict resolution preserves the approved intent and interruption is recoverable`. Use real conflicting commits. Persist the operation before mutation; conflict resolution uses bounded actual material and approved scope. On interruption, inspect actual rebase/index/branch facts before resuming; never fabricate a successful new SHA.
- [ ] Exercise native `/feat-flow-sync` with real status/receipt. Successful unchanged-scope sync requires renewed verification/review, not another business-plan interview. Pre-PR delivery must invoke the same sync path before final proof.

## Task 10: Actual verification, independent review, and relevant knowledge

This slice makes evidence correspond to the current worktree, not an author's claim.

**Files:** Create `src/knowledge.ts`, review resources, and `tests/live/acceptance.test.ts`; extend evidence/current-candidate handling.

**Interfaces:** `proposeKnowledge(request: KnowledgeRequest): Promise<KnowledgeProposal>` returns no-change with reason, or the actual relevant existing-file diff and material evidence. Review receipts identify the exact worktree/base/candidate and their actual model/result.

- [ ] Tracer: `synchronizing after green evidence prevents delivery until reverified`. Complete an actual fixture check/review, advance the integration base through Task 9, and attempt delivery. Observe stale evidence and no push/PR; run the real affected check and independent review before proceeding.
- [ ] Run `npm run test:live -- --campaign <approved-id> --case stale-proof` to RED; implement proof identity/invalidation and actual test/review completion; run to GREEN.
- [ ] Next cycle: `a relevant path-rule correction needs its actual diff approved, while no-change creates no docs`. Use existing fixture path rules/project skill guidance and one concrete recurring-error scenario. Generate only the warranted correction; cancellation/changed diff keeps delivery closed. In a no-change fixture, do not create glossary/docs or new rules.
- [ ] Standards reviewer reads actual related code/project conventions and relevant knowledge result. Spec reviewer independently reads the approved scope and actual consumer behavior/evidence. Use distinct jobs/material packets, not agreement voting or an author-written success summary.
- [ ] A late review result for an old epoch/code/base cannot restore acceptance. Failed checks/findings are handled, not suppressed or repinned into implementation-coupled tests.

## Task 11: One PR/Linear delivery with exact-handle reconciliation

This slice performs real authorized side effects once and repairs partial success safely.

**Files:** Create `src/delivery.ts`, `tests/live/delivery.test.ts`, and only the owned remote-fixture support needed here. Extend native delivery orchestration and operation settlement.

**Interfaces:** `deliver(request: DeliveryRequest): Promise<DeliveryReceipt>` consumes exact run/scope/base/head/proof identities, one requirement issue, authorized repository/PR target, and a captured native Linear binding. Results distinguish prepared, dispatched, settled, and unknown operations plus actual PR/issue state.

- [ ] Before remote writes, use the exact native root `MCPManager` handle already captured in Task 3, before any helper. Validate that handle's source/config/viewer/workspace/team/tool capability and the exact target. If it is unavailable or changed, block; do not reacquire via a global singleton, construct another manager, or reinterpret a helper's global slot as the root. Helpers keep MCP disabled.
- [ ] Tracer: `actual PR success followed by Linear failure repairs only the backwrite`. Use a newly owned disposable remote repository/PR and separate Desktop non-Bug issue with verified delete permission. Read the actual PR through GitHub and actual issue through Linear; no fake service responses.
- [ ] Run `npm run test:live -- --campaign <approved-id> --case delivery-partial-success` to RED; implement pre-PR sync → renewed real checks/review → authorized push/one PR → correct Linear state/backlink; rerun only the failed scenario to GREEN.
- [ ] Next cycle: `lost create response reconciles the actual owned PR/issue instead of duplicating it`. Deliberately drop only the owned test connection after the real server operation; reconcile via branch/head/repository/operation marker and exact issue identity. Do not choose the first search match or repeat an unknown create.
- [ ] Next real S5 cycle: `lost push receipt reconciles exact remote head before retry`. After a real push applies to the owned remote, drop only its test result connection or terminate the owned caller before receipt settlement. Read the exact remote branch/head and reconcile the dispatched operation; no blind second push or guessed success. Run `--case push-response-lost` through RED/minimal GREEN.
- [ ] Next real S5 cycle: `lost Linear backwrite receipt reconciles exact issue state and link`. Let the real server apply the owned issue update, then lose the test response before settlement. Reconnect the same authorized binding, read that exact issue/state/link, and settle without repeating the update or creating another object. Run `--case linear-backwrite-response-lost` through RED/minimal GREEN. No fake success, fabricated receipt, or private run-file mutation is permitted.
- [ ] Next cycle: `a replaced MCP source/viewer cannot redirect an approved write`. Use an owned fixture source switch or loss, not production config edits. Observe blocked remote dispatch and unchanged actual target. Source mismatch is not permission to search for a different connection with a similar tool name.
- [ ] Existing-issue entry uses that one issue, conversation entry creates only one substantive issue after complete deduplication. No auto-child issues/project creation. Map project status IDs from actual metadata; repair only the failed operation. Never auto-merge or treat CI monitoring as part of finish.
- [ ] After observing real results, close the owned test PR, delete only its owned private test repository and the dedicated Linear test issue, and verify actual cleanup. A PR is closed, not directly deleted; deleting its dedicated repository removes that fixture. Platform recovery/retention still applies. Cleanup failure makes the full campaign fail visibly; retain a cleanup ledger, not a false PASS. DESK-1358 is never a cleanup target.

## Task 12: Native update and restart without an old-kernel loader

This slice preserves a running flow when installation changes, without pretending reload is code hot replacement.

**Files:** Create `src/update.ts`, `tests/live/update.test.ts`, and `tests/support/install-fixture.ts`; extend the Task 3 build script with actual release metadata and immutable fingerprint generation. The install fixture creates a real temporary local Git catalog/repository plus dedicated native profile and drives the native installer/upgrade/restart. Task 13 reuses this same fixture; it does not invent a second installer path.

**Interfaces:** `inspectUpdate(request: UpdateRequest): Promise<UpdateAssessment>` compares immutable loaded build identity with read-only native installation registration/small release metadata. Migration runs under the existing short run transaction and returns a validated current view before admission.

- [ ] Before the update tracer, build real releases A/B into that owned local Git fixture using `scripts/build.ts`, with ordinary `omp.extensions`, generated metadata, and no installed dev node_modules/compiler. Commit only the temporary fixture repository and install A through the actual native user-scope catalog path. This prerequisite belongs to Task 12; Task 13 later adds the production catalog/CI/docs and integrated installed acceptance.

- [ ] Tracer: `installed new build does not change the loaded controller until native restart`. Install release A in the dedicated native profile, start a run, upgrade to B, and actually issue `/reload-plugins`. Observe loaded A and installed B; it must not claim B code is running.
- [ ] Run `npm run test:live -- --campaign <approved-id> --case update-restart` to RED; implement immutable embedded resources/build ID and native update assessment; rerun to GREEN after the actual native restart path.
- [ ] Next cycle: `same-version reinstall is detected by content build ID`. Replace the dedicated installed artifact with another correctly built artifact of the same version; observe the mismatch without loading new code/resources into the old controller.
- [ ] Next cycle: `active writes or unknown operations block restart readiness`. Quiescence means no active local admission and no unresolved dispatched effect; do not kill/restart midway through writes, auto-spawn `-e H`, or use ctx.shutdown as an automatic upgrade supervisor.
- [ ] New build validates schema and migrates/reconciles before ownership is ready. Unsupported schema, failed migration, missing material, or ambiguous external state stays blocked with a truthful receipt. Old completion callbacks cannot reopen the new epoch. Test the actual restored request/tool outcome, not only metadata fields.

## Task 13: Standard release artifact, native install, finish, and whole-flow acceptance

This slice completes the entire promised product. It is not permission to publish it.

**Files:** Complete build/release scripts; add `.omp-plugin/marketplace.json`, `.github/workflows/check-omp-feat-flow.yml`, package README, scoped package ignores, and root README integration. Extend `scripts/hooks/pre-commit`, `scripts/hooks/pre-push`, and fix `scripts/setup-hooks.sh` to use Git's resolved hooks path in linked worktrees. Add installed-flow acceptance under `tests/live/`.

**Interfaces:** `package.json` version and catalog entry start at `0.1.0`. `omp.extensions` has one `runtime/index.mjs` entry. `release.json` records schema/version/buildId and host capabilities, not executable resources. `buildId` fingerprints sorted source/static resources/build script/compiler config/package lock and build-tool identity, excluding generated output/timestamps/absolute paths.

- [ ] Release generation uses esbuild with static resources and host `@oh-my-pi/*` imports external. There is no bundled private SDK/MCP singleton, install-time build, plugin-local dev node_modules dependency at runtime, or second registration entry.
- [ ] Commit generated `runtime/index.mjs` and release metadata with the source in the eventual user-approved PR. New CI uses Node 22/npm ci and pinned Bun 1.4.4, runs typecheck/local cases, rebuilds into a temporary output, and compares actual release bytes/fingerprint/version/catalog. CI never commits or pushes. Do not copy ai-flow's bot-force-commit pattern or edit its CI.
- [ ] Native installed tracer: install from a real owned local Git catalog/repository fixture, user scope in a dedicated native profile, with no node_modules/developer compiler in the installed tree. Start the actual flow and observe its effective context/admission, not just command names. Then native upgrade, reload, restart, and same-version reinstall follow Task 12.
- [ ] Run `npm run test:live -- --campaign <approved-id> --case installed-flow` to RED; finish manifest/discovery/release integration and native finish cleanup; rerun to GREEN. Installation callbacks alone do not establish that the loaded runtime changed.
- [ ] Verify shared hook changes with a throwaway real Git repository/worktree and a real deliberate TypeScript failure blocking commit, then a valid fixture passing. Do not commit to this product branch or install over the developer's existing hooks as a test. No permanent source-string/echo/wiring test for hook text.
- [ ] Run the owning local suite and typecheck once after integration. Run the bounded real campaign across both entry types, concurrent requirements, controlled sync/conflict, current proof/knowledge approval, partial delivery, all four recovery entries, native install/update, and safe finish. Actual native CLI smoke supplements the SDK-backed real native modes; the harness does not implement another RPC server or chat UI.
- [ ] Inspect actual TUI at desktop/normal terminal dimensions, cold-read actual native question fields, actual first provider request, actual file/Git effects, actual GitHub PR and Linear state, and actual owned-resource cleanup. Missing account/model/tool, skipped live case, NO_TOOL_ATTEMPT, or failed cleanup is not whole-flow acceptance.
- [ ] Update user docs/changelog in the package README for actual shipped commands, installation, prerequisites, project defaults, dependency update policy, permission boundaries, sync/recovery/update/finish, known verified platform/runtime, and truthful failed-recovery remedies. Remove throwaway fixtures only after their receipts/cleanup are saved. Preserve permanent behavioral tests only at confirmed seams.
- [ ] Final independent whole-branch Spec/Standards/adversarial review reads the real current worktree and all live evidence. Report resolved models, addressed findings, exact tests, remaining limits, and uncommitted state. Stop for explicit commit/push/PR/publication instructions; passing tests do not grant them.

## Bounded real acceptance campaign

This is a proposed test authorization, not a test already run. Keep local Git/OS-lock tests independent of paid model calls.

- This B decision grants exactly **one campaign across RED/GREEN and integrated reruns**, with at most **96 forwarded real inference HTTP requests**, at most **8192 requested output tokens per request**, at most **1 MiB request body**, and **one live scenario at a time**. Each scenario has a **5-minute wall-clock deadline**; cumulative active test execution has a **30-minute limit**. Coding intervals between fully stopped cases do not consume active-test time; a running case cannot pause its clock. Root, cold readers, review helpers, summarization/title requests, and retries all count. Never reset allowance by another script/process/campaign; uncertain usage blocks resumption until reconciled. Further allowance needs new explicit approval. These ceilings are not a monetary-billing guarantee and do not include the development conversation or independent development-review agents outside the tested plugin.
- Approved default selector for the proposal: `llm-proxy-v2/kimi-k3.1-pro`. Verify availability and native transport/output-limit support before any inference. Unavailable/incompatible means a visible preflight block and a new explicit selector decision, not fallback or a model substitution. Product users retain their own authorized model policy.
- The real native host uses public ModelRegistry/provider configuration only in the owned fixture to route the selected genuine provider/model to a loopback fixed-upstream pass-through meter. Preserve provider/model identity, original native transport, upstream endpoint, and normal credential resolution; only the fixture route and output ceiling change. Native `registerProvider` can override routing/model metadata without a custom stream provider. Never register a canned provider, copy private credential stores, log auth headers, or edit the developer's global model config.
- Before the campaign, prove every possible inference path is either routed through that meter or refused before dispatch. Disable warming/fallback/prewalk and bind side/helper model selectors explicitly. If any native path cannot be bounded through public configuration, do not start the campaign or pretend the main-loop dispatch callback covers it.
- The meter refuses forwarding before the 97th real request, an oversized/uncapped request, or exhausted active-test time; the scenario watchdog stops the owned test host at five minutes. Exhaustion fails the campaign and permits only reachable no-inference cleanup, not another test or a reset campaign. It never returns a fabricated successful model answer. Upstream failures and deliberately dropped fixture connections remain real failures. Retry consumes another allowance.
- Use actual native public SDK session creation and exported `runRpcMode`/`InteractiveMode`, plus actual native CLI/package-manager smoke. No alternate RPC protocol or synthetic TUI. Native CLI discovery must use ordinary user-scope installation; do not overwrite extensions arrays, blanket-disable unrelated plugins, or load a duplicate candidate with `-e` as a substitute for install proof.
- The test observer records native lifecycle/provider/tool/UI events and the first actual business-request projection. Match its redacted/canonical payload fingerprint with the real forwarded wire payload; do not infer first-request context from a later status response or feed expected recovery facts into the prompt.
- Live fixtures contain synthetic code/requirements and public native/method prompts only, never Plaud Web production source/PRDs, customer material, or secrets. Native/tool metadata can include owned resource IDs and operator/team identity. These prompts, code, metadata, and responses go to the approved real service under that service's retention policy; the plugin cannot delete provider-side data or promise zero retention.
- The meter processes full payloads in memory, does not persist auth headers or complete prompt/response bodies, and retains only canonical hashes, timing/status, selected synthetic context sentinels, tool names, and redacted outcomes for proof. Delete owned native profiles/raw session logs and transient buffers when the campaign ends after deriving minimum evidence. Minimal redacted evidence remains in the private bootstrap/run index until explicit developer archive/deletion; no background retention daemon. If ambient production context cannot be excluded, block rather than forward it.
- For a required guard attempt, allow at most three real model requests to obtain an actual native tool_call. No attempt means a failed case. Do not fabricate an event, directly edit run state, or assert that model obedience proves interception.
- Native TUI clear is its own actual-key scenario. New session/fresh process are distinct checks. Automatic compaction must include real tool-loop continuation; source event names are not runtime proof.
- All fixtures have an ownership marker and cleanup ledger: temporary directories/repos, dedicated native profiles, owned cmux resources, newly authorized private GitHub test repositories/PRs, and new non-Bug Desktop issues. Verify repository/Linear delete capability before creation. Close the owned PR, delete its dedicated repository, and use native Delete for the dedicated Linear issue with its 30-day recovery retention. Do not promise direct PR deletion or immediate physical purge. Preserve the retained tracking issue and unrelated resources. Reuse Task 12's installer fixture; the final installed campaign also verifies real GitHub catalog cloning/upgrading in the owned private test repository, not publication of an unaccepted product release.
- No user production-profile install, product commit/push/PR, merge, or publication is included. If the developer grants only implementation now, live/remote actions remain pending and no whole-flow PASS is claimed.

## Coverage and handoff

The complete spec maps to tasks as follows; no required behavior is intentionally deferred.

| Spec area | Owning tasks |
|---|---|
| §§1–2 Product, commands, entries | 3, 5, 6, 8, 11, 13 |
| §3 Standard package and native upgrade | 3, 12, 13 |
| §4 Project defaults/concurrency | 1, 2, 6, 8, 11 |
| §5 Permission stages | 2, 3, 5, 6, 10, 11 |
| §6 Cold reading and explicit approval | 4, 5 |
| §§7–8 Methods, conditional activities, justified agents | 4, 6, 10 |
| §9 Sync and moving review base | 1, 9, 10, 11 |
| §10 Locks, ownership, outbox, operations, four recovery entries | 2, 3, 7, 9, 11, 12 |
| §11 Existing knowledge policy | 6, 10 |
| §12 Deterministic delivery and finish | 8, 10, 11, 13 |
| §§13–14 Confirmed seams, real E2E, deletion, cleanup | All tasks and bounded campaign |
| §15 Deleted legacy costs and honest proof state | Global constraints and final review |

Before a new implementation context starts, the private handoff index must identify this exact plan/spec revision, the actual human answer approving seams/actions, current task and worktree/code fingerprint, outstanding operations, actual RED/GREEN/review receipts, model/dependency/native build identities, and cleanup obligations. Hash mismatch, missing material, stale evidence, or ambiguous ownership blocks the related write. Do not ask a new author to reconstruct authority from a compacted summary or chronological exploration log.

## Human review requested

Review this plan and the seven seams before implementation. Recommended execution: one fresh native implementation context as the serial author, with independent fresh reviews at meaningful slice boundaries and a whole-branch review at the end; no parallel writers. A serial fresh-author-per-task approach is also viable if explicitly chosen.

Decisions needed now are only: whether this plan and S1–S7 capture the intended interfaces/acceptance; whether to start implementation under the stated serial method; and whether the separately described bounded live/installation/dedicated-remote test scope is authorized. A response granting implementation only does not grant testing, installation, product commit/push/PR, or publication. Do not auto-present or auto-accept approval merely because this draft or an agent review is ready.
