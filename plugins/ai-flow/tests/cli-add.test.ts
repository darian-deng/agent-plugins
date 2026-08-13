import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { builtinFlows, detect, nearestProjectRoot, ensureGitignore } from '../src/cli/add.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ai-flow-cli-test-'));
}

describe('cli/add — builtinFlows', () => {
  it('lists the plugin built-in flows (feat-flow present)', () => {
    const flows = builtinFlows();
    expect(flows.some((f) => f.name === 'feat-flow')).toBe(true);
    expect(flows.find((f) => f.name === 'feat-flow')!.description.length).toBeGreaterThan(0);
  });
});

describe('cli/add — nearestProjectRoot', () => {
  it('walks up to the nearest dir holding a project marker', () => {
    const root = tmp();
    const sub = join(root, 'packages', 'foo', 'src');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(root, 'packages', 'foo', 'package.json'), '{}');
    const found = nearestProjectRoot(sub);
    expect(found?.dir).toBe(join(root, 'packages', 'foo'));
    expect(found?.marker).toBe('package.json');
  });

  it('only ever returns a dir that genuinely holds the reported marker', () => {
    const root = tmp();
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    // tmp dirs have no project marker, but the real fs above may hit one, so we
    // can't assert null. We CAN assert correctness: whatever it returns must be
    // an ancestor of `sub` that actually contains the marker file it names —
    // this fails if walk-up reports a phantom hit.
    const found = nearestProjectRoot(sub);
    if (found !== null) {
      expect(existsSync(join(found.dir, found.marker))).toBe(true);
      expect(resolve(sub).startsWith(resolve(found.dir))).toBe(true);
    } else {
      expect(found).toBeNull();
    }
  });
});

describe('cli/add — detect', () => {
  it('recommends the nearest sub-project root over the git root', () => {
    const root = tmp();
    execSync('git init -q', { cwd: root });
    const foo = join(root, 'packages', 'foo');
    mkdirSync(join(foo, 'src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(foo, 'package.json'), '{}');

    // detect canonicalizes (resolves symlinks) so candidates de-dup reliably;
    // compare against the real path of foo, not the symlinked tmpdir form.
    const fooReal = realpathSync(foo);
    const result = detect(join(foo, 'src'));
    expect(result.recommended).toBe(fooReal);
    expect(result.candidates.some((c) => c.dir === fooReal)).toBe(true);
  });

  it('flags an outer .ai-flow on a candidate (nested shadowing)', () => {
    const root = tmp();
    const foo = join(root, 'packages', 'foo');
    mkdirSync(join(foo), { recursive: true });
    writeFileSync(join(foo, 'package.json'), '{}');
    mkdirSync(join(root, '.ai-flow', 'feat-flow'), { recursive: true }); // outer .ai-flow

    const fooReal = realpathSync(foo);
    const rootReal = realpathSync(root);
    const result = detect(foo);
    const fooCand = result.candidates.find((c) => c.dir === fooReal);
    expect(fooCand?.outerAiFlow).toBe(rootReal);
  });

  it('falls back to cwd when there is no marker and no git', () => {
    const root = tmp();
    const result = detect(root);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.recommended).toBeTruthy();
  });
});

describe('cli/add — ensureGitignore', () => {
  // Both rules go at the GIT ROOT, not the flow anchor: the anchor may be a
  // monorepo subproject, and a rule sitting there covers only that directory.
  it('writes both rules at the git root when .gitignore is absent', () => {
    const root = tmp();
    execSync('git init -q', { cwd: root });
    const anchor = join(root, 'packages', 'foo');
    mkdirSync(anchor, { recursive: true });

    ensureGitignore(anchor);

    const gi = readFileSync(join(root, '.gitignore'), 'utf-8').split(/\r?\n/);
    expect(gi).toContain('**/.ai-flow/**/state/');
    // Without this rule the whole worktree directory reads as untracked, and the
    // squash at the end of a flow (`git add -A`) swallows it as an embedded
    // repository — git only warns, so the commit silently carries an empty
    // gitlink instead of the work.
    expect(gi).toContain('.worktrees/');
    expect(existsSync(join(anchor, '.gitignore'))).toBe(false);
  });

  it('appends only the missing rule and never duplicates', () => {
    const root = tmp();
    execSync('git init -q', { cwd: root });
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n**/.ai-flow/**/state/\n');

    ensureGitignore(root);
    ensureGitignore(root); // idempotent

    const lines = readFileSync(join(root, '.gitignore'), 'utf-8').split(/\r?\n/).filter(Boolean);
    expect(lines.filter((l) => l === '**/.ai-flow/**/state/')).toHaveLength(1);
    expect(lines.filter((l) => l === '.worktrees/')).toHaveLength(1);
    expect(lines[0]).toBe('node_modules/'); // pre-existing content untouched
  });

  it('does not lose the last line when the file has no trailing newline', () => {
    const root = tmp();
    execSync('git init -q', { cwd: root });
    writeFileSync(join(root, '.gitignore'), 'dist/');

    ensureGitignore(root);

    const lines = readFileSync(join(root, '.gitignore'), 'utf-8').split(/\r?\n/).filter(Boolean);
    expect(lines).toContain('dist/');
    expect(lines).toContain('.worktrees/');
  });
});
