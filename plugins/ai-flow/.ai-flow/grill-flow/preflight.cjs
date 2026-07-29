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
if (cmdExists('mmdc')) {
  ok('mmdc (mermaid-cli)');
} else {
  err('mmdc (mermaid-cli) not found. stage-2 生成方案视图 HTML 的配图依赖它。');
  cmd('npm install -g @mermaid-js/mermaid-cli');
  process.exit(FAIL);
}

// 注：stage-3 的 /simplify 是 Claude Code 内置命令，无独立文件可探测，故不在此检查。
// correctness 轴改由子代理携未提交 diff 审 bug（不依赖内置 slash 命令，无需 preflight 检测）。

process.exit(PASS);
