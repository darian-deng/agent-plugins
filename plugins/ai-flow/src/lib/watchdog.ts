/**
 * Stall watchdog: the engine's answer to "the session stopped, and stopping was
 * not the right move".
 *
 * ── Why a cron and not a hook timer ────────────────────────────────────────────
 * There is no timer hook. Every hook is event-driven, and the one event that
 * matters here — "the turn ended and nobody came back" — is precisely the absence
 * of events. What the host does provide is a session-scoped scheduler
 * (`CronCreate`), whose documented semantics are the ones this needs:
 * tasks fire ONLY while Claude Code is running and idle, never mid-turn; a fire
 * missed during a long request happens once when the session next goes idle, not
 * once per missed interval; `/clear` drops them; recurring tasks expire after 7
 * days. That "never mid-turn" guarantee is load-bearing — it is why nothing here
 * has to infer whether a 40-minute Bash is still running.
 *
 * ── Why not post into the session's inbox socket ───────────────────────────────
 * The rejected design had a detached process post to `CLAUDE_CODE_MESSAGING_SOCKET`
 * on a 5-minute timer. Measured on macOS / Claude Code 2.1.278 against a real
 * receiving session, it fails two ways:
 *   1. A session running with permission prompts bypassed does not receive the
 *      message at all (the host holds it for approval unless the SENDER also
 *      declares it bypasses), and the sender gets no failure signal — silent.
 *   2. When it does arrive, the host frames it as coming from ANOTHER session and
 *      tells the receiver it carries no consent. The observed reaction was the
 *      model stopping to ask the developer whether the message was legitimate —
 *      i.e. the nudge produced the very stall it exists to break.
 * A cron prompt is the session's own scheduled prompt, so it carries none of that.
 *
 * ── Who creates it, and why the engine can still trust it ──────────────────────
 * Only the model can call `CronCreate`; a hook cannot. That would normally make
 * this a prompt-level discipline, and prompt-level discipline is exactly what this
 * flow has already measured failing (`grill-flow/references/subagent-lifecycle.md`
 * records a main session ending turns with "it's running in the background" while
 * nothing was started — 335 minutes of silence, 43.9% of that session's wall
 * clock). What closes the loop is that `Stop` hook input carries `session_crons`,
 * including each task's `prompt` text: the engine can SEE whether the cron exists
 * and re-ask until it does. Verification, not trust.
 */

/**
 * Prefix that marks a prompt as a watchdog tick rather than something a developer
 * typed. Three separate places key off it, so it is defined once:
 *   - `Stop` matches it against `session_crons[].prompt` to tell whether the cron
 *     this flow asked for actually exists;
 *   - `UserPromptSubmit` matches it against the incoming prompt to route the tick
 *     into `decideTick` instead of the ordinary command parser;
 *   - the same handler uses it to decide NOT to treat the tick as developer
 *     activity (a tick that reset the nudge counter would re-arm itself, and the
 *     watchdog would nudge every interval forever with nobody in the room).
 * Recognition is the sentinel AND the host's `source` field: a prompt that arrives
 * as `user` is never a tick, however it starts, so a developer who types or pastes
 * the prefix is not swallowed. `source` cannot carry the identity on its own — a
 * developer's own `/loop` arrives as a wakeup too — and it is optional in the host's
 * schema, so its absence falls back to the text match.
 */
export const WATCHDOG_SENTINEL = '[ai-flow:watchdog]';

/** Every-5-minutes. The host adds up to 10% of the period as deterministic jitter. */
export const WATCHDOG_CRON = '*/5 * * * *';

export const DEFAULT_IDLE_MINUTES = 5;

/**
 * Nudges allowed per stage before the watchdog goes quiet. Reset by any developer
 * prompt and by every stage advance.
 *
 * A cap is not optional. Without one the loop is unbounded in the one situation
 * the watchdog is built for: nobody is in the room, so nothing else ends it. A
 * nudged model that answers "I'm waiting for you" and stops produces a new turn
 * end, the next tick sees a fresh `last_stop_at`, and the cycle repeats every
 * interval until the cron's 7-day expiry — each iteration a fully-billed turn
 * carrying the whole flow context.
 */
export const DEFAULT_NUDGE_CAP = 3;

/** How many times one session may be asked to create the cron before giving up. */
export const MAX_CRON_ASKS = 3;

export interface WatchdogState {
  /**
   * When the owner session last ENDED A TURN, ISO. Written by the Stop hook, and
   * the only clock the tick decision has.
   *
   * Two stoppages do not update it, both documented host behavior: a turn the
   * developer interrupted (Stop does not run on a user interrupt) and a turn that
   * died on an API error (that fires StopFailure instead). Both leave a stale,
   * older timestamp, so the next tick sees a LONGER idle span than really elapsed
   * and nudges — which is the safe direction: the session is in fact sitting there
   * doing nothing.
   */
  last_stop_at: string | null;
  /**
   * Whether the last turn ended with background work still in flight (`shell`,
   * `subagent`, `monitor`, …) or a scheduled wakeup other than this watchdog's own
   * cron. Such a session is not stalled — the host will wake it when the work
   * lands — so a tick is suppressed.
   *
   * Note which way this cuts on the failure this flow actually measured: a session
   * that CLAIMS background work it never started reports an empty array, so it is
   * not suppressed. The claim is invisible to the engine; the absence is not.
   */
  background: boolean;
  /** Whether the watchdog cron was present in `session_crons` at the last turn end. */
  cron_seen: boolean;
  /** How many times this session has been told to create the cron. Caps at MAX_CRON_ASKS. */
  cron_asks: number;
  /** Nudges let through for the CURRENT stage. Reset on developer prompt and stage advance. */
  nudges_this_stage: number;
  /** When a nudge was last let through, ISO. Shown by `<flow> status`. */
  last_nudge_at: string | null;
}

