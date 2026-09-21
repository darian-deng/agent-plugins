import { join } from 'path';
import { PLUGIN_ROOT } from './flow-paths.js';

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
  /** Whether the watcher was present in `background_tasks` at the last turn end. */
  watcher_seen: boolean;
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
    watcher_seen: false,
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
  background: boolean;
  gatePending: boolean;
  nudgesThisStage: number;
  config: WatchdogConfig;
}

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
  if (f.background) return { stalled: false, note: '有后台任务在跑，等它把你叫醒' };
  const idleMs = f.now - f.lastStopAt;
  if (idleMs < f.config.idleMs) {
    return { stalled: false, note: `刚停下 ${Math.round(idleMs / 1000)} 秒` };
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
}): string {
  const mins = Math.round(opts.idleMs / 60_000);
  const lines = [
    `${WATCHDOG_LABEL} 引擎的停滞自检把你叫醒了（不是开发者说的话）。`,
    ``,
    `机械事实：流程 '${opts.flowName}' 停在 stage '${opts.stageId}'，已静置约 ${mins} 分钟；`,
    `没有后台任务在跑，也没有待批的 gate —— 没有任何东西会在将来把你叫醒。`,
    ``,
    `先判断这次停下来是否合理，二选一：`,
    `· **在等开发者**（问题已经摆给他了、卡在必须他拍板或他去真机验证的点上、或者他刚明确叫停）`,
    `  → 回一行说清在等什么，然后结束回合。不要重复解释，不要重新开工。`,
    `· **其它情况**（插曲已经讨论完/改完，只是没回到 flow）`,
    `  → 不要向开发者复述计划，直接接着 stage '${opts.stageId}' 往下做。`,
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
