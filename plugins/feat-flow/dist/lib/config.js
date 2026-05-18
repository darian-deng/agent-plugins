import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
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
// Plugin-level persistent data directory — survives plugin updates.
// Defaults to the standard Claude Code plugin data path when env var is absent.
export function getPluginDataDir() {
    return (process.env['CLAUDE_PLUGIN_DATA'] ??
        join(homedir(), '.claude', 'plugins', 'data', 'feat-flow-darian-agent-plugins'));
}
// Scope detection: all scopes (user/project/local) share the same cache path,
// so path-based detection is unreliable. Instead, check whether the plugin is
// registered in the project's settings files (project/local scope) or not (user scope).
function hasPluginInSettings(settingsPath) {
    try {
        const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        const plugins = s['enabledPlugins'];
        return plugins?.['feat-flow@darian-agent-plugins'] === true;
    }
    catch {
        return false;
    }
}
export function isUserScopeInstall(cwd) {
    const projectSettings = join(cwd, '.claude', 'settings.json');
    const localSettings = join(cwd, '.claude', 'settings.local.json');
    const inProject = existsSync(projectSettings) && hasPluginInSettings(projectSettings);
    const inLocal = existsSync(localSettings) && hasPluginInSettings(localSettings);
    return !inProject && !inLocal;
}
export const GLOBAL_SCOPE_ERROR = 'feat-flow 需要以 project 或 local scope 安装（当前为 user scope）\n\n' +
    '修复：\n' +
    '  claude plugin uninstall feat-flow@darian-agent-plugins\n' +
    '  claude plugin install feat-flow@darian-agent-plugins --scope project';
//# sourceMappingURL=config.js.map