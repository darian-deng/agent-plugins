import { describe, it, expect, afterEach } from 'vitest';
import { handleStop } from '../src/lib/stop-handler.js';
import { handleUserPrompt } from '../src/lib/userprompt-handler.js';
import { handleStatus } from '../src/lib/commands/status.js';
import { advanceStage } from '../src/lib/advance-stage.js';
import { handleSessionStart } from '../src/lib/session-handler.js';
import {
  decideTick,
  resolveWatchdogConfig,
  readWatchdog,
  cronPromptFor,
  WATCHDOG_SENTINEL,
  MAX_CRON_ASKS,
  DEFAULT_NUDGE_CAP,
} from '../src/lib/watchdog.js';
import { createFlowTestRepo, writeActiveState, readActiveState, writeSignal, MINIMAL_CONFIG } from './fixtures/helpers.js';
import type { StopInput, UserPromptInput, SessionStartInput } from '../src/lib/types.js';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeRepo(config = MINIMAL_CONFIG) {
  const repo = createFlowTestRepo(config.name, config);
  cleanups.push(repo.cleanup);
  return repo;
}

const OWNER = 'owner-sess';

function seedFlow(repoRoot: string, flowName: string, extra: Record<string, unknown> = {}) {
  writeActiveState(repoRoot, flowName, {
    flow_id: `${flowName}-abc`,
    flow_name: flowName,
    requirement: 'build a thing',
    current_stage: 'work',
    base_sha: 'abc',
    last_session_id: OWNER,
    ...extra,
  });
}

function stopInput(repoRoot: string, over: Partial<StopInput> = {}): StopInput {
  return {
    hook_event_name: 'Stop',
    session_id: OWNER,
    cwd: repoRoot,
    stop_hook_active: false,
    background_tasks: [],
    session_crons: [],
    ...over,
  };
}

function promptInput(repoRoot: string, prompt: string, sessionId = OWNER): UserPromptInput {
  return { hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd: repoRoot, prompt };
}

const CFG = resolveWatchdogConfig(undefined, {} as NodeJS.ProcessEnv);

