import { execSync } from 'child_process';
import { hasActiveFlow } from './state.js';

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// Runs checks specific to `feat-flow start`:
// - no active flow (can't start a second one)
// - clean working tree (need a clean base_sha)
// Git-repo and init checks are handled by auto-init in the router.
export function runPreflight(repoRoot: string): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (hasActiveFlow(repoRoot)) {
    errors.push('已有活跃 flow 正在进行中。请先运行 feat-flow abort 终止，或使用 feat-flow status 查看当前状态。');
  }

  try {
    const status = execSync('git status --porcelain', { cwd: repoRoot, stdio: 'pipe' })
      .toString()
      .trim();
    if (status) {
      errors.push(
        '工作区有未提交的改动，无法记录干净的 base_sha。\n' +
        '请先执行 git commit 或 git stash，再开始 feat-flow。\n' +
        `未提交文件：\n${status.split('\n').slice(0, 5).map(l => `  ${l}`).join('\n')}`,
      );
    }
  } catch {
    warnings.push('无法检查 git 工作区状态。');
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function getBaseSha(repoRoot: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoRoot, stdio: 'pipe' })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}
