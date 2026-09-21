import type { StopInput } from './types.js';
import { resolveActiveFlow, patchActiveState, appendLog, isForeignCheckout } from './state.js';
import { loadFlowConfig } from './flow-config-loader.js';
import { truncateError } from './format.js';
import {
  WATCHDOG_SENTINEL,
  MAX_CRON_ASKS,
  readWatchdog,
  resolveWatchdogConfig,
  cronCreateInstruction,
  type WatchdogState,
} from './watchdog.js';

/**
 * End of a model turn. Two jobs, and neither of them blocks.
 *
 *  1. Stamp the only clock the stall watchdog has: WHEN this session last stopped,
 *     whether background work was still in flight at that moment, and whether the
 *     watchdog cron exists.
 *  2. If the cron is missing, ask the model to create it — the one case where this
 *     hook returns anything, and the reason it can be trusted at all (a hook cannot
 *     call `CronCreate`, but `session_crons` lets it verify the model did).
 *
 * Deliberately never returns `decision: "block"`. Stop fires at the ZEROTH second
 * of idleness — the developer is typically still reading the answer it just got —
 * so a "you should not have stopped" continuation issued here would talk over them,
 * and at that instant nothing mechanical distinguishes a legitimate hand-back from
 * a stall. The 5-minute wait is what separates those two, and Stop cannot express
 * it: its only clock is the next turn end, which is precisely what a stalled
 * session never produces.
 */
export async function handleStop(input: StopInput): Promise<{ additionalContext: string } | null> {
  const { cwd, session_id } = input;

  // A subagent's turn end arrives as SubagentStop, but the host also converts a
  // subagent-scoped Stop hook into one, and a subagent shares its parent's
  // session_id. Branch on presence, never on a value — a client that never sends
  // agent_id must keep behaving as before.
  if (input.agent_id !== undefined) return null;

  const active = await resolveActiveFlow(cwd, session_id).catch(() => null);
  if (!active) return null;

  const { flowName, state, repoRoot } = active;

  // Only the session that OWNS the flow is "the executing session". A second
  // session opened against the same project never becomes the owner (session-handler
  // returns early for it before binding), and a session in another checkout of the
  // repository is not part of this flow at all. Neither should be stamping this
  // flow's clock, and neither should be nudged into driving it.
  //
  // The test matches posttool-handler's: a null owner passes. It must, because
  // `<flow> resume` writes `last_session_id: null` on purpose (resume.ts: "left null
  // so the next SessionStart binds normally") and the session that typed the command
  // keeps driving the flow from there. Requiring `=== session_id` would stop stamping
  // the clock for exactly that session — silently, for the rest of its life, with
  // `<flow> status` reporting the watchdog unarmed and nothing ever arming it. The
  // exposure a null owner opens is small: every other path that reaches a turn end
  // has already claimed ownership, at SessionStart or at `start`.
  if (state.last_session_id !== null && state.last_session_id !== session_id) return null;
  if (isForeignCheckout(active, cwd)) return null;

  try {
    const config = await loadFlowConfig(repoRoot, flowName).catch(() => null);
    const wd = resolveWatchdogConfig(config?.watchdog);

    const crons = input.session_crons ?? [];
    const cronSeen = crons.some((c) => (c.prompt ?? '').includes(WATCHDOG_SENTINEL));

    // "Something else will wake this session" — either work still running, or a
    // scheduled wakeup that is not the watchdog's own. Either way it is not stalled.
    //
    // A MISSING array is treated as "nothing running", not as "unknown". The host
    // sends both arrays whenever the task registry is reachable, so absence means an
    // older client or an unreachable registry — and the failure to prefer is the one
    // that stays visible. Suppressing on absence would make the watchdog do nothing,
    // forever, indistinguishably from a flow that never stalls; not suppressing costs
    // at most `cap` nudges per stage, each of which the developer sees.
    const background =
      (input.background_tasks ?? []).length > 0 ||
      crons.some((c) => !(c.prompt ?? '').includes(WATCHDOG_SENTINEL));

    const nowIso = new Date().toISOString();
    let willAsk = false;
    const written = await patchActiveState(repoRoot, flowName, (cur) => {
      const w = readWatchdog(cur);
      const next: WatchdogState = { ...w, last_stop_at: nowIso, background, cron_seen: cronSeen };
      // Decided against the state as it is at WRITE time, so the ask counter cannot
      // be spent twice by two turns ending back to back.
      willAsk =
        wd.enabled &&
        // The host sets this on a turn that only happened because a Stop hook asked
        // for it. Bailing here is what makes a chain impossible: at most one extra
        // turn per ask, never a second one stacked on top.
        !input.stop_hook_active &&
        !cronSeen &&
        w.cron_asks < MAX_CRON_ASKS;
      if (willAsk) next.cron_asks = w.cron_asks + 1;
      return { watchdog: next };
    });
    // null = the flow completed or was aborted while this turn was ending. Nothing
    // to stamp and nothing to schedule.
    if (!written || !willAsk) return null;

    await appendLog(
      repoRoot, flowName, session_id,
      `WATCHDOG_CRON_ASK attempt=${readWatchdog(written).cron_asks}/${MAX_CRON_ASKS} stage=${state.current_stage}`
    );
    return { additionalContext: cronCreateInstruction(flowName) };
  } catch (e) {
    try {
      await appendLog(repoRoot, flowName, session_id, `ERROR stop: ${truncateError(e)}`);
    } catch { /* appendLog itself failed */ }
    return null;
  }
}
