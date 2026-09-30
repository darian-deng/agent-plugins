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
 * The same status, worded for the DEVELOPER: the SessionStart systemMessage, which
 * never reaches the model. No stage id and no flow id — both are engine vocabulary a
 * developer has to look up. Position plus the stage's `name` instead, and the one
 * thing the developer may have to act on.
 * e.g. "grill-flow 第 5/5 步：知识沉淀 · 这一步已完成，等你确认进下一步"
 * Kept in step with `statusline/subagent-statusline.cjs`, which shows the same line in
 * the agent panel.
 */
export function developerStatusLine(opts: {
  flowName: string;
  stages: ReadonlyArray<{ id: string; name?: string | undefined }>;
  stageId: string;
  gatePending: boolean;
}): string {
  const idx = opts.stages.findIndex((s) => s.id === opts.stageId);
  const name = opts.stages[idx]?.name;
  const where = idx >= 0
    ? `${opts.flowName} 第 ${idx + 1}/${opts.stages.length} 步${name ? `：${name}` : ''}`
    : `${opts.flowName} ${opts.stageId}`;
  return opts.gatePending ? `${where} · 这一步已完成，等你确认进下一步` : where;
}

/** Shown to a session that cannot drive the flow because another one owns it. */
export function readOnlyStatusLine(flowName: string): string {
  return `⚠ ${flowName} 由另一个会话持有，本会话只读；那个会话若已关闭，/clear 即可接管`;
}
