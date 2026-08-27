#!/usr/bin/env node
// grill-flow preflight — runs once when 'grill-flow start' is called (and at install).
// Exit 0 = all checks pass. Non-zero = blocked with error message.
// Plain CommonJS + node builtins only: cross-platform (incl. Windows) with just
// Node ≥18, no shell/python. Shipped verbatim as a flow asset (not compiled).
// cwd at runtime = project root (repoRoot); skill checks use CLAUDE_CONFIG_DIR/home.
'use strict';

const { existsSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');
const { spawnSync } = require('child_process');

const PASS = 0;
const FAIL = 1;

const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const SKILLS_DIR = join(claudeDir, 'skills');

const err = (m) => process.stderr.write('❌  ' + m + '\n');
const cmd = (m) => process.stderr.write('    ' + m + '\n');
const ok = (m) => process.stdout.write('✅  ' + m + '\n');

// A binary exists if spawning it does not fail with ENOENT. Probe with
// `--version`; a non-zero exit (present but flag unsupported) is fine.
function cmdExists(bin) {
  return !spawnSync(bin, ['--version'], { stdio: 'ignore' }).error;
}
function checkSkill(name) {
  return existsSync(join(SKILLS_DIR, name, 'SKILL.md'));
}

// ── 1. Claude Code CLI ──────────────────────────────────────────────────────
if (!cmdExists('claude')) {
  err('claude CLI not found. grill-flow only runs inside Claude Code.');
  err('Install: https://docs.anthropic.com/en/docs/claude-code');
  process.exit(FAIL);
}
ok('claude CLI');

// ── 2. Node.js ≥ 18 ─────────────────────────────────────────────────────────
const nodeMajor = parseInt(process.version.replace(/^v/, '').split('.')[0], 10);
if (!Number.isFinite(nodeMajor) || nodeMajor < 18) {
  err('Node.js ≥ 18 required (found: ' + process.version + ').');
  process.exit(FAIL);
}
ok('Node.js ' + process.version);

// ── 3. git ──────────────────────────────────────────────────────────────────
if (!cmdExists('git')) {
  err('git not found. grill-flow requires git for base_sha_code tracking and per-ticket commits.');
  process.exit(FAIL);
}
ok('git');

// ── 4. Required user-installed skills ───────────────────────────────────────
// optimize-claude-context: stage-5 沉淀（治理 CLAUDE.md / rules / ADR 全层）。
const SKILL_INSTALL = {
  'optimize-claude-context': 'npx skills add darian-deng/agent-skills@optimize-claude-context -g -y',
};
const missing = [];
for (const skill of Object.keys(SKILL_INSTALL)) {
  if (checkSkill(skill)) ok('skill: ' + skill);
  else missing.push(skill);
}
if (missing.length) {
  err('Missing required skills: ' + missing.join(' '));
  err('');
  err('── 复制以下命令到终端执行 ──────');
  for (const skill of missing) cmd(SKILL_INSTALL[skill]);
  err('────────────────────');
  process.exit(FAIL);
}

// ── 5. mermaid-cli (mmdc) — stage-2 方案视图 HTML 配图渲染 ────────────────────
// stage-2 由子代理手写 .mmd → mmdc 渲染 SVG → 主 session 内联进 tech-design.html。
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
  err('mmdc (mermaid-cli) not found. stage-2 生成方案视图 HTML 的配图依赖它。');
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
    cmd('npm install -g @mermaid-js/mermaid-cli@latest');
    process.exit(FAIL);
  }
}

// 注：stage-3 的 /simplify 是 Claude Code 内置命令，无独立文件可探测，故不在此检查。
// correctness 轴改由子代理携未提交 diff 审 bug（不依赖内置 slash 命令，无需 preflight 检测）。

process.exit(PASS);
