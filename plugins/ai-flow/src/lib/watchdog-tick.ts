import type { UserPromptInput, HookOutput } from './types.js';
import {
  readSignal,
  isGatePending,
  patchActiveState,
  appendLog,
  isForeignCheckout,
  type ResolvedFlow,
} from './state.js';
import { loadFlowConfig } from './flow-config-loader.js';
import { truncateError } from './format.js';
import {
  WATCHDOG_SENTINEL,
  readWatchdog,
  resolveWatchdogConfig,
  decideTick,
  nudgeText,
} from './watchdog.js';

/**
 * True when this prompt is a watchdog cron firing rather than something a developer typed.
 *
 * The sentinel is the identity — `source` alone cannot serve, because a developer's
 * own `/loop` or scheduled task also arrives as a wakeup and must not be swallowed
 * as a watchdog self-check. What `source` adds is the other half: a developer who
 * types or pastes text beginning with the sentinel arrives as `user`, and their
 * prompt then goes through as an ordinary prompt instead of being blocked as a tick.
 * The field is optional in the host's own schema, so an absent value falls back to
 * the text match rather than recognising nothing at all.
 */
export function isWatchdogTick(prompt: string, source?: UserPromptInput['source']): boolean {
  if (source === 'user') return false;
  return prompt.trimStart().startsWith(WATCHDOG_SENTINEL);
}

function block(note: string): HookOutput {
  return {
    decision: 'block',
    // Goes to the developer, never into the model's context. One line, because it
    // prints on every suppressed tick — which is most of them — and that line is
    // also the only way to tell "the watchdog is alive and saw nothing wrong" from
    // "the watchdog is dead". A silent version of this feature is indistinguishable
    // from a broken one.
    reason: `[ai-flow:watchdog] ${note}`,
    suppressOriginalPrompt: true,
  };
}

/**
 * A watchdog cron fired. Decide whether the session's silence is worth waking the
 * model for — and in the common case, end it here.
 *
 * The suppression path costs nothing: the prompt is blocked before the model sees
 * it, so a tick that finds a pending gate, live background work, or a session that
 * only stopped forty seconds ago is one hook run and one terminal line. That is the
 * whole reason a five-minute poll is affordable to leave running; a tick that woke
 * the model each time would re-read the entire conversation to conclude nothing.
 */
export async function handleWatchdogTick(
  input: UserPromptInput,
  active: ResolvedFlow | null,
  cwd: string
): Promise<HookOutput> {
  const { session_id } = input;

  // The cron outlives its flow: it is session-scoped, so completing or aborting a
  // flow leaves it firing into a session with nothing to watch. Say so rather than
  // failing quiet — the developer is the only one who can delete it.
  if (!active) {
    return block('流程已结束或已中止，这条定时自检可以删掉（CronList → CronDelete）');
  }

  const { flowName, state, repoRoot } = active;

  // `!== null &&`, matching posttool-handler's owner test rather than the stricter
  // `=== session_id`. `<flow> resume` deliberately leaves `last_session_id` null
  // (resume.ts: "left null so the next SessionStart binds normally") while the
  // session that typed the command carries straight on driving the flow — under the
  // strict test every tick for the rest of that session is refused with a message
  // saying this session is not the executor, which is the opposite of true.
  if (
    (state.last_session_id !== null && state.last_session_id !== session_id) ||
    isForeignCheckout(active, cwd)
  ) {
    return block(`本 session 不是流程 '${flowName}' 的执行者，自检跳过`);
  }

  try {
    const config = await loadFlowConfig(repoRoot, flowName);
    const cfg = resolveWatchdogConfig(config.watchdog);
    const gatePending = isGatePending(readSignal(repoRoot, flowName), config, state.current_stage);
    const w = readWatchdog(state);
    const lastStopAt = w.last_stop_at ? Date.parse(w.last_stop_at) : NaN;

    const decision = decideTick({
      now: Date.now(),
      lastStopAt: Number.isNaN(lastStopAt) ? null : lastStopAt,
      background: w.background,
      gatePending,
      nudgesThisStage: w.nudges_this_stage,
      config: cfg,
    });

    if (!decision.nudge) {
      // Not logged to flow.log on purpose: suppressed ticks are the common case and
      // arrive every interval for as long as the session is idle. A log line each
      // would bury the events that matter under a heartbeat nobody reads.
      return block(`${flowName}/${state.current_stage}：${decision.note}`);
    }

    // Spend the budget against the state as it is at WRITE time. Two ticks cannot
    // realistically overlap, but the same rule that guards every other counter here
    // costs nothing to keep.
    let spent = 0;
    const written = await patchActiveState(repoRoot, flowName, (cur) => {
      const cw = readWatchdog(cur);
      spent = cw.nudges_this_stage + 1;
      return {
        watchdog: { ...cw, nudges_this_stage: spent, last_nudge_at: new Date().toISOString() },
      };
    });
    if (!written) {
      return block('流程已结束或已中止，自检跳过');
    }

    await appendLog(
      repoRoot, flowName, session_id,
      `WATCHDOG_NUDGE stage=${state.current_stage} idle_min=${Math.round(decision.idleMs / 60_000)}` +
        ` count=${spent}/${cfg.cap}`
    );

    return {
      systemMessage: `[ai-flow:${flowName}] 已静置 ${Math.round(decision.idleMs / 60_000)} 分钟，触发停滞自检（${spent}/${cfg.cap}）`,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: nudgeText({
          flowName,
          stageId: state.current_stage,
          idleMs: decision.idleMs,
          remaining: decision.remaining,
          wrapUpPct: state.context_wrap_up.at_pct,
        }),
      },
    };
  } catch (e) {
    try {
      await appendLog(repoRoot, flowName, session_id, `ERROR watchdog-tick: ${truncateError(e)}`);
    } catch { /* appendLog itself failed */ }
    // A config that will not load means every threshold is unknown. Blocking is the
    // side that cannot do damage.
    return block('自检判定失败（flow 配置读不出来），本次跳过');
  }
}
