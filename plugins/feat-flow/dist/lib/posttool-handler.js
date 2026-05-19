import { hasActiveFlow, writeActiveState } from './state.js';
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const DEFAULT_WARN_AT_PCT = 70;
const DEFAULT_BLOCK_AT_PCT = 90;
const DEFAULT_REWARN_DELTA_PCT = 10;
export async function handlePostTool(input) {
    const { cwd: repoRoot, tool_name, context_size_pct } = input;
    const active = await hasActiveFlow(repoRoot);
    if (!active)
        return null;
    if (!WRITE_TOOLS.has(tool_name))
        return null;
    const { flowName, state } = active;
    const pct = context_size_pct ?? 0;
    const config_warn = state.context_warning;
    const warnAt = DEFAULT_WARN_AT_PCT;
    const rewarnDelta = DEFAULT_REWARN_DELTA_PCT;
    if (pct < warnAt)
        return null;
    const prevPct = config_warn.warned_at_pct ?? 0;
    if (config_warn.warned && pct < prevPct + rewarnDelta)
        return null;
    const updated = {
        ...state,
        context_warning: { warned: true, warned_at_pct: pct, warned_at: new Date().toISOString() },
    };
    await writeActiveState(repoRoot, flowName, updated);
    return {
        additionalContext: `Context at ${pct}%. When you finish the current task, run /clear — state is persisted and progress won't be lost.`,
    };
}
//# sourceMappingURL=posttool-handler.js.map