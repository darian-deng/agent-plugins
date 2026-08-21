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
// mmdc 为 npm 全局 CLI（底层 puppeteer/headless chromium），按命令存在性检测。
if (cmdExists('mmdc')) {
  ok('mmdc (mermaid-cli)');
} else {
  err('mmdc (mermaid-cli) not found. Stage 2 生成 tech-design.html 的配图依赖它。');
  cmd('npm install -g @mermaid-js/mermaid-cli');
  process.exit(FAIL);
}

process.exit(PASS);
