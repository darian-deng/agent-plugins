import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const SKILL_DIR = join(PLUGIN_ROOT, 'skills', 'ai-flow');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const PREFLIGHT = join(PLUGIN_ROOT, '.ai-flow', 'feat-flow', 'preflight.sh');

describe('ai-flow skill — structure', () => {
  it('SKILL.md exists', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('SKILL.md has name and description in frontmatter', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    expect(content).toMatch(/^---/);
    expect(content).toMatch(/\bname:/);
    expect(content).toMatch(/\bdescription:/);
  });

  it('all references/ files mentioned in SKILL.md actually exist', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const refs = [...content.matchAll(/references\/[\w-]+\.md/g)].map(m => m[0]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(existsSync(join(SKILL_DIR, ref)), `Missing: ${ref}`).toBe(true);
    }
  });

  it('each reference file is non-empty and starts with a heading', () => {
    const refs = ['install-feat-flow.md', 'create-flow.md', 'modify-flow.md'];
    for (const ref of refs) {
      const content = readFileSync(join(SKILL_DIR, 'references', ref), 'utf-8');
      expect(content.length, `${ref} should not be empty`).toBeGreaterThan(100);
      expect(content.startsWith('#'), `${ref} should start with a heading`).toBe(true);
    }
  });
});

describe('feat-flow preflight.sh — integration', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) execSync(`rm -rf "${d}"`);
    tmpDirs.length = 0;
  });

  function makeFakeHome(): string {
    const d = mkdtempSync(join(tmpdir(), 'ai-flow-preflight-test-'));
    tmpDirs.push(d);
    return d;
  }

  it('preflight.sh exists and is executable', () => {
    expect(existsSync(PREFLIGHT)).toBe(true);
    const mode = statSync(PREFLIGHT).mode;
    expect(mode & 0o111).toBeGreaterThan(0);
  });

  it('fails when claude CLI is not in PATH', () => {
    const fakeHome = makeFakeHome();
    const result = execSync(
      `HOME="${fakeHome}" PATH="/usr/bin:/bin" sh "${PREFLIGHT}" 2>&1 || true`,
      { encoding: 'utf-8' }
    );
    expect(result).toMatch(/claude CLI not found/i);
  });

  it('fails with missing skills when HOME has no .claude/skills', () => {
    const fakeHome = makeFakeHome();
    // Provide a mock claude but no skills
    const binDir = join(fakeHome, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'claude'), '#!/bin/sh\necho "feature-dev@claude-plugins-official"\n');
    chmodSync(join(binDir, 'claude'), 0o755);

    const result = execSync(
      `HOME="${fakeHome}" PATH="${binDir}:$PATH" sh "${PREFLIGHT}" 2>&1 || true`,
      { encoding: 'utf-8' }
    );
    expect(result).toMatch(/Missing required skills/i);
  });

  it('passes when all prerequisites are mocked', () => {
    const fakeHome = makeFakeHome();

    const skills = [
      'brainstorming', 'writing-plans', 'subagent-driven-development',
      'verification-before-completion', 'tdd', 'diagnose',
      'improve-codebase-architecture', 'skill-surgeon', 'claude-md-improver',
    ];
    for (const skill of skills) {
      mkdirSync(join(fakeHome, '.claude', 'skills', skill), { recursive: true });
      writeFileSync(join(fakeHome, '.claude', 'skills', skill, 'SKILL.md'), '# mock');
    }

    const binDir = join(fakeHome, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'claude'), '#!/bin/sh\necho "feature-dev@claude-plugins-official"\n');
    chmodSync(join(binDir, 'claude'), 0o755);

    const result = execSync(
      `HOME="${fakeHome}" PATH="${binDir}:$PATH" sh "${PREFLIGHT}" 2>&1; echo "EXIT:$?"`,
      { encoding: 'utf-8' }
    );
    expect(result).toContain('EXIT:0');
  });
});
