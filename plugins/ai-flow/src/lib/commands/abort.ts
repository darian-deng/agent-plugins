import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, realpathSync } from 'fs';
import { join } from 'path';
import { readActiveState, appendLog } from '../state.js';
import type { CommandResult } from '../types.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

/**
 * Linked worktrees this flow created, i.e. the ones under `<repoRoot>/.worktrees/`.
 *
 * Deliberately scoped to that prefix rather than "every linked worktree": a
 * developer may keep long-lived worktrees of the same repo for unrelated work,
 * and those must not block aborting a flow.
 *
 * This matters because the snapshot below runs `git add -A` at repoRoot only, so
 * commits and uncommitted work living in a separate worktree are invisible to it
 * — aborting would silently drop them while promising the opposite.
 */
function flowWorktrees(repoRoot: string, flowId: string): { path: string; branch: string }[] {
  let out: string;
  try {
    out = git(['worktree', 'list', '--porcelain'], repoRoot);
  } catch {
    return []; // not a git repo / git unavailable — nothing we can assert
  }
  // `git worktree list` prints real paths, so compare against a resolved repoRoot:
  // when the flow anchor is reached through a symlink the raw prefix never matches
  // and every worktree looks absent — a fail-OPEN in the one direction this guard
  // exists to cover.
  let base = repoRoot;
  try { base = realpathSync(repoRoot); } catch { /* keep raw */ }
  // Scoped to `<repoRoot>/.worktrees/<flow_id>-*`, matching what the flow's own
  // helper script creates. A developer's unrelated worktree parked at
  // `.worktrees/dev` must not block aborting — the comment above promises exactly
  // that, and a bare `.worktrees/` prefix broke the promise.
  const prefix = join(base, '.worktrees') + '/' + flowId + '-';
  const found: { path: string; branch: string }[] = [];
  // Register on the `worktree ` line and read the real branch from the following
  // `branch refs/heads/…` line. Two reasons not to key off `branch ` alone or to
  // derive the name from the path:
  //  - `git worktree add --detach` emits `detached` instead of `branch …`, so
  //    keying off `branch ` drops that worktree entirely — fail-open in exactly
  //    the direction this guard exists to cover.
  //  - deriving `wt/<dirname>` from the path invents a branch that may not exist,
  //    and the message below tells the developer to run `git branch -D` on it.
  let cur: { path: string; branch: string } | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      const p = line.slice('worktree '.length).trim();
      cur = p.startsWith(prefix) ? { path: p, branch: '(detached)' } : null;
      if (cur) found.push(cur);
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      cur = null;
    } else if (line.trim() === '') {
      cur = null; // entry boundary
    }
  }
  return found;
}

export async function handleAbort(repoRoot: string, flowName: string, sessionId: string, args: string = ''): Promise<CommandResult> {
  const state = await readActiveState(repoRoot, flowName);
  if (!state) {
    return { action: 'deny', reason: 'No active flow to abort.' };
  }

  // Token-level check: --confirm must be a discrete token, not a substring of another flag.
  const confirmed = args.split(/\s+/).includes('--confirm');

  const worktrees = flowWorktrees(repoRoot, state.flow_id);
  const worktreeList = worktrees.map((w) => `      - ${w.path} (${w.branch})`).join('\n');

  if (!confirmed) {
    return {
      action: 'deny',
      reason:
        `即将中止 flow '${state.flow_id}'（当前 ${state.current_stage}）：\n` +
        `  • 创建快照 branch: ${flowName}/aborted-<timestamp>\n` +
        `  • 将当前所有改动 commit 到该 branch\n` +
        `  • 删除 active.json（flow 终止，hooks 解锁）\n\n` +
        (worktrees.length > 0
          ? `⚠ 本 flow 还有 ${worktrees.length} 个未收口的 worktree：\n${worktreeList}\n` +
            `  快照只覆盖主工作树，这些 worktree 里的改动与 commit 不会被保存。\n` +
            `  先收口（归并或自行保留分支）再 abort。\n\n`
          : '') +
        `确认执行：${flowName} abort --confirm`,
    };
  }

  // Refuse rather than snapshot a partial tree: `git add -A` at repoRoot cannot
  // see another worktree's disk, so proceeding would drop that work silently.
  if (worktrees.length > 0) {
    await appendLog(repoRoot, flowName, sessionId, `ABORT_REFUSED_WORKTREES count=${worktrees.length}`);
    return {
      action: 'deny',
      reason:
        `Abort 已拒绝：本 flow 有 ${worktrees.length} 个未收口的 worktree，快照会漏掉它们的改动。\n${worktreeList}\n\n` +
        `处理其中每一个，然后重试：\n` +
        `  • 要保留其工作：先归并回当前分支（\`git merge --ff-only <branch>\`），或留下该分支不删\n` +
        `  • 确定丢弃：\`git worktree remove --force <path> && git branch -D <branch>\`\n` +
        `  • 目录已手动删除但条目仍在：\`git worktree prune\``,
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
    await appendLog(repoRoot, flowName, sessionId, `ABORT_ERROR ${String(err)}`);
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
  await appendLog(repoRoot, flowName, sessionId, `ABORTED branch=${branchName}`);

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
