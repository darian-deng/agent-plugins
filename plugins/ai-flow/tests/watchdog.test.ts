import { describe, it, expect, afterEach } from 'vitest';
import { handleStop } from '../src/lib/stop-handler.js';
import { handleUserPrompt } from '../src/lib/userprompt-handler.js';
import { handlePostTool } from '../src/lib/posttool-handler.js';
import { handlePreTool } from '../src/lib/pretool-handler.js';
import { handleStatus } from '../src/lib/commands/status.js';
import { advanceStage } from '../src/lib/advance-stage.js';
import { handleSessionStart } from '../src/lib/session-handler.js';
import {
  decideStall,
  resolveWatchdogConfig,
  readWatchdog,
  watcherCommand,
  isWatcherTask,
  WATCHER_MARKER,
  MAX_ARM_ASKS,
  DEFAULT_NUDGE_CAP,
  ACTIVITY_STAMP_THROTTLE_MS,
  ACTIVITY_STALE_MS,
  NUDGE_DEDUPE_MS,
  withinDedupeWindow,
  isLegacyCronTick,
  nudgeText,
} from '../src/lib/watchdog.js';
import { createFlowTestRepo, writeActiveState, readActiveState, writeSignal, MINIMAL_CONFIG } from './fixtures/helpers.js';
import type { StopInput, UserPromptInput, PostToolInput, SessionStartInput } from '../src/lib/types.js';

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

function ourWatcher(repoRoot: string, flowName = 'test-flow') {
  return { id: 'bg1', type: 'shell', status: 'running', command: watcherCommand(repoRoot, flowName, `${flowName}-abc`, OWNER) };
}

function armedWatchdog(over: Record<string, unknown> = {}) {
  return {
    last_stop_at: new Date().toISOString(),
    last_activity_at: null,
    background: false,
    watcher_seen: true,
    arm_asks: 1,
    nudges_this_stage: 0,
    last_nudge_at: null,
    ...over,
  };
}

const CFG = resolveWatchdogConfig(undefined, {} as NodeJS.ProcessEnv);

describe('decideStall', () => {
  const base = {
    now: 1_000_000,
    lastStopAt: 1_000_000 - 10 * 60_000,
    lastActivityAt: 1_000_000 - 12 * 60_000,
    background: false,
    gatePending: false,
    nudgesThisStage: 0,
    config: CFG,
  };

  it('quiet past the threshold with nothing pending → stalled', () => {
    const v = decideStall(base);
    expect(v.stalled).toBe(true);
    if (v.stalled) expect(v.remaining).toBe(DEFAULT_NUDGE_CAP - 1);
  });

  it('a turn is running (activity newer than the last stop) → not stalled', () => {
    // The case `last_stop_at` alone cannot see: a turn started by a background task
    // finishing carries no prompt, so the last recorded stop is the previous turn's.
    expect(decideStall({ ...base, lastActivityAt: base.now - 30_000 }).stalled).toBe(false);
  });

  it('an activity stamp older than the staleness bound no longer means "a turn is running"', () => {
    // ESC and an API-killed turn both end without a Stop, leaving activity permanently
    // ahead of the last stop. Unbounded, the watchdog would go quiet for the rest of
    // the session — in exactly the unattended case it exists for.
    const stale = { ...base, lastActivityAt: base.now - ACTIVITY_STALE_MS - 1, lastStopAt: base.now - 20 * 60_000 };
    expect(decideStall(stale).stalled).toBe(true);
    expect(decideStall({ ...stale, lastActivityAt: base.now - ACTIVITY_STALE_MS + 60_000 }).stalled).toBe(false);
  });

  it('gate pending → not stalled (waiting for a human is the correct stop)', () => {
    expect(decideStall({ ...base, gatePending: true }).stalled).toBe(false);
  });

  it('background work in flight → not stalled (something will wake the session)', () => {
    expect(decideStall({ ...base, background: true }).stalled).toBe(false);
  });

  it('stopped less than the idle threshold ago → not stalled', () => {
    expect(decideStall({ ...base, lastStopAt: base.now - 40_000 }).stalled).toBe(false);
  });

  it('never stopped → not stalled', () => {
    expect(decideStall({ ...base, lastStopAt: null }).stalled).toBe(false);
  });

  it('cap spent → not stalled', () => {
    expect(decideStall({ ...base, nudgesThisStage: DEFAULT_NUDGE_CAP }).stalled).toBe(false);
  });

  it('disabled → not stalled', () => {
    const off = resolveWatchdogConfig({ enabled: false }, {} as NodeJS.ProcessEnv);
    expect(decideStall({ ...base, config: off }).stalled).toBe(false);
  });

  it('AI_FLOW_WATCHDOG=0 disables regardless of flow config', () => {
    expect(resolveWatchdogConfig({ enabled: true }, { AI_FLOW_WATCHDOG: '0' } as NodeJS.ProcessEnv).enabled).toBe(false);
  });

  it('idle_minutes from the flow config is what the threshold uses', () => {
    const cfg = resolveWatchdogConfig({ idle_minutes: 30 }, {} as NodeJS.ProcessEnv);
    const quiet = { ...base, config: cfg, lastActivityAt: base.now - 40 * 60_000 };
    expect(decideStall({ ...quiet, lastStopAt: base.now - 10 * 60_000 }).stalled).toBe(false);
    expect(decideStall({ ...quiet, lastStopAt: base.now - 31 * 60_000 }).stalled).toBe(true);
  });
});

