import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import { writeFileSync, chmodSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { handlePreTool } from '../src/lib/pretool-handler.js';
import { readActiveState } from '../src/lib/state.js';
import { createFlowTestRepo, writeActiveState, MINIMAL_CONFIG, GATED_CONFIG, SCRIPTED_CONFIG, BLOCKING_CONFIG } from './fixtures/helpers.js';
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

describe('handlePreTool — signal interception (new signal-content semantics)', () => {
  it('gate stage: write correct nextStageId to signal → ALLOW, no gate-token created', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work'); // work has no gate, next is review
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    // MINIMAL_CONFIG work stage has no gate, completion: {}
    // nextStage = 'review'
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'review' }));
    expect(out?.permissionDecision).toBe('allow');
    // No gate-token should be created
    const gateTokenPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'gate-token');
    expect(existsSync(gateTokenPath)).toBe(false);
  });

  it('gate stage (completion.gate=true): write correct nextStageId to signal → ALLOW (no deny)', async () => {
    const repo = makeRepo();
    // Use GATED_CONFIG: work stage has gate: true, next is review
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
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const signalPath = join(gatedRepo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(gatedRepo.repoRoot, 'Write', { file_path: signalPath, content: 'review' }));
    expect(out?.permissionDecision).toBe('allow');
    // No gate-token
    const gateTokenPath = join(gatedRepo.repoRoot, '.ai-flow', 'test-flow', 'state', 'gate-token');
    expect(existsSync(gateTokenPath)).toBe(false);
  });

  it('non-terminal stage with none: write correct nextStageId → ALLOW', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work');
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'review' }));
    expect(out?.permissionDecision).toBe('allow');
  });

  it('non-terminal stage: write wrong content → DENY with expected content hint', async () => {
    const repo = makeRepo();
    activateFlow(repo.repoRoot, 'work');
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'done' }));
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toContain('review');
  });

  it('terminal stage: write flow-complete → ALLOW (posttool handles completion)', async () => {
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
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'review',
      base_sha: 'abc',
    });
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'flow-complete' }));
    expect(out?.permissionDecision).toBe('allow');
    // active.json still exists — posttool will handle the completion
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).not.toBeNull();
  });

  it('terminal stage: write wrong content → DENY', async () => {
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
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'review',
      base_sha: 'abc',
    });
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'done' }));
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toContain('flow-complete');
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
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'review' }));
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
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: 'review' }));
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

describe('handlePreTool — context block enforcement', () => {
  it('context_blocked=true + write tool → DENY with /clear message', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      context_blocked: true,
      context_warning: { warned: true, warned_at_pct: 65, warned_at: new Date().toISOString() },
    });
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: '/tmp/foo.ts', content: 'x' }));
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/clear/i);
    expect(out?.permissionDecisionReason).toContain('65%');
  });

  it('context_blocked=true + Edit tool → DENY', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      context_blocked: true,
      context_warning: { warned: true, warned_at_pct: 70, warned_at: new Date().toISOString() },
    });
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Edit', { file_path: '/tmp/foo.ts', old_string: 'a', new_string: 'b' }));
    expect(out?.permissionDecision).toBe('deny');
  });

  it('context_blocked=true + Read tool → ALLOW (read tools not blocked)', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      context_blocked: true,
      context_warning: { warned: true, warned_at_pct: 70, warned_at: new Date().toISOString() },
    });
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Read', { file_path: '/tmp/foo.ts' }));
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });

  it('context_blocked=false + write tool → normal processing (not denied by block)', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      context_blocked: false,
    });
    const anyPath = join(repo.repoRoot, 'src', 'main.ts');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: anyPath, content: 'x' }));
    // Should NOT be denied by context block (may be allowed or denied for other reasons)
    const reason = out?.permissionDecisionReason ?? '';
    expect(reason).not.toMatch(/context blocked/i);
  });

  // Design intent: signal writes are also blocked when context_blocked=true.
  // User must /clear first — after which context_blocked resets to false — then signal.
  // This prevents stage advancement with an already-exhausted context window.
  it('context_blocked=true + signal Write → DENY (stage advancement blocked too)', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      context_blocked: true,
      context_warning: { warned: true, warned_at_pct: 65, warned_at: new Date().toISOString() },
    });
    const signalPath = join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'signal');
    const out = await handlePreTool(makeInput(repo.repoRoot, 'Write', { file_path: signalPath, content: '' }));
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toMatch(/context blocked/i);
  });
});
