import { join } from 'path';
import { PLUGIN_ROOT } from './flow-paths.js';
import type { BackgroundTaskEntry } from './types.js';

/**
 * Stall watchdog: the engine's answer to a session that stopped when it should
 * have kept going — most often after a side conversation the model settled and
 * then never came back from.
 *
 * ── Why a background process and not a timer ───────────────────────────────────
 * There are four ways to wake an idle Claude Code session: the developer types, a
 * scheduled task fires, a background task finishes, or another session posts to the
 * inbox socket. The first two versions of this used the last two, and both failed
 * for the same structural reason — they decide AFTER the wake, not before:
 *
 *  - **Scheduled task (`CronCreate`).** Fires on wall-clock minutes, only while the
 *    session is idle, and a fire missed during a turn is delivered the moment the
 *    turn ends. So the most common tick lands at "stopped 0 seconds ago", exactly
 *    when it must be discarded — and discarding a prompt is never silent: every
 *    path ends in a `hook_blocking_error` the host renders, with a default string
 *    when `reason` is empty. Letting it through instead costs a full turn, which
 *    re-reads the whole conversation to conclude that nothing is wrong. A wall
 *    clock also cannot express the one thing this needs: "five minutes after the
 *    turn ended".
 *  - **Inbox socket.** Measured on macOS / Claude Code 2.1.278 against a real
 *    receiving session: a session that bypasses permission prompts receives nothing
 *    and the sender gets no failure signal; when delivery works, the host frames the
 *    text as coming from another session and tells the receiver it carries no
 *    consent — the observed reaction was the model stopping to ask the developer
 *    whether the message was legitimate, i.e. the nudge producing the stall it
 *    exists to break.
 *
 * A backgrounded process inverts it. The host wakes the session when the process
 * EXITS, so the process itself decides when — and while it is not stalled it simply
 * keeps sleeping: no wake, no output, no tokens. The decision moved in front of the
 * wake, and with it the entire noise problem. It also gets, for free, what the
 * detached daemon of the socket version had to hand-roll: the host owns the task's
 * lifetime (it is listed in the session's background tasks and dies with the
 * session), and the wake arrives as the session's own task finishing rather than as
 * a message from elsewhere.
 *
 * ── Who starts it, and why the engine can still trust it ──────────────────────
 * Only the model can start a background task; a hook cannot. That would normally
 * make this a prompt-level discipline, and prompt-level discipline is exactly what
 * this flow has measured failing (`grill-flow/references/subagent-lifecycle.md`
 * records a main session ending turns with "it's running in the background" while
 * nothing was started — 335 minutes of silence, 43.9% of that session's wall clock).
 * What closes the loop is that `Stop` hook input carries `background_tasks`,
 * including each shell task's command line: the engine can SEE whether the watcher
 * is running and ask again until it is. Verification, not trust.
 */

/** Prefix on everything this feature says, so its lines are recognisable at a glance. */
export const WATCHDOG_LABEL = '[ai-flow:watchdog]';

/**
 * 0.76.0 drove this feature from a `CronCreate` task whose prompt began with the
 * label above, and the engine intercepted that prompt. 0.77.0 removed the
 * interception along with the whole cron design — but a cron already scheduled in a
 * live session outlives the upgrade, and `claude --resume` restores it. With nothing
 * left to recognise it, the tick arrives as an ordinary prompt and the model answers
 * it in full, as if a developer had asked (observed once, on a resume).
 *
 * Nothing but the developer can remove that task, so the engine stops the prompt and
 * says which one to delete. Remove this when no live session can still be holding a
 * 0.76.0 cron.
 */
export function isLegacyCronTick(prompt: string, source?: string): boolean {
  if (source === 'user') return false;
  return prompt.trimStart().startsWith(`${WATCHDOG_LABEL} `) && prompt.includes('停滞自检');
}

/**
 * Literal token in the watcher's command line. The `Stop` hook matches it against
 * `background_tasks[].command` to answer two questions it has no other source for:
 * is the watcher running, and is a given background task the watcher (which must not
 * count as "work in flight" — if it did, its own presence would suppress every nudge).
 */
