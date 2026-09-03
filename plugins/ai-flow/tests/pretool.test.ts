import { describe, it, expect, afterEach } from 'vitest';
import { join, dirname } from 'path';
import { writeFileSync, chmodSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { handlePreTool } from '../src/lib/pretool-handler.js';
import { readActiveState } from '../src/lib/state.js';
import { bindSession, unbindSession } from '../src/lib/session-registry.js';
import { PLUGIN_FLOWS_DIR } from '../src/lib/flow-paths.js';
import { createFlowTestRepo, writeActiveState, MINIMAL_CONFIG, GATED_CONFIG, SCRIPTED_CONFIG, BLOCKING_CONFIG, NO_ESCAPE_CONFIG } from './fixtures/helpers.js';
import type { PreToolInput } from '../src/lib/types.js';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeRepo(config = MINIMAL_CONFIG) {
  const repo = createFlowTestRepo('test-flow', config);
  cleanups.push(repo.cleanup);
  return repo;
}

function makeInput(
  repoRoot: string,
  toolName: string,
  toolInput: Record<string, unknown>
): PreToolInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-1',
    cwd: repoRoot,
    tool_name: toolName,
    tool_input: toolInput,
  };
}

function activateFlow(repoRoot: string, stage = 'work') {
  writeActiveState(repoRoot, 'test-flow', {
    flow_id: 'test-flow-abc',
    flow_name: 'test-flow',
    requirement: 'test',
    current_stage: stage,
    base_sha: 'abc',
  });
}

describe('handlePreTool — no active flow', () => {
  it('any write → null (pass through)', async () => {
    const repo = makeRepo();
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: '/tmp/test.txt', content: 'x' }));
    expect(out).toBeNull();
  });
});

describe('handlePreTool — signal interception (done protocol)', () => {
  it("non-gate stage: write 'done' to signal → ALLOW", async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work');
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'done' }));
    expect(out?.permissionDecision).toBe('allow');
  });

  it("gate stage: write 'done' to signal → ALLOW", async () => {
    const gatedRepo = createFlowTestRepo('test-flow', {
      schema_version: '1.0',
      name: 'test-flow',
      stages: [
        { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted', completion: { gate: true } },
        { id: 'review', prompt: 'stages/review.md', write_scope: 'unrestricted', completion: {} },
      ],
    });
    cleanups.push(gatedRepo.cleanup);
    writeActiveState(gatedRepo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'test', current_stage: 'work', base_sha: 'abc',
    });
    const signalPath = join(gatedRepo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(gatedRepo.repoRoot, 'Write', { file_path: signalPath, content: 'done' }));
    expect(out?.permissionDecision).toBe('allow');
  });

  it("terminal stage: write 'done' → ALLOW (posttool handles completion)", async () => {
    const repo = createFlowTestRepo('test-flow', {
      schema_version: '1.0',
      name: 'test-flow',
      stages: [
        { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted', completion: {} },
        { id: 'review', prompt: 'stages/review.md', write_scope: 'unrestricted', completion: {} },
      ],
    });
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'test', current_stage: 'review', base_sha: 'abc',
    });
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'done' }));
    expect(out?.permissionDecision).toBe('allow');
  });

  it("write anything other than 'done' to signal → DENY with hint", async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work');
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'stage-2' }));
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toContain('done');
  });

  it("write 'flow-complete' (old protocol) to signal → DENY with hint", async () => {
    const repo = createFlowTestRepo('test-flow', {
      schema_version: '1.0',
      name: 'test-flow',
      stages: [
        { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted', completion: {} },
        { id: 'review', prompt: 'stages/review.md', write_scope: 'unrestricted', completion: {} },
      ],
    });
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'test', current_stage: 'review', base_sha: 'abc',
    });
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'flow-complete' }));
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toContain('done');
  });

  // 通过的机器门也可能有话要说（它跳过了哪条断言）。runScript 原先在 status===0 时把
  // stdout/stderr 整段丢弃，于是那些 `⚠` 只在门**因为别的原因失败**时才可见——也就是
  // 它们最没用的时候。「门看着在把关、实际对这票是空操作」比不设门更危险。
  it('script passes but writes warnings → ALLOW，告警经 systemMessage 带出', async () => {
    const repo = createFlowTestRepo('test-flow', SCRIPTED_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'test', current_stage: 'work', base_sha: 'abc',
    });
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts'), { recursive: true });
    const sh = join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts', 'check.sh');
    writeFileSync(sh, '#!/bin/sh\necho "⚠ 断言⑦ 整体未生效" >&2\nexit 0\n');
    chmodSync(sh, 0o755);
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'done' }));
    expect(out?.permissionDecision).toBe('allow');
    expect(out?.systemMessage).toContain('断言⑦ 整体未生效');
  });

  it('script passes 且无输出 → 不制造空的 systemMessage', async () => {
    const repo = createFlowTestRepo('test-flow', SCRIPTED_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'test', current_stage: 'work', base_sha: 'abc',
    });
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts'), { recursive: true });
    const sh = join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts', 'check.sh');
    writeFileSync(sh, '#!/bin/sh\nexit 0\n');
    chmodSync(sh, 0o755);
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'done' }));
    expect(out?.permissionDecision).toBe('allow');
    expect(out?.systemMessage).toBeUndefined();
  });

  it('script passes + gate configured → ALLOW, no gate-token created', async () => {
    const config = {
      schema_version: '1.0' as const,
      name: 'test-flow',
      stages: [
        {
          id: 'work',
          prompt: 'stages/work.md',
          write_scope: 'unrestricted' as const,
          completion: {
            script: { command: 'bash scripts/check.sh' },
            gate: true as const,
          },
        },
        {
          id: 'review',
          prompt: 'stages/review.md',
          write_scope: 'unrestricted' as const,
          completion: {},
        },
      ],
    };
    const repo = createFlowTestRepo('test-flow', config);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts'), { recursive: true });
    writeFileSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts', 'check.sh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts', 'check.sh'), 0o755);
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'done' }));
    expect(out?.permissionDecision).toBe('allow');
    const gateTokenPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'gate-token');
    expect(existsSync(gateTokenPath)).toBe(false);
  });

  it('script fails → DENY write, additionalContext includes failure reason', async () => {
    const repo = createFlowTestRepo('test-flow', SCRIPTED_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts'), { recursive: true });
    writeFileSync(
      join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts', 'check.sh'),
      '#!/bin/sh\necho "validation failed: tests not passing"\nexit 1\n'
    );
    chmodSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts', 'check.sh'), 0o755);
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'done' }));
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/validation failed/i);
  });
});

