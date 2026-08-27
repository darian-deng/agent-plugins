#!/usr/bin/env node
// feat-flow preflight — runs once when 'feat-flow start' is called (and at install).
// Exit 0 = all checks pass. Non-zero = blocked with error message.
// Plain CommonJS + node builtins only: runs cross-platform (incl. Windows) with
// just Node ≥18, no shell/python. Shipped verbatim as a flow asset (not compiled).
'use strict';

const { existsSync, readdirSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');
const { spawnSync } = require('child_process');

const PASS = 0;
const FAIL = 1;

const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const SKILLS_DIR = join(claudeDir, 'skills');
const PLUGINS_CACHE = join(claudeDir, 'plugins', 'cache');

const err = (m) => process.stderr.write('❌  ' + m + '\n');
const cmd = (m) => process.stderr.write('    ' + m + '\n');
const ok = (m) => process.stdout.write('✅  ' + m + '\n');

// A binary exists if spawning it does not fail with ENOENT. We probe with
// `--version`; a non-zero exit (binary present but flag unsupported) is fine —
// only a spawn error (not on PATH) means missing.
function cmdExists(bin) {
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
  return !r.error;
}

function checkSkill(name) {
  return existsSync(join(SKILLS_DIR, name, 'SKILL.md'));
}

// Match a directory named `name` up to `maxDepth` levels deep under PLUGINS_CACHE
// (direct children of the cache are level 1). Mirrors `find -maxdepth <n>`.
function checkPlugin(name, maxDepth) {
  if (!existsSync(PLUGINS_CACHE)) return false;
  const stack = [{ dir: PLUGINS_CACHE, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth >= maxDepth) continue; // entries here would be at level depth+1 > maxDepth
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === name) return true; // this entry is at level depth+1 ≤ maxDepth
      stack.push({ dir: join(dir, e.name), depth: depth + 1 });
    }
  }
  return false;
}

// ── 1. Claude Code CLI ──────────────────────────────────────────────────────
if (!cmdExists('claude')) {
  err('claude CLI not found. feat-flow only runs inside Claude Code.');
  err('Install: https://docs.anthropic.com/en/docs/claude-code');
  process.exit(FAIL);
}
ok('claude CLI');

// ── 2. Node.js ≥ 18 ───────────────────────────────────────────────────────────
const nodeMajor = parseInt(process.version.replace(/^v/, '').split('.')[0], 10);
if (!Number.isFinite(nodeMajor) || nodeMajor < 18) {
  err('Node.js ≥ 18 required (found: ' + process.version + ').');
  process.exit(FAIL);
}
ok('Node.js ' + process.version);

// ── 3. git ────────────────────────────────────────────────────────────────────
if (!cmdExists('git')) {
  err('git not found. feat-flow requires git for base_sha_code tracking and per-task commits.');
  process.exit(FAIL);
}
ok('git');

// ── 4. Required user-installed skills ─────────────────────────────────────────
const SKILL_INSTALL = {
  'subagent-driven-development': 'npx skills add obra/superpowers@subagent-driven-development -g -y',
  // Hard dependency, not a nice-to-have: dispatch-unit.md deliberately does NOT
  // inline the red-green steps (it only names this skill), so when it is absent the
  // implementer subagent gets no TDD guidance at all — it writes the implementation
  // first, `verify` still exits 0, and nothing turns red anywhere.
  'test-driven-development': 'npx skills add obra/superpowers@test-driven-development -g -y',
  'receiving-code-review': 'npx skills add obra/superpowers@receiving-code-review -g -y',
  'optimize-claude-context': 'npx skills add darian-deng/agent-skills@optimize-claude-context -g -y',
};
// Third-party skills carry no version field (checked against obra/superpowers
// upstream: no per-skill version in SKILL.md frontmatter, repo package.json
// version isn't surfaced to installed skill dirs). stage-4.md's SDD usage is
// written against a specific behavior generation, not just "the skill exists" —
// so gate on the file whose presence *is* that behavior: task-reviewer-prompt.md
// only ships from the v6.0.0 rewrite onward (single reviewer, two verdicts per
// task; replaces the old separate spec-reviewer-prompt.md/code-quality-reviewer-prompt.md
// two-pass review that stage-4.md used to assume). If SDD's shape moves again,
// this check breaks loudly instead of stage-4.md silently drifting from reality.
const SKILL_STRUCTURE_MARKER = {
  'subagent-driven-development': 'task-reviewer-prompt.md',
};
const missing = [];
const outdated = [];
for (const skill of Object.keys(SKILL_INSTALL)) {
  if (!checkSkill(skill)) {
    missing.push(skill);
    continue;
  }
  const marker = SKILL_STRUCTURE_MARKER[skill];
  if (marker && !existsSync(join(SKILLS_DIR, skill, marker))) {
    outdated.push(skill);
    continue;
  }
  ok('skill: ' + skill);
}
if (missing.length || outdated.length) {
  if (missing.length) err('Missing required skills: ' + missing.join(' '));
  if (outdated.length) {
    err('Outdated skills (installed, but missing structure feat-flow depends on): ' + outdated.join(' '));
  }
  err('');
  err('── 复制以下命令到终端执行 ──────');
  for (const skill of missing) cmd(SKILL_INSTALL[skill]);
  for (const skill of outdated) cmd(`npx skills update ${skill} -g -y`);
  err('────────────────────');
  process.exit(FAIL);
}

