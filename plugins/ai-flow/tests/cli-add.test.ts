import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { builtinFlows, detect, nearestProjectRoot, ensureGitignore, wipeTemplateEntries, checkForceReinstall } from '../src/cli/add.js';

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

/**
 * `install --force` used to `rmSync` the whole installed flow directory before copying
 * the template back. That took `state/` with it — `active.json`, `signal`, `mark-base`,
 * `flow.log`. `state/` is gitignored, so a reinstall aimed at picking up a fixed
 * stage prompt silently destroyed any flow that was mid-run, with nothing to restore
 * from. These two guard the fix.
 */
describe('cli/add — --force 不能杀掉正在跑的 flow', () => {
  /** A minimal installed flow dir: template-owned files + engine-owned state/. */
  function installedFlow(stageIds: string[], currentStage: string | null): string {
    const dest = join(tmp(), '.ai-flow', 'demo-flow');
    mkdirSync(join(dest, 'stages'), { recursive: true });
    writeFileSync(join(dest, 'config.json'), JSON.stringify({ name: 'demo-flow', stages: stageIds.map((id) => ({ id })) }));
    writeFileSync(join(dest, 'helper.md'), 'helper');
    writeFileSync(join(dest, 'stages', 'stage-1.md'), 'one');
    // A file the NEW template no longer ships — the reason --force wipes at all.
    writeFileSync(join(dest, 'stages', 'renamed-away.md'), 'stale');
    if (currentStage) {
      mkdirSync(join(dest, 'state'), { recursive: true });
      writeFileSync(join(dest, 'state', 'active.json'), JSON.stringify({ flow_id: 'demo-20260816', current_stage: currentStage }));
      writeFileSync(join(dest, 'state', 'flow.log'), 'STARTED\n');
    }
    return dest;
  }

  function template(stageIds: string[]): string {
    const src = join(tmp(), 'demo-flow');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'config.json'), JSON.stringify({ name: 'demo-flow', stages: stageIds.map((id) => ({ id })) }));
    return src;
  }

  it('清模板文件时保留 state/：陈旧文件删掉，active.json 与 flow.log 原样留下', () => {
    const dest = installedFlow(['stage-1', 'stage-2'], 'stage-2');
    const before = readFileSync(join(dest, 'state', 'active.json'), 'utf-8');

    wipeTemplateEntries(dest);

    // 模板拥有的全部清掉了（这正是 --force 存在的理由）
    expect(existsSync(join(dest, 'stages', 'renamed-away.md'))).toBe(false);
    expect(existsSync(join(dest, 'stages'))).toBe(false);
    expect(existsSync(join(dest, 'config.json'))).toBe(false);
    expect(existsSync(join(dest, 'helper.md'))).toBe(false);
    // 引擎拥有的一个都没动
    expect(readFileSync(join(dest, 'state', 'active.json'), 'utf-8')).toBe(before);
    expect(readFileSync(join(dest, 'state', 'flow.log'), 'utf-8')).toBe('STARTED\n');
  });

  it('没有正在跑的 flow → 直接放行，不报 live', () => {
    const dest = installedFlow(['stage-1', 'stage-2'], null);
    const r = checkForceReinstall(template(['stage-1', 'stage-2']), dest, 'demo-flow');
    expect(r.ok).toBe(true);
    expect(r.ok && r.live).toBeNull();
  });

  it('有正在跑的 flow、且新 config 仍有它当前那个 stage → 放行，并报出被换掉定义的是谁', () => {
    const dest = installedFlow(['stage-1', 'stage-2'], 'stage-2');
    const r = checkForceReinstall(template(['stage-1', 'stage-2', 'stage-3']), dest, 'demo-flow');
    expect(r.ok).toBe(true);
    expect(r.ok && r.live?.flow_id).toBe('demo-20260816');
    expect(r.ok && r.live?.current_stage).toBe('stage-2');
  });

  it('新 config 里没有它当前那个 stage → 拒绝，且拒绝发生在任何删除之前', () => {
    const dest = installedFlow(['stage-1', 'stage-2'], 'stage-2');
    // 新模板把 stage-2 改名了：getStageConfig 找不到就抛，而它在 PreTool/PostTool 路径上
    const r = checkForceReinstall(template(['stage-1', 'implement']), dest, 'demo-flow');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('stage-2');
    expect(r.ok === false && r.reason).toContain('demo-flow abort');
    // 纯函数：一个字节都没动
    expect(existsSync(join(dest, 'state', 'active.json'))).toBe(true);
    expect(existsSync(join(dest, 'stages', 'renamed-away.md'))).toBe(true);
  });

  it('active.json 损坏（读不出 current_stage）→ 当作没有在跑的 flow，不拿它当拒绝依据', () => {
    const dest = installedFlow(['stage-1'], 'stage-1');
    writeFileSync(join(dest, 'state', 'active.json'), '{ 这不是 json');
    const r = checkForceReinstall(template(['whatever']), dest, 'demo-flow');
    expect(r.ok).toBe(true);
  });
});