describe('handlePreTool — Read hook: stage file ordering', () => {
  it('Read current stage file → ALLOW', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work');
    const stagePath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'stages', 'work.md');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Read', { file_path: stagePath }));
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });

  it('Read next stage file (index > current) → DENY', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work'); // current = work (index 0), next = review (index 1)
    const stagePath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'stages', 'review.md');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Read', { file_path: stagePath }));
    expect(out?.permissionDecision).toBe('deny');
  });

  it('Read non-stage file → ALLOW', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Read', { file_path: '/tmp/some-file.ts' }));
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });

  it('Read other state files → ALLOW', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot);
    const activePath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'active.json');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Read', { file_path: activePath }));
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });
});

describe('handlePreTool — control plane protection', () => {
  it('write to config.json → DENY + violation logged', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot);
    const configPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'config.json');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: configPath, content: '{}' }));
    expect(out?.permissionDecision).toBe('deny');
  });

  it('write to stages/*.md in flow dir → DENY', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot);
    const stagePath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'stages', 'work.md');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: stagePath, content: 'x' }));
    expect(out?.permissionDecision).toBe('deny');
  });

  it('write to state/active.json directly → DENY', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot);
    const path = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'active.json');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: path, content: '{}' }));
    expect(out?.permissionDecision).toBe('deny');
  });

  it('Bash command touching state/signal → DENY', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot);
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Bash', { command: `echo done > "${signalPath}"` }));
    expect(out?.permissionDecision).toBe('deny');
  });
});

describe('handlePreTool — control plane protection across git worktrees', () => {
  // A worktree holds a second copy of every tracked control-plane file at a path
  // that is not under repoRoot, so `relative(repoRoot, …)` matching never sees it.
  // Editing that copy and merging the branch back rewrites the flow's own stage
  // prompts / config / gate scripts, which is why it must be refused identically.
  function makeWorktree(repoRoot: string, name: string): string {
    const wt = join(dirname(repoRoot), `${name}-wt`);
    execSync(`git worktree add "${wt}" -b ${name} 2>/dev/null`, { cwd: repoRoot });
    cleanups.push(() => {
      try { execSync(`rm -rf "${wt}"`); } catch { /* already gone */ }
    });
    return wt;
  }

  // The real caller is a subagent whose cwd is the worktree; the flow still
  // resolves to the main checkout through the session→anchor binding.
  function makeWorktreeInput(wt: string, filePath: string): PreToolInput {
    return {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-wt',
      cwd: wt,
      tool_name: 'Write',
      tool_input: { file_path: filePath, content: 'x' },
    };
  }

  afterEach(() => unbindSession('sess-wt'));

  it('write to stages/*.md inside a worktree → DENY', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot);
    bindSession('sess-wt', repo.repoRoot, 'test-flow');
    const wt = makeWorktree(repo.repoRoot, 'wt-stage');
    const out = await handlePreTool(
      makeWorktreeInput(wt, join(wt, '.ai-flow', 'test-flow', 'stages', 'work.md'))
    );
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/Stage prompt files are read-only/);
  });

  it('write to config.json inside a worktree → DENY', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot);
    bindSession('sess-wt', repo.repoRoot, 'test-flow');
    const wt = makeWorktree(repo.repoRoot, 'wt-config');
    const out = await handlePreTool(
      makeWorktreeInput(wt, join(wt, '.ai-flow', 'test-flow', 'config.json'))
    );
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/config\.json is read-only/);
  });

  it('write to scripts/ inside a worktree → DENY', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot);
    bindSession('sess-wt', repo.repoRoot, 'test-flow');
    const wt = makeWorktree(repo.repoRoot, 'wt-scripts');
    const out = await handlePreTool(
      makeWorktreeInput(wt, join(wt, '.ai-flow', 'test-flow', 'scripts', 'gate-stage-3.cjs'))
    );
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/Script files cannot be modified/);
  });

  it('write to state/active.json inside a worktree → DENY', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot);
    bindSession('sess-wt', repo.repoRoot, 'test-flow');
    const wt = makeWorktree(repo.repoRoot, 'wt-active');
    const out = await handlePreTool(
      makeWorktreeInput(wt, join(wt, '.ai-flow', 'test-flow', 'state', 'active.json'))
    );
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/active\.json/);
  });

  it('write to ordinary code inside a worktree → ALLOW (guard must not swallow the whole worktree)', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work'); // unrestricted stage
    bindSession('sess-wt', repo.repoRoot, 'test-flow');
    const wt = makeWorktree(repo.repoRoot, 'wt-code');
    const out = await handlePreTool(makeWorktreeInput(wt, join(wt, 'src', 'main.ts')));
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });

  it('write to a vendored .ai-flow template copy in the tree → ALLOW (no .git beside it)', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work');
    // Mirrors ai-flow's own repo, which ships flow templates at
    // plugins/ai-flow/.ai-flow/<flow>/ while running a flow from the repo root.
    const vendored = join(repo.repoRoot, 'plugins', 'ai-flow', '.ai-flow', 'test-flow', 'stages');
    mkdirSync(vendored, { recursive: true });
    const out = await handlePreTool(
      makeInput(repo.repoRoot, 'Write', { file_path: join(vendored, 'work.md'), content: 'x' })
    );
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });
});

