export declare const PLUGIN_ROOT: string;
export declare const STAGES_DIR: string;
export declare const HELPER_PATH: string;
export declare const SETUP_VERSION = "1.0.0";
export declare const DEFAULT_CONTEXT_SIZE = 1000000;
/** Context warning thresholds */
export declare const WARN_PCT = 35;
export declare const URGENT_PCT = 55;
export declare const REWARN_DELTA_PCT = 5;
/** Model name → context window size lookup */
export declare const MODEL_CONTEXT: Record<string, number>;
export declare function contextSizeForModel(model: string): number;
export declare function isUserScopeInstall(cwd: string): boolean;
export declare const GLOBAL_SCOPE_ERROR: string;
//# sourceMappingURL=config.d.ts.map