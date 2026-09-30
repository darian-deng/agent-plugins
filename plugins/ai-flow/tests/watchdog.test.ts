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
  emptyWatchdog,
  watcherCommand,
  isWatcherTask,
  isOwnWatcher,
  classifyInFlight,
  watcherOwnership,
  isDeveloperPrompt,
  ownerChangedText,
  ownerChangeReady,
  BASH_IDLE_MULTIPLIER,
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
import { holdPath, readHold } from '../src/lib/state.js';
import { STOP_GUARD_CONTINUE_EXIT, STOP_GUARD_LABEL } from '../src/lib/stop-handler.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import type { FlowConfig } from '../src/lib/flow-schema.js';
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
    agents_in_flight: false,
    bash_in_flight: false,
    bash_tasks: [],
    last_user_prompt_at: null,
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
    agentsInFlight: false,
    bashInFlight: false,
    holdPresent: false,
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

  it('a subagent in flight → not stalled (it will end and wake the session)', () => {
    expect(decideStall({ ...base, agentsInFlight: true }).stalled).toBe(false);
    // Even hours later: a subagent's end is certain, a shell task's is not.
    expect(decideStall({ ...base, agentsInFlight: true, lastStopAt: base.now - 5 * 60 * 60_000, lastActivityAt: base.now - 5 * 60 * 60_000 }).stalled).toBe(false);
  });

  it('a shell task in flight → the fuse is longer, not infinite', () => {
    // The task may be a `pnpm dev` that never exits. Under the old absolute exemption
    // one flow sat 212 minutes with nothing but that instance in flight.
    const shell = { ...base, bashInFlight: true };
    expect(decideStall(shell).stalled).toBe(false);                                    // 10 min < 30
    const long = { ...shell, lastStopAt: base.now - (CFG.idleMs * BASH_IDLE_MULTIPLIER + 1_000), lastActivityAt: base.now - ACTIVITY_STALE_MS - 1 };
    expect(decideStall(long).stalled).toBe(true);
    expect(decideStall({ ...long, agentsInFlight: true }).stalled).toBe(false);
  });

  it('a hold → not stalled (the model wrote down what it is waiting for)', () => {
    expect(decideStall({ ...base, holdPresent: true }).stalled).toBe(false);
    expect(decideStall({ ...base, holdPresent: true, lastStopAt: base.now - 5 * 60 * 60_000 }).stalled).toBe(false);
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
      holdPath: '/repo/.ai-flow/test-flow/state/hold',
    });
    expect(text).toContain(WATCHER_MARKER);
    expect(text).toContain('run_in_background');
  });

  it('offers exactly two actions: keep working, or write the hold file — never "say you are waiting and stop"', () => {
    // The previous wording's first option was "waiting for the developer → say so and
    // stop". It was taken verbatim on the first nudge a flow received; the developer
    // had been asking the flow not to stop.
    const text = nudgeText({
      flowName: 'test-flow', stageId: 'work', idleMs: 10 * 60_000, remaining: 2,
      wrapUpPct: null, rearmCommand: watcherCommand('/repo', 'test-flow', 'test-flow-abc', OWNER),
      holdPath: '/repo/.ai-flow/test-flow/state/hold', bashTasks: ['pnpm dev'],
    });
    expect(text).toContain('/repo/.ai-flow/test-flow/state/hold');
    expect(text).toContain('pnpm dev');
    expect(text).not.toMatch(/回一行说清在等什么，然后结束回合/);
  });

  it('an inherited watcher hands over only after the new owner\'s developer has spoken', () => {
    // /clear then /reload-plugins, no prompt yet: SessionStart blanked the watchdog.
    expect(ownerChangeReady({ watchdog: emptyWatchdog() })).toBe(false);
    expect(ownerChangeReady({ watchdog: { ...emptyWatchdog(), last_activity_at: new Date().toISOString() } })).toBe(false);
    expect(ownerChangeReady({ watchdog: { ...emptyWatchdog(), last_user_prompt_at: new Date().toISOString() } })).toBe(true);
    // A hand-back turn already made the new session arm its own: handing over now would
    // talk it into a second one.
    expect(ownerChangeReady({ watchdog: { ...emptyWatchdog(), last_user_prompt_at: new Date().toISOString(), watcher_seen: true } })).toBe(false);
    expect(ownerChangeReady(null)).toBe(false);
  });

  it('the owner-changed exit hands the NEW session its own arming command', () => {
    const text = ownerChangedText('test-flow', watcherCommand('/repo', 'test-flow', 'test-flow-abc', 'new-sess'));
    expect(text).toContain('--session "new-sess"');
    expect(text).toContain('run_in_background');
  });
});

