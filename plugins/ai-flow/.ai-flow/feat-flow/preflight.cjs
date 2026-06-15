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
  'grounded-design': 'npx skills add darian-deng/agent-skills@grounded-design -g -y',
  'subagent-driven-development': 'npx skills add obra/superpowers@subagent-driven-development -g -y',
  'receiving-code-review': 'npx skills add obra/superpowers@receiving-code-review -g -y',
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

// ── 5. feature-dev plugin (code-architect → Stage 2) ──────────────────────────
if (checkPlugin('feature-dev', 4)) {
  ok('plugin: feature-dev');
} else {
  err('feature-dev plugin not detected in plugin cache.');
  err('Install via: claude plugin install feature-dev@claude-plugins-official --scope user');
  err('feat-flow will fail at Stage 2 (code-architect) without this plugin.');
  process.exit(FAIL);
}

process.exit(PASS);