describe('handlePreTool — write scope', () => {
  it('write to docs path when scope=docs_only → ALLOW', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'review'); // review has docs_only
    const allowedPath = join(repo.repoRoot, 'docs', 'test-flow', 'test-flow-abc', 'design.md');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: allowedPath, content: 'x' }));
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });

  it('write to src/ when scope=docs_only → DENY', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'review');
    const blockedPath = join(repo.repoRoot, 'src', 'index.ts');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: blockedPath, content: 'x' }));
    expect(out?.permissionDecision).toBe('deny');
  });

  it('write to any path when scope=unrestricted → ALLOW (subject to control plane)', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work'); // work stage is unrestricted
    const anyPath = join(repo.repoRoot, 'src', 'main.ts');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: anyPath, content: 'x' }));
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });
});

describe('handlePreTool — cwd ≠ repoRoot guard (subdir-write bug)', () => {
  // repoRoot is always cwd or an ancestor (hasActiveFlow walks up). When the
  // session cwd is a subdirectory, a RELATIVE file_path is resolved by the write
  // tool against cwd — silently landing in the wrong place — while the scope check
  // (which assumes repoRoot) validates the wrong path. The guard forces absolute paths.
  function makeSubdirInput(
    subdir: string,
    toolName: string,
    toolInput: Record<string, unknown>
  ): PreToolInput {
    return {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      cwd: subdir,
      tool_name: toolName,
      tool_input: toolInput,
    };
  }

  it('relative write from subdir cwd (unrestricted stage) → DENY with absolute-path instruction', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work'); // unrestricted — would otherwise silently misplace
    const subdir = join(repo.repoRoot, 'packages', 'app');
    mkdirSync(subdir, { recursive: true });
    const out = await handlePreTool(
      makeSubdirInput(subdir, 'Write', { file_path: 'docs/test-flow/test-flow-abc/design.md', content: 'x' })
    );
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toContain(
      join(repo.repoRoot, 'docs/test-flow/test-flow-abc/design.md')
    );
  });

  it('absolute write from subdir cwd → not denied by cwd guard', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work');
    const subdir = join(repo.repoRoot, 'packages', 'app');
    mkdirSync(subdir, { recursive: true });
    const absPath = join(repo.repoRoot, 'src', 'main.ts');
    const out = await handlePreTool(makeSubdirInput(subdir, 'Write', { file_path: absPath, content: 'x' }));
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });

  it('relative write when cwd == repoRoot → unaffected by cwd guard', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work'); // unrestricted
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: 'src/main.ts', content: 'x' }));
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });

  it('relative signal write from subdir cwd → DENY with absolute signal path', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work');
    const subdir = join(repo.repoRoot, 'sub');
    mkdirSync(subdir, { recursive: true });
    const out = await handlePreTool(
      makeSubdirInput(subdir, 'Write', { file_path: '.ai-flow/test-flow/state/signal', content: 'review' })
    );
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toContain(
      join(repo.repoRoot, '.ai-flow/test-flow/state/signal')
    );
  });
});

