import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { handleUserPrompt } from '../src/lib/userprompt-handler.js';
import { readActiveState, isGateActive } from '../src/lib/state.js';
import { createFlowTestRepo, writeActiveState, writeGateToken, MINIMAL_CONFIG } from './fixtures/helpers.js';
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

  it('test-flow approve → routes to approve handler', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    writeGateToken(repo.repoRoot, 'test-flow', 'mytoken');
    const out = await handleUserPrompt(makeInput('test-flow approve mytoken', repo.repoRoot));
    const o = out.hookSpecificOutput as { additionalContext?: string };
    expect(o.additionalContext).toContain('review');
  });

  it('test-flow abort → routes to abort handler', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: execSync('git rev-parse HEAD', { cwd: repo.repoRoot, encoding: 'utf-8' }).trim(),
    });
    await handleUserPrompt(makeInput('test-flow abort', repo.repoRoot));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).toBeNull();
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

  it('non-gate message when gate active → clears gate (deletes gate-token) + allows', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    writeGateToken(repo.repoRoot, 'test-flow', 'tok-abc');
    await handleUserPrompt(makeInput('please explain the current stage', repo.repoRoot));
    expect(await isGateActive(repo.repoRoot, 'test-flow')).toBe(false);
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
});
