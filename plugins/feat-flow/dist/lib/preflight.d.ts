export interface PreflightResult {
    ok: boolean;
    errors: string[];
    warnings: string[];
}
export declare function runPreflight(repoRoot: string): PreflightResult;
export declare function getBaseSha(repoRoot: string): string;
//# sourceMappingURL=preflight.d.ts.map