export const WATCHER_MARKER = 'ai-flow-watchdog-watch';

export const DEFAULT_IDLE_MINUTES = 5;

/** How often the watcher re-reads the flow state. */
export const WATCHER_POLL_MS = 20_000;

/**
 * The watcher stops watching after this long and says so on the way out. Not a
 * safety bound — the host already kills it with the session — but an upper limit on
 * how stale its idea of the flow can get.
 */
export const WATCHER_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;

/**
 * Nudges allowed per stage before the watchdog goes quiet. Reset by any developer
 * prompt and by every stage advance.
 *
 * A cap is not optional. Without one the loop is unbounded in the one situation the
 * watchdog is built for: nobody is in the room, so nothing else ends it. A nudged
 * model that answers "I'm waiting for you" and stops produces a new turn end, the
 * watcher gets restarted, and the cycle repeats — each iteration a fully billed turn
 * carrying the whole flow context.
 */
export const DEFAULT_NUDGE_CAP = 3;

/** How many times one session may be asked to start the watcher before giving up. */
export const MAX_ARM_ASKS = 3;

/**
 * Two watchers that reach the same conclusion within this window count as one: the
 * second keeps sleeping instead of waking the session again.
 *
 * Duplicates are not hypothetical — a watcher left over from a previous arming can
 * outlive the turn that started it, and `Stop` only asks for a new one when it sees
 * none. Without this the pair delivers two wakes and spends two of the stage's three
 * nudges within seconds of each other (observed in the end-to-end smoke run). The
 * loser cannot simply exit, because an exit IS a wake — so it goes back to sleeping.
 */
export const NUDGE_DEDUPE_MS = 60_000;

/** True when another watcher already delivered a nudge close enough to count as this one. */
export function withinDedupeWindow(lastNudgeAt: string | null, now: number): boolean {
  if (!lastNudgeAt) return false;
  const t = Date.parse(lastNudgeAt);
  return !Number.isNaN(t) && now - t < NUDGE_DEDUPE_MS;
}

export interface WatchdogState {
  /**
   * When the owner session last ENDED A TURN, ISO. Written by the Stop hook, and
   * half of the watcher's idle test.
   *
   * Two stoppages do not update it, both documented host behavior: a turn the
   * developer interrupted (Stop does not run on a user interrupt) and a turn that
   * died on an API error (that fires StopFailure instead). Both leave an older
   * timestamp, so the next check sees a LONGER idle span than really elapsed and
   * nudges — the safe direction, since the session is in fact sitting there. That
   * only holds because the activity stamp below expires (`ACTIVITY_STALE_MS`):
   * neither ending clears it, so without expiry both would read as "a turn is still
   * running", forever.
   */
  last_stop_at: string | null;
  /**
   * When the session last showed signs of working: a developer prompt, or a tool
   * call (stamped at most every `ACTIVITY_STAMP_THROTTLE_MS`). The other half of the
   * idle test, and the reason the watcher cannot fire in the middle of a turn that
   * no prompt started — a background task's completion, or a Stop-hook continuation,
   * both of which leave `last_stop_at` pointing at the PREVIOUS turn's end.
   */
  last_activity_at: string | null;
  /**
   * Whether the last turn ended with background work still in flight — the watcher
   * itself excluded. Such a session is not stalled: the host will wake it when the
   * work lands.
   *
   * Note which way this cuts on the failure this repo actually measured: a session
   * that CLAIMS background work it never started reports an empty array, so it is
   * NOT suppressed. The claim is invisible to the engine; the absence is not.
   */
  background: boolean;
  /**
   * `background`, split by what will actually wake the session. A subagent or a
   * workflow ends and wakes it; a shell task may be a 15-minute timer (ends) or a dev
   * server (never ends). The watcher treats the two differently — see `decideStall`.
   */
  agents_in_flight: boolean;
  bash_in_flight: boolean;
  /** The shell tasks behind `bash_in_flight`, so a nudge can name what it is ignoring. */
  bash_tasks: string[];
  /**
   * Whether the watcher THIS session started was present in `background_tasks` at
   * the last turn end. Own watcher, not any watcher: a watcher from a previous
   * session survives `/clear` (the host process does), and counting it here is what
   * kept ten consecutive sessions of one flow from ever being asked to arm — while
   * that inherited process, bound to a session id that was no longer the owner,
   * looped silently for days without a single nudge.
   */
  watcher_seen: boolean;
  /**
   * When the developer last typed (UserPromptSubmit with `source` user/absent), ISO.
   * Compared with `last_stop_at` it tells whether the turn that just ended was one
   * the developer started — the Stop guard leaves those alone.
   */
  last_user_prompt_at: string | null;
  /** How many times this session has been told to start the watcher. Caps at MAX_ARM_ASKS. */
  arm_asks: number;
  /** Nudges spent on the CURRENT stage. Reset by a developer prompt and by stage advance. */
  nudges_this_stage: number;
  /** When a nudge last fired, ISO. Reported by `<flow> status`. */
  last_nudge_at: string | null;
}

