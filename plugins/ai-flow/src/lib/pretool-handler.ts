import { join, relative, resolve } from 'path';
import { existsSync } from 'fs';
import type { PreToolInput } from './types.js';
import {
  resolveActiveFlow,
  appendLog,
  signalPath,
  activeJsonPath,
  isInsideLinkedWorktree,
  realPath,
} from './state.js';
import { loadFlowConfig, getStageConfig, resolveDocsPaths, stageIndex, getStageByPromptPath } from './flow-config-loader.js';
import { runScript } from './script-executor.js';
import { truncateError } from './format.js';
import { flowDefDir, flowAnchorDir, isBuiltinFlow, PLUGIN_ROOT } from './flow-paths.js';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);

export interface PreToolResult {
  permissionDecision: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;
  systemMessage?: string;
}

function deny(reason: string, systemMessage?: string): PreToolResult {
  return { permissionDecision: 'deny', permissionDecisionReason: reason, ...(systemMessage && { systemMessage }) };
}

function allow(systemMessage?: string): PreToolResult {
  return { permissionDecision: 'allow', ...(systemMessage && { systemMessage }) };
}


function resolvePath(repoRoot: string, filePath: string): string {
  if (filePath.startsWith('/')) return filePath;
  return join(repoRoot, filePath);
}

/**
 * True when `segment` is nothing but an invocation of a script that lives in the
 * active flow's `scripts/` directory: `node [--long-opts] <path> [args…]`.
 *
 * Deliberately narrow, because it is the one hole in an otherwise blunt fragment
 * match. The whole segment must be that invocation; the script must end in
 * `.cjs`/`.mjs`/`.js` and sit under one of the `scripts` fragments; and with that
 * single path removed, nothing else control-plane-shaped may remain — which is
 * what keeps `node <script> > <flow>/state/signal` denied. `node -e "<code>"`
 * never matches: `-e` is not a long option, and its argument is code, not a path.
 */
function isFlowScriptExecution(
  segment: string,
  scriptFragments: string[],
  stateFragments: string[]
): boolean {
  // Nothing that names a state fragment (signal / active.json) ever qualifies — not
  // as an invocation, not as an assignment. That rule predates this function and is
  // what keeps `node <script> > <flow>/state/signal` denied; the shapes admitted
  // below must not become a way around it.
  if (stateFragments.some((f) => segment.includes(f))) return false;

  // Shell keywords that legitimately precede a command inside a compound statement,
  // plus any leading `VAR=value` assignments. Without stripping these, the exemption
  // only fired for a bare one-liner and the flow's OWN documented usage got refused
  // three times in a single run: `for L in R1 R2 R3; do node …/worktree.cjs sync …;
  // done` (the segment starts with `do `) and `S=…/worktree.cjs; node $S sync …`
  // (the assignment segment names a script path but invokes nothing). The refusal
  // message talks about reads and writes, which is not what happened — so the agent
  // rewrites the command instead of the shape, and hits it again.
  //
  // ⚠️ The assignment VALUE must not contain a command substitution. "An assignment
  // executes nothing" is false in shell: `X="$(cp evil.cjs <flow>/scripts/gate.cjs)"`
  // runs the `cp`, and so does the leading-assignment form `A="$(rm -rf …)" node …`.
  // Admitting those shapes without this restriction re-opened Bash writes to the gate
  // scripts and stage prompts — i.e. it made this guard weaker than before the
  // widening. `$(`, backticks and process substitution `<(`/`>(` are therefore all
  // excluded from the value; a plain literal path (the shape the flow actually uses)
  // still matches.
  const VALUE = String.raw`(?:"(?:[^"\`$]|\$(?![({]))*"|'[^']*'|(?:[^\s;|&\`"']|\$(?![({]))*)`;
  const ASSIGNMENTS = new RegExp(String.raw`^(?:[A-Za-z_][A-Za-z0-9_]*=${VALUE}\s*)+$`);
  const LEADING_ASSIGNMENTS = new RegExp(String.raw`^(?:[A-Za-z_][A-Za-z0-9_]*=${VALUE}\s+)+`);
  const trimmed = segment.trim();
  // A segment that is ONLY substitution-free assignments executes nothing.
  if (ASSIGNMENTS.test(trimmed)) return true;
  const bare = trimmed
    .replace(/^(?:do|then|else)\s+/, '')
    .replace(LEADING_ASSIGNMENTS, '');
  const m = /^node((?:\s+--[A-Za-z0-9][A-Za-z0-9-]*(?:=[^\s]*)?)*)\s+(?:"([^"]*)"|'([^']*)'|([^\s"']+))(\s[\s\S]*)?$/.exec(bare);
  if (!m) return false;
  const script = m[2] ?? m[3] ?? m[4] ?? '';
  if (!/\.(cjs|mjs|js)$/.test(script)) return false;
  if (!scriptFragments.some((f) => script.includes(f))) return false;
  const rest = (m[1] ?? '') + (m[5] ?? '');
  return ![...scriptFragments, ...stateFragments].some((f) => rest.includes(f));
}

