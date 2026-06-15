import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { handleStart } from '../src/lib/commands/start.js';
import { handleSessionStart } from '../src/lib/session-handler.js';
import { handleSessionEnd } from '../src/lib/session-end-handler.js';
import { readActiveState } from '../src/lib/state.js';
import { lookupSession, bindSession } from '../src/lib/session-registry.js';
import { createFlowTestRepo, writeActiveState, MINIMAL_CONFIG } from './fixtures/helpers.js';

// CLAUDE_CONFIG_DIR is isolated to a tmpdir by tests/setup.ts, so the binding
// registry written by these handlers never touches the developer's real ~/.claude.
function registryDir(): string {
  return join(process.env['CLAUDE_CONFIG_DIR']!, 'ai-flow', 'sessions');
}
function clearRegistry(): void {
  const d = registryDir();
  if (existsSync(d)) rmSync(d, { recursive: true, force: true });
}

let cleanups: Array<() => void> = [];
beforeEach(() => clearRegistry());
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeRepo() {
  const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG);
  cleanups.push(repo.cleanup);
  return repo;
}

describe('binding wiring — handleStart', () => {
  it('writes a session→anchor binding pointing at the flow it just started', async () => {
    const repo = makeRepo();
    const result = await handleStart(repo.repoRoot, 'test-flow', 'build X', 'sess-start', 0);
    expect(result.action).toBe('allow');

    // This is the mutation guard for C8: if bindSession is dropped from
    // handleStart, the lookup below is null and this test fails.
    const b = lookupSession('sess-start');
    expect(b).not.toBeNull();
    expect(b!.projectRoot).toBe(repo.repoRoot);
    expect(b!.flowName).toBe('test-flow');
  });
});

describe('binding wiring — handleSessionStart', () => {
  it('(re)binds the session on resume, even for a flow created before bindings existed', async () => {
    const repo = makeRepo();
    // Seed a flow with no current owner and NO pre-existing binding.
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'r',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: null,
    });
    expect(lookupSession('sess-resume')).toBeNull();

    await handleSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'sess-resume',
      cwd: repo.repoRoot,
      source: 'resume',
    });

    const b = lookupSession('sess-resume');
    expect(b).not.toBeNull();
    expect(b!.projectRoot).toBe(repo.repoRoot);
    expect(b!.flowName).toBe('test-flow');
  });
});

describe('binding wiring — handleSessionEnd', () => {
  it('clears the lock and unbinds even when cwd has drifted ABOVE the anchor (C1 regression)', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'r',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'sess-end',
    });
    bindSession('sess-end', repo.repoRoot, 'test-flow');

    // cwd is the PARENT of the anchor — walk-up from here cannot find the flow.
    // Only the binding (resolved before unbind) can. If SessionEnd unbinds first
    // (the pre-fix order), last_session_id is never cleared.
    await handleSessionEnd({
      hook_event_name: 'SessionEnd',
      session_id: 'sess-end',
      cwd: dirname(repo.repoRoot),
    });

    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.last_session_id).toBeNull();
    expect(lookupSession('sess-end')).toBeNull();
  });

  it('does not release a lock held by a different (owning) session', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'r',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'owner-sess',
    });
    bindSession('other-sess', repo.repoRoot, 'test-flow');

    await handleSessionEnd({
      hook_event_name: 'SessionEnd',
      session_id: 'other-sess',
      cwd: repo.repoRoot,
    });

    // Lock untouched (held by owner-sess); only the ending session is unbound.
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.last_session_id).toBe('owner-sess');
    expect(lookupSession('other-sess')).toBeNull();
  });
});