export function emptyWatchdog(): WatchdogState {
  return {
    last_stop_at: null,
    background: false,
    cron_seen: false,
    cron_asks: 0,
    nudges_this_stage: 0,
    last_nudge_at: null,
  };
}

/**
 * Read the watchdog block off a state object that may predate it. Flows created
 * before this version have no such key, and a partially-written one must not make
 * a caller read `undefined.nudges_this_stage`.
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
 * `AI_FLOW_WATCHDOG=0` turns the whole thing off without touching any config file
 * — the escape hatch for a developer who finds it noisy mid-flow and does not want
 * to edit a flow definition to get quiet.
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

export interface TickFacts {
  now: number;
  lastStopAt: number | null;
  background: boolean;
  gatePending: boolean;
  nudgesThisStage: number;
  config: WatchdogConfig;
}

export type TickDecision =
  /** Block the tick. `note` is shown to the developer and costs the model nothing. */
  | { nudge: false; note: string }
  /** Let the tick reach the model. `idleMs` is how long the session has been quiet. */
  | { nudge: true; idleMs: number; remaining: number };

/**
 * The whole suppression policy, as a pure function so every branch is testable
 * without a session.
 *
 * Suppression is the common case and it is FREE: `UserPromptSubmit` blocks the
 * prompt before the model sees it, so a tick that finds nothing wrong costs one
 * hook run and one line in the terminal. That is the reason this feature can be
 * left on at all — a tick that woke the model every interval would re-read the
 * whole conversation each time.
 */
export function decideTick(f: TickFacts): TickDecision {
  if (!f.config.enabled) {
    return { nudge: false, note: 'watchdog 已关闭，这条定时自检可以删掉（CronList → CronDelete）' };
  }
  if (f.lastStopAt === null) {
    return { nudge: false, note: '本 session 还没结束过回合，无从判断停滞' };
  }
  if (f.gatePending) {
    return { nudge: false, note: '在等开发者 approve，停下来是对的' };
  }
  if (f.background) {
    return { nudge: false, note: '上一轮结束时还有后台任务在跑，等它把你叫醒' };
  }
  const idleMs = f.now - f.lastStopAt;
  if (idleMs < f.config.idleMs) {
    return {
      nudge: false,
      note: `刚停下 ${Math.round(idleMs / 1000)} 秒，未到 ${Math.round(f.config.idleMs / 60_000)} 分钟阈值`,
    };
  }
  if (f.nudgesThisStage >= f.config.cap) {
    return {
      nudge: false,
      note: `本 stage 已催 ${f.nudgesThisStage}/${f.config.cap} 次，不再催（开发者一说话就清零）`,
    };
  }
  return { nudge: true, idleMs, remaining: f.config.cap - f.nudgesThisStage - 1 };
}

/** The prompt text the model is told to give CronCreate. Also what Stop matches on. */
export function cronPromptFor(flowName: string): string {
  return `${WATCHDOG_SENTINEL} ${flowName} 停滞自检`;
}

/** Injected by Stop when `session_crons` shows the cron is missing. */
export function cronCreateInstruction(flowName: string): string {
  return [
    `${WATCHDOG_SENTINEL} 现在调用 CronCreate 建一条停滞自检，参数照抄：`,
    `    cron:   "${WATCHDOG_CRON}"`,
    `    prompt: "${cronPromptFor(flowName)}"`,
    `它是本 session 内的定时任务（/clear 后自动消失，7 天过期）。每次触发都先经引擎判定：`,
    `没停滞就在到达你之前被拦掉，不消耗 token；只有确实停滞才会叫你。`,
    `建完不用向开发者汇报，接着做你手上的事。`,
  ].join('\n');
}

/** Injected when a tick is let through. */
export function nudgeText(opts: {
  flowName: string;
  stageId: string;
  idleMs: number;
  remaining: number;
  wrapUpPct: number | null;
}): string {
  const mins = Math.round(opts.idleMs / 60_000);
  const lines = [
    `${WATCHDOG_SENTINEL} 这是引擎排的定时自检（本 session 自己的 cron），**不是开发者说的话**。`,
    ``,
    `机械事实：流程 '${opts.flowName}' 停在 stage '${opts.stageId}'，已静置约 ${mins} 分钟；`,
    `没有后台任务在跑，也没有待批的 gate —— 也就是说没有任何东西会在将来把你叫醒。`,
    ``,
    `先判断这次停下来是否合理，二选一：`,
    `· **在等开发者**（问题已经摆给他了、卡在必须他拍板或他去真机验证的点上、或者他刚明确叫停）`,
    `  → 回一行说清在等什么，然后结束回合。不要重复解释，不要重新开工。`,
    `· **其它情况**（插曲已经讨论完/改完，只是没回到 flow）`,
    `  → 不要向开发者复述计划，直接接着 stage '${opts.stageId}' 往下做。`,
    ``,
    `本 stage 还剩 ${opts.remaining} 次自检（开发者一说话就清零）。`,
  ];
  if (opts.wrapUpPct !== null) {
    lines.push(
      ``,
      `⚠️ context 已在 ${opts.wrapUpPct}% 进入收尾：如果交接文档还没落盘，先把它写完再停，` +
        `别让这一轮的判断和在飞子代理的状态随 /clear 一起丢掉。`
    );
  }
  return lines.join('\n');
}