describe('handlePreTool — Bash control-plane + cd freedom', () => {
  // cd is no longer fenced for Bash: the flow is resolved by session binding and
  // stage prompts anchor paths on the injected absolute {{project_root}}, so the
  // agent may freely `cd` into a sub-project to run scoped commands. Only the three
  // control-plane paths (signal / active.json / scripts) stay blocked in Bash.
  function makeBashInput(cwd: string, command: string): PreToolInput {
    return {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      cwd,
      tool_name: 'Bash',
      tool_input: { command },
    };
  }

  function subdirOf(repoRoot: string): string {
    const subdir = join(repoRoot, 'apps', 'plaud-desktop');
    mkdirSync(subdir, { recursive: true });
    return subdir;
  }

  it('drifted cwd + ordinary git command → allowed (cd freedom)', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work');
    const subdir = subdirOf(repo.repoRoot);
    const out = await handlePreTool(
      makeBashInput(subdir, 'git diff --stat && git add apps/plaud-desktop/src/main/service.ts')
    );
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });

  it('drifted cwd + cd-prefixed command → allowed', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work');
    const subdir = subdirOf(repo.repoRoot);
    const out = await handlePreTool(
      makeBashInput(subdir, `cd ${repo.repoRoot} && git add apps/plaud-desktop/src/main/service.ts`)
    );
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });

  it('cwd == repoRoot + relative git add → allowed', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work');
    const out = await handlePreTool(makeBashInput(repo.repoRoot, 'git add src/main.ts'));
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });

  it('drifted cwd + ordinary non-cd command (cat) → allowed (cd freedom)', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work');
    const subdir = subdirOf(repo.repoRoot);
    const out = await handlePreTool(makeBashInput(subdir, `cat ${join(repo.repoRoot, 'README.md')}`));
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });

  it('drifted cwd + signal write via Bash → DENY (control plane still blocked)', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work');
    const subdir = subdirOf(repo.repoRoot);
    const signal = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeBashInput(subdir, `echo done > ${signal}`));
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/signal/i);
  });

  it('drifted cwd + scripts write via Bash → DENY (control plane still blocked)', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work');
    const subdir = subdirOf(repo.repoRoot);
    const scriptPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts', 'validate.sh');
    const out = await handlePreTool(makeBashInput(subdir, `echo x > ${scriptPath}`));
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/script/i);
  });

  it('no active flow + drifted cwd + bash → null (guard requires active flow)', async () => {
    const repo = makeRepo(); // no activateFlow
    const subdir = subdirOf(repo.repoRoot);
    const out = await handlePreTool(makeBashInput(subdir, 'git add apps/x.ts'));
    expect(out).toBeNull();
  });

  // C3 regression: an agent NOT cd'd typically writes the repoRoot-RELATIVE path.
  // The absolute-only match used to miss this; guard the relative fragment so a
  // refactor that drops it from cpFragments fails here.
  it('cwd == repoRoot + relative signal path via Bash → DENY', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work');
    const out = await handlePreTool(
      makeBashInput(repo.repoRoot, 'echo done > .ai-flow/test-flow/state/signal')
    );
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/signal|control-plane/i);
  });

  it('cwd == repoRoot + relative active.json path via Bash → DENY', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work');
    const out = await handlePreTool(
      makeBashInput(repo.repoRoot, 'echo {} > .ai-flow/test-flow/state/active.json')
    );
    expect(out?.permissionDecision).toBe('deny');
  });

  // Running a flow's own helper script must be allowed — stage-3 hands out
  // `node {{flow_root}}/scripts/worktree.cjs open …` (at least once per ticket) and
  // a bare fragment match refused the very command the flow just instructed, with a
  // message about reads/writes that pointed nowhere near the real cause.
  // Observed two minutes into the first migrated resume: a session restored across
  // the 0.69.0 migration composed subagent dispatch prompts from its scrollback and
  // handed out the project-side references path that `legacy-cleanup` had just
  // deleted. `Read` answered "File does not exist" and said nothing about where the
  // file went; one subagent recovered by reading its worktree's stale copy, another
  // by running `find /`.
  // The project-side config.json is an override layer developers are invited to
  // edit, so a typo there is a reachable input — and `loadFlowConfig` throws on it,
  // which the catch-all turns into `return null`. Everything positioned after the
  // load fails OPEN; the Bash fence must not be among them.
  describe('config 坏掉时 Bash 控制面围栏仍然活着', () => {
    function brokenConfigRepo() {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      writeFileSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'config.json'), '{}');
      return repo;
    }

    it('写 signal 的 Bash 仍被拦(否则一条命令就能推进别人持有的流程)', async () => {
      const repo = brokenConfigRepo();
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, 'echo done > .ai-flow/test-flow/state/signal')
      );
      expect(out?.permissionDecision).toBe('deny');
    });

    it('碰 active.json 的 Bash 仍被拦', async () => {
      const repo = brokenConfigRepo();
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, 'cat .ai-flow/test-flow/state/active.json')
      );
      expect(out?.permissionDecision).toBe('deny');
    });

    it('跑 flow 自己的脚本仍然放行(围栏上移没有把执行豁免一起带走)', async () => {
      const repo = brokenConfigRepo();
      const script = join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts', 'worktree.cjs');
      const out = await handlePreTool(makeBashInput(repo.repoRoot, `node ${script} status f1`));
      expect(out?.permissionDecision ?? 'allow').toBe('allow');
    });
  });

  describe('指向 0.69.0 之前定义位置的路径 → 重定向到插件那份', () => {
    // `grill-flow`, not the usual `test-flow`: the guard only has anything to say
    // about a flow the PLUGIN ships. For one it does not, `flowDefDir` falls back to
    // the project directory and the "stale" path IS the live one — which the last
    // test in this block pins.
    function builtinRepo() {
      const repo = createFlowTestRepo('grill-flow', MINIMAL_CONFIG);
      cleanups.push(repo.cleanup);
      writeActiveState(repo.repoRoot, 'grill-flow', {
        flow_id: 'grill-flow-abc',
        flow_name: 'grill-flow',
        requirement: 'test',
        current_stage: 'work',
        base_sha: 'abc',
      });
      return repo;
    }

    it('项目侧 references 路径 → DENY,并给出 flow_def 下的正确路径', async () => {
      const repo = builtinRepo();
      const stale = join(repo.repoRoot, '.ai-flow', 'grill-flow', 'references', 'fowler-smells.md');
      const out = await handlePreTool(makeInput(repo.repoRoot, 'Read', { file_path: stale }));
      expect(out?.permissionDecision).toBe('deny');
      // The redirect is the whole point — a bare refusal would be no better than ENOENT.
      expect(out?.permissionDecisionReason).toContain(join(PLUGIN_FLOWS_DIR, 'grill-flow', 'references', 'fowler-smells.md'));
      expect(out?.permissionDecisionReason).toContain('flow_def');
    });

    it('worktree 里那份陈旧副本同样拦下(读到过期内容比读不到更糟)', async () => {
      const repo = builtinRepo();
      const wt = '/tmp/some-repo.ai-flow-worktrees/f1-T1/.ai-flow/grill-flow/references/quality-chain.md';
      const out = await handlePreTool(makeInput(repo.repoRoot, 'Read', { file_path: wt }));
      expect(out?.permissionDecision).toBe('deny');
    });

    it('Bash 里 cat 同一条路径不在此列(Bash 有自己那套守卫,再叠一层会撞掉脚本执行豁免)', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const stale = join(repo.repoRoot, '.ai-flow', 'test-flow', 'references', 'handoff.md');
      const out = await handlePreTool(makeBashInput(repo.repoRoot, `cat ${stale}`));
      // It just ENOENTs, which is the pre-existing behaviour. Accepted: `Read` is the
      // shape the dispatch prompts and every observed instance actually used.
      expect(out?.permissionDecision ?? 'allow').toBe('allow');
    });

    it('写入这些路径仍归控制面守卫,不被本条抢走(它的报错更该说控制面)', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const stage = join(repo.repoRoot, '.ai-flow', 'test-flow', 'stages', 'work.md');
      const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: stage, content: 'x' }));
      expect(out?.permissionDecision).toBe('deny');
      expect(out?.permissionDecisionReason ?? '').not.toContain('0.69.0');
    });

    it('子代理同样拦(每次实测到的都发生在子代理里)', async () => {
      const repo = builtinRepo();
      const stale = join(repo.repoRoot, '.ai-flow', 'grill-flow', 'references', 'x.md');
      const input = makeInput(repo.repoRoot, 'Read', { file_path: stale });
      (input as unknown as Record<string, unknown>)['agent_id'] = 'sub-1';
      const out = await handlePreTool(input);
      expect(out?.permissionDecision).toBe('deny');
    });

    it('state/ 和 config.json 不在此列(它们本来就该留在项目里)', async () => {
      const repo = builtinRepo();
      const cfg = join(repo.repoRoot, '.ai-flow', 'grill-flow', 'config.json');
      const out = await handlePreTool(makeInput(repo.repoRoot, 'Read', { file_path: cfg }));
      expect(out?.permissionDecision ?? 'allow').toBe('allow');
    });

    it('定义目录自己那份放行(自定义 flow 的定义就在项目里,拦了等于拦掉它自己)', async () => {
      // For a flow the plugin does not ship, flowDefDir falls back to the project
      // directory — the very path this guard would otherwise call stale.
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const own = join(repo.repoRoot, '.ai-flow', 'test-flow', 'stages', 'work.md');
      const out = await handlePreTool(makeInput(repo.repoRoot, 'Read', { file_path: own }));
      expect(out?.permissionDecision ?? 'allow').toBe('allow');
    });
  });

  describe('执行 flow 自己的脚本', () => {
    const script = (repoRoot: string) =>
      join(repoRoot, '.ai-flow', 'test-flow', 'scripts', 'worktree.cjs');

    it('绝对路径执行 → 放行', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, `node ${script(repo.repoRoot)} open f1 R1`)
      );
      expect(out?.permissionDecision ?? 'allow').toBe('allow');
    });

    it('脚本在插件里、--flow-dir 指回项目 → 放行（0.69.0 起的真实形状）', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      // The definition layer moved into the plugin, so the script path no longer
      // sits under repoRoot and the project's own flow dir travels as an argument.
      // Both halves have to clear this guard: the path still matches a `scripts`
      // fragment (the `.ai-flow/<flow>/scripts` shape is the same wherever it
      // lives), and `--flow-dir <project>/.ai-flow/<flow>` must NOT read as a
      // control-plane reference — it names no signal, no active.json, no scripts dir.
      const pluginScript = join(
        '/opt/plugins/ai-flow', '.ai-flow', 'test-flow', 'scripts', 'worktree.cjs'
      );
      const flowDir = join(repo.repoRoot, '.ai-flow', 'test-flow');
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, `node ${pluginScript} --flow-dir ${flowDir} open f1 R1`)
      );
      expect(out?.permissionDecision ?? 'allow').toBe('allow');
    });

    it('--flow-dir 指到 signal 上仍然拒（参数不是绕过控制面的口子）', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const pluginScript = join(
        '/opt/plugins/ai-flow', '.ai-flow', 'test-flow', 'scripts', 'worktree.cjs'
      );
      const signal = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, `node ${pluginScript} --flow-dir ${signal} open f1 R1`)
      );
      expect(out?.permissionDecision).toBe('deny');
    });

    it('相对路径执行 + 长选项 → 放行', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, 'node --no-warnings .ai-flow/test-flow/scripts/gate-stage-3.cjs')
      );
      expect(out?.permissionDecision ?? 'allow').toBe('allow');
    });

    it('引号包住的脚本路径 + 参数带重定向 → 放行', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, `node "${script(repo.repoRoot)}" close f1 R1 --keep 2>&1`)
      );
      expect(out?.permissionDecision ?? 'allow').toBe('allow');
    });

    // 下面三条是实测被拒过的真实调度命令（一次运行里拒了三回）：豁免原先只认「整段就是一条
    // node 调用」，循环体、变量赋值这些正常 shell 形态一律落空，而拒绝文案讲的是读写控制面，
    // 与真实原因（命令形状）无关——于是重写命令而不是重写形状，再撞一次。
    it('for 循环体里执行（`do node …`）→ 放行', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(
          repo.repoRoot,
          `for L in R1 R2 R3; do node ${script(repo.repoRoot)} sync f1 $L; done`
        )
      );
      expect(out?.permissionDecision ?? 'allow').toBe('allow');
    });

    it('把脚本路径先赋给变量再执行 → 放行', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, `S=${script(repo.repoRoot)}; node $S sync f1 R2; node $S sync f1 R3`)
      );
      expect(out?.permissionDecision ?? 'allow').toBe('allow');
    });

    it('前置环境变量 + 执行 → 放行', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, `CI=1 node ${script(repo.repoRoot)} status f1`)
      );
      expect(out?.permissionDecision ?? 'allow').toBe('allow');
    });

    // 放宽形状不能变成绕过 signal 的路子——state 片段永远不参与豁免。
    it('把 signal 路径赋给变量 → 仍 DENY（否则后续 `> $S` 那段不含片段、会整条溜过去）', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, `S=${join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal')}; echo done > $S`)
      );
      expect(out?.permissionDecision).toBe('deny');
    });

    it('循环体里写 signal → 仍 DENY', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(
          repo.repoRoot,
          `for f in a; do echo done > ${join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal')}; done`
        )
      );
      expect(out?.permissionDecision).toBe('deny');
    });

    // 放宽形状时最容易开出的洞：shell 里「赋值不执行任何东西」是**假的**——
    // `X="$(cmd)"` 会跑 cmd，前置赋值 `A="$(cmd)" node …` 同样会。
    it('赋值值里藏命令替换改脚本 → DENY', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, `X="$(cp /tmp/evil.cjs ${script(repo.repoRoot)})"`)
      );
      expect(out?.permissionDecision).toBe('deny');
    });

    it('反引号形式的命令替换 → DENY', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, 'X=`cp /tmp/evil.cjs ' + script(repo.repoRoot) + '`')
      );
      expect(out?.permissionDecision).toBe('deny');
    });

    it('前置赋值里藏命令替换 + 合法执行 → DENY', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, `A="$(rm -rf ${join(repo.repoRoot, '.ai-flow', 'test-flow', 'stages')})" node ${script(repo.repoRoot)} run`)
      );
      expect(out?.permissionDecision).toBe('deny');
    });

    // stage 提示词与 config.json：Write/Edit 早就拦，Bash 这一路原先完全没防，于是
    // 「flow 期间 stage 与机器门只读」只在两条路径里的一条上成立。
    it('用 Bash 覆盖 stage 文件 → DENY', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, `cp /tmp/new.md ${join(repo.repoRoot, '.ai-flow', 'test-flow', 'stages', 'work.md')}`)
      );
      expect(out?.permissionDecision).toBe('deny');
    });

    it('用 Bash sed 改 config.json → DENY', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, `sed -i '' 's/a/b/' ${join(repo.repoRoot, '.ai-flow', 'test-flow', 'config.json')}`)
      );
      expect(out?.permissionDecision).toBe('deny');
    });

    it('git checkout 覆盖整个 stages 目录 → DENY', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, `git checkout HEAD~1 -- .ai-flow/test-flow/stages/`)
      );
      expect(out?.permissionDecision).toBe('deny');
    });

    // 以下每一条都必须仍然 DENY —— 豁免只开「执行」这一个形态。
    it('读脚本内容 → 仍 DENY', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(makeBashInput(repo.repoRoot, `cat ${script(repo.repoRoot)}`));
      expect(out?.permissionDecision).toBe('deny');
    });

    it('写脚本 → 仍 DENY', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, `echo x > ${script(repo.repoRoot)}`)
      );
      expect(out?.permissionDecision).toBe('deny');
    });

    it('执行之后再读另一个控制面文件 → 仍 DENY（逐段判定）', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(
          repo.repoRoot,
          `node ${script(repo.repoRoot)} open f1 R1 && cat .ai-flow/test-flow/scripts/gate-stage-2.cjs`
        )
      );
      expect(out?.permissionDecision).toBe('deny');
    });

    it('把执行结果重定向进 signal → 仍 DENY', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, `node ${script(repo.repoRoot)} x > .ai-flow/test-flow/state/signal`)
      );
      expect(out?.permissionDecision).toBe('deny');
    });

    it('node -e 里引用脚本 → 仍 DENY（-e 的参数是代码不是路径）', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, `node -e "require('${script(repo.repoRoot)}')"`)
      );
      expect(out?.permissionDecision).toBe('deny');
    });

    it('非 .cjs/.js 结尾的路径（当成目录用）→ 仍 DENY', async () => {
      const repo = makeRepo();
      activateFlow(repo.repoRoot, 'work');
      const out = await handlePreTool(
        makeBashInput(repo.repoRoot, `node ${join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts')}`)
      );
      expect(out?.permissionDecision).toBe('deny');
    });
  });

  // The control-plane match must be path-scoped to the flow: an unrelated file
  // that merely happens to be named active.json (the user's own config) must NOT
  // be blocked. Guards against re-introducing an over-broad bare-name match.
  it('unrelated file named active.json → allowed (no false-positive)', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work');
    const out = await handlePreTool(makeBashInput(repo.repoRoot, 'cat src/config/active.json'));
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });
});