describe('own watcher vs inherited watcher', () => {
  it('the same flow instance under a previous session id is NOT this session\'s watcher', () => {
    // `/clear` keeps the host process and its background tasks; the next session
    // inherits the old watcher, which stays silent for an owner it does not know.
    const old = watcherCommand('/repo', 'test-flow', 'test-flow-abc', 'prev-sess');
    expect(isWatcherTask(old, 'test-flow-abc')).toBe(true);
    expect(isOwnWatcher(old, 'test-flow-abc', OWNER)).toBe(false);
    expect(isOwnWatcher(watcherCommand('/repo', 'test-flow', 'test-flow-abc', OWNER), 'test-flow-abc', OWNER)).toBe(true);
  });

  it('classifyInFlight: agents wake, shell tasks may not, any watcher is neither, unknown host tasks are ignored', () => {
    const w = watcherCommand('/repo', 'test-flow', 'test-flow-abc', 'prev-sess');
    const c = classifyInFlight([
      { id: '1', type: 'shell', command: w },
      { id: '2', type: 'local_bash', command: 'sleep 900', description: 'timer' },
      { id: '3', type: 'monitor' },
      { id: '4', type: 'dream' },
    ]);
    expect(c).toEqual({ agents: false, bash: true, bashTasks: ['timer'], agentTasks: [] });
    expect(classifyInFlight([{ id: '5', type: 'local_agent' }]).agents).toBe(true);
    expect(classifyInFlight([{ id: '6', type: 'subagent' }]).agents).toBe(true);
    // Older client without `type`: a command means shell, otherwise a subagent.
    expect(classifyInFlight([{ id: '7', command: 'pnpm dev' }])).toEqual({ agents: false, bash: true, bashTasks: ['pnpm dev'], agentTasks: [] });
    expect(classifyInFlight([{ id: '8' }]).agents).toBe(true);
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

  it('another background task does count as work in flight, by kind', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    await handleStop(stopInput(repo.repoRoot, {
      background_tasks: [ourWatcher(repo.repoRoot), { id: 't2', type: 'subagent', status: 'running' }],
    }));
    let w = readWatchdog(readActiveState(repo.repoRoot, 'test-flow'));
    expect(w.background).toBe(true);
    expect(w.agents_in_flight).toBe(true);
    expect(w.bash_in_flight).toBe(false);
    await handleStop(stopInput(repo.repoRoot, {
      background_tasks: [{ id: 't3', type: 'shell', status: 'running', command: 'pnpm dev', description: 'dev server' }],
    }));
    w = readWatchdog(readActiveState(repo.repoRoot, 'test-flow'));
    expect(w.agents_in_flight).toBe(false);
    expect(w.bash_in_flight).toBe(true);
    expect(w.bash_tasks).toEqual(['dev server']);
  });

  it('a watcher inherited from the previous session is neither armed nor work in flight', async () => {
    // The 0.80.x zombie: same flow instance, old session id, still listed after /clear.
    // Counted as armed it silenced the whole flow for six days; counted as work in
    // flight it would silence the watchdog that replaces it.
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    const inherited = { id: 'bg0', type: 'shell', status: 'running',
      command: watcherCommand(repo.repoRoot, 'test-flow', 'test-flow-abc', 'prev-sess') };
    const out = await handleStop(stopInput(repo.repoRoot, { background_tasks: [inherited] }));
    expect(out?.additionalContext).toContain(WATCHER_MARKER);
    const w = readWatchdog(readActiveState(repo.repoRoot, 'test-flow'));
    expect(w.watcher_seen).toBe(false);
    expect(w.background).toBe(false);
    expect(w.bash_in_flight).toBe(false);
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
  it('is turned into an order to delete the task, so it stops for good', async () => {
    // A cron scheduled under 0.76.0 outlives the upgrade and `--resume` restores it.
    // 0.77.0 removed the interception with the design, so it arrived as an ordinary
    // prompt and the model answered it in full — observed once, on a resume.
    //
    // 0.78.0 blocked it instead, which costs no tokens but never ENDS it: the task keeps
    // firing every five minutes, and `CronDelete` is a tool the MODEL has — a blocked
    // prompt's text goes to the developer, who cannot run it. So the tick is let through
    // carrying the order to delete the task: one turn, then it is gone.
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', { watchdog: armedWatchdog() });
    const out = await handleUserPrompt({
      hook_event_name: 'UserPromptSubmit', session_id: OWNER, cwd: repo.repoRoot,
      prompt: '[ai-flow:watchdog] test-flow 停滞自检',
    });
    expect(out.decision).toBeUndefined();
    const ctx = (out.hookSpecificOutput as { additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('CronList');
    expect(ctx).toContain('CronDelete');
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
    expect(w).toEqual(emptyWatchdog());
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

describe('the watcher knows whose flow it is looking at', () => {
  const st = (over: Partial<{ flow_id: string; last_session_id: string | null }> = {}) =>
    ({ flow_id: 'test-flow-abc', last_session_id: OWNER, ...over });
  it('same flow, same owner → ours', () => {
    expect(watcherOwnership(st(), 'test-flow-abc', OWNER)).toBe('ours');
  });
  it('no owner (the shape `<flow> resume` leaves) → still ours', () => {
    expect(watcherOwnership(st({ last_session_id: null }), 'test-flow-abc', OWNER)).toBe('ours');
  });
  it('same flow, another owner → owner-changed (exit and hand over)', () => {
    // The 0.80.x zombie was this verdict handled as `continue`: silent forever, and
    // counted as armed by every session that inherited it.
    expect(watcherOwnership(st({ last_session_id: 'new-sess' }), 'test-flow-abc', OWNER)).toBe('owner-changed');
  });
  it('another flow instance, or no flow → foreign-flow (silent, no exit)', () => {
    expect(watcherOwnership(st({ flow_id: 'test-flow-xyz' }), 'test-flow-abc', OWNER)).toBe('foreign-flow');
    expect(watcherOwnership(null, 'test-flow-abc', OWNER)).toBe('foreign-flow');
  });
});

describe('state/hold', () => {
  function promptInput(repoRoot: string, over: Partial<UserPromptInput> = {}): UserPromptInput {
    return { hook_event_name: 'UserPromptSubmit', session_id: OWNER, cwd: repoRoot, prompt: '继续', ...over };
  }
  function writeHold(repoRoot: string, text = '等开发者在已登录浏览器里点深链；只有他有会话；点完继续 T58') {
    const p = holdPath(repoRoot, 'test-flow');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    return p;
  }

  it('a developer prompt clears it and logs what was held', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    writeHold(repo.repoRoot);
    await handleUserPrompt(promptInput(repo.repoRoot, { source: 'user' }));
    expect(readHold(repo.repoRoot, 'test-flow')).toBeNull();
    const log = readFileSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'flow.log'), 'utf-8');
    expect(log).toContain('HOLD_CLEARED 等开发者在已登录浏览器里点深链');
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).last_user_prompt_at).not.toBeNull();
  });

  it('a subagent hand-back or peer message (no `source` on 2.1.283) does not clear it, stamp the developer, or return the budget', async () => {
    // Measured live: a hand-back stamped last_user_prompt_at 14 s after arriving. The
    // host documents `source: "system"` for these but does not send the field.
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', { watchdog: armedWatchdog({ nudges_this_stage: 2 }) });
    writeHold(repo.repoRoot);
    for (const prompt of [
      'Another Claude session sent a message:\n<agent-message from="a2b4491b6e2ddbc0b">\n[Subagent hand-back] …',
      '<task-notification>\n<task-id>a2b4</task-id>\n<status>completed</status>\n</task-notification>',
      '[Subagent hand-back] The text below is the final report…',
      'Another Claude session sent a message while you were working:\n<agent-message from="x">hi</agent-message>',
    ]) {
      await handleUserPrompt(promptInput(repo.repoRoot, { prompt }));
      expect(readHold(repo.repoRoot, 'test-flow'), prompt.slice(0, 30)).not.toBeNull();
      const w = readWatchdog(readActiveState(repo.repoRoot, 'test-flow'));
      expect(w.last_user_prompt_at, prompt.slice(0, 30)).toBeNull();
      expect(w.nudges_this_stage, prompt.slice(0, 30)).toBe(2);
      expect(w.last_activity_at).not.toBeNull();   // it IS a turn starting, so activity is stamped
    }
    // …and the developer's own words, with or without `source`, do all three.
    await handleUserPrompt(promptInput(repo.repoRoot, { prompt: '继续' }));
    expect(readHold(repo.repoRoot, 'test-flow')).toBeNull();
    const w = readWatchdog(readActiveState(repo.repoRoot, 'test-flow'));
    expect(w.last_user_prompt_at).not.toBeNull();
    expect(w.nudges_this_stage).toBe(0);
  });

  it('isDeveloperPrompt: `source` wins when present, the envelope decides otherwise', () => {
    expect(isDeveloperPrompt('anything', 'user')).toBe(true);
    expect(isDeveloperPrompt('继续', 'system')).toBe(false);
    expect(isDeveloperPrompt('继续', 'schedule_wakeup')).toBe(false);
    expect(isDeveloperPrompt('继续')).toBe(true);
    expect(isDeveloperPrompt('  Another Claude session sent a message: x')).toBe(false);
    expect(isDeveloperPrompt('<task-notification>')).toBe(false);
    expect(isDeveloperPrompt('[ai-flow:watchdog] 引擎的停滞自检把你叫醒了')).toBe(false);
    // Mentioning the envelope mid-sentence is still the developer.
    expect(isDeveloperPrompt('为什么 Another Claude session sent a message 这种通知这么多')).toBe(true);
  });

  it('a wakeup nobody typed does not clear it', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    writeHold(repo.repoRoot);
    await handleUserPrompt(promptInput(repo.repoRoot, { source: 'schedule_wakeup' }));
    expect(readHold(repo.repoRoot, 'test-flow')).not.toBeNull();
    expect(readWatchdog(readActiveState(repo.repoRoot, 'test-flow')).last_user_prompt_at).toBeNull();
  });

  it('a subagent may not write it', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    const res = await handlePreTool({
      hook_event_name: 'PreToolUse', session_id: OWNER, cwd: repo.repoRoot, agent_id: 'sub-1',
      tool_name: 'Write', tool_input: { file_path: holdPath(repo.repoRoot, 'test-flow'), content: 'waiting' },
    });
    expect(res?.permissionDecision).toBe('deny');
    const main = await handlePreTool({
      hook_event_name: 'PreToolUse', session_id: OWNER, cwd: repo.repoRoot,
      tool_name: 'Write', tool_input: { file_path: holdPath(repo.repoRoot, 'test-flow'), content: 'waiting' },
    });
    expect(main?.permissionDecision ?? 'allow').toBe('allow');
  });

  it('cannot be written through Bash by anyone — Bash cannot tell a subagent from the main session', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    for (const agent of [undefined, 'sub-1']) {
      for (const cmd of [
        `echo waiting > ${holdPath(repo.repoRoot, 'test-flow')}`,
        'printf x > .ai-flow/test-flow/state/hold',
      ]) {
        const res = await handlePreTool({
          hook_event_name: 'PreToolUse', session_id: OWNER, cwd: repo.repoRoot,
          ...(agent && { agent_id: agent }), tool_name: 'Bash', tool_input: { command: cmd },
        });
        expect(res?.permissionDecision, `${agent ?? 'main'}: ${cmd}`).toBe('deny');
        expect(res?.permissionDecisionReason).toContain('hold');
      }
    }
  });

  it('stays writable during context wrap-up, when everything but the flow docs is refused', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', { context_wrap_up: { at_pct: 61 } });
    // MINIMAL_CONFIG's `work` stage has no docs_paths → wrap-up refuses nothing there.
    // Use the `review` stage, which does, so the refusal is live and the carve-out is what passes.
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow', requirement: 'x', current_stage: 'review', base_sha: 'abc',
      last_session_id: OWNER, context_wrap_up: { at_pct: 61 },
    });
    const denied = await handlePreTool({
      hook_event_name: 'PreToolUse', session_id: OWNER, cwd: repo.repoRoot,
      tool_name: 'Write', tool_input: { file_path: join(repo.repoRoot, 'src', 'x.ts'), content: 'x' },
    });
    expect(denied?.permissionDecision).toBe('deny');
    const hold = await handlePreTool({
      hook_event_name: 'PreToolUse', session_id: OWNER, cwd: repo.repoRoot,
      tool_name: 'Write', tool_input: { file_path: holdPath(repo.repoRoot, 'test-flow'), content: 'waiting on developer' },
    });
    expect(hold?.permissionDecision ?? 'allow').toBe('allow');
  });

  it('writing it is acknowledged and logged', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    const p = writeHold(repo.repoRoot);
    const out = await handlePostTool({
      hook_event_name: 'PostToolUse', session_id: OWNER, cwd: repo.repoRoot,
      tool_name: 'Write', tool_input: { file_path: p }, tool_response: {},
    });
    expect(out?.additionalContext).toContain('state/hold 已登记');
    const log = readFileSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'flow.log'), 'utf-8');
    expect(log).toContain('HOLD_SET stage=work 等开发者');
  });

  it('advancing a stage clears it', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow');
    writeHold(repo.repoRoot);
    await advanceStage(repo.repoRoot, 'test-flow', OWNER);
    expect(readHold(repo.repoRoot, 'test-flow')).toBeNull();
  });
});

