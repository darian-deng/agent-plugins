/**
 * ai-flow install CLI — deterministic backing for the /ai-flow:add skill.
 *
 * The skill drives the *interaction* (showing the flow list, asking the user
 * which flow + which directory via AskUserQuestion). This CLI does the
 * *mechanical, must-be-correct* work and returns structured results:
 *
 *   node dist/cli/add.js list
 *       → JSON list of built-in flows the plugin ships.
 *   node dist/cli/add.js detect [--cwd <dir>]
 *       → JSON: where the user is, the project-root candidates for the anchor,
 *         git root, and nested-.ai-flow warnings.
 *   node dist/cli/add.js install --flow <name> --dir <dir> [--force]
 *       → copies the template, fixes .gitignore, runs the flow's preflight,
 *         prints how to start. Human-readable (this is the final message).
 *
 * It locates the plugin root from its own file location, so it needs no python
 * and no $CLAUDE_PLUGIN_ROOT.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  cpSync,
  rmSync,
  chmodSync,
  appendFileSync,
  realpathSync,
} from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/cli/add.js → plugin root is two levels up.
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const PLUGIN_FLOWS_DIR = join(PLUGIN_ROOT, '.ai-flow');

// Project-root marker files (multi-language) — presence of any marks a project
// root. git root is always an acceptable fallback anchor.
const PROJECT_MARKERS = [
  'package.json',
  'pyproject.toml',
  'go.mod',
  'go.work',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
  'pnpm-workspace.yaml',
];

interface FlowInfo {
  name: string;
  description: string;
}

export function builtinFlows(): FlowInfo[] {
  if (!existsSync(PLUGIN_FLOWS_DIR)) return [];
  const out: FlowInfo[] = [];
  for (const entry of readdirSync(PLUGIN_FLOWS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cfgPath = join(PLUGIN_FLOWS_DIR, entry.name, 'config.json');
    if (!existsSync(cfgPath)) continue;
    let description = '';
    try {
      description = String((JSON.parse(readFileSync(cfgPath, 'utf-8')) as { description?: string }).description ?? '');
    } catch { /* keep empty description */ }
    out.push({ name: entry.name, description });
  }
  return out;
}

function hasProjectMarker(dir: string): string | null {
  for (const m of PROJECT_MARKERS) {
    if (existsSync(join(dir, m))) return m;
  }
  return null;
}

