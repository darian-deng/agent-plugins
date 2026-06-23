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