// ── 5. feature-dev plugin (code-architect → Stage 2) ──────────────────────────
if (checkPlugin('feature-dev', 4)) {
  ok('plugin: feature-dev');
} else {
  err('feature-dev plugin not detected in plugin cache.');
  err('Install via: claude plugin install feature-dev@claude-plugins-official --scope user');
  err('feat-flow will fail at Stage 2 (code-architect) without this plugin.');
  process.exit(FAIL);
}

// ── 6. mermaid-cli (mmdc) — Stage 2 tech-design.html 配图渲染 ─────────────────
// Stage 2 由子代理手写 .mmd → mmdc 渲染 SVG → 主 session 内联进 tech-design.html。
// mmdc 为 npm 全局 CLI（底层 puppeteer/headless chromium）。
//
// 为什么连版本一起卡（不只查命令存在）：配图契约用 `-c references/assets/mermaid-theme.json`
// 指定 `layout: elk` 拿正交直角走线，而 `@mermaid-js/layout-elk` 是 **11.14.0 起**才成为
// mermaid-cli 的依赖（11.13.0 及之前每个版本都没有）。mermaid 对没注册的布局算法是
// **静默 fallback**（只 log.warn 一句 "Layout algorithm ... is not registered"），于是旧版
// 上 `-c` 照样被吃下、退出码 0、SVG 正常产出，只是布局退回默认的贝塞尔曲线——契约里
// 「箭头穿盒/压线由布局器保证」当场变成假的。配图质量门也抓不到：它的自检 PNG 用同一份
// 配置渲染，几何与 SVG 一致。所以这里是这条降级唯一的检出点。
const MMDC_MIN = [11, 14];
if (!cmdExists('mmdc')) {
  err('mmdc (mermaid-cli) not found. Stage 2 生成 tech-design.html 的配图依赖它。');
  cmd('npm install -g @mermaid-js/mermaid-cli');
  process.exit(FAIL);
}
// 用 spawnSync 与本文件的 cmdExists 保持同一套调用方式（execSync 没在这里导入）。
const mmdcProbe = spawnSync('mmdc', ['--version'], { encoding: 'utf-8' });
const mmdcRaw = String(mmdcProbe.stdout || '').trim();
const mmdcSem = /(\d+)\.(\d+)\.(\d+)/.exec(mmdcRaw);
if (!mmdcSem) {
  // 解析不出版本 = 拦，与本文件 Node 版本检查的处置一致（那里也是 !Number.isFinite → FAIL）。
  // 这条检查存在的全部意义就是抓「静默降级」，放行会把静默降级从「mmdc 太旧」扩大到
  // 「mmdc 输出格式没见过」——那同样是没验证过 elk 可用就往下跑。
  err(`mmdc 的版本无法解析（\`mmdc --version\` 输出："${mmdcRaw || '空'}"），判不出是否满足 >=${MMDC_MIN.join('.')}。`);
  cmd('npm install -g @mermaid-js/mermaid-cli@latest');
  process.exit(FAIL);
} else {
  const [maj, min] = [Number(mmdcSem[1]), Number(mmdcSem[2])];
  if (maj > MMDC_MIN[0] || (maj === MMDC_MIN[0] && min >= MMDC_MIN[1])) {
    ok(`mmdc (mermaid-cli) ${mmdcSem[0]}`);
  } else {
    err(`mmdc ${mmdcSem[0]} 过旧：配图契约的 layout: elk 需要 >=${MMDC_MIN.join('.')}（layout-elk 从 11.14.0 起才随 mermaid-cli 自带）。`);
    err('旧版不会报错，只会静默退回默认布局——图照样出、退出码 0，但「箭头不穿盒由布局器保证」不再成立。');
    err('（轻量模式的 mmdc 调用不带 -c、其实用不到 elk，但 preflight 跑在 flow 启动时、那会儿还没选形态，只能按需要 elk 的那条路径拦。）');
    cmd('npm install -g @mermaid-js/mermaid-cli@latest');
    process.exit(FAIL);
  }
}

process.exit(PASS);