/**
 * Minimum gap between two activity stamps. PostToolUse fires on every tool call, and
 * the stamp only has to be accurate to "is a turn running right now", which a
 * 15-second resolution answers against a five-minute threshold.
 */
export const ACTIVITY_STAMP_THROTTLE_MS = 15_000;

/**
 * How stale an activity stamp may be while still counting as "a turn is running".
 *
 * Without a bound, the two turn endings that never fire `Stop` — the developer
 * interrupting with ESC, and a turn dying on an API error (StopFailure fires instead)
 * — leave `last_activity_at` permanently ahead of `last_stop_at`, and the watcher
 * reads that as a turn running forever. It would then never nudge again for the rest
 * of the session, in exactly the unattended case this exists for.
 *
 * 15 minutes, because the bound has to clear the longest gap a LIVE turn can have
 * between two stamps: a foreground Bash call is capped at 10 minutes by the host, and
 * a long subagent stamps through its own tool calls (which is why subagent calls are
 * stamped too — see posttool-handler). Past that, nothing is running.
 */
export const ACTIVITY_STALE_MS = 15 * 60_000;

export function emptyWatchdog(): WatchdogState {
  return {
    last_stop_at: null,
    last_activity_at: null,
    background: false,
    agents_in_flight: false,
    bash_in_flight: false,
    bash_tasks: [],
    watcher_seen: false,
    last_user_prompt_at: null,
    arm_asks: 0,
    nudges_this_stage: 0,
    last_nudge_at: null,
  };
}

/**
 * Read the watchdog block off a state object that may predate it, or be partially
 * written. Flows created before this version have no such key.
 */
export function readWatchdog(state: { watchdog?: Partial<WatchdogState> } | null | undefined): WatchdogState {
  return { ...emptyWatchdog(), ...(state?.watchdog ?? {}) };
}

export interface WatchdogConfig {
  enabled: boolean;
  idleMs: number;
  cap: number;
}

/**
 * `AI_FLOW_WATCHDOG=0` turns the whole thing off without touching a config file —
 * the escape hatch for a developer who wants quiet mid-flow and should not have to
 * edit a flow definition to get it.
 */
export function resolveWatchdogConfig(
  cfg: { enabled?: boolean | undefined; idle_minutes?: number | undefined } | undefined,
  env: NodeJS.ProcessEnv = process.env
): WatchdogConfig {
  const envOff = env['AI_FLOW_WATCHDOG'] === '0';
  return {
    enabled: !envOff && (cfg?.enabled ?? true),
    idleMs: (cfg?.idle_minutes ?? DEFAULT_IDLE_MINUTES) * 60_000,
    cap: DEFAULT_NUDGE_CAP,
  };
}

export interface StallFacts {
  now: number;
  lastStopAt: number | null;
  lastActivityAt: number | null;
  /** A subagent / workflow / MCP task is running: it WILL end and wake the session. */
  agentsInFlight: boolean;
  /** A non-watcher shell task is running: a timer that will end, or a server that never will. */
  bashInFlight: boolean;
  gatePending: boolean;
  /** `state/hold` exists: the model wrote down what it is waiting for. */
  holdPresent: boolean;
  nudgesThisStage: number;
  config: WatchdogConfig;
}

