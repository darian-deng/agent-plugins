import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { readActiveState, deleteGateToken, appendTransition } from '../state.js';
import type { CommandResult } from '../types.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

export async function handleAbort(repoRoot: string, flowName: string, args: string): Promise<CommandResult> {
  const state = await readActiveState(repoRoot, flowName);
  if (!state) {
    return { action: 'deny', reason: 'No active flow to abort.' };
  }

  // Token-level check: --confirm must be a discrete token, not a substring of another flag.
  const confirmed = args.split(/\s+/).includes('--confirm');

  if (!confirmed) {
    return {
      action: 'deny',
      reason:
        `即将中止 flow '${state.flow_id}'（当前 ${state.current_stage}）：\n` +
        `  • 创建快照 branch: ${flowName}/aborted-<timestamp>\n` +
        `  • 将当前所有改动 commit 到该 branch\n` +
        `  • 删除 active.json（flow 终止，hooks 解锁）\n\n` +
        `确认执行：${flowName} abort --confirm`,
    };
  }

  // Capture original branch before any checkout, handles detached HEAD gracefully.
  let originalBranch: string;
  try {
    originalBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  } catch {
    originalBranch = '';
  }

  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const branchName = `${flowName}/aborted-${timestamp}`;

  let snapshotCommitted = false;
  try {
    git(['checkout', '-b', branchName], repoRoot);

    const snapshotDir = join(repoRoot, 'docs', flowName, state.flow_id);
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(
      join(snapshotDir, 'state-snapshot.json'),
      JSON.stringify(state, null, 2)
    );

    git(['add', '-A'], repoRoot);
    git(['commit', '-m', `${flowName}: abort flow ${state.flow_id}`], repoRoot);
    snapshotCommitted = true;
    if (originalBranch && originalBranch !== 'HEAD') {
      git(['checkout', originalBranch], repoRoot);
    }
  } catch (err) {
    // Best-effort: restore original branch.
    if (originalBranch && originalBranch !== 'HEAD') {
      try { git(['checkout', originalBranch], repoRoot); } catch { /* best-effort */ }
    }
    await appendTransition(repoRoot, flowName, `ABORT_ERROR ${String(err)}`);
    const reason = snapshotCommitted
      ? `Abort partially failed: snapshot was committed to '${branchName}' but could not switch back.\n` +
        `Error: ${String(err)}\n` +
        `Flow remains active — active.json was NOT deleted.\n` +
        `You can resume from: ${flowName} resume ${branchName}`
      : `Abort failed: could not commit snapshot to branch '${branchName}'.\n` +
        `Error: ${String(err)}\n` +
        `Flow remains active — active.json was NOT deleted.`;
    return { action: 'deny', reason };
  }

  // Only reach here if the entire git sequence succeeded.
  const activeJsonPath = join(repoRoot, '.ai-flow', flowName, 'state', 'active.json');
  if (existsSync(activeJsonPath)) unlinkSync(activeJsonPath);
  await deleteGateToken(repoRoot, flowName);
  await appendTransition(repoRoot, flowName, `ABORTED branch=${branchName}`);

  const headNote = (!originalBranch || originalBranch === 'HEAD')
    ? `\nNote: you were in detached HEAD state; HEAD is now on '${branchName}'.`
    : '';

  return {
    action: 'allow',
    additionalContext:
      `Flow '${flowName}' aborted. Snapshot saved to branch: ${branchName}${headNote}\n` +
      `To resume: ${flowName} resume ${branchName}`,
  };
}
