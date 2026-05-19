import type { PreToolInput } from './types.js';
export interface PreToolResult {
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    systemMessage?: string;
}
export declare function handlePreTool(input: PreToolInput): Promise<PreToolResult | null>;
//# sourceMappingURL=pretool-handler.d.ts.map