describe('handlePreTool — non-owner read-only guard', () => {
  // Another live session owns the flow; this session (makeInput default 'sess-1')
  // is a second session in the same repo. It may read/search/Bash, but must not
  // mutate project files, and must never reach signal/stage-advance logic.
  function activateOwnedByOther(repoRoot: string, stage = 'work') {
    writeActiveState(repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: stage,
      base_sha: 'abc',
      last_session_id: 'owner-sess',
    });
  }

  it('non-owner + Write to project file → DENY (read-only)', async () => {
    const repo = makeRepo();
    activateOwnedByOther(repo.repoRoot, 'work'); // work is unrestricted — owner could write here
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: join(repo.repoRoot, 'src', 'main.ts'), content: 'x' }));
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/只读|仅可读取|禁止修改/);
  });

  it('non-owner + Edit → DENY (read-only)', async () => {
    const repo = makeRepo();
    activateOwnedByOther(repo.repoRoot, 'work');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Edit', { file_path: join(repo.repoRoot, 'src', 'main.ts'), old_string: 'a', new_string: 'b' }));
    expect(out?.permissionDecision).toBe('deny');
  });

  it('non-owner + Write to signal → DENY by read-only guard, NOT signal-advance path', async () => {
    const repo = makeRepo();
    activateOwnedByOther(repo.repoRoot, 'work');
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'done' }));
    // Critical: must short-circuit before signal handling — a non-owner writing
    // 'done' must never be ALLOWed (which would let it advance another session's flow).
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/只读|仅可读取|禁止修改/);
  });

  it('non-owner + Read non-stage file → ALLOW (reads not blocked)', async () => {
    const repo = makeRepo();
    activateOwnedByOther(repo.repoRoot, 'work');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Read', { file_path: '/tmp/some-file.ts' }));
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });

  it('non-owner + ordinary Bash → ALLOW (Bash not fenced for read-only session)', async () => {
    const repo = makeRepo();
    activateOwnedByOther(repo.repoRoot, 'work');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Bash', { command: 'grep -r foo src/' }));
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });

  it('non-owner + Bash touching signal → DENY (control plane fenced for everyone)', async () => {
    const repo = makeRepo();
    activateOwnedByOther(repo.repoRoot, 'work');
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Bash', { command: `echo done > "${signalPath}"` }));
    expect(out?.permissionDecision).toBe('deny');
  });

  it('owner + Write → not denied by read-only guard', async () => {
    const repo = makeRepo();
    // owner == makeInput default session 'sess-1'
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'sess-1',
    });
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: join(repo.repoRoot, 'src', 'main.ts'), content: 'x' }));
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });
});

