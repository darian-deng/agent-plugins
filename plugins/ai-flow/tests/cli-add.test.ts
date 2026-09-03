import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { builtinFlows, detect, nearestProjectRoot, ensureGitignore, install, forceWouldStrandFlow } from '../src/cli/add.js';
import { PLUGIN_FLOWS_DIR } from '../src/lib/flow-paths.js';

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
 * What `install` is allowed to put in a project since 0.69.0.
 *
 * It used to `cpSync` the whole flow template in, and `--force` had to wipe the
 * template-owned entries first so files the template had dropped did not linger.
 * The definition lives in the plugin now, so there is nothing to copy and nothing to
 * wipe: the project gets `config.json` (a sparse override layer, and the marker that
 * says this project runs the flow) plus an empty `state/`. These tests pin that, and
 * pin that the one destructive thing left — resetting a non-empty override layer —
 * happens only under `--force` and never silently.
 */
describe('cli/add — install 只建锚点，不复制定义', () => {
  /** A project root with git, so ensureGitignore has somewhere to write. */
  function project(): string {
    const root = tmp();
    execSync('git init -q', { cwd: root });
    writeFileSync(join(root, 'package.json'), '{}');
    return root;
  }

  /** Run install with stdout captured (it is the CLI's human-readable result). */
  function runInstall(flow: string, dir: string, force = false): string {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      chunks.push(String(c));
      return true;
    });
    try {
      install(flow, dir, force);
    } finally {
      spy.mockRestore();
    }
    return chunks.join('');
  }

  it('新装:项目里只多出 config.json（内容 {}）和空的 state/,定义一个字节都没复制过来', () => {
    const root = project();
    runInstall('feat-flow', root);

    const dest = join(root, '.ai-flow', 'feat-flow');
    expect(readdirSync(dest).sort()).toEqual(['config.json', 'state']);
    expect(JSON.parse(readFileSync(join(dest, 'config.json'), 'utf-8'))).toEqual({});
    expect(readdirSync(join(dest, 'state'))).toEqual([]);
    // 定义仍然只有插件里那一份
    for (const entry of ['stages', 'references', 'scripts', 'helper.md', 'preflight.cjs']) {
      expect(existsSync(join(dest, entry))).toBe(false);
    }
  });

  it('重复安装（无 --force）:不再报错,但用户的覆盖层原样保住', () => {
    const root = project();
    runInstall('feat-flow', root);
    const dest = join(root, '.ai-flow', 'feat-flow');
    const mine = JSON.stringify({ context: { wrap_up_at_pct: 42 } }, null, 2);
    writeFileSync(join(dest, 'config.json'), mine);

    const out = runInstall('feat-flow', root);

    expect(readFileSync(join(dest, 'config.json'), 'utf-8')).toBe(mine);
    expect(out).toContain('--force');
  });

  it('缺 state/ 时补建,同样不动 config.json', () => {
    const root = project();
    const dest = join(root, '.ai-flow', 'feat-flow');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'config.json'), '{"context":{"wrap_up_at_pct":42}}');

    runInstall('feat-flow', root);

    expect(existsSync(join(dest, 'state'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dest, 'config.json'), 'utf-8'))).toEqual({ context: { wrap_up_at_pct: 42 } });
  });

  it('--force:重置成 {},并把原内容原样打印出来,让丢掉的东西看得见', () => {
    const root = project();
    runInstall('feat-flow', root);
    const dest = join(root, '.ai-flow', 'feat-flow');
    writeFileSync(join(dest, 'config.json'), '{\n  "context": { "wrap_up_at_pct": 42 }\n}');

    const out = runInstall('feat-flow', root, true);

    expect(JSON.parse(readFileSync(join(dest, 'config.json'), 'utf-8'))).toEqual({});
    expect(out).toContain('wrap_up_at_pct');
  });

  // `--force` is the one thing this command does that can change a running flow's
  // stage table, because a project-side `stages` replaces the plugin's wholesale.
  // Getting it wrong is silent: both hot paths catch and return null, so the flow
  // does not stop, it stops being a flow.
  describe('--force 会不会把正在跑的 flow 撂在一个不存在的 stage 上', () => {
    function pluginStages(): string[] {
      const cfg = JSON.parse(
        readFileSync(join(PLUGIN_FLOWS_DIR, 'feat-flow', 'config.json'), 'utf-8')
      ) as { stages: Array<{ id: string }> };
      return cfg.stages.map((st) => st.id);
    }

    function withOverrideStages(root: string, currentStage: string, overrideStageId: string) {
      const dest = join(root, '.ai-flow', 'feat-flow');
      writeFileSync(join(dest, 'config.json'), JSON.stringify({
        stages: [{ id: overrideStageId, prompt: 'stages/x.md', write_scope: 'unrestricted', completion: { gate: true } }],
      }));
      writeFileSync(join(dest, 'state', 'active.json'), JSON.stringify({
        flow_id: 'feat-20260903', current_stage: currentStage,
      }));
      return dest;
    }

    it('覆盖层带 stages 且当前 stage 不在插件表里 → 拒绝,不重置', () => {
      const root = project();
      runInstall('feat-flow', root);
      const dest = withOverrideStages(root, 'stage-custom', 'stage-custom');

      const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('EXIT'); }) as never);
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        expect(() => install('feat-flow', root, true)).toThrow('EXIT');
        const msg = err.mock.calls.map((c) => String(c[0])).join('');
        expect(msg).toContain('stage-custom');
        expect(msg).toContain('静默失效');
      } finally {
        exit.mockRestore();
        err.mockRestore();
      }
      // The refusal has to leave the override alone — resetting it IS the damage.
      expect(JSON.parse(readFileSync(join(dest, 'config.json'), 'utf-8'))).toHaveProperty('stages');
    });

    it('覆盖层带 stages 但当前 stage 插件表里也有 → 照常重置', () => {
      const root = project();
      runInstall('feat-flow', root);
      const shared = pluginStages()[0]!;
      const dest = withOverrideStages(root, shared, shared);

      runInstall('feat-flow', root, true);

      expect(JSON.parse(readFileSync(join(dest, 'config.json'), 'utf-8'))).toEqual({});
    });

    it('覆盖层没有 stages → 不拦(阶段表本来就是插件那份,重置改不了它)', () => {
      // Refusing here would blame this command for a flow that was already broken.
      const root = project();
      runInstall('feat-flow', root);
      const dest = join(root, '.ai-flow', 'feat-flow');
      writeFileSync(join(dest, 'config.json'), JSON.stringify({ context: { wrap_up_at_pct: 42 } }));
      writeFileSync(join(dest, 'state', 'active.json'), JSON.stringify({
        flow_id: 'feat-20260903', current_stage: 'stage-gone',
      }));

      runInstall('feat-flow', root, true);

      expect(JSON.parse(readFileSync(join(dest, 'config.json'), 'utf-8'))).toEqual({});
    });

    it('没有正在跑的 flow → 不拦', () => {
      const defCfg = join(PLUGIN_FLOWS_DIR, 'feat-flow', 'config.json');
      expect(forceWouldStrandFlow(defCfg, '/nonexistent/config.json', null)).toEqual({ stranded: false });
    });
  });

  it('--force 覆盖层本来就是 {} → 没有「丢了什么」可报,不吓唬用户', () => {
    const root = project();
    runInstall('feat-flow', root);

    const out = runInstall('feat-flow', root, true);

    expect(out).not.toContain('被重置成了');
  });

  it('有正在跑的 flow:state/ 一个字节都不动,且说明定义不随本命令改变', () => {
    const root = project();
    runInstall('feat-flow', root);
    const state = join(root, '.ai-flow', 'feat-flow', 'state');
    writeFileSync(join(state, 'active.json'), JSON.stringify({ flow_id: 'feat-20260903', current_stage: 'stage-3' }));
    writeFileSync(join(state, 'flow.log'), 'STARTED\n');

    const out = runInstall('feat-flow', root, true);

    expect(JSON.parse(readFileSync(join(state, 'active.json'), 'utf-8')).current_stage).toBe('stage-3');
    expect(readFileSync(join(state, 'flow.log'), 'utf-8')).toBe('STARTED\n');
    expect(out).toContain('feat-20260903');
    expect(out).toContain('随插件版本走');
  });
});
