#!/usr/bin/env node
/**
 * The stall watcher: a background process whose only job is to decide WHEN to wake
 * the session, and to stay silent until then.
 *
 * Started by the model with `Bash(run_in_background: true)` on instruction from the
 * `Stop` hook, which also verifies it is running (see watchdog.ts for why the wake
 * has to come from a process finishing rather than from a timer or an inbox message).
 *
 * The contract with the host is the whole design: a backgrounded command's EXIT wakes
 * the session and delivers its stdout. So:
 *   - not stalled  → keep looping. The session is never woken, nothing is printed,
 *                    no tokens are spent, and the developer sees nothing.
 *   - stalled      → print the nudge and exit. That exit is the wake, and the printed
 *                    text is both the model's instruction and the developer's notice
 *                    that the watchdog is the reason work resumed.
 *   - not ours any more (flow gone, different flow instance, different owner)
 *                  → keep looping SILENTLY rather than exiting. Exiting would wake a
 *                    session to tell it nothing, and every exit costs a turn. The host
 *                    reaps this process when the session ends.
 */
import { setTimeout as sleep } from 'timers/promises';
import { readActiveState, patchActiveState, readSignal, isGatePending, appendLog } from '../lib/state.js';
import { loadFlowConfig } from '../lib/flow-config-loader.js';
import {
  readWatchdog,
  resolveWatchdogConfig,
  decideStall,
  nudgeText,
  WATCHDOG_LABEL,
  WATCHER_POLL_MS,
  WATCHER_MAX_LIFETIME_MS,
  withinDedupeWindow,
  watcherCommand,
  type WatchdogState,
} from '../lib/watchdog.js';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? '') : '';
}

const repoRoot = arg('repo');
const flowName = arg('flow');
const flowId = arg('flow-id');
const sessionId = arg('session');

if (!repoRoot || !flowName) {
  process.stderr.write('usage: watch.js --repo <path> --flow <name> --flow-id <id> --session <id>\n');
  process.exit(2);
}

const startedAt = Date.now();

for (;;) {
  await sleep(WATCHER_POLL_MS);

  const state = await readActiveState(repoRoot, flowName).catch(() => null);
  // Flow finished, was aborted, or this is a different instance / a different owner
  // than the one that started us. Not our business — and NOT worth a wake. Checked
  // BEFORE the lifetime exit below, which is the one exit that speaks without having
  // found a stall: firing it here would wake a session hours later to announce the
  // expiry of a watcher for a flow that ended twenty minutes in.
  if (!state) continue;
  if (flowId && state.flow_id !== flowId) continue;
  if (sessionId && state.last_session_id !== null && state.last_session_id !== sessionId) continue;

  if (Date.now() - startedAt > WATCHER_MAX_LIFETIME_MS) {
    // Said out loud rather than done silently, because a watcher that vanished without
    // a word is indistinguishable from one still watching — the failure mode this whole
    // feature exists to end. Carries the replacement command for the same reason the
    // nudge does: the model should not have to reconstruct it.
    process.stdout.write(
      `${WATCHDOG_LABEL} 停滞自检已运行满 12 小时，自行退出。'${flowName}' 仍在进行，` +
        `用 Bash 重新起一个（\`run_in_background: true\`）：\n\n    ` +
        watcherCommand(repoRoot, flowName, state.flow_id, sessionId) + '\n'
    );
    break;
  }

  const config = await loadFlowConfig(repoRoot, flowName).catch(() => null);
  if (!config) continue;

  const w = readWatchdog(state);
  const lastStopAt = w.last_stop_at ? Date.parse(w.last_stop_at) : NaN;
  const lastActivityAt = w.last_activity_at ? Date.parse(w.last_activity_at) : NaN;

  const verdict = decideStall({
    now: Date.now(),
    lastStopAt: Number.isNaN(lastStopAt) ? null : lastStopAt,
    lastActivityAt: Number.isNaN(lastActivityAt) ? null : lastActivityAt,
    background: w.background,
    gatePending: isGatePending(readSignal(repoRoot, flowName), config, state.current_stage),
    nudgesThisStage: w.nudges_this_stage,
    config: resolveWatchdogConfig(config.watchdog),
  });

  if (!verdict.stalled) continue;

  // Claim the nudge against the state as it is at WRITE time, not the copy read
  // above — the hooks write the same document concurrently, and so does any other
  // watcher still alive from an earlier arming.
  let spent = 0;
  let lostRace = false;
  const written = await patchActiveState(repoRoot, flowName, (cur) => {
    const cw = readWatchdog(cur);
    lostRace = withinDedupeWindow(cw.last_nudge_at, Date.now());
    if (lostRace) return {};
    spent = cw.nudges_this_stage + 1;
    const next: WatchdogState = {
      ...cw,
      nudges_this_stage: spent,
      last_nudge_at: new Date().toISOString(),
    };
    return { watchdog: next };
  }).catch(() => null);
  // The flow ended in the moment between deciding and writing. Say nothing.
  if (!written) continue;
  // Another watcher just delivered this one. Go back to sleep rather than exit —
  // exiting is itself a wake, so the duplicate would still cost a turn.
  if (lostRace) continue;

  await appendLog(
    repoRoot, flowName, sessionId || 'watchdog',
    `WATCHDOG_NUDGE stage=${state.current_stage} idle_min=${Math.round(verdict.idleMs / 60_000)}` +
      ` count=${spent}/${resolveWatchdogConfig(config.watchdog).cap}`
  ).catch(() => {});

  process.stdout.write(
    nudgeText({
      flowName,
      stageId: state.current_stage,
      idleMs: verdict.idleMs,
      remaining: verdict.remaining,
      wrapUpPct: state.context_wrap_up.at_pct,
      rearmCommand: watcherCommand(repoRoot, flowName, state.flow_id, sessionId),
    }) + '\n'
  );
  break;
}
