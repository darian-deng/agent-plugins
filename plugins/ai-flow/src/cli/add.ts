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
 *       → creates the project-side anchor, fixes .gitignore, runs the flow's
 *         preflight, prints how to start. Human-readable (this is the final message).
 *
 * Installing copies NOTHING. Since 0.69.0 a built-in flow's definition (stages,
 * references, scripts, helper.md, preflight.cjs, the full config.json) lives in the
 * plugin and travels with the plugin version — see `src/lib/flow-paths.ts` for why.
 * All the project gets is the two things that are genuinely per-project:
 *
 *   <target>/.ai-flow/<flow>/config.json   sparse override layer, written as `{}`
 *   <target>/.ai-flow/<flow>/state/        runtime state, gitignored
 *
 * config.json doubles as the anchor marker: `resolveActiveFlow` / `discoverFlows`
 * answer "which flows does this project run" by its presence, so it is written even
 * when empty.
 *
 * It locates the plugin root from its own file location, so it needs no python
 * and no $CLAUDE_PLUGIN_ROOT.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
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

interface LiveFlow {
  flow_id: string;
  current_stage: string;
}

/** The flow instance currently running out of `dest`, if any. */
function liveFlowAt(dest: string): LiveFlow | null {
  const p = join(dest, 'state', 'active.json');
  if (!existsSync(p)) return null;
  try {
    const s = JSON.parse(readFileSync(p, 'utf-8')) as Partial<LiveFlow>;
    if (!s.current_stage) return null;
    return { flow_id: String(s.flow_id ?? '(未知)'), current_stage: s.current_stage };
  } catch {
    return null;
  }
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

/**
 * Is this project-side override layer carrying anything at all?
 *
 * `{}` (what a fresh install writes) and an unreadable/empty file both count as
 * empty: there is nothing a developer could lose by resetting them.
 */
function overrideKeys(configPath: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.keys(parsed as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** Stage ids a config.json declares, or [] if it declares none / cannot be read. */
function stageIdsOf(configPath: string): string[] {
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as { stages?: Array<{ id?: string }> };
    return (cfg.stages ?? []).map((s) => String(s.id ?? '')).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Would resetting the override layer strand a running flow on a stage that no
 * longer exists?
 *
 * `loadFlowConfig` lets a project-side `stages` REPLACE the plugin's wholesale
 * (partial merge of a stage list has no defensible semantics), so `--force` is the
 * one thing this command does that can change which stages a running flow has. If
 * the stage it is sitting on is not among the plugin's, nothing crashes — and that
 * is the problem. Both hot paths catch and return null (`session-handler.ts` and
 * `pretool-handler.ts` end in catch-alls that log `ERROR <hook>` and bail), so the
 * flow does not stop, it goes quiet: no stage prompt injected, every PreToolUse
 * guard failing OPEN, the signal no longer intercepted so the stage never advances.
 * The only trace is one line in flow.log.
 *
 * Deliberately narrow. It fires only when the override actually carries `stages` —
 * without them the effective table is already the plugin's, so `--force` changes
 * nothing about stages and refusing would blame this command for a flow that was
 * already broken.
 */
export function forceWouldStrandFlow(
  defConfigPath: string,
  overridePath: string,
  live: LiveFlow | null
): { stranded: true; incoming: string[] } | { stranded: false } {
  if (!live) return { stranded: false };
  if (!overrideKeys(overridePath).includes('stages')) return { stranded: false };
  const incoming = stageIdsOf(defConfigPath);
  // An unreadable plugin config is a different failure; install() already required
  // it to exist. Don't turn it into a bogus stranding refusal.
  if (incoming.length === 0 || incoming.includes(live.current_stage)) return { stranded: false };
  return { stranded: true, incoming };
}

export function install(flow: string, dir: string, force: boolean) {
  const defDir = join(PLUGIN_FLOWS_DIR, flow);
  if (!existsSync(join(defDir, 'config.json'))) {
    fail(`内置 flow '${flow}' 不存在。可用:${builtinFlows().map((f) => f.name).join(', ') || '(无)'}`);
  }
  const target = resolve(dir);
  if (!existsSync(target)) fail(`目标目录不存在:${target}`);

  const dest = join(target, '.ai-flow', flow);
  const overridePath = join(dest, 'config.json');
  const alreadyInstalled = existsSync(overridePath);
  const lines: string[] = [];

  const outer = outerAiFlow(target);
  if (outer) {
    lines.push(`⚠️  外层目录已存在 .ai-flow:${outer}`);
    lines.push(`    在 ${target} 安装后,在此子树工作时引擎会就近锚定到 ${target}/.ai-flow,`);
    lines.push(`    **完全屏蔽** ${outer}/.ai-flow 的 flow(这是项目隔离的预期行为)。确认这是你要的。`);
    lines.push('');
  }

  // A live flow here is NOT a reason to refuse: nothing this command writes can
  // reach the running flow's stage prompts / references / scripts — those live in
  // the plugin now and change only with the plugin version. The one thing install
  // can take away is the project's own override layer, and only under --force.
  const live = liveFlowAt(dest);
  if (live) {
    lines.push(`ℹ️  ${dest} 有一个正在跑的 flow:${live.flow_id}(当前 stage:${live.current_stage})`);
    lines.push(`    它的 stage 提示词 / references / scripts 装在插件里、随插件版本走,本命令一个字都不会动;`);
    lines.push(`    运行状态(state/)原样保留,flow 不会中断。`);
    lines.push('');
  }

  mkdirSync(dest, { recursive: true });

  if (!alreadyInstalled) {
    // `{}` = "no overrides": the plugin's config.json supplies every value. The file
    // exists anyway because its presence is what marks this project as running the flow.
    writeFileSync(overridePath, '{}\n');
    lines.push(`✅ 已安装 '${flow}' → ${dest}`);
  } else if (!force) {
    lines.push(`✅ '${flow}' 已装在 ${dest},本次只补齐缺失的部分。`);
    lines.push(`    config.json(项目侧稀疏覆盖层)保持原样未动——要把它重置成 {} 请重跑并加 --force。`);
  } else {
    const strand = forceWouldStrandFlow(join(defDir, 'config.json'), overridePath, live);
    if (strand.stranded) {
      fail(
        `拒绝重置:这里有一个正在跑的 flow(${live!.flow_id}),它停在 stage '${live!.current_stage}',\n` +
        `而项目侧 config.json 用自己的 stages 覆盖了插件的阶段表。重置成 {} 之后阶段表换成插件那份\n` +
        `(${strand.incoming.join(', ')}),里面没有 '${live!.current_stage}'。\n` +
        `后果不是报错而是**静默失效**:引擎两条热路径都会捕获异常并放行,于是新 session 不再注入\n` +
        `stage 提示词、PreToolUse 的守卫全部 fail open、signal 也不再被拦截,flow 永远推进不下去,\n` +
        `只在 flow.log 留一行 ERROR。\n` +
        `先选一条:① 等它跑完再重置;② \`${flow} abort\` 存快照后再重置;` +
        `③ 手工把 state/active.json 的 current_stage 改成插件阶段表里的对应 id,再重跑本命令。\n` +
        `位置:${dest}`
      );
    }
    const kept = overrideKeys(overridePath);
    if (kept.length > 0) {
      // The override layer is git-tracked, so this is recoverable — but only if the
      // developer knows it happened. Print what is being dropped, verbatim.
      lines.push(`⚠️  --force:下面这份项目侧 config.json 被重置成了 {},原内容在此(git 里也还能找回):`);
      lines.push('```json');
      lines.push(readFileSync(overridePath, 'utf-8').trimEnd());
      lines.push('```');
      lines.push(`    重置后本 flow 全部使用插件默认值(${join(defDir, 'config.json')})。`);
      if (kept.includes('stages')) {
        lines.push(`    ⚠️ 丢掉的键里有 stages:阶段表将换回插件默认的那一份。`);
      }
      lines.push('');
    }
    writeFileSync(overridePath, '{}\n');
    lines.push(`✅ 已重置 '${flow}' 的项目侧覆盖层 → ${overridePath}`);
  }

  // The engine creates this on demand, but writing it here makes the install result
  // self-describing: the two things the project owns are both on disk afterwards.
  mkdirSync(join(dest, 'state'), { recursive: true });

  // Ensure .gitignore ignores the runtime state dir (at the git root, so one
  // rule covers .ai-flow installed anywhere in the repo — including subprojects).
  // config.json is deliberately NOT ignored — it is the anchor and is meant to be
  // committed, empty or not.
  ensureGitignore(target);
  lines.push('');

  // Run preflight (fail-fast diagnostics, but the anchor stays either way). The
  // script lives with the definition, in the plugin; cwd stays the project root so
  // its project-file checks resolve there.
  const preflightResult = runPreflight(defDir, target, dest);
  if (preflightResult !== null) {
    lines.push(preflightResult.ok ? '✅ preflight 通过' : '❌ preflight 未通过(锚点已建好,补齐下列依赖后即可启动):');
    if (preflightResult.output.trim()) lines.push(preflightResult.output.trimEnd());
    lines.push('');
  }

  // Usage. The description comes from the PLUGIN's config.json — the project copy is
  // a sparse override and normally carries nothing at all.
  let desc = '';
  try {
    desc = String((JSON.parse(readFileSync(join(defDir, 'config.json'), 'utf-8')) as { description?: string }).description ?? '');
  } catch { /* ignore */ }
  lines.push(`📋 ${flow}${desc ? ' — ' + desc : ''}`);
  lines.push(`流程定义(随插件版本走,不复制到项目):${defDir}`);
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

/**
 * Run the flow's preflight.
 *
 * `defDir` is where the script lives (the plugin, for a built-in flow); `cwd` is the
 * project root, so project-file checks resolve against the project; `anchorDir` is
 * `<project>/.ai-flow/<flow>`.
 *
 * The two env vars are the same pair the engine injects (`RunScriptOptions.env` in
 * `src/lib/script-executor.ts`). A script that ships with the plugin cannot derive
 * either path from `__dirname` any more — that now points into the plugin's own
 * checkout — so without them a script falls through to its cwd walk-up, or dies.
 */
function runPreflight(defDir: string, cwd: string, anchorDir: string): { ok: boolean; output: string } | null {
  // Prefer a Node preflight (.cjs/.mjs — node-only, cross-platform); fall back
  // to a legacy shell preflight.
  let res;
  const env = { ...process.env, AI_FLOW_FLOW_DIR: anchorDir, AI_FLOW_PROJECT_ROOT: cwd };
  const opts = { cwd, env, encoding: 'utf-8' as const, timeout: 30_000 };
  const cjs = join(defDir, 'preflight.cjs');
  const mjs = join(defDir, 'preflight.mjs');
  const sh = join(defDir, 'preflight.sh');
  if (existsSync(cjs)) res = spawnSync(process.execPath, [cjs], opts);
  else if (existsSync(mjs)) res = spawnSync(process.execPath, [mjs], opts);
  else if (existsSync(sh)) res = spawnSync('sh', [sh], opts);
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
