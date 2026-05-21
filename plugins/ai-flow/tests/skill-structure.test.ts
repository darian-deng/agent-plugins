import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(PLUGIN_ROOT, 'skills');
const PREFLIGHT = join(PLUGIN_ROOT, '.ai-flow', 'feat-flow', 'preflight.sh');

function checkSkill(name: string) {
  const skillMd = join(SKILLS_DIR, name, 'SKILL.md');

  it(`skills/${name}/SKILL.md exists`, () => {
    expect(existsSync(skillMd)).toBe(true);
  });

  it(`skills/${name}/SKILL.md has name and description in frontmatter`, () => {
    const content = readFileSync(skillMd, 'utf-8');
    expect(content).toMatch(/^---/);
    expect(content).toMatch(/\bname:/);
    expect(content).toMatch(/\bdescription:/);
  });
}

describe('ai-flow skills — structure', () => {
  checkSkill('add');
  checkSkill('adr');
  checkSkill('create');
  checkSkill('update');
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

    // 新 feat-flow preflight 需要的 4 个用户 skill
    const skills = [
      'grill-me', 'writing-plans', 'subagent-driven-development', 'receiving-code-review',
    ];
    for (const skill of skills) {
      mkdirSync(join(fakeHome, '.claude', 'skills', skill), { recursive: true });
      writeFileSync(join(fakeHome, '.claude', 'skills', skill, 'SKILL.md'), '# mock');
    }

    // Mock claude CLI
    const binDir = join(fakeHome, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'claude'), '#!/bin/sh\necho "mocked claude CLI"\n');
    chmodSync(join(binDir, 'claude'), 0o755);

    // 新 preflight 用 `find $HOME/.claude/plugins/cache -name <plugin>` 检测插件
    // 在 fakeHome 下建空目录占位即可（find -name 匹配目录名）
    for (const plugin of ['feature-dev', 'claude-md-management']) {
      mkdirSync(join(fakeHome, '.claude', 'plugins', 'cache', 'mock-marketplace', plugin), { recursive: true });
    }

    const result = execSync(
      `HOME="${fakeHome}" PATH="${binDir}:$PATH" sh "${PREFLIGHT}" 2>&1; echo "EXIT:$?"`,
      { encoding: 'utf-8' }
    );
    expect(result).toContain('EXIT:0');
  });
});
