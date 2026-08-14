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

function allow(): PreToolResult {
  return { permissionDecision: 'allow' };
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
  const m = /^node((?:\s+--[A-Za-z0-9][A-Za-z0-9-]*(?:=[^\s]*)?)*)\s+(?:"([^"]*)"|'([^']*)'|([^\s"']+))(\s[\s\S]*)?$/.exec(segment);
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
 * templates in its tree (ai-flow's own repo ships `.ai-flow/<flow>/` copies
 * under the plugin directory) and those are ordinary content, editable during a
 * flow. What separates the two is whether the copy lives inside a linked
 * worktree, which is exactly the condition under which an edit there can travel
 * back into the flow's own checkout via a merge.
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
  if (!sameAnchor && !isInsideLinkedWorktree(anchor)) return null;

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

  const config = await loadFlowConfig(repoRoot, activeFlowName);

  // ─── Context block enforcement ────────────────────────────────────────────────
  if (state.context_blocked && WRITE_TOOLS.has(tool_name)) {
    const blockedPct = state.context_warning.warned_at_pct;
    const pctInfo = blockedPct !== null ? ` at ${blockedPct}%` : '';
    return deny(
      `Context blocked${pctInfo}. Run /clear to continue — state is persisted and progress won't be lost.`
    );
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
    const cpFragments = [...stateFragments, ...scriptFragments];
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
      .filter((seg) => !isFlowScriptExecution(seg, scriptFragments, stateFragments));
    if (offending.length > 0) {
      return deny(
        'Bash access to ai-flow control-plane files (signal / active.json / scripts) is blocked — matching is by path fragment, so this covers reads too. ' +
        'To READ these files, use the Read tool instead (it can read them). To write the signal use the Write tool; active.json / scripts are changed by the user manually. ' +
        'RUNNING a flow script is allowed, but only as a whole command on its own: `node <flow>/scripts/<name>.cjs [args]`.'
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
    if (stageCfg.completion.script) {
      const flowDir = join(repoRoot, '.ai-flow', activeFlowName);
      const scriptOpts = stageCfg.completion.script.timeout_ms !== undefined
        ? { timeout_ms: stageCfg.completion.script.timeout_ms }
        : undefined;
      const scriptResult = await runScript(stageCfg.completion.script.command, flowDir, scriptOpts);
      if (!scriptResult.ok) {
        await appendLog(repoRoot, activeFlowName, session_id, `SCRIPT_FAIL stage=${state.current_stage} reason=${scriptResult.reason.replace(/\n/g, ' ').slice(0, 80)}`);
        return deny(`Script validation failed:\n${scriptResult.reason}\n\nFix the issues and try again.`);
      }
    }

    // Gate type: ALLOW (PostToolUse will detect gate via signal content and handle pending state)
    if (stageCfg.completion.gate) {
      await appendLog(repoRoot, activeFlowName, session_id, `GATE_SIGNAL_WRITTEN stage=${state.current_stage}`);
      return allow();
    }

    // None/script type (non-gate): ALLOW — PostToolUse will advance stage and inject next prompt
    await appendLog(repoRoot, activeFlowName, session_id, `SIGNAL_ALLOW stage=${state.current_stage}`);
    return allow();
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
