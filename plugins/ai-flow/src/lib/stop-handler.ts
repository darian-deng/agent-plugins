import type { StopInput } from './types.js';
import { resolveActiveFlow, patchActiveState, appendLog, isForeignCheckout } from './state.js';
import { loadFlowConfig } from './flow-config-loader.js';
import { truncateError } from './format.js';
import {
  MAX_ARM_ASKS,
  readWatchdog,
  resolveWatchdogConfig,
  armInstruction,
  isWatcherTask,
  type WatchdogState,
} from './watchdog.js';

/**
 * End of a model turn. Two jobs, and neither of them blocks.
 *
 *  1. Stamp what the stall watcher reads: when this session stopped, and whether
 *     background work was still in flight at that moment.
 *  2. If the watcher is not running, ask the model to start it — the one case where
 *     this hook returns anything, and the reason the watchdog can be trusted at all
 *     (a hook cannot start a background task, but `background_tasks` lets it verify
 *     that the model did).
 *
 * Deliberately never returns `decision: "block"`. Stop fires at the ZEROTH second of
 * idleness — the developer is usually still reading the answer they just got — so a
 * "you should not have stopped" continuation issued here would talk over them, and at
 * that instant nothing mechanical separates a legitimate hand-back from a stall. The
 * wait is what separates them, and Stop cannot express a wait: its only clock is the
 * next turn end, which is exactly what a stalled session never produces.
 */
export async function handleStop(input: StopInput): Promise<{ additionalContext: string } | null> {
  const { cwd, session_id } = input;

  // A subagent's turn end arrives as SubagentStop, but the host also converts a
  // subagent-scoped Stop hook into one, and a subagent shares its parent's session_id.
  // Branch on presence, never on a value — a client that never sends agent_id must
  // keep behaving as before.
  if (input.agent_id !== undefined) return null;

  const active = await resolveActiveFlow(cwd, session_id).catch(() => null);
  if (!active) return null;

  const { flowName, state, repoRoot } = active;

  // Only the session executing the flow takes part. A second session opened against
  // the same project never becomes the owner (session-handler returns early for it
  // before binding), and a session in another checkout is not part of this flow.
  //
  // The test matches posttool-handler's: a null owner passes. It must, because
  // `<flow> resume` writes `last_session_id: null` on purpose ("left null so the next
  // SessionStart binds normally") and the session that typed the command keeps driving
  // the flow from there. Requiring `=== session_id` would stop stamping the clock for
  // exactly that session, silently, for the rest of its life.
  if (state.last_session_id !== null && state.last_session_id !== session_id) return null;
  if (isForeignCheckout(active, cwd)) return null;

  try {
    const config = await loadFlowConfig(repoRoot, flowName).catch(() => null);
    const wd = resolveWatchdogConfig(config?.watchdog);

    const tasks = input.background_tasks ?? [];
    // Scoped to THIS flow instance: a watcher left over from a finished flow keeps
    // looping rather than exiting, so an unscoped match would report the next flow as
    // armed while nothing watches it.
    const watcherSeen = tasks.some((t) => isWatcherTask(t.command, state.flow_id));

    // "Something else will wake this session" — work still running, or a scheduled
    // wakeup. Either way it is not stalled. The watcher itself is excluded: counting
    // it would make its own presence suppress every nudge it exists to deliver.
    //
    // A MISSING array is read as "nothing running", not as "unknown". The host sends
    // both arrays whenever the task registry is reachable, so absence means an older
    // client — and the failure to prefer is the visible one. Suppressing on absence
    // would make the watchdog do nothing, forever, indistinguishably from a flow that
    // never stalls; not suppressing costs at most `cap` nudges per stage.
    const background =
      tasks.some((t) => !isWatcherTask(t.command)) ||
      (input.session_crons ?? []).length > 0;

    const nowIso = new Date().toISOString();
    let willAsk = false;
    const written = await patchActiveState(repoRoot, flowName, (cur) => {
      const w = readWatchdog(cur);
      const next: WatchdogState = { ...w, last_stop_at: nowIso, background, watcher_seen: watcherSeen };
      // Seeing a watcher means every ask so far worked, so the give-up counter starts
      // over. It must: delivering a nudge KILLS the watcher (the exit is the wake), so
      // over a long flow the asks are routine re-arms, not failures. Left accumulating,
      // three successful arms would exhaust the budget and `<flow> status` would report
      // "asked three times, never started" about a watcher that started every time.
      if (watcherSeen) next.arm_asks = 0;
      // Decided against the state as it is at WRITE time, so two turns ending back to
      // back cannot spend the ask counter twice.
      willAsk =
        wd.enabled &&
        // The host sets this on a turn that only happened because a Stop hook asked
        // for it. Bailing here is what makes a chain impossible: at most one extra
        // turn per ask, never a second stacked on top.
        !input.stop_hook_active &&
        !watcherSeen &&
        w.arm_asks < MAX_ARM_ASKS;
      if (willAsk) next.arm_asks = w.arm_asks + 1;
      return { watchdog: next };
    });
    // null = the flow completed or was aborted while this turn was ending.
    if (!written || !willAsk) return null;

    await appendLog(
      repoRoot, flowName, session_id,
      `WATCHDOG_ARM_ASK attempt=${readWatchdog(written).arm_asks}/${MAX_ARM_ASKS} stage=${state.current_stage}`
    );
    return { additionalContext: armInstruction(repoRoot, flowName, state.flow_id, session_id) };
  } catch (e) {
    try {
      await appendLog(repoRoot, flowName, session_id, `ERROR stop: ${truncateError(e)}`);
    } catch { /* appendLog itself failed */ }
    return null;
  }
}