/**
 * How much longer than `idleMs` a session may sit while a shell task is in flight
 * before it counts as stalled anyway.
 *
 * "A background task will wake you" was an absolute suppressor, and one flow proved
 * it wrong for hours at a time: the task was a `pnpm dev` instance kept alive for a
 * real-machine check, which never exits, so nothing ever woke the session — 212
 * minutes once, 344 another time. Six times the threshold (30 minutes at the default)
 * clears every self-imposed timer the flows use (15-minute `sleep`s) and every
 * verification run, so the only thing left in flight at that point is something that
 * was never going to end.
 */
export const BASH_IDLE_MULTIPLIER = 6;

export type StallVerdict =
  /** Keep sleeping. `note` is for the log and for `<flow> status`; nobody is woken. */
  | { stalled: false; note: string }
  /** Wake the session. */
  | { stalled: true; idleMs: number; remaining: number };

/**
 * The whole policy, as a pure function so every branch is testable without a session.
 *
 * Everything that returns `stalled: false` costs exactly nothing — the watcher loops
 * and the session never learns a check happened. That is the property the previous
 * design could not have, and the reason this one can be left on.
 */
export function decideStall(f: StallFacts): StallVerdict {
  if (!f.config.enabled) return { stalled: false, note: 'watchdog 已关闭' };
  if (f.lastStopAt === null) return { stalled: false, note: '本 session 还没结束过回合' };
  // A turn is running. `last_stop_at` alone cannot see this: a turn started by a
  // background task finishing, or by a Stop-hook continuation, carries no prompt, so
  // the last recorded stop is the PREVIOUS turn's end and can be arbitrarily old.
  //
  // The staleness bound is not optional — see ACTIVITY_STALE_MS. An ESC interrupt and
  // an API-killed turn both end without a `Stop`, leaving activity permanently ahead
  // of the last stop; unbounded, this branch would then hold forever and the watchdog
  // would go quiet for the rest of the session.
  if (
    f.lastActivityAt !== null &&
    f.lastActivityAt > f.lastStopAt &&
    f.now - f.lastActivityAt < ACTIVITY_STALE_MS
  ) {
    return { stalled: false, note: '正在干活（最后一个事件不是「停下」）' };
  }
  if (f.gatePending) return { stalled: false, note: '在等开发者 approve，停下来是对的' };
  // The model wrote down what it is waiting for. That is the one legitimate stop the
  // engine cannot see through, so it is the one it asks to be told about — and being
  // told is the whole point: a hold is a file the developer can read, not a sentence
  // that scrolled past. Cleared by the developer's next prompt.
  if (f.holdPresent) return { stalled: false, note: '有 state/hold，在等开发者的人手动作' };
  if (f.agentsInFlight) return { stalled: false, note: '有子代理在飞，等它把你叫醒' };
  const idleMs = f.now - f.lastStopAt;
  const threshold = f.bashInFlight ? f.config.idleMs * BASH_IDLE_MULTIPLIER : f.config.idleMs;
  if (idleMs < threshold) {
    return {
      stalled: false,
      note: f.bashInFlight
        ? `有后台 shell 任务在跑，静置 ${Math.round(idleMs / 1000)} 秒（阈值放宽到 ${Math.round(threshold / 60_000)} 分钟）`
        : `刚停下 ${Math.round(idleMs / 1000)} 秒`,
    };
  }
  if (f.nudgesThisStage >= f.config.cap) {
    return { stalled: false, note: `本 stage 已催满 ${f.nudgesThisStage}/${f.config.cap} 次` };
  }
  return { stalled: true, idleMs, remaining: f.config.cap - f.nudgesThisStage - 1 };
}

/**
 * The exact command the model is told to background, and what `Stop` matches on.
 *
 * The session id is baked in by the hook rather than asked of the model, which has
 * no way to know its own. The watcher needs it to stay out of a flow it no longer
 * owns: its output wakes the session that STARTED it, so a watcher that outlived a
 * handover would be nudging a session the flow has moved on from.
 */