/** Nearest ancestor (at or above `dir`) that is a project root, with its marker. */
export function nearestProjectRoot(dir: string): { dir: string; marker: string } | null {
  let cur = resolve(dir);
  while (true) {
    const marker = hasProjectMarker(cur);
    if (marker) return { dir: cur, marker };
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// Canonicalize a path (resolve symlinks) so de-duplication is reliable: git
// returns the real path (e.g. /private/tmp/x on macOS) while cwd-derived
// candidates keep the symlinked form (/tmp/x); without this they would split
// into two "different" candidate anchors for the same directory.
function canonical(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

function gitRoot(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** Nearest STRICT ancestor of `dir` that contains a `.ai-flow` directory. */
function outerAiFlow(dir: string): string | null {
  let cur = dirname(resolve(dir));
  while (true) {
    if (existsSync(join(cur, '.ai-flow'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function installedFlows(dir: string): string[] {
  const af = join(dir, '.ai-flow');
  if (!existsSync(af)) return [];
  try {
    return readdirSync(af, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(af, e.name, 'config.json')))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function detect(cwd: string) {
  const resolvedCwd = canonical(cwd);
  const git = gitRoot(resolvedCwd);
  const npr = nearestProjectRoot(resolvedCwd);

  // Build ordered, de-duplicated candidate anchors.
  const seen = new Set<string>();
  const candidates: Array<{ dir: string; reason: string; isCwd: boolean; outerAiFlow: string | null; existingFlows: string[] }> = [];
  const add = (dir: string | null, reason: string) => {
    if (!dir) return;
    const r = canonical(dir);
    if (seen.has(r)) return;
    seen.add(r);
    candidates.push({
      dir: r,
      reason,
      isCwd: r === resolvedCwd,
      outerAiFlow: outerAiFlow(r),
      existingFlows: installedFlows(r),
    });
  };

  if (hasProjectMarker(resolvedCwd)) add(resolvedCwd, `当前目录就是项目根(${hasProjectMarker(resolvedCwd)})`);
  if (npr && npr.dir !== resolvedCwd) add(npr.dir, `最近的项目根(${npr.marker})`);
  add(git, 'git 根');
  if (candidates.length === 0) add(resolvedCwd, '当前目录(无项目标记、非 git 仓)');

  return {
    cwd: resolvedCwd,
    gitRoot: git,
    recommended: candidates[0]?.dir ?? resolvedCwd,
    candidates,
  };
}

function fail(msg: string): never {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function install(flow: string, dir: string, force: boolean) {
  const src = join(PLUGIN_FLOWS_DIR, flow);
  if (!existsSync(join(src, 'config.json'))) {
    fail(`内置 flow '${flow}' 不存在。可用:${builtinFlows().map((f) => f.name).join(', ') || '(无)'}`);
  }
  const target = resolve(dir);
  if (!existsSync(target)) fail(`目标目录不存在:${target}`);

  const dest = join(target, '.ai-flow', flow);
  const lines: string[] = [];

  if (existsSync(join(dest, 'config.json')) && !force) {
    fail(`'${flow}' 已安装在 ${target}/.ai-flow/${flow}。如需覆盖,重跑并加 --force。`);
  }

  const outer = outerAiFlow(target);
  if (outer) {
    lines.push(`⚠️  外层目录已存在 .ai-flow:${outer}`);
    lines.push(`    在 ${target} 安装后,在此子树工作时引擎会就近锚定到 ${target}/.ai-flow,`);
    lines.push(`    **完全屏蔽** ${outer}/.ai-flow 的 flow(这是项目隔离的预期行为)。确认这是你要的。`);
    lines.push('');
  }

  // Copy template. On --force, wipe the existing dest first so files removed
  // from the template (renamed stages, deleted scripts, preflight.sh→.cjs) don't
  // linger — cpSync merges over the tree and would otherwise leave stale files.
  if (force && existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });

  // chmod preflight if present
  const preflightSh = join(dest, 'preflight.sh');
  if (existsSync(preflightSh)) {
    try { chmodSync(preflightSh, 0o755); } catch { /* non-fatal */ }
  }

  // Ensure .gitignore ignores the runtime state dir (at the git root, so one
  // rule covers .ai-flow installed anywhere in the repo — including subprojects)
  ensureGitignore(target);

  lines.push(`✅ 已安装 '${flow}' → ${dest}`);
  lines.push('');

  // Run preflight (fail-fast diagnostics, but files stay installed either way)
  const preflightResult = runPreflight(dest, target);
  if (preflightResult !== null) {
    lines.push(preflightResult.ok ? '✅ preflight 通过' : '❌ preflight 未通过(flow 已安装,补齐下列依赖后即可启动):');
    if (preflightResult.output.trim()) lines.push(preflightResult.output.trimEnd());
    lines.push('');
  }

  // Usage
  let desc = '';
  try {
    desc = String((JSON.parse(readFileSync(join(dest, 'config.json'), 'utf-8')) as { description?: string }).description ?? '');
  } catch { /* ignore */ }
  lines.push(`📋 ${flow}${desc ? ' — ' + desc : ''}`);
  lines.push(`锚点(项目根):${target}`);
  lines.push(`启动:在 ${target} 目录的 session 里输入  ${flow} start <需求描述>`);
  lines.push(`查看流程:${flow} help`);

  process.stdout.write(lines.join('\n') + '\n');
}

export function ensureGitignore(target: string): void {
  // Write the rule at the git root — not the flow anchor. The anchor may be a
  // monorepo subproject nested under the repo root; a rule sitting there only
  // covers that one directory. One rule at the git root, with a `**/` prefix,
  // ignores every `.ai-flow/**/state/` anywhere in the repo.
  const root = gitRoot(target) ?? target;
  const giPath = join(root, '.gitignore');
  // `.worktrees/` was where a flow used to put the isolated checkout of a ticket it
  // runs in parallel. Those now live BESIDE the repo (`<repo>.ai-flow-worktrees/`),
  // because module resolution escapes a nested worktree into the main checkout's
  // `node_modules`, giving the same package two physical paths — TypeScript sees two
  // unrelated types and typecheck inside the worktree fails for unrelated reasons.
  // The rule stays for worktrees opened before that change and for ones a developer
  // parks there by hand: unignored, the whole directory shows up as untracked and the
  // squash at the end of a flow (`git add -A`) swallows it as an embedded repository
  // — which git reports as a *warning*, not an error, so the commit silently ends up
  // carrying an empty gitlink instead of the work.
  const rules = ['**/.ai-flow/**/state/', '.worktrees/'];
  let existing = '';
  try { existing = existsSync(giPath) ? readFileSync(giPath, 'utf-8') : ''; } catch { /* treat as empty */ }
  const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = rules.filter((r) => !present.has(r));
  if (missing.length === 0) return;
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  try { appendFileSync(giPath, `${prefix}${missing.join('\n')}\n`); } catch { /* non-fatal */ }
}

function runPreflight(flowDir: string, cwd: string): { ok: boolean; output: string } | null {
  // Prefer a Node preflight (.cjs/.mjs — node-only, cross-platform); fall back
  // to a legacy shell preflight.
  let res;
  const cjs = join(flowDir, 'preflight.cjs');
  const mjs = join(flowDir, 'preflight.mjs');
  const sh = join(flowDir, 'preflight.sh');
  if (existsSync(cjs)) res = spawnSync(process.execPath, [cjs], { cwd, encoding: 'utf-8', timeout: 30_000 });
  else if (existsSync(mjs)) res = spawnSync(process.execPath, [mjs], { cwd, encoding: 'utf-8', timeout: 30_000 });
  else if (existsSync(sh)) res = spawnSync('sh', [sh], { cwd, encoding: 'utf-8', timeout: 30_000 });
  else return null;
  const output = [res.stdout, res.stderr].filter(Boolean).join('\n');
  return { ok: res.status === 0, output };
}

// ─── arg parsing ──────────────────────────────────────────────────────────────
function getOpt(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === 'list') {
    process.stdout.write(JSON.stringify(builtinFlows(), null, 2) + '\n');
    return;
  }
  if (cmd === 'detect') {
    const cwd = getOpt(argv, 'cwd') ?? process.cwd();
    process.stdout.write(JSON.stringify(detect(cwd), null, 2) + '\n');
    return;
  }
  if (cmd === 'install') {
    const flow = getOpt(argv, 'flow');
    const dir = getOpt(argv, 'dir') ?? process.cwd();
    const force = argv.includes('--force');
    if (!flow) fail('用法:install --flow <name> --dir <dir> [--force]');
    install(flow, dir, force);
    return;
  }

  fail(`未知命令:${cmd ?? '(空)'}。可用:list | detect | install`);
}

// Only run as a CLI when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