describe('decideTick', () => {
  const base = {
    now: 1_000_000,
    lastStopAt: 1_000_000 - 10 * 60_000,
    background: false,
    gatePending: false,
    nudgesThisStage: 0,
    config: CFG,
  };

  it('quiet past the threshold with nothing pending → nudge', () => {
    const d = decideTick(base);
    expect(d.nudge).toBe(true);
    if (d.nudge) expect(d.remaining).toBe(DEFAULT_NUDGE_CAP - 1);
  });

  it('gate pending → suppressed (waiting for a human is the correct stop)', () => {
    expect(decideTick({ ...base, gatePending: true }).nudge).toBe(false);
  });

  it('background work in flight → suppressed (something will wake the session)', () => {
    expect(decideTick({ ...base, background: true }).nudge).toBe(false);
  });

  it('stopped less than the idle threshold ago → suppressed', () => {
    expect(decideTick({ ...base, lastStopAt: base.now - 40_000 }).nudge).toBe(false);
  });

  it('never stopped → suppressed', () => {
    expect(decideTick({ ...base, lastStopAt: null }).nudge).toBe(false);
  });

  it('cap spent → suppressed', () => {
    expect(decideTick({ ...base, nudgesThisStage: DEFAULT_NUDGE_CAP }).nudge).toBe(false);
  });

  it('disabled → suppressed', () => {
    const off = resolveWatchdogConfig({ enabled: false }, {} as NodeJS.ProcessEnv);
    expect(decideTick({ ...base, config: off }).nudge).toBe(false);
  });

  it('AI_FLOW_WATCHDOG=0 disables regardless of flow config', () => {
    const cfg = resolveWatchdogConfig({ enabled: true }, { AI_FLOW_WATCHDOG: '0' } as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(false);
  });

  it('idle_minutes from the flow config is what the threshold uses', () => {
    const cfg = resolveWatchdogConfig({ idle_minutes: 30 }, {} as NodeJS.ProcessEnv);
    expect(decideTick({ ...base, config: cfg, lastStopAt: base.now - 10 * 60_000 }).nudge).toBe(false);
    expect(decideTick({ ...base, config: cfg, lastStopAt: base.now - 31 * 60_000 }).nudge).toBe(true);
  });
});

describe('handleStop', () => {
  it('owner session → stamps last_stop_at and asks for the cron', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    const out = await handleStop(stopInput(repo.repoRoot));
    expect(out?.additionalContext).toContain('CronCreate');
    expect(out?.additionalContext).toContain(cronPromptFor('test-flow'));
    const w = readWatchdog(readActiveState(repo.repoRoot, 'test-flow'));
    expect(w.last_stop_at).not.toBeNull();
    expect(w.cron_asks).toBe(1);
    expect(w.cron_seen).toBe(false);
  });

  it('cron already present → records it and asks nothing', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    const out = await handleStop(stopInput(repo.repoRoot, {
      session_crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: cronPromptFor('test-flow') }],
    }));
    expect(out).toBeNull();
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).cron_seen).toBe(true);
  });

  it('stop_hook_active → never asks again in the same chain', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    const out = await handleStop(stopInput(repo.repoRoot, { stop_hook_active: true }));
    expect(out).toBeNull();
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).cron_asks).toBe(0);
  });

  it('asks at most MAX_CRON_ASKS times', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    for (let i = 0; i < MAX_CRON_ASKS; i++) {
      expect(await handleStop(stopInput(repo.repoRoot))).not.toBeNull();
    }
    expect(await handleStop(stopInput(repo.repoRoot))).toBeNull();
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).cron_asks).toBe(MAX_CRON_ASKS);
  });

  it('non-owner session → touches nothing', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    const out = await handleStop(stopInput(repo.repoRoot, { session_id: 'other-sess' }));
    expect(out).toBeNull();
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).last_stop_at).toBeNull();
  });

  it('unowned flow (the shape `<flow> resume` leaves behind) → still stamps the clock', async () => {
    // resume.ts sets last_session_id: null and the session that ran the command keeps
    // driving the flow. Matching posttool-handler's lenient owner test is what keeps
    // the watchdog alive for it.
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', { last_session_id: null });
    expect(await handleStop(stopInput(repo.repoRoot))).not.toBeNull();
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).last_stop_at).not.toBeNull();
  });

  it('subagent turn end → touches nothing', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    const out = await handleStop({ ...stopInput(repo.repoRoot), agent_id: 'sub-1' });
    expect(out).toBeNull();
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).last_stop_at).toBeNull();
  });

  it('no active flow → no error, no output', async () => {
    const repo = makeRepo();
    await expect(handleStop(stopInput(repo.repoRoot))).resolves.toBeNull();
  });

  it('a background task in flight is recorded as background', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    await handleStop(stopInput(repo.repoRoot, {
      background_tasks: [{ id: 't1', type: 'subagent', status: 'running' }],
    }));
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).background).toBe(true);
  });

  it("someone else's cron counts as background; the watchdog's own does not", async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    await handleStop(stopInput(repo.repoRoot, {
      session_crons: [{ id: 'c9', prompt: 'check the build' }],
    }));
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).background).toBe(true);

    await handleStop(stopInput(repo.repoRoot, {
      session_crons: [{ id: 'c1', prompt: cronPromptFor('test-flow') }],
    }));
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).background).toBe(false);
  });
});

