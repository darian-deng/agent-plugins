import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
