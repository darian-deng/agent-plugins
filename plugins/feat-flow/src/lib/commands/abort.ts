import { execSync } from 'child_process';
import { existsSync, copyFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { UserPromptInput, HookOutput, UserPromptOutput } from '../types.js';
import { readState, hasActiveFlow, removeMarker, removeGateToken, paths, appendTransition } from '../state.js';

export async function handleAbort(input: UserPromptInput): Promise<HookOutput> {
  const { cwd } = input;

  if (!hasActiveFlow(cwd)) {
    const out: UserPromptOutput = {
      hookEventName: 'UserPromptSubmit',
      permissionDecision: 'deny',
      permissionDecisionReason: '没有活跃 flow 可以终止。\n运行 feat-flow start <需求描述> 开始新工作流。',
    };
    return { hookSpecificOutput: out };
  }

  const state = readState(cwd);
  const rawFlowId = state?.flow_id ?? 'unknown';
  // Validate flowId before use in shell — tampered state.json could inject metacharacters
  const flowId = /^[\w/-]+$/.test(rawFlowId) ? rawFlowId : 'unknown-flow';
  const rawSha = state?.base_sha ?? 'HEAD';
  // Validate before shell interpolation — prevents injection via tampered state.json
  const baseSha = /^[0-9a-f]{7,40}$/i.test(rawSha) || rawSha === 'HEAD' ? rawSha : 'HEAD';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const branchName = `feat-flow/aborted-${timestamp}`;

  const exec = (cmd: string) =>
    execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();

  let abortBranch = branchName;

  try {
    // Copy transitions.log to docs before committing
    const p = paths(cwd);
    const docsDir = join(cwd, 'docs', 'feat-flows', flowId);
    if (existsSync(p.transitionsLog) && existsSync(docsDir)) {
      try {
        copyFileSync(p.transitionsLog, join(docsDir, 'history.log'));
      } catch { /* non-fatal */ }
    }

    // Create abort branch — must succeed before any destructive operation
    exec(`git checkout -b ${branchName}`);

    exec('git add -A');
    try {
      exec(`git commit -m "feat-flow: abort flow ${flowId}"`);
    } catch {
      // Nothing to commit — acceptable
    }

    // Return to original branch BEFORE resetting (guard: if this fails, do not reset)
    exec('git checkout -');
    // Only reset after confirmed back on original branch
    exec(`git reset --hard ${baseSha}`);

    abortBranch = branchName;
  } catch (err) {
    // Partial failure — still clean up marker
    appendTransition(cwd, `ABORT_ERROR ${String(err)}`);
  }

  // Clean up marker, token, and transitions log entry
  removeMarker(cwd);
  removeGateToken(cwd);
  appendTransition(cwd, `FLOW_ABORTED flow_id=${flowId} branch=${abortBranch}`);

  const ctx =
    `✅ feat-flow 已终止\n\n` +
    `flow_id:      ${flowId}\n` +
    `abort branch: ${abortBranch}\n\n` +
    `所有改动已保存到 ${abortBranch} 分支。\n` +
    `如需恢复，执行：feat-flow resume ${abortBranch}`;

  const out: UserPromptOutput = {
    hookEventName: 'UserPromptSubmit',
    additionalContext: ctx,
  };
  return {
    systemMessage: `✅ feat-flow 已终止，改动保存至 ${abortBranch}`,
    hookSpecificOutput: out,
  };
}