type ControlPlaneRole = 'active.json' | 'config.json' | 'stages' | 'scripts' | 'signal';

/**
 * Classify a write target as one of the flow's control-plane files, or null.
 *
 * Matching is on the path SUFFIX rather than on `relative(repoRoot, …)`, because
 * a git worktree of the same repository holds a second copy of every tracked
 * control-plane file at a path that is not under repoRoot at all
 * (`../wt-x/.ai-flow/<flow>/stages/…`). Editing that copy and merging the branch
 * back changes the real stage prompts / config / gate scripts, so it is the same
 * privilege as editing them in place and must be refused the same way.
 *
 * A suffix match alone over-reaches: a project may legitimately VENDOR flow
 * templates in its tree and those are ordinary content, editable during a flow.
 * What separates the two is whether the copy lives inside a linked worktree,
 * which is exactly the condition under which an edit there can travel back into
 * the flow's own checkout via a merge.
 *
 * The installed plugin's own `.ai-flow/<flow>/` is the third case, and since the
 * definition layer moved there it is the LIVE definition rather than a vendored
 * copy: the stage prompts, gate scripts and config the running flow is executing
 * are read from it on every stage transition. Editing it mid-flow is the same
 * privilege as editing the project's copy used to be, so it is fenced the same
 * way. (When the flow being run is ai-flow's own development checkout the two
 * coincide and `sameAnchor` already covers it.)
 *
 * Testing for a `.git` file BESIDE `.ai-flow` is not that condition: `git
 * worktree add` checks out the whole repository, so under a monorepo sub-project
 * anchor the `.git` file sits at the worktree root while `.ai-flow/` is nested
 * under it (ai-flow's own repo has this shape). That spelling let a subagent
 * rewrite the gate scripts / stage prompts inside its worktree and merge them
 * back, which is the one thing this guard exists to stop.
 */
function controlPlaneRole(repoRoot: string, flowName: string, absPath: string): ControlPlaneRole | null {
  const norm = absPath.replace(/\\/g, '/');
  const marker = `/.ai-flow/${flowName}/`;
  const idx = norm.lastIndexOf(marker);
  if (idx === -1) return null;

  // `|| '/'` keeps anchor absolute when `.ai-flow` sits at the filesystem root,
  // where the slice is empty and both checks below would resolve against the
  // process cwd instead.
  const anchor = norm.slice(0, idx) || '/';
  const rest = norm.slice(idx + marker.length);
  // `realPath` on both sides: the two spellings come from different sources — the
  // write target from the agent, repoRoot from flow resolution, which now answers
  // with git's real path for a worktree. A literal mismatch here reads as "not this
  // repo's anchor" and drops the guard, so it must compare the resolved paths.
  const sameAnchor = realPath(anchor) === realPath(repoRoot);
  const isShippedDefinition = isBuiltinFlow(flowName) && realPath(anchor) === realPath(PLUGIN_ROOT);
  if (!sameAnchor && !isShippedDefinition && !isInsideLinkedWorktree(anchor)) return null;

  if (rest === 'state/active.json') return 'active.json';
  if (rest === 'config.json') return 'config.json';
  if (rest.startsWith('stages/')) return 'stages';
  if (rest.startsWith('scripts/')) return 'scripts';
  // A worktree's COPY of the signal path. The real one is normally intercepted
  // earlier (absPath === signalPath(repoRoot, …)) and returns before this switch.
  // That earlier check is a byte comparison though, so a non-canonical spelling of
  // the real path (`/repo/./.ai-flow/…`) slips past it and lands here — hence the
  // explicit anchor test, so we never tell the agent its own main-checkout signal
  // is "a worktree copy".
  // Writing the copy is worse than a no-op: `state/` is gitignored so nothing
  // reads it, and a subagent that "signalled" there believes it has delivered.
  if (rest === 'state/signal' && !sameAnchor) return 'signal';
  return null;
}

