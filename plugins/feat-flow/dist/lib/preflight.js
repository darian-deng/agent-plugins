import { execSync } from 'child_process';
import { isSetupDone, hasActiveFlow } from './state.js';
export function runPreflight(repoRoot) {
    const errors = [];
    const warnings = [];
    // 1. git repo check
    try {
        execSync('git rev-parse --show-toplevel', { cwd: repoRoot, stdio: 'pipe' });
    }
    catch {
        errors.push('当前目录不是 git 仓库。请在项目根目录下运行 feat-flow start。');
        return { ok: false, errors, warnings };
    }
    // 2. setup done check
    if (!isSetupDone(repoRoot)) {
        errors.push('当前项目尚未初始化 feat-flow。请先运行：feat-flow-setup');
    }
    // 3. no active flow
    if (hasActiveFlow(repoRoot)) {
        errors.push('已有活跃 flow 正在进行中。请先运行 feat-flow abort 终止，或使用 feat-flow status 查看当前状态。');
    }
    // 4. clean working tree (base_sha integrity)
    try {
        const status = execSync('git status --porcelain', { cwd: repoRoot, stdio: 'pipe' })
            .toString()
            .trim();
        if (status) {
            errors.push('工作区有未提交的改动，无法记录干净的 base_sha。\n' +
                '请先执行 git commit 或 git stash，再开始 feat-flow。\n' +
                `未提交文件：\n${status.split('\n').slice(0, 5).map(l => `  ${l}`).join('\n')}`);
        }
    }
    catch {
        warnings.push('无法检查 git 工作区状态。');
    }
    return { ok: errors.length === 0, errors, warnings };
}
export function getBaseSha(repoRoot) {
    try {
        return execSync('git rev-parse HEAD', { cwd: repoRoot, stdio: 'pipe' })
            .toString()
            .trim();
    }
    catch {
        return 'unknown';
    }
}
//# sourceMappingURL=preflight.js.map