describe('stage stop guard', () => {
  const GUARDED: FlowConfig = {
    schema_version: '1.0',
    name: 'guarded-flow',
    stages: [
      { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted', completion: {}, stop_guard: 'node scripts/guard.cjs' },
      { id: 'review', prompt: 'stages/review.md', write_scope: 'unrestricted', completion: { gate: true } },
    ],
  };
  // The script echoes the facts the engine passed, so the tests can assert on them.
  const GUARD_SCRIPT = `
const f = JSON.parse(process.env.AI_FLOW_STOP_FACTS || '{}');
if (process.env.GUARD_MODE === 'crash') { process.stderr.write('boom'); process.exit(1); }
if (process.env.GUARD_MODE === 'pass') process.exit(0);
process.stdout.write('${STOP_GUARD_LABEL} 够格未开 2 张 stage=' + f.stage + ' bash=' + f.bash_in_flight + ' agents=' + f.agents_in_flight + ':' + (f.agent_tasks || []).join('|') + ' hold=' + f.hold_path);
process.exit(${STOP_GUARD_CONTINUE_EXIT});
`;
  function guardedRepo() {
    const repo = makeRepo(GUARDED);
    writeFileSync(join(repo.flowDir, 'scripts', 'guard.cjs'), GUARD_SCRIPT);
    writeActiveState(repo.repoRoot, 'guarded-flow', {
      flow_id: 'guarded-flow-abc', flow_name: 'guarded-flow', requirement: 'x', current_stage: 'work', base_sha: 'abc',
      last_session_id: OWNER,
      // A previous turn ended long ago and no developer prompt since: the turn that is
      // ending now was started by something else (a task notification, a continuation).
      watchdog: armedWatchdog({ last_stop_at: new Date(Date.now() - 60_000).toISOString(), last_user_prompt_at: null }),
    });
    return repo;
  }
  const input = (repoRoot: string, over: Partial<StopInput> = {}) =>
    stopInput(repoRoot, { background_tasks: [ourWatcher(repoRoot, 'guarded-flow')], ...over });

  it('a turn nobody started, nothing in flight, no hold → the guard runs and its verdict continues the turn', async () => {
    const repo = guardedRepo();
    const out = await handleStop(input(repo.repoRoot));
    expect(out?.additionalContext).toContain(`${STOP_GUARD_LABEL} 够格未开 2 张 stage=work bash=false`);
    expect(out?.additionalContext).toContain(holdPath(repo.repoRoot, 'guarded-flow'));
    const log = readFileSync(join(repo.repoRoot, '.ai-flow', 'guarded-flow', 'state', 'flow.log'), 'utf-8');
    expect(log).toContain('STOP_GUARD_CONTINUE stage=work');
  });

  it('a shell task in flight does not exempt — the guard is told and decides', async () => {
    const repo = guardedRepo();
    const out = await handleStop(input(repo.repoRoot, {
      background_tasks: [ourWatcher(repo.repoRoot, 'guarded-flow'), { id: 'd', type: 'shell', command: 'pnpm dev' }],
    }));
    expect(out?.additionalContext).toContain('bash=true');
  });

  it('a subagent in flight does not exempt — the guard gets the agents\' descriptions and decides (idle slots)', async () => {
    const repo = guardedRepo();
    const out = await handleStop(input(repo.repoRoot, {
      background_tasks: [ourWatcher(repo.repoRoot, 'guarded-flow'), { id: 'a', type: 'subagent', description: 'T7·实施' }],
    }));
    expect(out?.additionalContext).toContain('agents=true:T7·实施');
  });

  it('a hold → no guard', async () => {
    const repo = guardedRepo();
    const p = holdPath(repo.repoRoot, 'guarded-flow');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, 'waiting on the developer to click the deep link');
    expect(await handleStop(input(repo.repoRoot))).toBeNull();
  });

  it('the turn the developer started → no guard (the watchdog\'s idle rule covers them)', async () => {
    const repo = guardedRepo();
    await handleUserPrompt({ hook_event_name: 'UserPromptSubmit', session_id: OWNER, cwd: repo.repoRoot, prompt: '进度到哪了', source: 'user' });
    expect(await handleStop(input(repo.repoRoot))).toBeNull();
    // …but the NEXT turn, if nothing started it, is guarded again.
    const out = await handleStop(input(repo.repoRoot));
    expect(out?.additionalContext).toContain(STOP_GUARD_LABEL);
  });

  it('stop_hook_active → no guard (never chains)', async () => {
    const repo = guardedRepo();
    expect(await handleStop(input(repo.repoRoot, { stop_hook_active: true }))).toBeNull();
  });

  it('a gate pending → no guard', async () => {
    const repo = guardedRepo();
    writeActiveState(repo.repoRoot, 'guarded-flow', {
      flow_id: 'guarded-flow-abc', flow_name: 'guarded-flow', requirement: 'x', current_stage: 'review', base_sha: 'abc',
      last_session_id: OWNER, watchdog: armedWatchdog({ last_stop_at: new Date(Date.now() - 60_000).toISOString() }),
    });
    writeSignal(repo.repoRoot, 'guarded-flow', 'done');
    expect(await handleStop(input(repo.repoRoot))).toBeNull();
  });

  it('the guard letting the stop stand (exit 0) → silence', async () => {
    const repo = guardedRepo();
    process.env['GUARD_MODE'] = 'pass';
    try { expect(await handleStop(input(repo.repoRoot))).toBeNull(); } finally { delete process.env['GUARD_MODE']; }
  });

  it('a broken guard is logged, never turned into a turn', async () => {
    const repo = guardedRepo();
    process.env['GUARD_MODE'] = 'crash';
    try { expect(await handleStop(input(repo.repoRoot))).toBeNull(); } finally { delete process.env['GUARD_MODE']; }
    const log = readFileSync(join(repo.repoRoot, '.ai-flow', 'guarded-flow', 'state', 'flow.log'), 'utf-8');
    expect(log).toContain('ERROR stop_guard');
  });

  it('a stage without stop_guard → nothing changes', async () => {
    const repo = makeRepo();
    seedFlow(repo.repoRoot, 'test-flow', { watchdog: armedWatchdog({ last_stop_at: new Date(Date.now() - 60_000).toISOString() }) });
    expect(await handleStop(stopInput(repo.repoRoot, { background_tasks: [ourWatcher(repo.repoRoot)] }))).toBeNull();
  });
});
