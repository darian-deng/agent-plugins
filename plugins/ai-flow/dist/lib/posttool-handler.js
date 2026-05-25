import { hasActiveFlow, writeActiveState } from './state.js';
import { contextPct, DEFAULT_CONTEXT_WINDOW } from './context.js';
import { loadFlowConfig } from './flow-config-loader.js';
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const DEFAULT_WARN_AT_PCT = 50;
const DEFAULT_REWARN_DELTA_PCT = 5;
export async function handlePostTool(input) {
    const { cwd: repoRoot, tool_name, session_id, context_size_pct } = input;
    const active = await hasActiveFlow(repoRoot);
    if (!active)
        return null;
    if (!WRITE_TOOLS.has(tool_name))
        return null;
    const { flowName, state } = active;
    // Load flow config to get per-flow context thresholds.
    let flowContextCfg;
    try {
        const config = await loadFlowConfig(repoRoot, flowName);
        flowContextCfg = config.context;
    }
    catch { /* non-fatal: fall back to defaults */ }
    // Use injected value (tests / future hook support) or compute from transcript.
    const contextWindow = state.context_size > 0 ? state.context_size : DEFAULT_CONTEXT_WINDOW;
    const pct = context_size_pct ?? contextPct(session_id, repoRoot, contextWindow);
    const warning = state.context_warning;
    const warnAt = flowContextCfg?.warn_at_pct ?? DEFAULT_WARN_AT_PCT;
    const rewarnDelta = flowContextCfg?.rewarn_delta_pct ?? DEFAULT_REWARN_DELTA_PCT;
    const blockAt = flowContextCfg?.block_at_pct;
    // ─── Block threshold ───────────────────────────────────────────────────────
    if (blockAt !== undefined && pct >= blockAt) {
        if (!state.context_blocked) {
            const updated = {
                ...state,
                context_blocked: true,
                context_warning: { warned: true, warned_at_pct: pct, warned_at: new Date().toISOString() },
            };
            await writeActiveState(repoRoot, flowName, updated);
        }
        return {
            additionalContext: `CONTEXT BLOCKED at ${pct}% (threshold: ${blockAt}%). ` +
                `All write tools are now denied. Run /clear to continue — state is persisted and progress won't be lost.`,
        };
    }
    // ─── Warn threshold ────────────────────────────────────────────────────────
    if (pct < warnAt)
        return null;
    const prevPct = warning.warned_at_pct ?? 0;
    if (warning.warned && pct < prevPct + rewarnDelta)
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