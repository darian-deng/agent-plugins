import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  bindSession,
  lookupSession,
  unbindSession,
  listBindings,
} from '../src/lib/session-registry.js';
import { resolveActiveFlow, gcRegistry, writeActiveState, type ActiveState } from '../src/lib/state.js';

function registryDir(): string {
  return join(process.env['CLAUDE_CONFIG_DIR']!, 'ai-flow', 'sessions');
}

function clearRegistry(): void {
  const d = registryDir();
  if (existsSync(d)) rmSync(d, { recursive: true, force: true });
}

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), 'ai-flow-reg-test-'));
}

function seedFlow(repoRoot: string, flowName: string, sessionId: string | null): ActiveState {
  const state: ActiveState = {
    flow_id: '2026-01-01-abcd',
    flow_name: flowName,
    requirement: 'r',
    current_stage: 's1',
    base_sha: 'sha',
    started_at: '2026-01-01T00:00:00.000Z',
    last_session_id: sessionId,
    context_size: 1_000_000,
    context_warning: { warned: false, warned_at_pct: null, warned_at: null },
    context_blocked: false,
  };
  // writeActiveState creates .ai-flow/<flow>/state/active.json
  return state;
}

describe('session-registry', () => {
  beforeEach(() => clearRegistry());

  it('bind → lookup round-trips', () => {
    bindSession('sess-A', '/some/anchor', 'feat-flow');
    const b = lookupSession('sess-A');
    expect(b).not.toBeNull();
    expect(b!.projectRoot).toBe('/some/anchor');
    expect(b!.flowName).toBe('feat-flow');
    expect(b!.sessionId).toBe('sess-A');
  });

  it('lookup of unknown session → null', () => {
    expect(lookupSession('nope')).toBeNull();
  });

  it('unbind removes the file', () => {
    bindSession('sess-B', '/x', 'f');
    expect(lookupSession('sess-B')).not.toBeNull();
    unbindSession('sess-B');
    expect(lookupSession('sess-B')).toBeNull();
  });

  it('sanitizes session id into a safe single-segment filename', () => {
    bindSession('weird/../id with spaces', '/x', 'f');
    // exactly one file, no path traversal escaping the registry dir
    const files = readdirSync(registryDir());
    expect(files.length).toBe(1);
    expect(files[0]).not.toContain('/');
    expect(lookupSession('weird/../id with spaces')).not.toBeNull();
  });

  it('corrupt file is skipped, not thrown', () => {
    mkdirSync(registryDir(), { recursive: true });
    writeFileSync(join(registryDir(), 'broken.json'), '{not json');
    expect(() => listBindings()).not.toThrow();
    expect(listBindings()).toEqual([]);
  });
});

describe('resolveActiveFlow', () => {
  beforeEach(() => clearRegistry());

  it('binding hit resolves the bound flow even when cwd has drifted ABOVE the anchor', async () => {
    const monorepo = makeRepo();
    const sub = join(monorepo, 'packages', 'foo');
    mkdirSync(sub, { recursive: true });
    await writeActiveState(sub, 'feat-flow', seedFlow(sub, 'feat-flow', 'sess-1'));
    bindSession('sess-1', sub, 'feat-flow');

    // cwd is the monorepo ROOT — above the anchor. walk-up from here would NOT
    // find the sub-repo flow; the binding must.
    const resolved = await resolveActiveFlow(monorepo, 'sess-1');
    expect(resolved).not.toBeNull();
    expect(resolved!.repoRoot).toBe(sub);
    expect(resolved!.flowName).toBe('feat-flow');
  });

  it('falls back to walk-up when there is no binding', async () => {
    const repo = makeRepo();
    await writeActiveState(repo, 'feat-flow', seedFlow(repo, 'feat-flow', 'sess-2'));

    const resolved = await resolveActiveFlow(repo, 'sess-unbound');
    expect(resolved).not.toBeNull();
    expect(resolved!.repoRoot).toBe(repo);
  });

  it('stale binding (flow aborted) falls through to walk-up', async () => {
    const repo = makeRepo();
    await writeActiveState(repo, 'feat-flow', seedFlow(repo, 'feat-flow', 'sess-3'));
    // Binding points at a flow with no active.json on disk.
    bindSession('sess-3', join(repo, 'gone'), 'ghost-flow');

    const resolved = await resolveActiveFlow(repo, 'sess-3');
    expect(resolved).not.toBeNull();
    expect(resolved!.repoRoot).toBe(repo);
    expect(resolved!.flowName).toBe('feat-flow');
  });
});

describe('gcRegistry', () => {
  beforeEach(() => clearRegistry());

  it('prunes bindings whose flow is gone or owned by another session', async () => {
    const repo = makeRepo();
    await writeActiveState(repo, 'feat-flow', seedFlow(repo, 'feat-flow', 'owner'));

    bindSession('owner', repo, 'feat-flow');       // valid: matches last_session_id
    bindSession('taken-over', repo, 'feat-flow');  // dead: not the owner
    bindSession('dangling', join(repo, 'nope'), 'x'); // dead: no active.json

    await gcRegistry();

    expect(lookupSession('owner')).not.toBeNull();
    expect(lookupSession('taken-over')).toBeNull();
    expect(lookupSession('dangling')).toBeNull();
  });

  it('keeps a binding whose flow is released (owner=null), not treating null as dead', async () => {
    const repo = makeRepo();
    // Flow exists but is currently unowned (released, waiting to resume).
    await writeActiveState(repo, 'feat-flow', seedFlow(repo, 'feat-flow', null));
    bindSession('last-owner', repo, 'feat-flow');

    await gcRegistry();

    // A null owner is not a takeover — the binding stays so the session can
    // still resolve the flow by binding even if its cwd drifts above the anchor.
    expect(lookupSession('last-owner')).not.toBeNull();
  });
});
