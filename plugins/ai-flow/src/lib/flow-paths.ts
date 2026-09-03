import { existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Where a flow's DEFINITION lives versus where its INSTANCE lives.
 *
 * Until 0.68.0 both lived in the project: `/ai-flow:add` copied the whole template
 * (stages, references, scripts, helper.md, preflight, config.json) into
 * `<repo>/.ai-flow/<flow>/`, on the theory that developers would tune the prompts
 * per project. Measured across all 7 installs before this change: not one file had
 * an intentional local edit, every copy differed from the template by 2–25 entries,
 * and all of it was version lag — including two installs stuck a full generation
 * behind (3–4 of 16 references). What the copies actually produced was drift, a
 * double-write burden on every template edit, and self-contradicting documents (a
 * copy's helper.md denying its own config.json).
 *
 * So the definition moved back into the plugin and now travels with the plugin
 * version. The project keeps exactly what is per-project:
 *
 *   <PLUGIN>/.ai-flow/<flow>/   config.json (defaults), helper.md, preflight.cjs,
 *                               stages/, references/, scripts/
 *   <repo>/.ai-flow/<flow>/     config.json (SPARSE overrides, may be `{}`), state/
 *
 * The project's config.json stays — it is also the anchor `resolveActiveFlow` and
 * `discoverFlows` use to answer "which flows is this project running", and dropping
 * it would mean inventing a second marker file for the same job.
 *
 * A flow the plugin does not ship (one `/ai-flow:create` wrote straight into the
 * project) is untouched by all of this: `flowDefDir` falls back to the project copy
 * and the merge below has nothing to merge, so it behaves exactly as before.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Plugin root, from this module's own location — `<root>/dist/lib/flow-paths.js`
 * when installed, `<root>/src/lib/flow-paths.ts` under vitest. Both are two levels
 * down, so the same expression serves. Deliberately not `$CLAUDE_PLUGIN_ROOT`: that
 * is only set for hook commands, and the CLI and tests have no such variable.
 */
export const PLUGIN_ROOT = resolve(__dirname, '..', '..');

/** `<PLUGIN>/.ai-flow` — the flows this plugin version ships. */
export const PLUGIN_FLOWS_DIR = join(PLUGIN_ROOT, '.ai-flow');

/** True when this flow's definition is owned by the plugin (i.e. it ships one). */
export function isBuiltinFlow(flowName: string): boolean {
  return existsSync(join(PLUGIN_FLOWS_DIR, flowName, 'config.json'));
}

/**
 * Where this flow's stages / references / scripts / helper.md / preflight live.
 *
 * The plugin's copy when it ships the flow, the project's otherwise. Substituted
 * into stage prompts as `{{flow_def}}`.
 */
export function flowDefDir(repoRoot: string, flowName: string): string {
  return isBuiltinFlow(flowName)
    ? join(PLUGIN_FLOWS_DIR, flowName)
    : join(repoRoot, '.ai-flow', flowName);
}

/**
 * Where this flow's INSTANCE lives: `state/` and the sparse config.json.
 *
 * Substituted into stage prompts as `{{flow_root}}` — unchanged meaning, on purpose.
 * The two placeholders were split in the direction where a missed rewrite fails
 * LOUDLY: a stale `{{flow_root}}/references/x.md` points at a directory the project
 * no longer has, so Read reports ENOENT. Had `{{flow_root}}` been repointed at the
 * plugin instead, a stale `{{flow_root}}/state/signal` would have written the signal
 * into the plugin directory — where nothing reads it, and nothing reports it either.
 */
export function flowAnchorDir(repoRoot: string, flowName: string): string {
  return join(repoRoot, '.ai-flow', flowName);
}

/** A stage's prompt file, resolved against the definition dir. */
export function stagePromptPath(repoRoot: string, flowName: string, promptRel: string): string {
  return join(flowDefDir(repoRoot, flowName), promptRel);
}