describe('handlePreTool — context wrap-up enforcement', () => {
  it('wrap-up latched + write tool → DENY with /clear message', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      context_wrap_up: { at_pct: 65 },
    });
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: '/tmp/foo.ts', content: 'x' }));
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/clear/i);
    expect(out?.permissionDecisionReason).toContain('65%');
  });

  it('wrap-up latched + Edit tool → DENY', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      context_wrap_up: { at_pct: 70 },
    });
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Edit', { file_path: '/tmp/foo.ts', old_string: 'a', new_string: 'b' }));
    expect(out?.permissionDecision).toBe('deny');
  });

  // The block stops the session producing new work; it must not also block the safe
  // exit. Observed: a session crossed the threshold with a subagent in flight, could no
  // longer record anything, and `/clear` then lost that subagent's report.
  it('wrap-up latched + write to the flow\'s own docs → 不被 block 拦（交接必须写得下去）', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'test', current_stage: 'review', base_sha: 'abc',
      context_wrap_up: { at_pct: 65 },
    });
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', {
      file_path: join(repo.repoRoot, 'docs', 'test-flow', 'test-flow-abc', 'tickets.md'),
      content: '交接块',
    }));
    expect(out?.permissionDecisionReason ?? '').not.toMatch(/Context wrap-up started/);
  });

  it('wrap-up latched + write to codebase（同一 stage）→ 仍 DENY，且文案讲清 /clear 的真实代价', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'test', current_stage: 'review', base_sha: 'abc',
      context_wrap_up: { at_pct: 65 },
    });
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', {
      file_path: join(repo.repoRoot, 'src', 'foo.ts'), content: 'x',
    }));
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toContain('Context wrap-up started at 65%');
    // 旧文案说 "progress won't be lost" —— 在有在飞子代理时那是假的。
    expect(out?.permissionDecisionReason).not.toMatch(/won't be lost/);
    expect(out?.permissionDecisionReason).toMatch(/in-flight subagent/i);
  });

  it('wrap-up latched + Read tool → ALLOW (read tools not blocked)', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      context_wrap_up: { at_pct: 70 },
    });
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Read', { file_path: '/tmp/foo.ts' }));
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });

  // The latch lives on shared flow state, so without an agent_id check it reaches every
  // subagent — including ones started after it, carrying a fraction of the context that
  // caused it. Observed: a session latched at 61% and did the prescribed thing — handed
  // the remaining fix work to a fresh subagent — which was then refused mid-edit at 75K
  // of its own context, leaving one file created and its call sites unwired.
  it('wrap-up latched + 子代理写代码 → 不被 block 拦（fresh context 正是退化时的处方）', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      context_wrap_up: { at_pct: 61 },
    });
    const input = makeInput(repo.repoRoot, 'Edit', {
      file_path: join(repo.repoRoot, 'src', 'main.ts'), old_string: 'a', new_string: 'b',
    });
    input.agent_id = 'agent-abc';
    const out = await handlePreTool(input);
    // 断言 allow 而不是只排除 block 的文案：写不进去就是写不进去，换一条守卫来拦同样是回归。
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
    expect(out?.permissionDecisionReason ?? '').not.toMatch(/context wrap-up started/i);
  });

  it('wrap-up latched + 主 session 写代码 → 仍 DENY（agent_id 缺席时行为不变）', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      context_wrap_up: { at_pct: 61 },
    });
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Edit', {
      file_path: join(repo.repoRoot, 'src', 'main.ts'), old_string: 'a', new_string: 'b',
    }));
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/context wrap-up started/i);
  });

  it('wrap-up not latched + write tool → normal processing (not denied by the wrap-up guard)', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      context_wrap_up: { at_pct: null },
    });
    const anyPath = join(repo.repoRoot, 'src', 'main.ts');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: anyPath, content: 'x' }));
    // Should NOT be denied by context block (may be allowed or denied for other reasons)
    const reason = out?.permissionDecisionReason ?? '';
    expect(reason).not.toMatch(/context wrap-up started/i);
  });

  // A stage with no docs_paths has no safe exit, and the guard's whole design note
  // says it "must not also block the safe exit". Observed before this branch existed:
  // an `unrestricted` stage with no docs_paths (legal — the schema requires them only
  // for `docs_only`, so `/ai-flow:create` emits it) latched at 60%, and then BOTH the
  // code write AND the handoff write were denied, the refusal text claiming writes to
  // "this flow's own docs (none configured)" were still allowed. The only prescribed
  // way out is `/clear`, which requires the handoff to be on disk first.
  describe('stage without docs_paths → nothing is refused (there is no safe exit to keep open)', () => {
    function latchedNoEscapeRepo() {
      const repo = createFlowTestRepo('test-flow', NO_ESCAPE_CONFIG);
      cleanups.push(repo.cleanup);
      writeActiveState(repo.repoRoot, 'test-flow', {
        flow_id: 'test-flow-abc',
        flow_name: 'test-flow',
        requirement: 'test',
        current_stage: 'work',
        base_sha: 'abc',
        context_wrap_up: { at_pct: 60 },
      });
      return repo;
    }

    it('write to the codebase → ALLOW, not denied by the wrap-up guard', async () => {
      const repo = latchedNoEscapeRepo();
      const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', {
        file_path: join(repo.repoRoot, 'src', 'main.ts'), content: 'x',
      }));
      expect(out?.permissionDecision ?? 'allow').toBe('allow');
      expect(out?.permissionDecisionReason ?? '').not.toMatch(/context wrap-up started/i);
    });

    it('write to a handoff document → ALLOW (this is the write /clear depends on)', async () => {
      const repo = latchedNoEscapeRepo();
      const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', {
        file_path: join(repo.repoRoot, 'docs', 'handoff.md'), content: '交接块',
      }));
      // allow, not merely "the wrap-up guard stayed quiet": a handoff that cannot be
      // written is the whole defect, whichever guard refuses it.
      expect(out?.permissionDecision ?? 'allow').toBe('allow');
      expect(out?.permissionDecisionReason ?? '').not.toMatch(/none configured/);
    });

    it('Edit to the codebase → ALLOW too (the guard covers every write tool or none)', async () => {
      const repo = latchedNoEscapeRepo();
      const out = await handlePreTool(makeInput(repo.repoRoot, 'Edit', {
        file_path: join(repo.repoRoot, 'src', 'main.ts'), old_string: 'a', new_string: 'b',
      }));
      expect(out?.permissionDecision ?? 'allow').toBe('allow');
    });

    // Includes the signal, i.e. the stage can still advance here — which the
    // configured-docs_paths case refuses ('wrap-up latched + signal Write → DENY'
    // below). Pinned rather than left implicit because it is a real consequence of
    // "nothing is refused" and reads like an oversight otherwise: making signal the
    // one exception would recreate the very defect this branch exists to fix, in a
    // smaller shape — a session that can neither write nor advance, with `/clear`
    // (which costs whatever is not on disk) as its only move.
    it('signal Write → ALLOW as well, so the stage can still advance', async () => {
      const repo = latchedNoEscapeRepo();
      const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', {
        file_path: join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal'),
        content: 'done',
      }));
      expect(out?.permissionDecision ?? 'allow').toBe('allow');
      expect(out?.permissionDecisionReason ?? '').not.toMatch(/context wrap-up started/i);
    });
  });

  // Design intent: signal writes are refused once the wrap-up has latched too.
  // User must /clear first — SessionStart clears the latch — then signal.
  // This prevents stage advancement with an already-exhausted context window.
  it('wrap-up latched + signal Write → DENY (stage advancement blocked too)', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      context_wrap_up: { at_pct: 65 },
    });
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: '' }));
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/context wrap-up started/i);
  });
});
