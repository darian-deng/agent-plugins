export function truncateError(e: unknown, max = 120): string {
  const s = String(e).replace(/\n/g, ' ');
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

/**
 * One-line flow status string shared by the SessionStart systemMessage (shown
 * to the user) and the UserPromptSubmit guidance (injected into the model).
 * Pure formatter — the caller computes gatePending (via isGatePending).
 * e.g. "[feat-flow] 恢复 · stage-5 · gate 待确认 · flow 2026-05-30-05o5"
 */
export function flowStatusLine(opts: {
  flowName: string;
  stageId: string;
  flowId: string;
  gatePending: boolean;
  recovered?: boolean;
}): string {
  const prefix = opts.recovered ? '恢复 · ' : '';
  const gate = opts.gatePending ? ' · gate 待确认' : '';
  return `[${opts.flowName}] ${prefix}${opts.stageId}${gate} · flow ${opts.flowId}`;
}