describe('two watchers do not double-nudge', () => {
  it('a nudge inside the dedupe window is someone else\'s', () => {
    // A watcher left over from an earlier arming can outlive the turn that started
    // it, and Stop only asks for a new one when it sees none — so the pair is real.
    const now = 1_000_000;
    expect(withinDedupeWindow(new Date(now - 1_000).toISOString(), now)).toBe(true);
    expect(withinDedupeWindow(new Date(now - NUDGE_DEDUPE_MS - 1).toISOString(), now)).toBe(false);
    expect(withinDedupeWindow(null, now)).toBe(false);
    expect(withinDedupeWindow('not a date', now)).toBe(false);
  });
});

describe('the watcher command carries its own identity', () => {
  it('the marker is in the command line, which is what Stop matches on', () => {
    const cmd = watcherCommand('/repo', 'test-flow', 'test-flow-abc', OWNER);
    expect(cmd).toContain(WATCHER_MARKER);
    expect(isWatcherTask(cmd)).toBe(true);
    expect(isWatcherTask('npm run build')).toBe(false);
    expect(isWatcherTask(undefined)).toBe(false);
  });

  it('a watcher for a different flow instance is not this flow\'s', () => {
    // A watcher whose flow ended keeps looping rather than exiting, so it is still
    // listed when the next flow starts in the same session.
    const old = watcherCommand('/repo', 'test-flow', 'test-flow-OLD', OWNER);
    expect(isWatcherTask(old, 'test-flow-abc')).toBe(false);
    expect(isWatcherTask(old, 'test-flow-OLD')).toBe(true);
  });
});

