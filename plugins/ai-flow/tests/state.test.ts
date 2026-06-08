import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import {
  readActiveState,
  writeActiveState,
  hasActiveFlow,
  readSignal,
  writeSignalFile,
  isGatePending,
  appendLog,
  nextStage,
} from '../src/lib/state.js';
import type { ActiveState } from '../src/lib/state.js';
import { MINIMAL_CONFIG, GATED_CONFIG } from './fixtures/helpers.js';

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
    context_blocked: false,
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

describe('readSignal / writeSignalFile / isGatePending', () => {
  it('readSignal returns null when no signal file', () => {
    const root = makeTmp();
    expect(readSignal(root, 'test-flow')).toBeNull();
  });

  it('writeSignalFile + readSignal roundtrip', () => {
    const root = makeTmp();
    writeSignalFile(root, 'test-flow', 'review');
    expect(readSignal(root, 'test-flow')).toBe('review');
  });

  it('isGatePending: signal == nextStage + gate=true → true', () => {
    // MINIMAL_CONFIG: work has no gate, review has gate: true
    // isGatePending for review stage + signal='flow-complete' (review is terminal)
    expect(isGatePending('flow-complete', MINIMAL_CONFIG, 'review')).toBe(true);
  });

  it('isGatePending: signal null → false', () => {
    expect(isGatePending(null, MINIMAL_CONFIG, 'review')).toBe(false);
  });

  it('isGatePending: signal wrong content → false', () => {
    expect(isGatePending('wrong', MINIMAL_CONFIG, 'review')).toBe(false);
  });

  it('isGatePending: stage has no gate → false', () => {
    // work stage has no gate
    expect(isGatePending('review', MINIMAL_CONFIG, 'work')).toBe(false);
  });

  // ── New signal protocol: AI writes 'done', hook computes the rest ──
  it('isGatePending: signal=done + gate stage → true', () => {
    expect(isGatePending('done', MINIMAL_CONFIG, 'review')).toBe(true);
  });

  it('isGatePending: signal=done + non-gate stage → false', () => {
    expect(isGatePending('done', MINIMAL_CONFIG, 'work')).toBe(false);
  });

  it('isGatePending: signal=done + non-terminal gate stage → true', () => {
    // GATED_CONFIG: work has gate=true and is non-terminal
    expect(isGatePending('done', GATED_CONFIG, 'work')).toBe(true);
  });

  it('isGatePending: old stage-id signal + gate stage → true (backward compat)', () => {
    // GATED_CONFIG: work→review, signal='review' is the old protocol
    expect(isGatePending('review', GATED_CONFIG, 'work')).toBe(true);
  });
});

describe('appendLog', () => {
  it('writes to flow.log with timestamp, flowName, full sessionId, and message', async () => {
    const root = makeTmp();
    mkdirSync(join(root, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    await appendLog(root, 'test-flow', 'my-full-session-id', 'STARTED flow_id=abc stage=work');
    const content = readFileSync(
      join(root, '.ai-flow', 'test-flow', 'state', 'flow.log'),
      'utf-8'
    );
    expect(content).toMatch(/\[test-flow\] \[session=my-full-session-id\] STARTED flow_id=abc stage=work/);
  });

  it('multiple calls accumulate in order in flow.log', async () => {
    const root = makeTmp();
    mkdirSync(join(root, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    await appendLog(root, 'test-flow', 'sess-1', 'event-A');
    await appendLog(root, 'test-flow', 'sess-1', 'event-B');
    await appendLog(root, 'test-flow', 'sess-1', 'event-C');
    const lines = readFileSync(
      join(root, '.ai-flow', 'test-flow', 'state', 'flow.log'),
      'utf-8'
    ).trim().split('\n');
    expect(lines[0]).toContain('event-A');
    expect(lines[1]).toContain('event-B');
    expect(lines[2]).toContain('event-C');
  });

  it('each line starts with ISO timestamp', async () => {
    const root = makeTmp();
    mkdirSync(join(root, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    await appendLog(root, 'test-flow', 'sess-1', 'TEST_EVENT');
    const content = readFileSync(
      join(root, '.ai-flow', 'test-flow', 'state', 'flow.log'),
      'utf-8'
    );
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
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
