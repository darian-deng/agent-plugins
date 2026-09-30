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

/**
 * The same status for the DEVELOPER: the SessionStart systemMessage, which never reaches
 * the model. Keeps the stage id — stage prompts and flow messages all say `stage-x` — and
 * drops the flow id. Kept in step with `statusline/subagent-statusline.cjs`.
 * e.g. "grill-flow stage-5 · 等你 approve"
 */
export function developerStatusLine(opts: { flowName: string; stageId: string; gatePending: boolean }): string {
  const where = `${opts.flowName} ${opts.stageId}`;
  return opts.gatePending ? `${where} · 等你 approve` : where;
}

/** Shown to a session that cannot drive the flow because another one owns it. */
export function readOnlyStatusLine(flowName: string): string {
  return `⚠ ${flowName} 由另一个会话持有，本会话只读；那个会话若已关闭，/clear 即可接管`;
}