describe('the watcher may only run in the background', () => {
  const bash = (repoRoot: string, command: string, bg?: boolean) => handlePreTool({
    hook_event_name: 'PreToolUse', session_id: OWNER, cwd: repoRoot,
    tool_name: 'Bash', tool_input: { command, ...(bg !== undefined && { run_in_background: bg }) },
  });

  it('foreground → refused, because it would hang the session for hours', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    const res = await bash(repo.repoRoot, watcherCommand(repo.repoRoot, 'test-flow', 'test-flow-abc', OWNER));
    expect(res?.permissionDecision).toBe('deny');
    expect(res?.permissionDecisionReason).toContain('run_in_background');
  });

  it('inspecting or killing the watcher is not the same command shape', async () => {
    // `ps aux | grep <marker>` and `pkill -f <marker>` both carry the marker. Refusing
    // them with "add run_in_background" is wrong, and removes the only way to stop a
    // runaway watcher.
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    for (const cmd of [`ps aux | grep ${WATCHER_MARKER}`, `pkill -f ${WATCHER_MARKER}`]) {
      const res = await bash(repo.repoRoot, cmd);
      expect(res?.permissionDecision ?? 'allow').toBe('allow');
    }
  });

  it('backgrounded → allowed', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    const res = await bash(repo.repoRoot, watcherCommand(repo.repoRoot, 'test-flow', 'test-flow-abc', OWNER), true);
    expect(res?.permissionDecision ?? 'allow').toBe('allow');
  });
});

describe('the nudge carries its own replacement', () => {
  it('tells the woken model to re-arm in the same turn', () => {
    // The watcher wakes the session by EXITING, so after a nudge there is none
    // running. Re-arming here is free; leaving it to Stop to notice costs a whole
    // extra turn every time.
    const text = nudgeText({
      flowName: 'test-flow', stageId: 'work', idleMs: 10 * 60_000, remaining: 2,
      wrapUpPct: null, rearmCommand: watcherCommand('/repo', 'test-flow', 'test-flow-abc', OWNER),
    });
    expect(text).toContain(WATCHER_MARKER);
    expect(text).toContain('run_in_background');
  });
});

describe('handleStop', () => {
  it('owner session with no watcher → stamps the clock and asks for one', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    const out = await handleStop(stopInput(repo.repoRoot));
    expect(out?.additionalContext).toContain('run_in_background');
    expect(out?.additionalContext).toContain(WATCHER_MARKER);
    const w = readWatchdog(readActiveState(repo.repoRoot, 'test-flow'));
    expect(w.last_stop_at).not.toBeNull();
    expect(w.arm_asks).toBe(1);
    expect(w.watcher_seen).toBe(false);
  });

  it('watcher already running → records it and asks nothing', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    const out = await handleStop(stopInput(repo.repoRoot, { background_tasks: [ourWatcher(repo.repoRoot)] }));
    expect(out).toBeNull();
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).watcher_seen).toBe(true);
  });

  it('the watcher does not count as work in flight', async () => {
    // If it did, its own presence would suppress every nudge it exists to deliver.
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    await handleStop(stopInput(repo.repoRoot, { background_tasks: [ourWatcher(repo.repoRoot)] }));
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).background).toBe(false);
  });

  it('another background task does count as work in flight', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    await handleStop(stopInput(repo.repoRoot, {
      background_tasks: [ourWatcher(repo.repoRoot), { id: 't2', type: 'subagent', status: 'running' }],
    }));
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).background).toBe(true);
  });

  it('a scheduled wakeup counts as work in flight', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    await handleStop(stopInput(repo.repoRoot, { session_crons: [{ id: 'c1', prompt: 'check the build' }] }));
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).background).toBe(true);
  });

  it('stop_hook_active → never asks again in the same chain', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    const out = await handleStop(stopInput(repo.repoRoot, { stop_hook_active: true }));
    expect(out).toBeNull();
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).arm_asks).toBe(0);
  });

  it('asks at most MAX_ARM_ASKS times', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    for (let i = 0; i < MAX_ARM_ASKS; i++) {
      expect(await handleStop(stopInput(repo.repoRoot))).not.toBeNull();
    }
    expect(await handleStop(stopInput(repo.repoRoot))).toBeNull();
  });

  it('seeing a watcher resets the give-up counter', async () => {
    // Every delivered nudge kills the watcher, so asks over a long flow are routine
    // re-arms. Left accumulating, three successful arms would exhaust the budget and
    // status would report "asked three times, never started".
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', { watchdog: armedWatchdog({ watcher_seen: false, arm_asks: 2 }) });
    await handleStop(stopInput(repo.repoRoot, { background_tasks: [ourWatcher(repo.repoRoot)] }));
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).arm_asks).toBe(0);
  });

  it('a watcher left over from a previous flow does not count as armed', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    const zombie = { id: 'bg0', type: 'shell', status: 'running',
      command: watcherCommand(repo.repoRoot, 'test-flow', 'test-flow-OLD', OWNER) };
    const out = await handleStop(stopInput(repo.repoRoot, { background_tasks: [zombie] }));
    expect(out).not.toBeNull();
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).watcher_seen).toBe(false);
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
    // driving the flow, so the strict owner test would kill the watchdog for it.
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
});

