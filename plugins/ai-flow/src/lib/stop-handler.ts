import type { StopInput } from './types.js';
import { resolveActiveFlow, patchActiveState, appendLog, isForeignCheckout, readHold, readSignal, isGatePending, holdPath } from './state.js';
import { loadFlowConfig, getStageConfig } from './flow-config-loader.js';
import { truncateError } from './format.js';
import { runScript } from './script-executor.js';
import { flowDefDir, flowAnchorDir } from './flow-paths.js';
import {
  MAX_ARM_ASKS,
  readWatchdog,
  resolveWatchdogConfig,
  armInstruction,
  isOwnWatcher,
  classifyInFlight,
  WATCHDOG_LABEL,
  type WatchdogState,
} from './watchdog.js';

/** Exit code a stage's `stop_guard` script uses to say "this stop is a stall; continue". */
export const STOP_GUARD_CONTINUE_EXIT = 3;
export const STOP_GUARD_LABEL = '[ai-flow:stop-guard]';

/**
 * End of a model turn. Three jobs, none of which blocks.
 *
 *  1. Stamp what the stall watcher reads: when this session stopped, and what kind
 *     of background work was still in flight at that moment.
 *  2. If the session's own watcher is not running, ask the model to start it — the
 *     reason the watchdog can be trusted at all (a hook cannot start a background
 *     task, but `background_tasks` lets it verify that the model did).
 *  3. Run the stage's `stop_guard` script, if it declares one, and relay its verdict.
 *     The engine supplies the mechanical facts it alone can see (what is in flight,
 *     whether a hold exists, who started the turn); the flow supplies the judgement
 *     of whether the stop was warranted (which tickets could have been opened).
 *
 * Deliberately never returns `decision: "block"` — `additionalContext` continues the
 * conversation through the same protections, without surfacing as a hook error. And
 * job 3 is skipped for a turn the DEVELOPER started: at that instant they are usually
 * still reading, and the watchdog's idle rule (job 1) is the right instrument for
 * them. The guard is for the turn nobody started — a subagent's report, a timer, a
 * previous continuation — where the model's "next turn I'll…" has no next turn.
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
    // Own watcher, scoped to THIS session and THIS flow instance. A watcher inherited
    // across `/clear` (same host process) or left over from a finished flow keeps
    // looping rather than exiting, so any looser match reports the session as armed
    // while nothing that will ever speak to it is watching.
    const watcherSeen = tasks.some((t) => isOwnWatcher(t.command, state.flow_id, session_id));

    // What will wake this session, by kind. A subagent ends; a shell task may be a
    // timer (ends) or a dev server (never does) — the watcher applies a longer fuse to
    // the latter rather than an absolute exemption. Any watcher is excluded: counting
    // one would make its own presence suppress every nudge it exists to deliver, and
    // the inherited one is exactly the shape this must not mistake for work.
    //
    // A MISSING array is read as "nothing running", not as "unknown". The host sends
    // both arrays whenever the task registry is reachable, so absence means an older
    // client — and the failure to prefer is the visible one. Suppressing on absence
    // would make the watchdog do nothing, forever, indistinguishably from a flow that
    // never stalls; not suppressing costs at most `cap` nudges per stage.
    const inFlight = classifyInFlight(tasks);
    const crons = (input.session_crons ?? []).length > 0;
    const agentsInFlight = inFlight.agents || crons;

    const nowIso = new Date().toISOString();
    let willAsk = false;
    let developerTurn = false;
    const written = await patchActiveState(repoRoot, flowName, (cur) => {
      const w = readWatchdog(cur);
      // Decided against the previous stop, before this one overwrites it: the turn
      // that just ended was the developer's if they typed after the last turn end.
      developerTurn =
        w.last_user_prompt_at !== null &&
        (w.last_stop_at === null || Date.parse(w.last_user_prompt_at) > Date.parse(w.last_stop_at));
      const next: WatchdogState = {
        ...w,
        last_stop_at: nowIso,
        background: agentsInFlight || inFlight.bash,
        agents_in_flight: agentsInFlight,
        bash_in_flight: inFlight.bash,
        bash_tasks: inFlight.bashTasks,
        watcher_seen: watcherSeen,
      };
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
    if (!written) return null;

    const out: string[] = [];
    if (willAsk) {
      await appendLog(
        repoRoot, flowName, session_id,
        `WATCHDOG_ARM_ASK attempt=${readWatchdog(written).arm_asks}/${MAX_ARM_ASKS} stage=${state.current_stage}`
      );
      out.push(armInstruction(repoRoot, flowName, state.flow_id, session_id));
    }

    // ─── Stage stop guard ────────────────────────────────────────────────────────
    // Only when nothing mechanical explains the stop: no subagent will wake the
    // session, no gate is waiting on the developer, no hold names what is waited for,
    // and the developer did not start this turn. Shell tasks do not exempt — the
    // guard's most frequent target is a session that "left a dev instance running"
    // and stopped, and the script sees `bash_in_flight` to weigh it itself.
    const guard = config && getStageConfig(config, state.current_stage).stop_guard;
    if (
      guard &&
      wd.enabled &&
      !input.stop_hook_active &&
      !agentsInFlight &&
      !developerTurn &&
      readHold(repoRoot, flowName) === null &&
      !isGatePending(readSignal(repoRoot, flowName), config, state.current_stage)
    ) {
      const facts = {
        flow_id: state.flow_id,
        stage: state.current_stage,
        session_id,
        bash_in_flight: inFlight.bash,
        bash_tasks: inFlight.bashTasks,
        hold_path: holdPath(repoRoot, flowName),
        wrap_up_pct: state.context_wrap_up.at_pct,
        last_assistant_message: (input.last_assistant_message ?? '').slice(-4000),
      };
      const res = await runScript(guard, flowDefDir(repoRoot, flowName), {
        timeout_ms: 20_000,
        env: {
          AI_FLOW_FLOW_DIR: flowAnchorDir(repoRoot, flowName),
          AI_FLOW_PROJECT_ROOT: repoRoot,
          AI_FLOW_STOP_FACTS: JSON.stringify(facts),
        },
      });
      if (res.status === STOP_GUARD_CONTINUE_EXIT) {
        const text = res.output.trim();
        await appendLog(repoRoot, flowName, session_id, `STOP_GUARD_CONTINUE stage=${state.current_stage}`);
        out.push(text.startsWith(STOP_GUARD_LABEL) ? text : `${STOP_GUARD_LABEL} ${text}`);
      } else if (!res.ok) {
        // A broken guard must be visible in the log, never in the model's context:
        // failing open here costs one missed continuation; failing closed would
        // manufacture a turn out of a script bug.
        await appendLog(repoRoot, flowName, session_id, `ERROR stop_guard: ${truncateError(res.reason)}`);
      }
    }

    if (out.length === 0) return null;
    return { additionalContext: out.join('\n\n') };
  } catch (e) {
    try {
      await appendLog(repoRoot, flowName, session_id, `ERROR stop: ${truncateError(e)}`);
    } catch { /* appendLog itself failed */ }
    return null;
  }
}

/** Exported for `<flow> status`: says whether a hold is what is keeping the watchdog quiet. */
export function describeHold(repoRoot: string, flowName: string): string | null {
  const h = readHold(repoRoot, flowName);
  return h === null ? null : `${WATCHDOG_LABEL} state/hold 在：${h.split('\n')[0]}`;
}
