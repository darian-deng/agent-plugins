import { join, relative, resolve } from 'path';
import type { PreToolInput } from './types.js';
import {
  resolveActiveFlow,
  appendLog,
  signalPath,
  activeJsonPath,
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
    const cpFragments = [
      signalPath(repoRoot, activeFlowName),
      join(repoRoot, flowRel, 'state', 'active.json'),
      join(repoRoot, flowRel, 'scripts'),
      join(flowRel, 'state', 'signal'),
      join(flowRel, 'state', 'active.json'),
      join(flowRel, 'scripts'),
    ];
    if (cpFragments.some((f) => command.includes(f))) {
      return deny(
        'Bash access to ai-flow control-plane files (signal / active.json / scripts) is blocked — matching is by path fragment, so this covers reads too. ' +
        'To READ these files, use the Read tool instead (it can read them). To write the signal use the Write tool; active.json / scripts are changed by the user manually.'
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
      `there. Re-issue the write with an absolute path to the location you actually intend: ` +
      `a flow-root artifact is ${join(repoRoot, fp)}; a file under the current dir is ${resolve(cwd, fp)}.`
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
  const rel = relative(repoRoot, absPath);
  const flowBase = join('.ai-flow', activeFlowName);

  // active.json direct write
  if (rel === join(flowBase, 'state', 'active.json')) {
    await appendLog(repoRoot, activeFlowName, session_id, `BLOCKED direct write to active.json`);
    return deny('Direct writes to active.json are blocked (control plane protection).');
  }

  // config.json
  if (rel === join(flowBase, 'config.json')) {
    await appendLog(repoRoot, activeFlowName, session_id, `BLOCKED write to config.json`);
    return deny('config.json is read-only during flow execution.');
  }

  // stages/
  if (rel.startsWith(join(flowBase, 'stages') + '/')) {
    await appendLog(repoRoot, activeFlowName, session_id, `BLOCKED write to stage prompt: ${fp}`);
    return deny('Stage prompt files are read-only during flow execution.');
  }

  // scripts/ — special message
  if (rel.startsWith(join(flowBase, 'scripts') + '/')) {
    await appendLog(repoRoot, activeFlowName, session_id, `BLOCKED write to scripts: ${fp}`);
    return deny('Script files cannot be modified during flow execution. Ask the user to replace them manually.');
  }

  // ─── Write scope enforcement ──────────────────────────────────────────────────
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
