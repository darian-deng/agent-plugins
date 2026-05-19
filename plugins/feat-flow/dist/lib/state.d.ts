import type { FlowConfig } from './flow-schema.js';
export interface ContextWarning {
    warned: boolean;
    warned_at_pct: number | null;
    warned_at: string | null;
}
export interface ActiveState {
    flow_id: string;
    flow_name: string;
    requirement: string;
    current_stage: string;
    base_sha: string;
    started_at: string;
    last_session_id: string | null;
    context_size: number;
    context_warning: ContextWarning;
}
export declare function readActiveState(repoRoot: string, flowName: string): Promise<ActiveState | null>;
export declare function writeActiveState(repoRoot: string, flowName: string, state: ActiveState): Promise<void>;
export declare function hasActiveFlow(repoRoot: string): Promise<{
    flowName: string;
    state: ActiveState;
} | null>;
export declare function isGateActive(repoRoot: string, flowName: string): Promise<boolean>;
export declare function writeGateToken(repoRoot: string, flowName: string, token: string): Promise<void>;
export declare function deleteGateToken(repoRoot: string, flowName: string): Promise<void>;
export declare function readGateToken(repoRoot: string, flowName: string): Promise<string | null>;
export declare function appendTransition(repoRoot: string, flowName: string, message: string): Promise<void>;
export declare function appendViolation(repoRoot: string, flowName: string, message: string): Promise<void>;
export declare function nextStage(config: FlowConfig, currentStageId: string): string | null;
export declare function signalPath(repoRoot: string, flowName: string): string;
export declare function activeJsonPath(repoRoot: string, flowName: string): string;
export declare function gateTokenPath(repoRoot: string, flowName: string): string;
export declare function scriptsDir(repoRoot: string, flowName: string): string;
//# sourceMappingURL=state.d.ts.map