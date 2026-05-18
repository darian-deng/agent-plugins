import type { FeatFlowState, ActiveMarker } from './types.js';
export declare const paths: (repoRoot: string) => {
    stateDir: string;
    stateJson: string;
    gateToken: string;
    transitionsLog: string;
    violationsLog: string;
    initialized: string;
    marker: string;
};
export declare function readState(repoRoot: string): FeatFlowState | null;
export declare function readMarker(repoRoot: string): ActiveMarker | null;
export declare function hasActiveFlow(repoRoot: string): boolean;
export declare function isSetupDone(repoRoot: string): boolean;
export declare function readGateToken(repoRoot: string): string | null;
export declare function writeState(repoRoot: string, state: FeatFlowState): void;
export declare function writeMarker(repoRoot: string, flowId: string): void;
export declare function removeMarker(repoRoot: string): void;
export declare function writeGateToken(repoRoot: string, token: string): void;
export declare function removeGateToken(repoRoot: string): void;
export declare function appendTransition(repoRoot: string, event: string): void;
export declare function makeInitialState(opts: {
    flowId: string;
    requirement: string;
    baseSha: string;
    sessionId: string;
    contextSize: number;
}): FeatFlowState;
export declare function advanceStage(state: FeatFlowState): FeatFlowState;
//# sourceMappingURL=state.d.ts.map