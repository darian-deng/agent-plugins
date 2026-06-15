import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { builtinFlows, detect, nearestProjectRoot } from '../src/cli/add.js';

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
