import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
const thisFile = fileURLToPath(import.meta.url);
// src/lib/config.ts → src/lib → src → plugin-root
export const PLUGIN_ROOT = dirname(dirname(dirname(thisFile)));
// Stage docs and helper live at plugin root — NOT in skills/ (which would
// register them as slash commands). These are internal reference files read
// programmatically by hook handlers, not user-invocable skills.
export const STAGES_DIR = join(PLUGIN_ROOT, 'stages');
export const HELPER_PATH = join(PLUGIN_ROOT, 'helper.md');
export const SETUP_VERSION = '1.0.0';
export const DEFAULT_CONTEXT_SIZE = 1_000_000;
/** Context warning thresholds */
export const WARN_PCT = 35;
export const URGENT_PCT = 55;
export const REWARN_DELTA_PCT = 5;
/** Model name → context window size lookup */
export const MODEL_CONTEXT = {
    'claude-opus-4-7': 200_000,
    'claude-sonnet-4-6': 1_000_000, // 1M variant assumed
    'claude-haiku-4-5': 200_000,
    'claude-haiku-4-5-20251001': 200_000,
};
export function contextSizeForModel(model) {
    const envOverride = parseInt(process.env['FEAT_FLOW_CONTEXT_SIZE'] ?? '', 10);
    if (!isNaN(envOverride) && envOverride > 0)
        return envOverride;
    return MODEL_CONTEXT[model] ?? DEFAULT_CONTEXT_SIZE;
}
// User-scope (global) install detection: plugin files land under
// ~/.claude/plugins/cache/ for user scope, inside the project for
// project/local scope.
const GLOBAL_CACHE = join(homedir(), '.claude', 'plugins', 'cache');
export function isGlobalInstall() {
    return PLUGIN_ROOT.startsWith(GLOBAL_CACHE);
}
export const GLOBAL_SCOPE_ERROR = '[feat-flow] ❌ 不支持 user scope（全局）安装\n\n' +
    'feat-flow 管理项目级工作流状态，必须以 project scope 或 local scope 安装。\n\n' +
    '修复步骤：\n' +
    '  1. 在 Claude Code 中卸载全局安装：\n' +
    '     /plugin uninstall feat-flow@darian-agent-plugins\n\n' +
    '  2. 重新安装，选择正确 scope：\n' +
    '     /plugin install feat-flow@darian-agent-plugins\n' +
    '     → 选择：Install for all collaborators on this repository (project scope)\n' +
    '     → 或选择：Install for you, in this repo only (local scope)';
//# sourceMappingURL=config.js.map