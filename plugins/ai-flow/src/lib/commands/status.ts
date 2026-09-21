import { readActiveState, readSignal, isGatePending, nextStage } from '../state.js';
import { readWatchdog, resolveWatchdogConfig, MAX_CRON_ASKS } from '../watchdog.js';
import { loadFlowConfig, getStageConfig, resolveDocsPaths } from '../flow-config-loader.js';
import type { CommandResult } from '../types.js';

export async function handleStatus(repoRoot: string, flowName: string): Promise<CommandResult> {
  const state = await readActiveState(repoRoot, flowName);
  if (!state) {
    return { action: 'allow', additionalContext: `No active flow for '${flowName}'. Run '${flowName} start <requirement>' to begin.` };
  }

  const lines: string[] = [
    `Flow: ${state.flow_name}`,
    `flow_id: ${state.flow_id}`,
    `current_stage: ${state.current_stage}`,
    `requirement: ${state.requirement}`,
  ];

  let gateActive = false;
  let gateTerminal = false;
  // Empty means "nothing is refused", and it says so for both reasons it can be
  // empty: the stage declares no docs_paths (pretool then skips the wrap-up refusal
  // — it has no safe exit to keep open), or the config would not load at all (in
  // which case pretool's catch-all has already dropped every guard). Both end in the
  // same observable state, so one line covers them.
  let wrapUpDocs: string[] = [];
  let watchdogCfg: { enabled?: boolean | undefined; idle_minutes?: number | undefined } | undefined;
  try {
    const config = await loadFlowConfig(repoRoot, flowName);
    watchdogCfg = config.watchdog;
    const signal = readSignal(repoRoot, flowName);
    gateActive = isGatePending(signal, config, state.current_stage);
    gateTerminal = nextStage(config, state.current_stage) === null;
    wrapUpDocs = resolveDocsPaths(
      getStageConfig(config, state.current_stage).docs_paths ?? [],
      state.flow_id
    );
  } catch { /* non-fatal */ }

  if (gateActive) {
    lines.push('', gateTerminal
      ? `Gate pending — run '${flowName} approve' to confirm and end the flow.`
      : `Gate pending — run '${flowName} approve' to advance to the next stage.`);
  }

  if (state.context_wrap_up.at_pct !== null) {
    lines.push('', wrapUpDocs.length > 0
      ? `Context wrap-up started at ${state.context_wrap_up.at_pct}% used — writes to the codebase are refused; writes to ${wrapUpDocs.join(', ')} stay open so a handoff can land.`
      : `Context wrap-up started at ${state.context_wrap_up.at_pct}% used — stage '${state.current_stage}' declares no docs_paths, so no write is being refused (refusing them would leave nowhere to write the handoff). Land the handoff in the repo and /clear.`);
  }

  // Whether the stall watchdog is actually armed. Every way this feature breaks —
  // the model never created the cron, `CLAUDE_CODE_DISABLE_CRON=1`, the flow turned
  // it off, a host with no scheduler at all — looks exactly like "nothing ever
  // stalled" from the outside. This line is where that difference becomes visible.
  const w = readWatchdog(state);
  const wdCfg = resolveWatchdogConfig(watchdogCfg);
  if (!wdCfg.enabled) {
    lines.push('', 'watchdog: 已关闭（config.watchdog.enabled=false 或 AI_FLOW_WATCHDOG=0）');
  } else if (w.cron_seen) {
    lines.push('', `watchdog: 已武装，静置阈值 ${Math.round(wdCfg.idleMs / 60_000)} 分钟，` +
      `本 stage 已催 ${w.nudges_this_stage}/${wdCfg.cap} 次` +
      (w.last_nudge_at ? `（最近一次 ${w.last_nudge_at}）` : ''));
  } else if (w.cron_asks >= MAX_CRON_ASKS) {
    lines.push('', `watchdog: 未武装 — 已让本 session 建定时自检 ${w.cron_asks} 次都没建成，不再重试。` +
      `可能是宿主停用了定时任务（CLAUDE_CODE_DISABLE_CRON=1）。停滞不会被发现。`);
  } else {
    lines.push('', `watchdog: 未武装 — 定时自检还没建起来（已提醒 ${w.cron_asks}/${MAX_CRON_ASKS} 次，下次回合结束再提醒）`);
  }

  return { action: 'allow', additionalContext: lines.join('\n') };
}
