import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';

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
export const MODEL_CONTEXT: Record<string, number> = {
  'claude-opus-4-7': 200_000,
  'claude-sonnet-4-6': 1_000_000, // 1M variant assumed
  'claude-haiku-4-5': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
};

export function contextSizeForModel(model: string): number {
  const envOverride = parseInt(process.env['FEAT_FLOW_CONTEXT_SIZE'] ?? '', 10);
  if (!isNaN(envOverride) && envOverride > 0) return envOverride;
  return MODEL_CONTEXT[model] ?? DEFAULT_CONTEXT_SIZE;
}

// Scope detection: all scopes (user/project/local) share the same cache path,
// so path-based detection is unreliable. Instead, check whether the plugin is
// registered in the project's settings files (project/local scope) or not (user scope).
function hasPluginInSettings(settingsPath: string): boolean {
  try {
    const s = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    const plugins = s['enabledPlugins'] as Record<string, unknown> | undefined;
    return plugins?.['feat-flow@darian-agent-plugins'] === true;
  } catch {
    return false;
  }
}

export function isUserScopeInstall(cwd: string): boolean {
  const projectSettings = join(cwd, '.claude', 'settings.json');
  const localSettings = join(cwd, '.claude', 'settings.local.json');
  const inProject = existsSync(projectSettings) && hasPluginInSettings(projectSettings);
  const inLocal = existsSync(localSettings) && hasPluginInSettings(localSettings);
  return !inProject && !inLocal;
}

export const GLOBAL_SCOPE_ERROR =
  '[feat-flow] ❌ 不支持 user scope（全局）安装\n\n' +
  'feat-flow 管理项目级工作流状态，必须以 project scope 或 local scope 安装。\n\n' +
  '修复步骤：\n' +
  '  1. 在 Claude Code 中卸载全局安装：\n' +
  '     /plugin uninstall feat-flow@darian-agent-plugins\n\n' +
  '  2. 重新安装，选择正确 scope：\n' +
  '     /plugin install feat-flow@darian-agent-plugins\n' +
  '     → 选择：Install for all collaborators on this repository (project scope)\n' +
  '     → 或选择：Install for you, in this repo only (local scope)';
