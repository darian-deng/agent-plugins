import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import {
  readActiveState,
  writeActiveState,
  hasActiveFlow,
  isGateActive,
  writeGateToken,
  deleteGateToken,
  appendTransition,
  nextStage,
} from '../src/lib/state.js';
import type { ActiveState } from '../src/lib/state.js';
import { MINIMAL_CONFIG } from './fixtures/helpers.js';

let tmpDirs: string[] = [];

function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ai-flow-state-test-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) execSync(`rm -rf "${d}"`);
  tmpDirs = [];
});

function makeActiveState(overrides?: Partial<ActiveState>): ActiveState {
  return {
    flow_id: 'test-abc123',
    flow_name: 'test-flow',
    requirement: 'add feature X',
    current_stage: 'work',
    base_sha: 'abc123',
    started_at: '2024-01-01T00:00:00.000Z',
    last_session_id: null,
    context_size: 0,
    context_warning: { warned: false, warned_at_pct: null, warned_at: null },
    ...overrides,
  };
}

describe('readActiveState', () => {
  it('returns null for nonexistent file', async () => {
    const root = makeTmp();
    const result = await readActiveState(root, 'test-flow');
    expect(result).toBeNull();
  });

  it('returns parsed state for valid file', async () => {
    const root = makeTmp();
    const stateDir = join(root, '.ai-flow', 'test-flow', 'state');
    mkdirSync(stateDir, { recursive: true });
    const state = makeActiveState();
    writeFileSync(join(stateDir, 'active.json'), JSON.stringify(state));
    const result = await readActiveState(root, 'test-flow');
    expect(result).toMatchObject(state);
  });

  it('returns null for corrupted JSON', async () => {
    const root = makeTmp();
    const stateDir = join(root, '.ai-flow', 'test-flow', 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'active.json'), '{ not valid json ');
    const result = await readActiveState(root, 'test-flow');
    expect(result).toBeNull();
  });
});

describe('writeActiveState', () => {
  it('creates directory if not exists', async () => {
    const root = makeTmp();
    const state = makeActiveState();
    await writeActiveState(root, 'test-flow', state);
    expect(existsSync(join(root, '.ai-flow', 'test-flow', 'state', 'active.json'))).toBe(true);
  });

  it('writeActiveState + readActiveState roundtrip', async () => {
    const root = makeTmp();
    const state = makeActiveState({ requirement: 'build something cool', current_stage: 'review' });
    await writeActiveState(root, 'test-flow', state);
    const loaded = await readActiveState(root, 'test-flow');
    expect(loaded).toEqual(state);
  });
});

describe('hasActiveFlow', () => {
  it('returns null with 0 flows', async () => {
    const root = makeTmp();
    const result = await hasActiveFlow(root);
    expect(result).toBeNull();
  });

  it('returns flow info with 1 active flow', async () => {
    const root = makeTmp();
    const state = makeActiveState({ flow_name: 'my-flow' });
    mkdirSync(join(root, '.ai-flow', 'my-flow', 'state'), { recursive: true });
    writeFileSync(
      join(root, '.ai-flow', 'my-flow', 'state', 'active.json'),
      JSON.stringify(state)
    );
    const result = await hasActiveFlow(root);
    expect(result).not.toBeNull();
    expect(result!.flowName).toBe('my-flow');
    expect(result!.state.flow_id).toBe('test-abc123');
  });

  it('scans multiple flows and returns the active one', async () => {
    const root = makeTmp();
    mkdirSync(join(root, '.ai-flow', 'flow-a', 'state'), { recursive: true });
    const state = makeActiveState({ flow_name: 'flow-b' });
    mkdirSync(join(root, '.ai-flow', 'flow-b', 'state'), { recursive: true });
    writeFileSync(
      join(root, '.ai-flow', 'flow-b', 'state', 'active.json'),
      JSON.stringify(state)
    );
    const result = await hasActiveFlow(root);
    expect(result!.flowName).toBe('flow-b');
  });
});

describe('isGateActive / writeGateToken / deleteGateToken', () => {
  it('isGateActive returns false when no gate-token', async () => {
    const root = makeTmp();
    expect(await isGateActive(root, 'test-flow')).toBe(false);
  });

  it('writeGateToken + isGateActive = true', async () => {
    const root = makeTmp();
    await writeGateToken(root, 'test-flow', 'tok-abc');
    expect(await isGateActive(root, 'test-flow')).toBe(true);
  });

  it('deleteGateToken + isGateActive = false', async () => {
    const root = makeTmp();
    await writeGateToken(root, 'test-flow', 'tok-abc');
    await deleteGateToken(root, 'test-flow');
    expect(await isGateActive(root, 'test-flow')).toBe(false);
  });
});

describe('appendTransition', () => {
  it('creates file if not exists and appends a line', async () => {
    const root = makeTmp();
    mkdirSync(join(root, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    await appendTransition(root, 'test-flow', 'work → review');
    const content = readFileSync(
      join(root, '.ai-flow', 'test-flow', 'state', 'transitions.log'),
      'utf-8'
    );
    expect(content).toContain('work → review');
  });

  it('multiple calls → all lines present in order', async () => {
    const root = makeTmp();
    mkdirSync(join(root, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    await appendTransition(root, 'test-flow', 'started');
    await appendTransition(root, 'test-flow', 'work → review');
    await appendTransition(root, 'test-flow', 'completed');
    const content = readFileSync(
      join(root, '.ai-flow', 'test-flow', 'state', 'transitions.log'),
      'utf-8'
    );
    const lines = content.trim().split('\n');
    expect(lines[0]).toContain('started');
    expect(lines[1]).toContain('work → review');
    expect(lines[2]).toContain('completed');
  });
});

describe('nextStage', () => {
  it('returns next stage id', () => {
    const result = nextStage(MINIMAL_CONFIG, 'work');
    expect(result).toBe('review');
  });

  it('returns null for last stage', () => {
    const result = nextStage(MINIMAL_CONFIG, 'review');
    expect(result).toBeNull();
  });
});