describe('watchdog tick through UserPromptSubmit', () => {
  const tick = (repoRoot: string, flowName = 'test-flow') =>
    handleUserPrompt(promptInput(repoRoot, cronPromptFor(flowName)));

  function stale(minutes: number): string {
    return new Date(Date.now() - minutes * 60_000).toISOString();
  }

  it('stalled → prompt passes through with the self-check, and spends one nudge', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', {
      watchdog: { last_stop_at: stale(12), background: false, cron_seen: true, cron_asks: 1, nudges_this_stage: 0, last_nudge_at: null },
    });
    const out = await tick(repo.repoRoot);
    expect(out.decision).toBeUndefined();
    const ctx = (out.hookSpecificOutput as { additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('不是开发者说的话');
    expect(ctx).toContain('work');
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).nudges_this_stage).toBe(1);
  });

  it('just stopped → blocked before the model sees it', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', {
      watchdog: { last_stop_at: new Date().toISOString(), background: false, cron_seen: true, cron_asks: 1, nudges_this_stage: 0, last_nudge_at: null },
    });
    const out = await tick(repo.repoRoot);
    expect(out.decision).toBe('block');
    expect(out.suppressOriginalPrompt).toBe(true);
    expect(out.reason).toContain(WATCHDOG_SENTINEL);
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).nudges_this_stage).toBe(0);
  });

  it('gate pending → blocked', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', {
      current_stage: 'review',
      watchdog: { last_stop_at: stale(30), background: false, cron_seen: true, cron_asks: 1, nudges_this_stage: 0, last_nudge_at: null },
    });
    writeSignal(repo.repoRoot, 'test-flow', 'done');
    const out = await tick(repo.repoRoot);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('approve');
  });

  it('cap spent → blocked, and the tick never re-arms itself', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', {
      watchdog: { last_stop_at: stale(30), background: false, cron_seen: true, cron_asks: 1, nudges_this_stage: DEFAULT_NUDGE_CAP, last_nudge_at: null },
    });
    const out = await tick(repo.repoRoot);
    expect(out.decision).toBe('block');
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).nudges_this_stage).toBe(DEFAULT_NUDGE_CAP);
  });

  it('a tick does NOT reset the nudge counter (only a developer does)', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', {
      watchdog: { last_stop_at: stale(30), background: false, cron_seen: true, cron_asks: 1, nudges_this_stage: 2, last_nudge_at: null },
    });
    await tick(repo.repoRoot);
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).nudges_this_stage).toBe(3);

    await handleUserPrompt(promptInput(repo.repoRoot, '继续'));
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).nudges_this_stage).toBe(0);
  });

  it('non-owner session → blocked, and the owner\'s counters stay put', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', {
      watchdog: { last_stop_at: stale(30), background: false, cron_seen: true, cron_asks: 1, nudges_this_stage: 1, last_nudge_at: null },
    });
    const out = await handleUserPrompt(promptInput(repo.repoRoot, cronPromptFor('test-flow'), 'other-sess'));
    expect(out.decision).toBe('block');
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).nudges_this_stage).toBe(1);
  });

  it('flow already finished → blocked with a "delete the cron" note', async () => {
    const repo = makeRepo();
    const out = await tick(repo.repoRoot);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('CronDelete');
  });

  it('a developer typing the sentinel is NOT swallowed (source=user)', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', {
      watchdog: { last_stop_at: new Date().toISOString(), background: false, cron_seen: true, cron_asks: 1, nudges_this_stage: 0, last_nudge_at: null },
    });
    const out = await handleUserPrompt({
      ...promptInput(repo.repoRoot, `${WATCHDOG_SENTINEL} 我自己打的`),
      source: 'user',
    });
    expect(out.decision).toBeUndefined();
  });

  it('without a source field the sentinel alone still identifies a tick', async () => {
    // `source` is optional in the host's schema, so recognition cannot depend on it.
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', {
      watchdog: { last_stop_at: new Date().toISOString(), background: false, cron_seen: true, cron_asks: 1, nudges_this_stage: 0, last_nudge_at: null },
    });
    const out = await handleUserPrompt(promptInput(repo.repoRoot, cronPromptFor('test-flow')));
    expect(out.decision).toBe('block');
  });

  it("a wakeup that is not this watchdog's is left alone", async () => {
    // A developer's own `/loop` also arrives as a wakeup; only the sentinel makes a
    // prompt ours.
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', {
      watchdog: { last_stop_at: new Date().toISOString(), background: false, cron_seen: true, cron_asks: 1, nudges_this_stage: 0, last_nudge_at: null },
    });
    const out = await handleUserPrompt({
      ...promptInput(repo.repoRoot, 'check the build'),
      source: 'schedule_wakeup',
    });
    expect(out.decision).toBeUndefined();
  });

  it('after `<flow> resume` leaves the owner null, the executing session still gets ticks', async () => {
    // resume.ts writes last_session_id: null on purpose and the session that typed
    // the command keeps driving. A strict owner test refused every tick for the rest
    // of that session, with a message saying it was not the executor.
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', {
      last_session_id: null,
      watchdog: { last_stop_at: stale(12), background: false, cron_seen: true, cron_asks: 1, nudges_this_stage: 0, last_nudge_at: null },
    });
    const out = await tick(repo.repoRoot);
    expect(out.decision).toBeUndefined();
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).nudges_this_stage).toBe(1);
  });
});