describe('activity stamping', () => {
  it('a developer prompt stamps activity and returns the nudge budget', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', { watchdog: armedWatchdog({ nudges_this_stage: 2 }) });
    const input: UserPromptInput = { hook_event_name: 'UserPromptSubmit', session_id: OWNER, cwd: repo.repoRoot, prompt: '继续' };
    await handleUserPrompt(input);
    const w = readWatchdog(readActiveState(repo.repoRoot, 'test-flow'));
    expect(w.nudges_this_stage).toBe(0);
    expect(w.last_activity_at).not.toBeNull();
  });

  it('a tool call stamps activity, so the watcher can see a turn in progress', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', { watchdog: armedWatchdog() });
    const input: PostToolInput = {
      hook_event_name: 'PostToolUse', session_id: OWNER, cwd: repo.repoRoot,
      tool_name: 'Read', tool_input: {}, tool_response: {},
    };
    await handlePostTool(input);
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).last_activity_at).not.toBeNull();
  });

  it('a fresh stamp is not rewritten on every tool call', async () => {
    const repo = makeRepo();
    const stamped = new Date(Date.now() - ACTIVITY_STAMP_THROTTLE_MS / 2).toISOString();
    seedFlow(repo.repoRoot, 'test-flow', { watchdog: armedWatchdog({ last_activity_at: stamped }) });
    const input: PostToolInput = {
      hook_event_name: 'PostToolUse', session_id: OWNER, cwd: repo.repoRoot,
      tool_name: 'Read', tool_input: {}, tool_response: {},
    };
    await handlePostTool(input);
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).last_activity_at).toBe(stamped);
  });

  it("a subagent's tool call DOES stamp activity — it proves the parent turn is running", async () => {
    // Deliberately unlike the context accounting, which skips subagents because their
    // token usage is per-window. A 20-minute subagent is the longest gap between two
    // stamps there is; skipping it would make the dispatching turn look idle.
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', { watchdog: armedWatchdog() });
    const input: PostToolInput = {
      hook_event_name: 'PostToolUse', session_id: OWNER, cwd: repo.repoRoot, agent_id: 'sub-1',
      tool_name: 'Read', tool_input: {}, tool_response: {},
    };
    await handlePostTool(input);
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).last_activity_at).not.toBeNull();
  });

  it('a non-owner session does not stamp the owner\'s activity', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', { watchdog: armedWatchdog({ nudges_this_stage: 2 }) });
    const input: UserPromptInput = { hook_event_name: 'UserPromptSubmit', session_id: 'other-sess', cwd: repo.repoRoot, prompt: 'hi' };
    await handleUserPrompt(input);
    const w = readWatchdog(readActiveState(repo.repoRoot, 'test-flow'));
    expect(w.last_activity_at).toBeNull();
    expect(w.nudges_this_stage).toBe(2);
  });
});

describe('nudge budget lifecycle', () => {
  it('advancing a stage returns the budget but keeps the arming state', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', { watchdog: armedWatchdog({ arm_asks: 2, nudges_this_stage: 3 }) });
    await advanceStage(repo.repoRoot, 'test-flow', OWNER);
    const w = readWatchdog(readActiveState(repo.repoRoot, 'test-flow'));
    expect(w.nudges_this_stage).toBe(0);
    expect(w.arm_asks).toBe(2);
    expect(w.watcher_seen).toBe(true);
  });
});