export function watcherCommand(
  repoRoot: string,
  flowName: string,
  flowId: string,
  sessionId: string
): string {
  const script = join(PLUGIN_ROOT, 'dist', 'watchdog', 'watch.js');
  return `node "${script}" --marker ${WATCHER_MARKER} --repo "${repoRoot}" --flow "${flowName}"`
    + ` --flow-id "${flowId}" --session "${sessionId}"`;
}

/**
 * True when a `background_tasks` entry is this feature's own watcher — and, when
 * `flowId` is given, the watcher for THAT flow instance.
 *
 * Scoping matters because a watcher whose flow ended keeps looping instead of exiting
 * (exiting would wake the session to say nothing). Complete one flow and start another
 * in the same session and the old process is still listed: matched on the marker
 * alone, `Stop` would see it, believe the new flow is armed, never ask for a real
 * watcher, and `<flow> status` would report 已武装 while nothing watches.
 *
 * The foreground guard in PreToolUse passes no `flowId` on purpose: it is refusing a
 * command shape, and that refusal holds whichever flow the command names.
 */
export function isWatcherTask(command: string | undefined, flowId?: string): boolean {
  const c = command ?? '';
  if (!c.includes(WATCHER_MARKER)) return false;
  return flowId ? c.includes(`--flow-id "${flowId}"`) : true;
}

/**
 * True when a `background_tasks` entry is the watcher THIS session started for THIS
 * flow instance — the only one whose presence means "armed".
 *
 * The flow-id test above is not enough. `/clear` keeps the host process, and with it
 * every background task, so the next session inherits its predecessor's watcher. That
 * process is bound to the old session id: `watch.ts` sees an owner it does not
 * recognise and stays silent. Counted as armed, it kept `Stop` from ever asking the
 * new session to start its own — measured on one flow as ten sessions and six days
 * without a nudge, with the inherited process still alive at the end of it.
 */
export function isOwnWatcher(command: string | undefined, flowId: string, sessionId: string): boolean {
  return isWatcherTask(command, flowId) && (command ?? '').includes(`--session "${sessionId}"`);
}

/**
 * Task types the host has been observed to report, in both spellings seen so far
 * (`types.ts` documents `shell | subagent | …`; the 2.1.28x binary emits
 * `local_bash | local_agent | …`). Anything else — monitors, dreams, auto-mode scans,
 * whatever the host adds next — is NOT counted as work in flight: those are the
 * host's own housekeeping, may run for the whole session, and counting one would
 * silence the watchdog for as long as it lives. The failure to prefer is a nudge
 * that finds the session busy (one turn); the failure to avoid is the one this file
 * exists to end.
 */
const AGENT_TASK_TYPES = new Set([
  'subagent', 'local_agent', 'agent', 'workflow', 'local_workflow',
  'mcp_task', 'teammate', 'in_process_teammate', 'remote_agent',
]);
const BASH_TASK_TYPES = new Set(['shell', 'local_bash', 'bash']);

export interface InFlight {
  agents: boolean;
  bash: boolean;
  /** Descriptions (or commands) of the shell tasks counted, for the nudge to name. */
  bashTasks: string[];
  /** Descriptions of the subagents counted — a stage's stop guard reads ticket ids off them. */
  agentTasks: string[];
}

/** Sort the session's background tasks into what will wake it and what may not. */
export function classifyInFlight(tasks: BackgroundTaskEntry[]): InFlight {
  const out: InFlight = { agents: false, bash: false, bashTasks: [], agentTasks: [] };
  for (const t of tasks) {
    const type = t.type ?? (t.command !== undefined ? 'shell' : 'subagent');
    if (BASH_TASK_TYPES.has(type)) {
      if (isWatcherTask(t.command)) continue;
      out.bash = true;
      out.bashTasks.push((t.description || t.command || t.id || 'shell task').slice(0, 120));
    } else if (AGENT_TASK_TYPES.has(type)) {
      out.agents = true;
      out.agentTasks.push((t.description || t.id || 'agent').slice(0, 120));
    }
  }
  return out;
}

