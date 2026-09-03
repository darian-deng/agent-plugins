import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  appendFileSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  realpathSync,
} from 'fs';
import { randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { join, dirname, resolve, relative } from 'path';
import type { FlowConfig } from './flow-schema.js';
import { lookupSession, listBindings, removeBinding } from './session-registry.js';

/**
 * One field, still an object. The wrapper earns its place at the read boundary:
 * `normalizeActiveState` tells the current shape from the pre-wrap-up one by
 * whether this key holds an object, and a bare nullable number would make
 * "present and null" versus "absent" load-bearing instead. A second field later
 * (the stage that latched, a timestamp) then costs nothing at the ~15 write sites.
 */
export interface ContextWrapUp {
  /**
   * Context occupancy at the FIRST crossing of the flow's `wrap_up_at_pct`, or
   * null while it has never been crossed. This doubles as the latch: non-null
   * means the wrap-up has started, which is what pretool-handler reads to refuse
   * writes to the codebase (the flow's own docs stay writable). It freezes at the
   * first crossing, so the refusal can name the level it happened at — and,
   * since the latch is persistent (only a new session / `/clear` clears it),
   * "already wrapping up" needs no repeated injection to stay true.
   */
  at_pct: number | null;
}

/** Shape written by the two-level (warn + block) engine. Read-side only. */
interface LegacyContextFields {
  context_warning?: {
    warned?: boolean;
    warned_at_pct?: number | null;
    warned_at?: string | null;
    block_reminded_at_pct?: number | null;
  };
  context_blocked?: boolean;
}

export interface ActiveState {
  flow_id: string;
  flow_name: string;
  requirement: string;
  current_stage: string;
  base_sha: string;
  started_at: string;
  last_session_id: string | null;
  context_size: number;
  context_wrap_up: ContextWrapUp;
  /**
   * Whether this session's first non-command user prompt has already been
   * given the resume guidance (Layer 2 in userprompt-handler). Reset to false
   * by SessionStart on a new session / clear / compact so the next prompt is
   * re-guided. Absent on flows created before this field existed — treat
   * undefined as "not yet handled".
   */
  first_prompt_handled?: boolean;
  /**
   * All session IDs that have ever been the owner of this flow instance.
   * Append-only; used for auditing. Populated by SessionStart.
   */
  history_session_ids?: string[];
  /**
   * Git SHA of the "Stage 1-3 docs" commit created at the start of Stage 4.
   * Stage 5 and Stage 6 use this as the diff base to scope reviews to only
   * the code changes of the current flow. Set by Stage 4 Step 1; absent until
   * then. Stored here (not as a separate file) so it is naturally flow-scoped:
   * a new flow gets a fresh active.json with no base_sha_code, eliminating
   * cross-flow pollution.
   */
  base_sha_code?: string;
}

function statePath(repoRoot: string, flowName: string, file: string): string {
  return join(repoRoot, '.ai-flow', flowName, 'state', file);
}

function stateDir(repoRoot: string, flowName: string): string {
  return join(repoRoot, '.ai-flow', flowName, 'state');
}

/**
 * Bring an active.json written by the two-level engine (`context_warning` +
 * `context_blocked`) onto the single wrap-up threshold. Real flows are mid-run
 * with state files in the old shape, and every read in the codebase goes through
 * `readActiveState`, so this is the one place that needs to know the old shape:
 * the next `patchActiveState` spreads the normalized object, and the old keys
 * stop being written from then on.
 *
 * `at_pct` is carried over ONLY when the old file had actually latched
 * (`context_blocked: true`). The old `warned_at_pct` also moved for the mere warn
 * level — 50% against a 60% block — so carrying it unconditionally would tell the
 * new engine the wrap-up had already started at 55% and make pretool refuse code
 * writes to a session that was never blocked. Not latched → null, and the next
 * context sample latches on its own once the occupancy reaches the threshold.
 */
function normalizeActiveState(parsed: unknown): ActiveState {
  const { context_warning: legacy, context_blocked: legacyLatched, ...rest } =
    parsed as ActiveState & LegacyContextFields;
  if (rest.context_wrap_up && typeof rest.context_wrap_up === 'object') return rest;
  const latched = legacyLatched === true;
  const atPct = latched ? (legacy?.warned_at_pct ?? null) : null;
  // `block_reminded_at_pct` is read off the old file only to be discarded: the
  // repeat reminder it throttled no longer exists, so there is no water mark to
  // carry forward.
  return { ...rest, context_wrap_up: { at_pct: atPct } };
}

export async function readActiveState(repoRoot: string, flowName: string): Promise<ActiveState | null> {
  const path = statePath(repoRoot, flowName, 'active.json');
  if (!existsSync(path)) return null;
  try {
    return normalizeActiveState(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    return null;
  }
}

/**
 * Replace active.json wholesale. Only correct for callers that OWN the entire
 * document — creating a flow instance (start) or restoring a snapshot (resume).
 * Everywhere else use `patchActiveState`: a whole-document write reinstates every
 * field as of the caller's own read, silently undoing whatever another process
 * changed in between.
 */
export async function writeActiveState(repoRoot: string, flowName: string, state: ActiveState): Promise<void> {
  const dir = stateDir(repoRoot, flowName);
  mkdirSync(dir, { recursive: true });
  const tmp = statePath(repoRoot, flowName, `active.json.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, statePath(repoRoot, flowName, 'active.json'));
}

const LOCK_STALE_MS = 10_000;
const LOCK_POLL_MS = 8;
const LOCK_MAX_WAIT_MS = 1_000;

/**
 * Cross-process mutex for active.json, on an O_EXCL lock file (the only
 * exclusion primitive available to hooks, which are separate short-lived
 * processes with no shared memory).
 *
 * Fails OPEN on timeout — the returned release is then a no-op and the caller
 * proceeds unlocked. Blocking longer would stall the developer's tool call, and
 * an unlocked patch still re-reads before merging, so the worst case degrades to
 * a microsecond-wide window instead of losing the update outright.
 *
 * A lock older than LOCK_STALE_MS is broken rather than waited on: its holder
 * was a hook process that died before releasing, and nothing else will ever
 * clean it up.
 */
async function acquireStateLock(repoRoot: string, flowName: string): Promise<() => void> {
  const lockPath = statePath(repoRoot, flowName, 'active.json.lock');
  mkdirSync(stateDir(repoRoot, flowName), { recursive: true });
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      return () => {
        try { unlinkSync(lockPath); } catch { /* already reaped as stale */ }
      };
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
      } catch { /* vanished or won by another waiter — just retry */ }
    }
    if (Date.now() >= deadline) return () => {};
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
}

/**
 * Merge `patch` into active.json under the state lock, re-reading immediately
 * before the merge so only the caller's own fields move.
 *
 * Why every mutation but start/resume must go through here: hooks are concurrent
 * processes, and PostToolUse also fires for subagent tool calls (a subagent
 * shares its parent's session_id), so a stage that fans out parallel subagents
 * has several hooks in flight at once. Each captured an ActiveState at its own
 * entry; writing that object back would roll `current_stage` backwards or erase
 * a `base_sha_code` captured meanwhile — and a missing base_sha_code hard-fails
 * the fail-closed completion scripts that diff against it.
 *
 * Pass a function to derive the patch from the fresh state — that is the only
 * way to make a check-then-set (ownership handover, first-writer-wins) atomic.
 *
 * Returns the state written, or null when active.json is absent: a completed or
 * aborted flow must not be resurrected by a hook that was still in flight.
 */
export async function patchActiveState(
  repoRoot: string,
  flowName: string,
  patch: Partial<ActiveState> | ((current: ActiveState) => Partial<ActiveState>)
): Promise<ActiveState | null> {
  const release = await acquireStateLock(repoRoot, flowName);
  try {
    const current = await readActiveState(repoRoot, flowName);
    if (!current) return null;
    const merged: ActiveState = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) };
    await writeActiveState(repoRoot, flowName, merged);
    return merged;
  } finally {
    release();
  }
}

export function findRepoRoot(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, '.ai-flow'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * True when `dir` sits ANYWHERE INSIDE a linked git worktree (`git worktree add`),
 * not merely at its root.
 *
 * Checking for a `.git` file at `dir` itself is not enough: `git worktree add`
 * checks out the whole repository, so with a monorepo sub-project anchor the
 * anchor's own copy of `.ai-flow/` lands at `<worktree>/<path-to-anchor>/.ai-flow/`
 * — several levels below the `.git` file at the worktree root. ai-flow's own repo
 * has exactly this shape. Where the worktree itself lives is irrelevant here, and
 * must stay so: the flow's helper script keeps them beside the repo, not inside it.
 *
 * `--git-dir` vs `--git-common-dir` differ only for a linked worktree; both a
 * submodule and a `--separate-git-dir` clone report them equal, which is the
 * distinction we need (their `.git` is also a plain file).
 *
 * `--path-format=absolute` is load-bearing, not tidiness: without it git answers
 * `--git-dir` with an absolute path but `--git-common-dir` with one relative to
 * the cwd, and resolving the two against `dir` disagrees whenever `dir` contains
 * an unresolved symlink (on macOS every path under `/tmp` or `/var` does). That
 * made an ordinary monorepo sub-project look like a worktree — the exact
 * over-reach the caller must not have.
 *
 * Returns false when git is unavailable or too old for `--path-format` (2.31+):
 * that keeps the pre-existing behaviour of ending the walk rather than risking
 * a wrong "yes".
 */
export function isInsideLinkedWorktree(dir: string): boolean {
  try {
    const out = execFileSync(
      'git',
      ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const [gitDir, commonDir] = out.trim().split('\n');
    if (!gitDir || !commonDir) return false;
    return resolve(gitDir) !== resolve(commonDir);
  } catch {
    return false; // not a git dir / git unavailable / git < 2.31
  }
}

/**
 * Absolute path with symlinks resolved, falling back to `resolve` for a path that
 * does not exist yet. Comparing paths that came from different sources needs this:
 * git prints real paths while the harness passes whatever spelling the agent used,
 * and on macOS `/tmp` and `/var` are symlinks, so the two never match literally.
 */
export function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** The active flow declared at exactly this anchor, or null. */
async function anchorFlow(
  dir: string
): Promise<{ flowName: string; state: ActiveState; repoRoot: string } | null> {
  const aiFlowDir = join(dir, '.ai-flow');
  if (!existsSync(aiFlowDir)) return null;
  for (const entry of readdirSync(aiFlowDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const state = await readActiveState(dir, entry.name);
    if (state) return { flowName: entry.name, state, repoRoot: dir };
  }
  return null;
}

/**
 * Inside a linked worktree, the same relative location in the MAIN checkout.
 *
 * Needed because walking further up only reaches the real anchor while the
 * worktree sits INSIDE the main checkout. It must not have to: module resolution
 * (both node's and tsc's) walks up looking for `node_modules`, so from inside a
 * nested worktree it escapes into the MAIN checkout's `node_modules` — the same
 * package then exists at two physical paths, which TypeScript treats as two
 * unrelated types, and typecheck there fails for reasons unrelated to the change
 * under test. Once the worktree lives outside the repo, "keep walking" climbs to
 * the filesystem root and finds nothing — fail-OPEN for every subagent working in
 * one (handlePreTool bails before any guard runs).
 *
 * git already knows where the main checkout is: for a linked worktree
 * `--git-common-dir` points at the main repo's `.git`, and `--show-toplevel`
 * gives this worktree's root, so the difference is `dir`'s path within the repo.
 *
 * Returns null when that cannot be established (git too old, bare or
 * `--separate-git-dir` layout where the parent of the common dir is not a work
 * tree, `dir` outside the toplevel). Callers fall back to the upward walk, so a
 * null here costs nothing that was working before.
 */
function siblingCheckoutAnchors(dir: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const [commonDir, wtRoot] = out.trim().split('\n');
    if (!commonDir || !wtRoot) return [];
    // `realPath`, not `resolve`: git prints real paths, and on macOS every path
    // under `/tmp` or `/var` reaches its target through a symlink. Comparing the
    // raw spellings makes `relative()` answer with a stack of `..` for a directory
    // that is plainly inside the worktree, and the guard below then rejects it.
    const self = realPath(dir);
    const rel = relative(resolve(wtRoot), self);
    if (rel.startsWith('..')) return [];

    // Every checkout of this repository, not just the main one. Jumping straight to
    // `dirname(commonDir)` was wrong whenever the flow's own checkout is ITSELF a
    // linked worktree (`main` → `W` → ticket tree `T`, the shape you get by running a
    // flow inside a worktree): `--git-common-dir` names the OUTERMOST checkout, so the
    // counterpart resolved to `main`, which has a tracked `.ai-flow` but no active
    // flow — and the caller took that idle verdict as final, returning null. null
    // fails OPEN (handlePreTool bails before any guard runs), so every subagent in a
    // ticket tree lost control-plane protection, signal interception and accounting.
    //
    // Listing the checkouts finds `W` too. Candidates keep the SAME anchor-relative
    // path, so this can never resolve a different project's flow — that over-reach is
    // what the caller's "idle means idle" rule exists to prevent, and it still holds.
    const roots = execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim())
      .filter(Boolean);
    // Order by PROXIMITY to `dir`, not "main checkout first". With nested worktrees
    // (`main` → `W` running the flow → ticket tree `T`) both `main` and `W` hold this
    // anchor, and both may hold an ACTIVE flow — the repo's own tests cover "each slice
    // runs its own flow in its own worktree", so that is a supported shape, not a
    // hypothetical. Taking `main` first would hand `T`'s subagents the wrong flow:
    // repoRoot, signal path and docs_paths all point at `main`'s flow, and its
    // `last_session_id` then trips the non-owner read-only guard, refusing every write
    // with "another session controls flow X" — a fail-CLOSED wrong answer, loud but
    // pointing the wrong way. `worktree.cjs` puts ticket trees in
    // `dirname(<W root>)/<repo>.ai-flow-worktrees/`, so `W` wins on shared prefix.
    // `main` is still included (and wins ties) — it is the overwhelmingly common answer.
    const mainRoot = dirname(resolve(commonDir));
    const sharedPrefix = (a: string, b: string): number => {
      const x = a.split('/'), y = b.split('/');
      let n = 0;
      while (n < x.length && n < y.length && x[n] === y[n]) n++;
      return n;
    };
    const ordered = [mainRoot, ...roots.filter((r) => resolve(r) !== mainRoot)]
      .sort((a, b) => sharedPrefix(resolve(b), self) - sharedPrefix(resolve(a), self));

    const seen = new Set<string>();
    const out2: string[] = [];
    for (const root of ordered) {
      const cand = rel ? join(root, rel) : root;
      const key = resolve(cand);
      if (key === self || seen.has(key)) continue;
      seen.add(key);
      out2.push(cand);
    }
    return out2;
  } catch {
    return [];
  }
}

/**
 * A resolved active flow, plus how it was found.
 *
 * `viaSibling` marks the one resolution route that can land on a flow living in a
 * DIFFERENT checkout of this repository than the caller's cwd: the cross-checkout
 * fallback in `hasActiveFlow`. It exists for the flow's own ticket worktrees, whose
 * `.ai-flow/` is a tracked copy with no state of its own — without it every subagent
 * in one fails OPEN. But `git worktree list` cannot tell a ticket tree apart from a
 * worktree the developer made by hand for an unrelated branch, so the same fallback
 * also resolves flow A (checkout A) for a session working in checkout B.
 *
 * Resolution must stay that wide — narrowing it brings back the fail-OPEN. What must
 * NOT stay wide is what callers then DO with it: a flow command typed in B must not
 * act on A's anchor, and any message about the lock must name both checkouts, or the
 * developer cannot tell an ordinary "another session owns this" from a cross-checkout
 * mismatch. Callers that mutate or explain use this flag; the rest ignore it.
 */
export type ResolvedFlow = {
  flowName: string;
  state: ActiveState;
  repoRoot: string;
  /** Set only when the flow was found in another checkout of this repository. */
  viaSibling?: boolean;
};

export async function hasActiveFlow(cwd: string): Promise<ResolvedFlow | null> {
  // Walk up from cwd to find the nearest .ai-flow directory (monorepo-safe).
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, '.ai-flow'))) {
      const here = await anchorFlow(dir);
      if (here) return here;
      // `.ai-flow` exists but holds no active flow. Normally that ends the walk:
      // a monorepo sub-project with its own (idle) anchor must NOT resolve to the
      // parent's flow. A linked worktree is the one exception — its `.ai-flow` is
      // a TRACKED copy of the real anchor's, and `state/` is gitignored
      // (`**/.ai-flow/**/state/`), so it can never hold an active.json. Stopping
      // here would return null for every subagent working inside a worktree,
      // which fails OPEN: handlePreTool bails before any guard runs, silently
      // disabling control-plane protection, signal interception and context
      // accounting.
      if (!isInsideLinkedWorktree(dir)) return null;
      // Ask git for THIS anchor's copy in every other checkout of the repository
      // (works wherever the worktree lives, and finds an intermediate checkout when
      // worktrees are nested — see `siblingCheckoutAnchors`). Candidates all share
      // this anchor's repo-relative path, so none of them can be a different
      // project's flow. The verdict is final in both directions: no active flow on
      // any of them means idle, and resolving the PARENT project's flow instead is
      // the very over-reach the check above exists to prevent.
      const candidates = siblingCheckoutAnchors(dir);
      if (candidates.length > 0) {
        for (const cand of candidates) {
          if (!existsSync(join(cand, '.ai-flow'))) continue;
          const over = await anchorFlow(cand);
          // Tagged: this flow lives in a different checkout than `cwd`. See `ResolvedFlow`.
          if (over) return { ...over, viaSibling: true };
        }
        return null;
      }
      // Could not map back (see `mainCheckoutCounterpart`) — keep walking, which
      // still reaches the anchor for a worktree nested inside the main checkout.
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

/**
 * Resolve the active flow for a hook invocation.
 *
 * Resolution order:
 *  1. session→anchor binding (cwd-INDEPENDENT) — survives the agent `cd`-ing to
 *     an ancestor/sibling of the anchor, which walk-up cannot. If the binding
 *     points to a flow whose active.json is gone (aborted), fall through.
 *  2. walk-up from cwd (hasActiveFlow) — backward-compatible fallback; also how
 *     a fresh session bootstraps before it has been bound.
 *
 * Ownership (last_session_id) is NOT validated here on purpose: a binding that
 * points to a flow now owned by another session must still RESOLVE, so the
 * downstream mutex can tell this session it is locked out (rather than silently
 * seeing no flow).
 */
export async function resolveActiveFlow(
  cwd: string,
  sessionId?: string
): Promise<ResolvedFlow | null> {
  if (sessionId) {
    const binding = lookupSession(sessionId);
    if (binding) {
      const state = await readActiveState(binding.projectRoot, binding.flowName);
      if (state) {
        return { flowName: binding.flowName, state, repoRoot: binding.projectRoot };
      }
      // Binding is stale (flow aborted/removed) — fall through to walk-up.
    }
  }
  return hasActiveFlow(cwd);
}

/**
 * Prune dead session→anchor bindings. A binding is dead when:
 *  - its anchor or active.json no longer exists (flow aborted/removed), or
 *  - the flow's active.json is owned by a DIFFERENT, non-null session
 *    (this binding's session was taken over).
 * A null owner (flow released, waiting to resume) is NOT treated as dead: the
 * binding may still be the legitimate last anchor, and keeping it lets the same
 * session re-resolve the flow by binding even if its cwd has drifted above the
 * anchor. (The normal cleanup path is SessionEnd's explicit unbind, not GC.)
 * Best-effort and exception-safe — never throws.
 */
export async function gcRegistry(): Promise<void> {
  for (const b of listBindings()) {
    let dead = false;
    try {
      const state = await readActiveState(b.projectRoot, b.flowName);
      if (!state || (state.last_session_id !== null && state.last_session_id !== b.sessionId)) dead = true;
    } catch {
      dead = true;
    }
    if (dead) removeBinding(b.sessionId);
  }
}

export function readSignal(repoRoot: string, flowName: string): string | null {
  const path = statePath(repoRoot, flowName, 'signal');
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return null;
  }
}

export function writeSignalFile(repoRoot: string, flowName: string, content: string): void {
  const dir = stateDir(repoRoot, flowName);
  mkdirSync(dir, { recursive: true });
  const tmp = statePath(repoRoot, flowName, `signal.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, content);
  renameSync(tmp, statePath(repoRoot, flowName, 'signal'));
}

export function isGatePending(signal: string | null, config: FlowConfig, currentStageId: string): boolean {
  if (!signal) return false;
  const stage = config.stages.find((s) => s.id === currentStageId);
  if (!stage) return false;
  if (!stage.completion.gate) return false;
  // New protocol: AI writes 'done'; hook rewrites to stage-id/flow-complete later
  if (signal === 'done') return true;
  // Backward compat: posttool already rewrote signal to stage-id or 'flow-complete'
  const expected = nextStage(config, currentStageId);
  if (expected !== null) {
    return signal === expected;
  }
  return signal === 'flow-complete';
}

export async function appendLog(repoRoot: string, flowName: string, sessionId: string, message: string): Promise<void> {
  const logPath = statePath(repoRoot, flowName, 'flow.log');
  mkdirSync(dirname(logPath), { recursive: true });
  const timestamp = new Date().toISOString();
  appendFileSync(logPath, `${timestamp} [${flowName}] [session=${sessionId}] ${message}\n`);
}

export function nextStage(config: FlowConfig, currentStageId: string): string | null {
  const idx = config.stages.findIndex((s) => s.id === currentStageId);
  if (idx === -1 || idx === config.stages.length - 1) return null;
  return config.stages[idx + 1]!.id;
}

export function signalPath(repoRoot: string, flowName: string): string {
  return statePath(repoRoot, flowName, 'signal');
}

/**
 * Marker file the AI writes (via the Write tool) to ask the engine to capture
 * `base_sha_code` = current git HEAD. Lets the engine own the active.json write
 * (control-plane-safe) instead of stages poking active.json with relative python.
 */
export function markBasePath(repoRoot: string, flowName: string): string {
  return statePath(repoRoot, flowName, 'mark-base');
}

export function activeJsonPath(repoRoot: string, flowName: string): string {
  return statePath(repoRoot, flowName, 'active.json');
}

export function scriptsDir(repoRoot: string, flowName: string): string {
  return join(repoRoot, '.ai-flow', flowName, 'scripts');
}

/**
 * Where the engine parks a RENDERED copy of the current stage prompt for the model to Read.
 *
 * Two engine paths hand the model a path instead of the prompt body: the oversize fallback
 * (`injectableStagePrompt`) and the gate-pending branch. Both used to point at
 * `stages/<id>.md` — the TEMPLATE — and that is not the same document:
 *
 *  - `{{flow_root}}` / `{{project_root}}` are still literal there. Substitution happens in
 *    `renderPrompt()`, i.e. only on the injection path. A model that copies one verbatim
 *    into Write creates a directory literally named `{{flow_root}}` and the file lands
 *    nowhere — silently, because Write does not fail (shell would). Stage prompts carry
 *    these on their load-bearing paths: where to write `signal`, which docs to read first.
 *  - the template also lacks what the engine appends at injection time
 *    (`writtenDocLengthNote()`, and `gateProtocolNote()` for gated stages).
 *
 * So pointing at the template silently downgrades "here is your executable stage" into
 * "here is a form to fill in from memory". Materializing the rendered text removes the
 * whole failure class instead of warning about it.
 *
 * Lives under `state/` because that is already gitignored (`.ai-flow/<flow>/state/`) and
 * flow-scoped. It is NOT control-plane: the Bash fence lists `state/signal` and
 * `state/active.json` by name, not the directory, and the read-ordering guard only matches
 * paths that `config.stages[].prompt` declares — so the model can Read this freely.
 */
export function renderedPromptPath(repoRoot: string, flowName: string): string {
  return statePath(repoRoot, flowName, 'current-prompt.md');
}

/**
 * Write the rendered prompt out and return its path; `null` if it could not be written.
 *
 * `stageId` is stamped into a header because this file OUTLIVES the moment it was written.
 * It is only refreshed on the two pointer paths, so a later stage that injects inline
 * leaves the previous stage's copy sitting there — and `helper.md` names this path to the
 * model, so it can find it without being handed a pointer. A model that compacts mid-stage
 * and re-reads it would otherwise get a complete, plausible, WRONG stage's prompt with
 * nothing to signal the mismatch. The header makes that detectable; `advanceStage` also
 * deletes the file on every transition so it rarely gets the chance.
 *
 * Fail-open by design: callers fall back to pointing at the template. A degraded pointer
 * still beats no prompt at all, which is what throwing here would produce.
 */
export function materializeRenderedPrompt(
  repoRoot: string,
  flowName: string,
  stageId: string,
  rendered: string
): string | null {
  try {
    const dest = renderedPromptPath(repoRoot, flowName);
    const header =
      `<!-- ai-flow: stage=${stageId} flow=${flowName} -->\n` +
      `> ⚠️ 这是 stage **${stageId}** 提示词的渲染副本（引擎落盘，占位符已展开）。\n` +
      `> **它和你当前所处的 stage 不一致时，就是旧件——别照它执行**，去读引擎本次注入给你的内容。\n\n`;
    mkdirSync(dirname(dest), { recursive: true });
    // tmp + rename, same as active.json / signal in this file: a reader must never observe
    // a half-written prompt, and the pointer message that sends them here is generated
    // right after this returns.
    const tmp = statePath(repoRoot, flowName, `current-prompt.${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(tmp, header + rendered, 'utf-8');
    renameSync(tmp, dest);
    return dest;
  } catch {
    return null;
  }
}

/** Drop the rendered copy. Called on every stage transition so a stale one cannot be read. */
export function clearRenderedPrompt(repoRoot: string, flowName: string): void {
  try {
    const p = renderedPromptPath(repoRoot, flowName);
    if (existsSync(p)) unlinkSync(p);
  } catch { /* best-effort: a stale copy is caught by its stage header anyway */ }
}

