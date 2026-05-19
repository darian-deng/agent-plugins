export declare const VALID_COMMANDS: readonly ["start", "approve", "abort", "resume", "status", "help"];
export type FlowCommand = (typeof VALID_COMMANDS)[number];
export declare function parseFlowCommand(prompt: string, knownFlows: string[]): {
    flowName: string;
    subCmd: string;
    args: string;
} | null;
//# sourceMappingURL=router.d.ts.map