describe('nudge budget lifecycle', () => {
  it('advancing a stage returns the budget', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', {
      watchdog: { last_stop_at: new Date().toISOString(), background: false, cron_seen: true, cron_asks: 2, nudges_this_stage: 3, last_nudge_at: null },
    });
    await advanceStage(repo.repoRoot, 'test-flow', OWNER);
    const w = readWatchdog(readActiveState(repo.repoRoot, 'test-flow'));
    expect(w.nudges_this_stage).toBe(0);
    // Not reset by a stage advance: the cron is session-scoped and still exists.
    expect(w.cron_asks).toBe(2);
    expect(w.cron_seen).toBe(true);
  });
});

describe('session boundaries', () => {
  it('a new session starts with a blank watchdog block', async () => {
    // Session-scoped crons do not survive `/clear`, so carrying `cron_seen` across
    // would leave the engine believing a cron exists that the host already dropped
    // — and it would never ask for a replacement.
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', {
      last_session_id: null,
      watchdog: { last_stop_at: new Date().toISOString(), background: true, cron_seen: true, cron_asks: 3, nudges_this_stage: 2, last_nudge_at: new Date().toISOString() },
    });
    const input: SessionStartInput = { hook_event_name: 'SessionStart', session_id: 'fresh-sess', cwd: repo.repoRoot, source: 'clear' };
    await handleSessionStart(input);
    const w = readWatchdog(readActiveState(repo.repoRoot, 'test-flow'));
    expect(w).toEqual({ last_stop_at: null, background: false, cron_seen: false, cron_asks: 0, nudges_this_stage: 0, last_nudge_at: null });
  });

  it('a compact in the SAME session keeps the watchdog block', async () => {
    // A compact keeps the session and its scheduled tasks; wiping `cron_seen` there
    // would make `<flow> status` report an armed watchdog as unarmed.
    const repo = makeRepo();
    const armed = { last_stop_at: new Date().toISOString(), background: false, cron_seen: true, cron_asks: 1, nudges_this_stage: 1, last_nudge_at: null };
    seedFlow(repo.repoRoot, 'test-flow', { watchdog: armed });
    const input: SessionStartInput = { hook_event_name: 'SessionStart', session_id: OWNER, cwd: repo.repoRoot, source: 'compact' };
    await handleSessionStart(input);
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).cron_seen).toBe(true);
  });
});

describe('status reports whether the watchdog is armed', () => {
  it('armed', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', {
      watchdog: { last_stop_at: new Date().toISOString(), background: false, cron_seen: true, cron_asks: 1, nudges_this_stage: 1, last_nudge_at: null },
    });
    const res = await handleStatus(repo.repoRoot, 'test-flow');
    expect(res.action).toBe('allow');
    if (res.action === 'allow') expect(res.additionalContext).toContain('watchdog: 已武装');
  });

  it('gave up asking → says so, and says stalls will go unnoticed', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', {
      watchdog: { last_stop_at: null, background: false, cron_seen: false, cron_asks: MAX_CRON_ASKS, nudges_this_stage: 0, last_nudge_at: null },
    });
    const res = await handleStatus(repo.repoRoot, 'test-flow');
    if (res.action === 'allow') {
      expect(res.additionalContext).toContain('未武装');
      expect(res.additionalContext).toContain('停滞不会被发现');
    }
  });
});