describe('a leftover 0.76.0 scheduled task', () => {
  it('is stopped before it reaches the model, with the command to remove it', async () => {
    // A cron scheduled under 0.76.0 outlives the upgrade and `--resume` restores it.
    // 0.77.0 removed the interception with the design, so it arrived as an ordinary
    // prompt and the model answered it in full — observed once, on a resume.
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', { watchdog: armedWatchdog() });
    const out = await handleUserPrompt({
      hook_event_name: 'UserPromptSubmit', session_id: OWNER, cwd: repo.repoRoot,
      prompt: '[ai-flow:watchdog] test-flow 停滞自检',
    });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('CronDelete');
  });

  it('the same words typed by a developer are not stopped', () => {
    expect(isLegacyCronTick('[ai-flow:watchdog] test-flow 停滞自检', 'user')).toBe(false);
    expect(isLegacyCronTick('[ai-flow:watchdog] test-flow 停滞自检', 'schedule_wakeup')).toBe(true);
    expect(isLegacyCronTick('讲讲 watchdog 怎么做的', undefined)).toBe(false);
  });
});

describe('session boundaries', () => {
  it('a new session starts with a blank watchdog block', async () => {
    // Background tasks do not survive into a fresh conversation, so carrying
    // `watcher_seen` across would leave the engine believing a watcher is running
    // that the host already reaped — and it would never ask for a replacement.
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', {
      last_session_id: null,
      watchdog: armedWatchdog({ arm_asks: 3, nudges_this_stage: 2, background: true }),
    });
    const input: SessionStartInput = { hook_event_name: 'SessionStart', session_id: 'fresh-sess', cwd: repo.repoRoot, source: 'clear' };
    await handleSessionStart(input);
    const w = readWatchdog(readActiveState(repo.repoRoot, 'test-flow'));
    expect(w).toEqual({
      last_stop_at: null, last_activity_at: null, background: false,
      watcher_seen: false, arm_asks: 0, nudges_this_stage: 0, last_nudge_at: null,
    });
  });

  it('a resume starts blank too — its timestamps describe a session that was put down', async () => {
    // Background tasks are not restored on resume, so a `last_stop_at` from hours ago
    // would have the first watcher started afterwards nudging within one poll.
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', {
      watchdog: armedWatchdog({ last_stop_at: new Date(Date.now() - 6 * 3600_000).toISOString() }),
    });
    const input: SessionStartInput = { hook_event_name: 'SessionStart', session_id: OWNER, cwd: repo.repoRoot, source: 'resume' };
    await handleSessionStart(input);
    const w = readWatchdog(readActiveState(repo.repoRoot, 'test-flow'));
    expect(w.last_stop_at).toBeNull();
    expect(w.watcher_seen).toBe(false);
  });

  it('a compact in the SAME session keeps the watchdog block', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', { watchdog: armedWatchdog() });
    const input: SessionStartInput = { hook_event_name: 'SessionStart', session_id: OWNER, cwd: repo.repoRoot, source: 'compact' };
    await handleSessionStart(input);
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).watcher_seen).toBe(true);
  });
});

describe('status reports whether the watchdog is armed', () => {
  it('armed', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', { watchdog: armedWatchdog({ nudges_this_stage: 1 }) });
    const res = await handleStatus(repo.repoRoot, 'test-flow');
    if (res.action === 'allow') expect(res.additionalContext).toContain('watchdog: 已武装');
  });

  it('gave up asking → says so, and says stalls will go unnoticed', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', {
      watchdog: armedWatchdog({ watcher_seen: false, arm_asks: MAX_ARM_ASKS }),
    });
    const res = await handleStatus(repo.repoRoot, 'test-flow');
    if (res.action === 'allow') {
      expect(res.additionalContext).toContain('未武装');
      expect(res.additionalContext).toContain('停滞不会被发现');
    }
  });
});