/**
 * A path that names this flow's definition somewhere it no longer lives.
 *
 * Since 0.69.0 `stages/` `references/` `scripts/` ship with the plugin; the project
 * keeps only `config.json` and `state/`. Two populations of stale paths outlive that
 * move and neither is hypothetical — both were observed within two minutes of the
 * first migrated resume:
 *
 *  - the project's own `<repo>/.ai-flow/<flow>/references/…`, which `legacy-cleanup`
 *    has just deleted. A session resumed across the migration composes these from its
 *    restored scrollback, and `Read` answers with a bare "File does not exist" that
 *    says nothing about where the file went.
 *  - a ticket worktree's tracked COPY of the same path, which still resolves. That is
 *    the worse one: it succeeds, silently, against whatever revision the flow branch
 *    happened to carry — the exact drift this move removed. It is also temporary
 *    cover: once the deletion is committed, `worktree.cjs sync` rebases it away and
 *    every such read starts failing instead.
 *
 * Left alone, the end state is a subagent told to "review against fowler-smells.md"
 * that cannot read it, reviews from memory, and reports as though the rubric applied.
 * So this is a redirect, not a fence: it costs a denied read and hands back the one
 * path that is correct for the running plugin version.
 */
function staleDefinitionPath(repoRoot: string, flowName: string, candidate: string): string | null {
  const norm = candidate.replace(/\\/g, '/');
  const marker = `/.ai-flow/${flowName}/`;
  const idx = norm.lastIndexOf(marker);
  if (idx === -1) return null;
  const rest = norm.slice(idx + marker.length);
  // `scripts/` is excluded on purpose: the dominant use of those paths is EXECUTION,
  // which the Bash control-plane carve-out already admits and which must keep
  // working. Reading a gate script is something the stage prompts explicitly tell
  // agents not to do anyway (~10K tokens), so there is nothing here to rescue.
  if (!/^(references|stages)\//.test(rest)) return null;
  // The plugin's own copy IS the definition — and for a flow the plugin does not
  // ship, `flowDefDir` falls back to the project directory, so the "stale" location
  // and the live one are the same path. Compare RESOLVED paths, not spellings: the
  // candidate comes from the agent while `repoRoot` comes from flow resolution,
  // which answers with git's real path. A literal mismatch (`/var/…` vs
  // `/private/var/…`) would read as "not the definition" and refuse the definition
  // itself — measured: 11 tests, all of them legitimate reads and script executions.
  const defDir = flowDefDir(repoRoot, flowName);
  const candidateDir = norm.slice(0, idx + marker.length - 1);
  if (realPath(candidateDir) === realPath(defDir)) return null;
  return `${defDir.replace(/\\/g, '/')}/${rest}`;
}

export async function handlePreTool(input: PreToolInput): Promise<PreToolResult | null> {
  const { cwd, tool_name, tool_input, session_id } = input;

  const active = await resolveActiveFlow(cwd, session_id).catch(() => null);
  if (!active) return null;

  const { flowName: activeFlowName, state, repoRoot } = active;

  try {

  // ─── Non-owner read-only guard ────────────────────────────────────────────────
  // Another session owns this flow. A second session in the same repo may read,
  // search and run Bash freely, but must not mutate project files — two sessions
  // editing the same repo concurrently corrupts the work. This MUST run first and
  // short-circuit: were a non-owner allowed to fall through, writing the signal
  // file would advance another session's flow. It depends only on state + tool, so
  // it runs before loadFlowConfig — a broken config must not fail open into letting
  // a foreign session write. Bash stays governed by the control-plane block below
  // (signal / active.json / scripts remain fenced for everyone), which is why Bash
  // is intentionally not blocked here.
  if (state.last_session_id && state.last_session_id !== session_id && WRITE_TOOLS.has(tool_name)) {
    await appendLog(repoRoot, activeFlowName, session_id, `NON_OWNER_WRITE_BLOCKED owner=${state.last_session_id} tool=${tool_name}`);
    const activeFile = activeJsonPath(repoRoot, activeFlowName);
    return deny(
      `当前工程正在进行流程 '${activeFlowName}'（由另一 session 控制），为避免改动冲突，` +
      `本 session 禁止修改本项目文件，仅可读取与检索。\n\n` +
      `如需修改：请在控制该流程的 session 中进行；若需由本 session 接管，执行 /clear 接管` +
      `（原 session 已不存在却仍被锁定时，先将 ${activeFile} 的 "last_session_id" 改为 null 再 /clear）。`
    );
  }

  // Redirect reads of the flow definition at its pre-0.69.0 location. Runs before
  // `loadFlowConfig` so a broken config cannot fail it open, and is deliberately NOT
  // gated on `agent_id`: every observed instance was a subagent, which is where the
  // dispatch prompt's remembered absolute paths land.
  // `Read` only, and only its `file_path`. Widening it to every path-shaped input
  // collided with two guards that were already right: writes to these paths are
  // `controlPlaneRole`'s job (its refusal explains the control plane, which is the
  // more useful thing to say about a write), and Bash needs the script-execution
  // carve-out to keep working. Measured: the wider version turned 11 correct
  // outcomes into refusals, including a vendored template copy that is ordinary
  // content by design.
  if (tool_name === 'Read') {
    const moved = staleDefinitionPath(repoRoot, activeFlowName, String(tool_input['file_path'] ?? ''));
    if (moved) {
    await appendLog(repoRoot, activeFlowName, session_id, `STALE_DEF_PATH tool=${tool_name}`);
    return deny(
      `这条路径指的是 flow 定义在 0.69.0 之前的位置,那份已经不在项目里了。\n` +
      `定义(stages / references / scripts)现在随插件版本走,项目里只剩 config.json 和 state/。\n\n` +
      `改用:${moved}\n\n` +
      `⚠️ 派子代理时别从上文里抄这个绝对路径——它带插件版本号,插件一升级就变。` +
      `每次从注入 context 顶部 \`[ai-flow:paths]\` 的 \`flow_def:\` 行现取。`
    );
    }
  }

  const config = await loadFlowConfig(repoRoot, activeFlowName);

  // ─── Context block enforcement ────────────────────────────────────────────────
  //
  // The block exists to stop the session PRODUCING more work on a degraded context.
  // It must not also block the safe exit. Denying every write made the prescribed
  // remedy unsafe: the flow's whole design is "everything a later session needs is on
  // disk", and the act that puts it there — writing the handoff / bookkeeping into the
  // flow's own docs — is a write. Observed: a session crossed the threshold with a
  // subagent still in flight, could no longer record anything, and `/clear` then lost
  // that subagent's report (its findings, its real-machine items, its security
  // self-check) — none of which is recoverable from the commit it left behind.
  //
  // So: still refuse writes to the codebase, but let the flow's own docs through, and
  // say plainly what /clear does and does not cost. The claim it used to make —
  // "progress won't be lost" — is false while a subagent is running.
  //
  // Scope it to the main session, mirroring the measurement side (`posttool-handler`
  // skips accounting when `agent_id` is present). `context_wrap_up.at_pct` is latched on the
  // shared flow state by whoever crossed the threshold, so without this the latch
  // reaches every subagent too — including ones that started after it and carry a
  // fraction of the context that caused it. Observed: a session latched at 61% and
  // then did the right thing — handed the remaining fix work to a fresh subagent —
  // and that subagent was refused mid-edit at 75K of its own context (7.5% of the
  // window). It had already created one file seconds earlier, so the refusal split a
  // single change in half and left an unimported module behind; six of the seven
  // items were never started. Delegating to a fresh context is the prescribed
  // response to a degraded one, and this is the branch that punished it.
  //
  // Deliberately NOT extended to Bash. This is a signal to the model, not a security
  // boundary — `cat >`, `sed -i` and `git commit` have always gone through. Catching
  // them would mean parsing shell for write intent, and would refuse `git commit` /
  // test runs / the flow's own scripts, which the stage prompts hand out by name.
  //
  // This comment used to claim no run had been observed routing around the block that
  // way. That is no longer true: one session crossed at 61% and then kept editing
  // `tickets.md` through a heredoc'd python script under Bash for a further 28 minutes,
  // 614K → 665K. Which is also why the block message now reads as "start wrapping up"
  // rather than "stop touching tools" — a signal the model can honour while still
  // landing a handoff beats one it either obeys into paralysis or routes around.
  if (state.context_wrap_up.at_pct !== null && WRITE_TOOLS.has(tool_name) && input.agent_id === undefined) {
    const stageCfgForBlock = getStageConfig(config, state.current_stage);
    const docsPaths = resolveDocsPaths(stageCfgForBlock.docs_paths ?? [], state.flow_id);
    // A stage with no docs_paths has no safe exit, so this guard refuses nothing at
    // all there and the wrap-up degrades to the brief posttool already injected.
    // `docs_paths` is only *required* for `write_scope: 'docs_only'` (flow-schema.ts),
    // so `/ai-flow:create` legitimately emits `unrestricted` stages without it — and
    // on those, refusing the codebase left the session nowhere to write while this
    // very message claimed the flow's docs were open ("none configured"). Since the
    // prescribed remedy is `/clear` and that costs whatever is not on disk, the guard
    // is what gives way, not the handoff. It also cannot fall back to some invented
    // path: the writable directory is the flow's own contract, not the engine's.
    // Both shipped flows set docs_paths on every stage, so this branch is for custom
    // flows only. Reaching it means the flow has no wrap-up enforcement — the brief
    // (and `status`) still say the context is spent, nothing refuses a write.
    // "Nothing" includes the signal, so the stage can still advance here, which the
    // configured case refuses. Deliberate: carving out signal alone would recreate
    // this very defect one size down — a session that can neither write nor advance,
    // with `/clear` (costing whatever is not on disk) as its only move.
    // Resolve the target here rather than reusing the one computed further down —
    // this check has to run before the write-tool path handling begins.
    const blockAbs = resolvePath(repoRoot, String(tool_input['file_path'] ?? tool_input['notebook_path'] ?? ''));
    const relForBlock = relative(repoRoot, blockAbs);
    const isFlowDocs = docsPaths.some((p) => {
      const norm = p.endsWith('/') ? p : p + '/';
      return relForBlock.startsWith(norm) || blockAbs.startsWith(join(repoRoot, norm));
    });
    if (docsPaths.length > 0 && !isFlowDocs) {
      const wrapUpPct = state.context_wrap_up.at_pct;
      return deny(
        `Context wrap-up started at ${wrapUpPct}%. Writes to the codebase are refused; writes to this flow's own docs `
        + `(${docsPaths.join(', ')}) are still allowed so you can land a handoff.\n\n`
        + `Before /clear: write whatever a later session cannot reconstruct into those docs — which lane is `
        + `where, which subagents are STILL RUNNING and on which worktree, current test baselines, and any `
        + `decision you have made but not recorded.\n`
        + `What /clear costs: flow state and commits are on disk and survive; **an in-flight subagent's report `
        + `does not** — its findings, real-machine items and security self-check cannot be reconstructed from `
        + `the commit it leaves behind. If one is running, prefer waiting for it, or summarise its worktree `
        + `state into the docs first.`
      );
    }
  }

  // ─── Bash interception ────────────────────────────────────────────────────────
  if (tool_name === 'Bash') {
    const command = String(tool_input['command'] ?? '');
    const flowRel = join('.ai-flow', activeFlowName);

    // Control-plane files must only ever be mutated through the engine (signal
    // via the Write tool; active.json/scripts not at all). Block Bash references
    // to them in BOTH their absolute and repoRoot-relative forms — an agent that
    // has not cd'd typically writes the relative path (`echo done >
    // .ai-flow/<flow>/state/signal`), which the absolute-only match missed.
    // Residual gap (accepted): a `cd` into the state dir followed by a bare
    // filename (`cd .../state && echo done > signal`) is not caught here — the
    // Write-tool interception below remains the precise, primary guard.
    const stateFragments = [
      signalPath(repoRoot, activeFlowName),
      join(repoRoot, flowRel, 'state', 'active.json'),
      join(flowRel, 'state', 'signal'),
      join(flowRel, 'state', 'active.json'),
    ];
    const scriptFragments = [
      join(repoRoot, flowRel, 'scripts'),
      join(flowRel, 'scripts'),
    ];
    // `stages/` and `config.json` are control-plane too — `controlPlaneRole` has
    // recognised both since the Write path was written, and Write/Edit refuse them.
    // Bash did not, so the same change went through unopposed via `cp`, `sed -i`,
    // or `git checkout <ref> -- <flow>/stages/`. "Stage prompts and machine gates
    // are read-only while a flow runs" held on exactly one of the two routes.
    // They join the `scripts` group so they share its execution carve-out, which
    // costs nothing: `isFlowScriptExecution` requires a `.cjs`/`.mjs`/`.js` suffix,
    // and neither of these can ever match it.
    const docFragments = [
      join(repoRoot, flowRel, 'stages'),
      join(flowRel, 'stages'),
      join(repoRoot, flowRel, 'config.json'),
      join(flowRel, 'config.json'),
    ];
    const exemptFragments = [...scriptFragments, ...docFragments];
    const cpFragments = [...stateFragments, ...exemptFragments];
    // RUNNING a flow's own helper script must be allowed: stage prompts hand out
    // commands like `node {{flow_root}}/scripts/worktree.cjs open <flow_id> <name>`
    // (one per ticket at least), and a fragment match refuses the very command the
    // flow just instructed — with a message about reads and writes, which is not
    // what happened. Exempt exactly one shape, and only for the `scripts` fragments:
    // a whole shell segment that is `node [--long-opts] <script under that dir> [args]`.
    // Everything else stays denied: `cat <script>`, `echo > <script>`,
    // `node -e "<reads script>"`, a segment that also names a second control-plane
    // path, and any command touching signal / active.json (those fragments never
    // take part in the exemption, so no spelling of them can be smuggled through).
    const offending = command
      .split(/&&|\|\||[;|\n]/)
      .map((s) => s.trim())
      .filter((seg) => cpFragments.some((f) => seg.includes(f)))
      .filter((seg) => !isFlowScriptExecution(seg, exemptFragments, stateFragments));
    if (offending.length > 0) {
      return deny(
        'Bash access to ai-flow control-plane files (signal / active.json / scripts / stages / config.json) is blocked — matching is by path fragment, so this covers reads too. ' +
        'To READ these files, use the Read tool instead (it can read them). To write the signal use the Write tool; active.json / scripts / stages / config.json are changed by the user manually. ' +
        'RUNNING a flow script is allowed: `node <flow>/scripts/<name>.cjs [args]`, optionally preceded by `do`/`then`/`else` or `VAR=value` assignments. What stays denied is a segment that also names the signal or active.json.'
      );
    }

    // cwd drift is no longer fenced for Bash: the flow is resolved by session
    // binding (cwd-independent) and stage prompts anchor flow paths on the
    // injected absolute {{project_root}}/{{flow_root}}, so the agent is free to
    // `cd` into a sub-project to run scoped commands. git operations resolve
    // `.git` upward, so they remain correct regardless of cwd.
    return null;
  }

  // ─── Read tools ──────────────────────────────────────────────────────────────
  if (READ_TOOLS.has(tool_name)) {
    const fp = String(tool_input['file_path'] ?? '');
    if (!fp) return null;
    const abs = resolvePath(repoRoot, fp);

    // Stage file ordering: deny reads of future stage files
    const targetStageId = getStageByPromptPath(config, activeFlowName, abs);
    if (targetStageId !== null) {
      const currentIdx = stageIndex(config, state.current_stage);
      if (currentIdx === -1) return null; // unknown current stage — fail open, don't lock AI out
      const targetIdx = stageIndex(config, targetStageId);
      if (targetIdx > currentIdx) {
        return deny(
          `Stage file '${targetStageId}' is ahead of the current stage '${state.current_stage}'. ` +
          `You may only read stage files for the current stage or earlier stages.`
        );
      }
    }

    return null;
  }

  if (!WRITE_TOOLS.has(tool_name)) return null;

  const fp = String(tool_input['file_path'] ?? tool_input['notebook_path'] ?? '');
  if (!fp) return null;

  // ─── Relative-write-while-drifted guard (silent-misplacement protection) ──────
  // cd is now unrestricted (the flow is resolved by session binding, not cwd). But a
  // RELATIVE file_path is still resolved by the Write tool against the CURRENT cwd —
  // so if the agent has cd'd away, a relative write silently lands under the wrong
  // dir, and the scope check below (which assumes repoRoot) would validate the wrong
  // path. We can't know the intended base, so require an absolute path when drifted.
  // Stage prompts anchor flow artifacts on the injected absolute {{project_root}},
  // so well-formed writes pass; this only catches stray relative writes.
  if (!fp.startsWith('/') && resolve(cwd) !== resolve(repoRoot)) {
    await appendLog(repoRoot, activeFlowName, session_id, `CWD_MISMATCH cwd=${cwd} path=${fp}`);
    return deny(
      `The current working directory (${cwd}) is not the flow root (${repoRoot}), and '${fp}' is a ` +
      `relative path — the Write tool would resolve it against the current cwd and silently create it ` +
      `there. Re-issue the write with an absolute path to the location you actually intend:\n` +
      `  • a file in the tree you are working in (a worktree checkout, if you are in one): ${resolve(cwd, fp)}\n` +
      `  • a flow artifact that belongs to the main checkout: ${join(repoRoot, fp)}\n` +
      `Neither is "the right one" by default — pick by what the file IS. Code and tests belong to the ` +
      `tree you are working in; flow bookkeeping under docs/ belongs to the main checkout.`
    );
  }

  const absPath = resolvePath(repoRoot, fp);

  // ─── Signal interception ─────────────────────────────────────────────────────
  if (absPath === signalPath(repoRoot, activeFlowName)) {
    await appendLog(repoRoot, activeFlowName, session_id, `SIGNAL_INTERCEPT stage=${state.current_stage} tool=${tool_name}`);
    const stageCfg = getStageConfig(config, state.current_stage);
    const signalContent = String(tool_input['content'] ?? '').trim();

    // Validate signal content: AI must always write exactly 'done'
    if (signalContent !== 'done') {
      await appendLog(repoRoot, activeFlowName, session_id, `SIGNAL_INVALID expected=done got=${signalContent}`);
      return deny(
        `Invalid signal content for stage '${state.current_stage}'. ` +
        `Write exactly 'done' to the signal file to trigger stage completion. Got: '${signalContent}'.`
      );
    }

    // Script validation (if configured)
    let gateNotes: string | undefined;
    if (stageCfg.completion.script) {
      // cwd is the DEFINITION dir so a `node scripts/x.cjs` command resolves against
      // the scripts that ship with this plugin version. The project's own paths can
      // no longer be derived from the script's location, so they are passed in.
      const defDir = flowDefDir(repoRoot, activeFlowName);
      const anchorDir = flowAnchorDir(repoRoot, activeFlowName);
      const scriptOpts = stageCfg.completion.script.timeout_ms !== undefined
        ? { timeout_ms: stageCfg.completion.script.timeout_ms }
        : undefined;
      const scriptResult = await runScript(stageCfg.completion.script.command, defDir, {
        ...scriptOpts,
        env: { AI_FLOW_FLOW_DIR: anchorDir, AI_FLOW_PROJECT_ROOT: repoRoot },
      });
      if (!scriptResult.ok) {
        await appendLog(repoRoot, activeFlowName, session_id, `SCRIPT_FAIL stage=${state.current_stage} reason=${scriptResult.reason.replace(/\n/g, ' ').slice(0, 80)}`);
        return deny(`Script validation failed:\n${scriptResult.reason}\n\nFix the issues and try again.`);
      }
      // A passing gate can still have something to say (assertions it had to
      // skip). Surface it; `allow()` alone would swallow it.
      if (scriptResult.notes) gateNotes = scriptResult.notes;
    }

    // Gate type: ALLOW (PostToolUse will detect gate via signal content and handle pending state)
    if (stageCfg.completion.gate) {
      await appendLog(repoRoot, activeFlowName, session_id, `GATE_SIGNAL_WRITTEN stage=${state.current_stage}`);
      return allow(gateNotes);
    }

    // None/script type (non-gate): ALLOW — PostToolUse will advance stage and inject next prompt
    await appendLog(repoRoot, activeFlowName, session_id, `SIGNAL_ALLOW stage=${state.current_stage}`);
    return allow(gateNotes);
  }

  // ─── Control plane protection ─────────────────────────────────────────────────
  switch (controlPlaneRole(repoRoot, activeFlowName, absPath)) {
    case 'active.json':
      await appendLog(repoRoot, activeFlowName, session_id, `BLOCKED direct write to active.json: ${fp}`);
      return deny('Direct writes to active.json are blocked (control plane protection).');
    case 'config.json':
      await appendLog(repoRoot, activeFlowName, session_id, `BLOCKED write to config.json: ${fp}`);
      return deny('config.json is read-only during flow execution — this also covers the copy in any worktree of this repository.');
    case 'stages':
      await appendLog(repoRoot, activeFlowName, session_id, `BLOCKED write to stage prompt: ${fp}`);
      return deny('Stage prompt files are read-only during flow execution — this also covers the copy in any worktree of this repository.');
    case 'scripts':
      await appendLog(repoRoot, activeFlowName, session_id, `BLOCKED write to scripts: ${fp}`);
      return deny('Script files cannot be modified during flow execution — this also covers the copy in any worktree of this repository. Ask the user to replace them manually.');
    case 'signal':
      await appendLog(repoRoot, activeFlowName, session_id, `BLOCKED write to worktree signal copy: ${fp}`);
      return deny(
        `这是本仓某个 worktree 里的 signal 副本，写它不会推进流程（'state/' 被 gitignore，没有任何东西读这份副本）。\n` +
        `signal 只能由主 session 写主仓那份：${signalPath(repoRoot, activeFlowName)}\n` +
        `若你是在 worktree 内执行某一票的子代理：交付方式是回报给编排器，不要写 signal。`
      );
  }

  // ─── Write scope enforcement ──────────────────────────────────────────────────
  const rel = relative(repoRoot, absPath);
  const stageCfg = getStageConfig(config, state.current_stage);
  if (stageCfg.write_scope === 'docs_only') {
    const docsPaths = resolveDocsPaths(stageCfg.docs_paths ?? [], state.flow_id);
    // Normalize: ensure trailing slash to prevent "docs/feat-flows-evil" matching "docs/feat-flows"
    const allowed = docsPaths.some((p) => {
      const norm = p.endsWith('/') ? p : p + '/';
      return rel.startsWith(norm) || absPath.startsWith(join(repoRoot, norm));
    });
    if (!allowed) {
      await appendLog(repoRoot, activeFlowName, session_id, `SCOPE_VIOLATION stage=${state.current_stage} path=${fp}`);
      return deny(
        `Write scope violation: stage '${state.current_stage}' is docs_only.\n` +
        `Allowed paths: ${docsPaths.join(', ')}\n` +
        `Blocked: ${fp}`
      );
    }
  }

  return null;

  } catch (e) {
    try {
      await appendLog(repoRoot, activeFlowName, session_id, `ERROR pretool tool=${tool_name}: ${truncateError(e)}`);
    } catch { /* appendLog itself failed */ }
    return null;
  }
}
