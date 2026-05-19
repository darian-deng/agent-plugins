import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import { writeFileSync, chmodSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { handlePreTool } from '../src/lib/pretool-handler.js';
import { isGateActive, readActiveState } from '../src/lib/state.js';
import { createFlowTestRepo, writeActiveState, MINIMAL_CONFIG, GATED_CONFIG, SCRIPTED_CONFIG } from './fixtures/helpers.js';
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

describe('handlePreTool — signal interception', () => {
  it('no script, no gate → ALLOW write, advance stage', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot);
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'done' }));
    expect(out?.permissionDecision).toBe('allow');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
  });

  it('script passes, no gate → ALLOW write, advance stage', async () => {
    const repo = createFlowTestRepo('test-flow', SCRIPTED_CONFIG);
    cleanups.push(repo.cleanup);
    activateFlow(repo.repoRoot);
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts'), { recursive: true });
    writeFileSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts', 'check.sh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts', 'check.sh'), 0o755);
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'done' }));
    expect(out?.permissionDecision).toBe('allow');
  });

  it('script fails → DENY write, additionalContext includes failure reason', async () => {
    const repo = createFlowTestRepo('test-flow', SCRIPTED_CONFIG);
    cleanups.push(repo.cleanup);
    activateFlow(repo.repoRoot);
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

  it('gate configured, no script → DENY write, gate-token created', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'review'); // review stage has gate: true
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'done' }));
    expect(out?.permissionDecision).toBe('deny');
    expect(await isGateActive(repo.repoRoot, 'test-flow')).toBe(true);
  });

  it('script passes + gate configured → DENY write, gate-token created', async () => {
    const config = {
      ...MINIMAL_CONFIG,
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
    activateFlow(repo.repoRoot, 'work');
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts'), { recursive: true });
    writeFileSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts', 'check.sh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'scripts', 'check.sh'), 0o755);
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'done' }));
    expect(out?.permissionDecision).toBe('deny');
    expect(await isGateActive(repo.repoRoot, 'test-flow')).toBe(true);
  });

  it('signal write at last stage → ALLOW, complete flow', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'review'); // last stage, no gate on signal-only completion
    const config = {
      ...MINIMAL_CONFIG,
      stages: [
        { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted' as const, completion: {} },
        { id: 'review', prompt: 'stages/review.md', write_scope: 'unrestricted' as const, completion: {} },
      ],
    };
    // re-create with no gate on last stage
    const repo2 = createFlowTestRepo('test-flow', config);
    cleanups.push(repo2.cleanup);
    activateFlow(repo2.repoRoot, 'review');
    const signalPath = join(repo2.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo2.repoRoot, 'Write', { file_path: signalPath, content: 'done' }));
    expect(out?.permissionDecision).toBe('allow');
    const state = await readActiveState(repo2.repoRoot, 'test-flow');
    expect(state).toBeNull();
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

  it('write to state/gate-token directly → DENY', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot);
    const path = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'gate-token');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: path, content: 'x' }));
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

describe('handlePreTool — read tools', () => {
  it('Read of state/gate-token → DENY (AI must not see token)', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot);
    const tokenPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'gate-token');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Read', { file_path: tokenPath }));
    expect(out?.permissionDecision).toBe('deny');
  });

  it('Read of other state files → ALLOW', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot);
    const activePath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'active.json');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Read', { file_path: activePath }));
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });

  it('Bash cat state/gate-token → DENY', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot);
    const tokenPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'gate-token');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Bash', { command: `cat "${tokenPath}"` }));
    expect(out?.permissionDecision).toBe('deny');
  });
});