/** Injected by `Stop` when `background_tasks` shows no watcher running. */
export function armInstruction(
  repoRoot: string,
  flowName: string,
  flowId: string,
  sessionId: string
): string {
  return [
    `${WATCHDOG_LABEL} 现在用 Bash 起一个后台停滞自检（\`run_in_background: true\`），命令照抄：`,
    ``,
    `    ${watcherCommand(repoRoot, flowName, flowId, sessionId)}`,
    ``,
    `description 写「ai-flow 停滞自检」。它是一个循环进程：盯着 flow 状态，**确认停滞才退出**，`,
    `没停滞就一直睡着——不唤醒你、不打扰开发者、不消耗 token。它退出时宿主会用它的输出把你叫醒。`,
    `⛔ 不要前台跑，不要等它，不要向开发者汇报这件事。起完接着做你手上的活。`,
  ].join('\n');
}

/** What the watcher prints on its way out — the text that wakes the session. */
export function nudgeText(opts: {
  flowName: string;
  stageId: string;
  idleMs: number;
  remaining: number;
  wrapUpPct: number | null;
  /**
   * The command that starts a fresh watcher. Carried in the nudge so the model
   * re-arms during the turn it was just woken for — free. Leaving it to the `Stop`
   * hook to notice and ask instead would spend a whole extra turn on it, every time.
   */
  rearmCommand: string;
  /** Absolute path of `state/hold` — the one file that makes a stop legitimate. */
  holdPath: string;
  /** Shell tasks still listed as running when the last turn ended (may be servers). */
  bashTasks?: string[];
}): string {
  const mins = Math.round(opts.idleMs / 60_000);
  const bash = opts.bashTasks ?? [];
  // The previous wording offered "waiting for the developer → say so and stop" as
  // the first of two options. Observed taken verbatim on the first nudge a flow ever
  // received, and it is exactly the stop the developer had been asking the flow not
  // to make. So the nudge no longer asks the model to judge whether stopping was
  // right; it names the two actions available and makes the legitimate stop a file.
  const lines = [
    `${WATCHDOG_LABEL} 引擎的停滞自检把你叫醒了（不是开发者说的话）。`,
    ``,
    `机械事实：流程 '${opts.flowName}' 停在 stage '${opts.stageId}'，已静置约 ${mins} 分钟；`
      + `没有子代理在飞，没有待批的 gate，也没有 state/hold。`,
    ...(bash.length > 0
      ? [`后台还挂着 ${bash.length} 个 shell 任务（${bash.join('；')}）——静置这么久它们还没结束，`
        + `就当它们不会把你叫醒（常驻进程如 dev server）。`]
      : []),
    ``,
    `二选一，都在本回合做完：`,
    `· **还有能推进的工作**（够格的票、待派的质量链、待收的树、待跑的收口测试）→ 直接做，`
      + `不复述计划，不预告「下一轮」——写「下一轮我…」然后停下，就是这次被叫醒的原因。`,
    `· **确实在等开发者的人手动作**（安全红线拍板、只有他能做的操作、他明确叫停）`
      + `→ 用 Write 写 \`${opts.holdPath}\`，一行：等谁做什么、为什么只能他做、等到之后下一步是什么。`
      + `有这个文件自检就不再催；开发者下一条输入会把它清掉。⛔ 只在正文里说「在等你」不算。`,
    ``,
    `本 stage 还剩 ${opts.remaining} 次自检（开发者一说话就清零）。`,
    ``,
    `⚠️ 这个自检进程刚才退出了（它就是靠退出把你叫醒的）。**在本回合内**用 Bash 重新起一个`,
    `（\`run_in_background: true\`，不要前台跑、不要等它、不要向开发者汇报）：`,
    ``,
    `    ${opts.rearmCommand}`,
  ];
  if (opts.wrapUpPct !== null) {
    lines.push(
      ``,
      `⚠️ context 已在 ${opts.wrapUpPct}% 进入收尾：如果交接文档还没落盘，先把它写完再停。`
    );
  }
  return lines.join('\n');
}

