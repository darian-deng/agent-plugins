import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(PLUGIN_ROOT, 'skills');
const PREFLIGHT = join(PLUGIN_ROOT, '.ai-flow', 'feat-flow', 'preflight.cjs');

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
  checkSkill('create');
  checkSkill('update');
});

describe('feat-flow preflight.cjs — integration', () => {
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

  // Run the node preflight with a mocked claude config dir. CLAUDE_CONFIG_DIR is
  // set explicitly (overriding the test-suite's setup.ts value) so the preflight
  // resolves skills/plugins under the fake home. node is invoked by absolute path
  // so a restricted PATH doesn't break the runner itself.
  function runPreflight(env: { home: string; path: string }): string {
    return execSync(
      `"${process.execPath}" "${PREFLIGHT}" 2>&1 || true`,
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          HOME: env.home,
          CLAUDE_CONFIG_DIR: join(env.home, '.claude'),
          PATH: env.path,
        },
      }
    );
  }

  it('preflight.cjs exists', () => {
    expect(existsSync(PREFLIGHT)).toBe(true);
  });

  it('fails when claude CLI is not in PATH', () => {
    const fakeHome = makeFakeHome();
    const result = runPreflight({ home: fakeHome, path: '/usr/bin:/bin' });
    expect(result).toMatch(/claude CLI not found/i);
  });

  it('fails with missing skills when config dir has no skills', () => {
    const fakeHome = makeFakeHome();
    const binDir = join(fakeHome, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'claude'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(binDir, 'claude'), 0o755);

    const result = runPreflight({ home: fakeHome, path: `${binDir}:${process.env.PATH}` });
    expect(result).toMatch(/Missing required skills/i);
  });

  it('passes when all prerequisites are mocked', () => {
    const fakeHome = makeFakeHome();

    // The 4 user skills feat-flow's preflight requires.
    const skills = [
      'grounded-design', 'subagent-driven-development', 'receiving-code-review', 'optimize-claude-context',
    ];
    for (const skill of skills) {
      mkdirSync(join(fakeHome, '.claude', 'skills', skill), { recursive: true });
      writeFileSync(join(fakeHome, '.claude', 'skills', skill, 'SKILL.md'), '# mock');
    }
    // subagent-driven-development v6.0.0+ ships task-reviewer-prompt.md alongside SKILL.md;
    // preflight gates on its presence to detect a pre-v6 install (see preflight.cjs).
    writeFileSync(
      join(fakeHome, '.claude', 'skills', 'subagent-driven-development', 'task-reviewer-prompt.md'),
      '# mock',
    );

    // Mock claude CLI on PATH.
    const binDir = join(fakeHome, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'claude'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(binDir, 'claude'), 0o755);

    // preflight walks <config>/plugins/cache for a dir named feature-dev.
    mkdirSync(join(fakeHome, '.claude', 'plugins', 'cache', 'mock-marketplace', 'feature-dev'), { recursive: true });

    const result = runPreflight({ home: fakeHome, path: `${binDir}:${process.env.PATH}` });
    expect(result).toMatch(/plugin: feature-dev/);
  });
});
