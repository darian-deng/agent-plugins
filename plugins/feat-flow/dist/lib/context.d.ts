export declare function readTokenCount(sessionId: string, cwd: string): number;
export declare function contextPct(sessionId: string, cwd: string, contextWindowSize: number): number;
export declare const DEFAULT_CONTEXT_WINDOW = 1000000;
/**
 * Parse context window size from model name.
 * Handles suffix hints like [1m] or [200k] (e.g. "claude-sonnet-4-6[1m]").
 * Falls back to DEFAULT_CONTEXT_WINDOW if unparseable.
 */
export declare function contextWindowForModel(model: string | undefined): number;
//# sourceMappingURL=context.d.ts.map