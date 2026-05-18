import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { isUserScopeInstall, GLOBAL_SCOPE_ERROR, STAGES_DIR, HELPER_PATH } from './config.js';
import { writeInitRecord } from './state.js';

export interface InitResult {
  ok: boolean;
  reason?: string;
  message?: string;
}

const GITIGNORE_ENTRIES = [
  '.feat-flow/state.json',
  '.feat-flow/gate-token',
  '.feat-flow/violations.log',
  '.feat-flow/*.tmp',
  '.feat-flow/transitions.log',
];

function getGitRoot(cwd: string): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd, stdio: 'pipe' }).toString().trim();
  } catch {
    return null;
  }
}

function getGitRemote(cwd: string): string {
  try {
    return execSync('git remote get-url origin', { cwd, stdio: 'pipe' }).toString().trim();
  } catch {
    return '';
  }
}

function updateGitignore(repoRoot: string): void {
  const gitignorePath = join(repoRoot, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
  const lines = existing.split('\n');
  const toAdd = GITIGNORE_ENTRIES.filter(e => !lines.some(l => l.trim() === e));
  if (toAdd.length > 0) {
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    writeFileSync(gitignorePath, existing + separator + toAdd.join('\n') + '\n');
  }
}

function copyDefaultStages(repoRoot: string): void {
  const dest = join(repoRoot, '.feat-flow', 'stages');
  if (existsSync(dest)) return; // project has own stages, respect them
  mkdirSync(dest, { recursive: true });
  try {
    const files = readdirSync(STAGES_DIR).filter(f => f.endsWith('.md'));
    for (const file of files) {
      copyFileSync(join(STAGES_DIR, file), join(dest, file));
    }
  } catch { /* STAGES_DIR missing in unusual installs */ }
}

function readHelper(): string {
  try {
    return readFileSync(HELPER_PATH, 'utf-8');
  } catch {
    return '';
  }
}

export async function runInit(cwd: string): Promise<InitResult> {
  // 1. scope check
  if (isUserScopeInstall(cwd)) {
    return { ok: false, reason: GLOBAL_SCOPE_ERROR };
  }

  // 2. Node.js check (we're running in Node, but verify it's on PATH for sub-processes)
  try {
    execSync('node --version', { stdio: 'pipe' });
  } catch {
    return { ok: false, reason: 'feat-flow init 失败：未找到 Node.js\n\n安装：https://nodejs.org（推荐 LTS v20+）' };
  }

  // 3. git repo check
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) {
    return { ok: false, reason: 'feat-flow init 失败：当前目录不是 git 仓库\n\n请在项目根目录下运行。' };
  }

  // 4. ensure .claude/ exists
  mkdirSync(join(gitRoot, '.claude'), { recursive: true });

  // 5. ensure .feat-flow/ exists
  mkdirSync(join(gitRoot, '.feat-flow'), { recursive: true });

  // 6. update .gitignore (idempotent)
  updateGitignore(gitRoot);

  // 7. copy default stages if project has none yet
  copyDefaultStages(gitRoot);

  // 8. write init record to CLAUDE_PLUGIN_DATA
  writeInitRecord(gitRoot, { git_remote: getGitRemote(gitRoot) });

  const helperContent = readHelper();
  const message =
    `**feat-flow 初始化完成**\n\n` +
    `- 阶段文档 \`.feat-flow/stages/\` 已就绪（可按项目定制后提交到 git）\n` +
    `- \`.gitignore\` 已更新\n\n` +
    `使用 \`feat-flow start <需求描述>\` 开始工作流。` +
    (helperContent ? `\n\n---\n\n${helperContent}` : '');

  return { ok: true, message };
}
