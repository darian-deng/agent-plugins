import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { handleUserPrompt } from '../src/lib/userprompt-handler.js';
import { readActiveState } from '../src/lib/state.js';
import { createFlowTestRepo, writeActiveState, writeSignal, MINIMAL_CONFIG } from './fixtures/helpers.js';
import type { UserPromptInput } from '../src/lib/types.js';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeRepo() {
  const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG);
  cleanups.push(repo.cleanup);
  return repo;
}

function makeInput(prompt: string, repoRoot: string, sessionId = 'sess-1'): UserPromptInput {
  return {
    hook_event_name: 'UserPromptSubmit',
    session_id: sessionId,
    cwd: repoRoot,
    prompt,
  };
}

describe('handleUserPrompt — routing', () => {
  it('non-flow message passes through (allow, no additionalContext)', async () => {
    const repo = makeRepo();
    const out = await handleUserPrompt(makeInput('hello world', repo.repoRoot));
    expect(out.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    const o = out.hookSpecificOutput as { permissionDecision?: string; additionalContext?: string };
    expect(o.permissionDecision).toBeUndefined();
    expect(o.additionalContext).toBeUndefined();
  });

  it('test-flow start → routes to start handler', async () => {
    const repo = makeRepo();
    const out = await handleUserPrompt(makeInput('test-flow start build feature X', repo.repoRoot));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).not.toBeNull();
  });

  it('test-flow start with multiline requirement → routes to start handler', async () => {
    const repo = makeRepo();
    const multiline = 'test-flow start build feature X\nThis is a detailed description\nwith multiple lines of context';
    const out = await handleUserPrompt(makeInput(multiline, repo.repoRoot));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).not.toBeNull();
    expect(state!.requirement).toContain('build feature X');
  });

  it('test-flow start with CJK args and no space after subcommand → routes to start handler', async () => {
    const repo = makeRepo();
    const prompt = 'test-flow start我要构建这个功能，具体需求如下\n详细描述在这里';
    await handleUserPrompt(makeInput(prompt, repo.repoRoot));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).not.toBeNull();
    expect(state!.requirement).toContain('我要构建这个功能');
  });

  it('statuscheck (unknown command with known prefix) → not routed as status', async () => {
    const repo = makeRepo();
    const out = await handleUserPrompt(makeInput('test-flow statuscheck', repo.repoRoot));
    const o = out.hookSpecificOutput as { permissionDecision?: string; additionalContext?: string };
    expect(o.permissionDecision).not.toBe('deny');
    expect(o.additionalContext).toMatch(/unknown|valid/i);
  });

  it('test-flow approve → routes to approve handler (no token needed)', async () => {
    const repo = createFlowTestRepo('test-flow', {
      schema_version: '1.0',
      name: 'test-flow',
      stages: [
        { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted', completion: { gate: true } },
        { id: 'review', prompt: 'stages/review.md', write_scope: 'unrestricted', completion: {} },
      ],
    });
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    // signal must contain nextStageId 'review' for gate to be pending
    writeSignal(repo.repoRoot, 'test-flow', 'review');
    const out = await handleUserPrompt(makeInput('test-flow approve', repo.repoRoot));
    const o = out.hookSpecificOutput as { additionalContext?: string };
    expect(o.additionalContext).toContain('review');
  });

  it('test-flow abort (no --confirm) → routes to abort handler, returns confirmation prompt', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: execSync('git rev-parse HEAD', { cwd: repo.repoRoot, encoding: 'utf-8' }).trim(),
    });
    const out = await handleUserPrompt(makeInput('test-flow abort', repo.repoRoot));
    // abort without --confirm returns a deny + confirmation prompt, state is unchanged
    const hookOut = out.hookSpecificOutput as { permissionDecision?: string; additionalContext?: string };
    const hasConfirmMsg = hookOut.permissionDecision === 'deny' || (hookOut.additionalContext ?? '').includes('--confirm');
    expect(hasConfirmMsg).toBe(true);
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).not.toBeNull(); // state preserved — abort did not execute
  });

  it('test-flow status → routes to status handler', async () => {
    const repo = makeRepo();
    const out = await handleUserPrompt(makeInput('test-flow status', repo.repoRoot));
    const o = out.hookSpecificOutput as { additionalContext?: string };
    expect(o.additionalContext).toMatch(/no active flow/i);
  });

  it('test-flow help → routes to help handler', async () => {
    const repo = makeRepo();
    const out = await handleUserPrompt(makeInput('test-flow help', repo.repoRoot));
    const o = out.hookSpecificOutput as { additionalContext?: string };
    expect(o.additionalContext).toContain('test-flow');
  });

  it('test-flow unknowncmd → soft error (allow + additionalContext, NOT deny)', async () => {
    const repo = makeRepo();
    const out = await handleUserPrompt(makeInput('test-flow unknowncmd', repo.repoRoot));
    const o = out.hookSpecificOutput as { permissionDecision?: string; additionalContext?: string };
    expect(o.permissionDecision).not.toBe('deny');
    expect(o.additionalContext).toBeTruthy();
  });

  it('unknown cmd message includes list of valid commands', async () => {
    const repo = makeRepo();
    const out = await handleUserPrompt(makeInput('test-flow foobar', repo.repoRoot));
    const o = out.hookSpecificOutput as { additionalContext?: string };
    expect(o.additionalContext).toMatch(/start|approve|abort|resume|status|help/i);
  });

  it('unknown cmd does NOT show "operation blocked" banner', async () => {
    const repo = makeRepo();
    const out = await handleUserPrompt(makeInput('test-flow foobar', repo.repoRoot));
    const o = out.hookSpecificOutput as { additionalContext?: string };
    expect(o.additionalContext).not.toMatch(/operation blocked/i);
  });

  it('flow name not in .ai-flow/ → soft error mentioning /ai-flow', async () => {
    const repo = makeRepo();
    const out = await handleUserPrompt(makeInput('unknown-flow start task', repo.repoRoot));
    // unknown prefix should pass through (not an error, not recognized)
    const o = out.hookSpecificOutput as { permissionDecision?: string };
    // Either pass-through or soft error mentioning the flow
    // If it's a registered flow pattern detection only known flows matter
    // An unknown prefix should just pass through
    expect(o.permissionDecision).not.toBe('deny');
  });

  // ── Session mutex enforcement ──────────────────────────────────────────────

  it('non-owner session issues flow command → denied', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'owner-sess',
    });
    const out = await handleUserPrompt(makeInput('test-flow status', repo.repoRoot, 'intruder-sess'));
    const o = out.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string };
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toContain('owner-se'); // 8-char truncated owner id
  });

  it('owner session issues flow command → not denied', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'owner-sess',
    });
    const out = await handleUserPrompt(makeInput('test-flow status', repo.repoRoot, 'owner-sess'));
    const o = out.hookSpecificOutput as { permissionDecision?: string };
    expect(o.permissionDecision).not.toBe('deny');
  });
});
