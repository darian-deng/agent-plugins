import { describe, it, expect, afterEach } from 'vitest';
import { handleSessionEnd } from '../src/lib/session-end-handler.js';
import { readActiveState } from '../src/lib/state.js';
import { createFlowTestRepo, writeActiveState, MINIMAL_CONFIG } from './fixtures/helpers.js';
import type { SessionEndInput } from '../src/lib/types.js';

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

function makeInput(repoRoot: string, sessionId: string): SessionEndInput {
  return { hook_event_name: 'SessionEnd', session_id: sessionId, cwd: repoRoot };
}

describe('handleSessionEnd', () => {
  it('owner session ends → last_session_id cleared to null', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'owner-sess',
    });
    await handleSessionEnd(makeInput(repo.repoRoot, 'owner-sess'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.last_session_id).toBeNull();
  });

  it('non-owner session ends → last_session_id unchanged', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'owner-sess',
    });
    await handleSessionEnd(makeInput(repo.repoRoot, 'other-sess'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.last_session_id).toBe('owner-sess');
  });

  it('no active flow → no error, returns cleanly', async () => {
    const repo = makeRepo();
    // No active.json written — hasActiveFlow returns null
    await expect(handleSessionEnd(makeInput(repo.repoRoot, 'any-sess'))).resolves.toBeUndefined();
  });

  it('last_session_id already null → stays null, no error', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: null,
    });
    await handleSessionEnd(makeInput(repo.repoRoot, 'any-sess'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.last_session_id).toBeNull();
  });

  it('owner session ends → other fields preserved', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build feature X',
      current_stage: 'work',
      base_sha: 'abc123',
      last_session_id: 'owner-sess',
      history_session_ids: ['prev-sess', 'owner-sess'],
    });
    await handleSessionEnd(makeInput(repo.repoRoot, 'owner-sess'));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.requirement).toBe('build feature X');
    expect(state!.base_sha).toBe('abc123');
    expect(state!.history_session_ids).toEqual(['prev-sess', 'owner-sess']);
    expect(state!.last_session_id).toBeNull();
  });
});