/**
 * Whether a UserPromptSubmit came from the developer, as opposed to a machine-injected
 * turn (a subagent's hand-back, a peer session's message, a task notification, a
 * scheduled wakeup).
 *
 * The host's schema documents a `source` field for exactly this (`user` = composer,
 * `system` = peer/channel messages, task notifications, auto-continuation, …) — and
 * 2.1.283 does not send it: the hook input is built with `...!1` where `source` would
 * go. Measured on a live flow: a subagent hand-back stamped `last_user_prompt_at`
 * within 14 seconds of arriving, with no developer at the keyboard. Read as "the
 * developer typed", that would clear a hold the developer never saw and exempt the
 * Stop guard on precisely the turns it exists for (the ones a hand-back starts).
 *
 * So `source` is trusted when present, and when absent the envelope text decides:
 * every machine-injected prompt the host produces is wrapped in a fixed, recognisable
 * frame (`Another Claude session sent a message`, `<agent-message from=…>`,
 * `<task-notification>`, …). A developer would have to type one of those frames
 * verbatim to be mistaken for a machine, and the cost of that mistake is one missed
 * hold-clear — which their next ordinary prompt performs.
 */
export function isDeveloperPrompt(prompt: string, source?: string): boolean {
  if (source !== undefined) return source === 'user';
  return !MACHINE_PROMPT_ENVELOPE.test(prompt.trimStart());
}
const MACHINE_PROMPT_ENVELOPE = new RegExp(
  '^(?:' + [
    'Another Claude session sent a message',
    'A peer session sent a message',
    'Activity was observed in the bound conversation',
    '<agent-message\\b',
    '<task-notification>',
    '\\[Subagent hand-back\\]',
    '\\[ai-flow:watchdog\\]',
    '\\[ai-flow:stop-guard\\]',
  ].join('|') + ')'
);

/**
 * Whose flow this watcher is looking at. The loop in `watch.ts` acts on the verdict;
 * the decision lives here so it can be tested without a 20-second poll.
 *
 *  - `ours`          → run the stall test.
 *  - `foreign-flow`  → a different flow instance (or none): stay silent, do not exit —
 *                      an exit wakes the session to say nothing.
 *  - `owner-changed` → same flow, new session: exit, and hand the new owner its own
 *                      arming command. A null owner is NOT a change (`<flow> resume`
 *                      leaves it null on purpose and the same session keeps driving).
 */
export function watcherOwnership(
  state: { flow_id: string; last_session_id: string | null } | null,
  flowId: string,
  sessionId: string
): 'ours' | 'foreign-flow' | 'owner-changed' {
  if (!state) return 'foreign-flow';
  if (flowId && state.flow_id !== flowId) return 'foreign-flow';
  if (sessionId && state.last_session_id !== null && state.last_session_id !== sessionId) return 'owner-changed';
  return 'ours';
}

/**
 * Whether an inherited watcher may hand over now: only once the new owner's developer
 * has spoken. SessionStart blanks the watchdog for a new session, and only a prompt the
 * developer typed stamps `last_user_prompt_at` (a hand-back or task notification does
 * not), so null means nobody has come back yet — and a wake then would start the flow
 * moving before the developer did. See the owner-changed branch in `watch.ts`.
 *
 * And never once the new owner has a watcher of its own (`watcher_seen`, stamped by
 * Stop from the live task list): a subagent hand-back can start a turn in the new
 * session before the developer speaks, its Stop asks for arming, the model arms — and
 * a hand-over printed after that would talk it into arming a second one.
 */
export function ownerChangeReady(state: { watchdog?: Partial<WatchdogState> } | null): boolean {
  if (state === null) return false;
  const w = readWatchdog(state);
  return w.last_user_prompt_at !== null && !w.watcher_seen;
}

/**
 * What an inherited watcher prints when it discovers the flow has a new owner. Its
 * exit wakes the process, so the text has to be worth a turn: it hands the new
 * session the arming command, which is what `Stop` would otherwise spend the next
 * turn end asking for.
 */
export function ownerChangedText(flowName: string, rearmCommand: string): string {
  return [
    `${WATCHDOG_LABEL} 上一个 session 起的停滞自检发现流程 '${flowName}' 已换了 session，自行退出（不是开发者说的话）。`,
    `本 session 还没有自己的自检进程。现在用 Bash 起一个（\`run_in_background: true\`，不要前台跑、不要等它、不要向开发者汇报），`,
    `起完接着做手上的活：`,
    ``,
    `    ${rearmCommand}`,
  ].join('\n');
}
