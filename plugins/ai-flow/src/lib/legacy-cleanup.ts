import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { isBuiltinFlow, flowDefDir } from './flow-paths.js';
import { LIVE_CONTEXT_KEYS } from './flow-schema.js';

/**
 * Delete what an old install left in the project, and reduce its config.json to
 * the overrides it actually chose.
 *
 * Before 0.69.0 `/ai-flow:add` copied the whole flow definition into the project
 * and `/ai-flow:update` + `upgrade-flows.cjs` tried to keep the copies in step.
 * Those copies are now dead weight AND actively wrong: the engine reads the
 * definition from the plugin, so a leftover `stages/` in the project is a document
 * nothing executes while looking exactly like the one that does. Worse, a leftover
 * full `config.json` still wins the merge in `loadFlowConfig`, which would pin the
 * flow to whatever stage list and thresholds it was installed with — the drift this
 * change exists to end.
 *
 * So the cleanup deletes rather than parks a copy aside. That is safe in the way
 * that matters: every one of these files is git-tracked in the project that
 * installed them, so `git checkout -- .ai-flow/` brings any of it back. `state/` is
 * never touched — it is gitignored, irreplaceable, and the one thing that is
 * genuinely per-project.
 *
 * ## What survives in the project's config.json
 *
 * Only `context`, and inside it only keys that both still exist in the schema and
 * differ from the plugin's default. Everything else is definition, not tuning:
 * `stages`, `name`, `description` and `schema_version` describe what the flow IS,
 * and a project that wants a different answer to that wants `/ai-flow:create`, not
 * an edited copy of a shipped flow.
 *
 * Dropping keys whose value EQUALS the plugin default is the load-bearing half.
 * A value copied at install time and a value someone chose are byte-identical, so
 * "keep anything the project set" preserves stale defaults forever — measured:
 * four installs still carried `rewarn_delta_pct: 10`, which nobody chose; it was
 * the template's default until it changed to 1, and the copies simply never heard.
 * Equality is the only signal that separates the two, and it is right far more
 * often than it is wrong: re-choosing the default by hand is indistinguishable
 * from inheriting it, and costs nothing when the default later moves.
 */

/** Definition-layer entries an old install copied into the project. */
const LEGACY_ENTRIES = [
  'stages',
  'references',
  'scripts',
  'helper.md',
  'preflight.cjs',
  'preflight.mjs',
  'preflight.sh',
] as const;

export interface LegacyPruneResult {
  /** Entry names deleted from `<repo>/.ai-flow/<flow>/`. */
  removed: string[];
  /** config.json keys dropped, as `key` or `context.key`. */
  configKeysDropped: string[];
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Prune one flow's legacy install. Returns null when there was nothing to do —
 * which is the normal case on every session after the first, so callers can treat
 * null as "stay silent".
 */
export function pruneLegacyInstall(repoRoot: string, flowName: string): LegacyPruneResult | null {
  // A flow the plugin does not ship lives entirely in the project on purpose.
  // Deleting its stages/ would delete the flow.
  if (!isBuiltinFlow(flowName)) return null;

  const anchorDir = join(repoRoot, '.ai-flow', flowName);
  const configPath = join(anchorDir, 'config.json');
  if (!existsSync(configPath)) return null;

  const removed: string[] = [];
  for (const entry of LEGACY_ENTRIES) {
    const p = join(anchorDir, entry);
    if (!existsSync(p)) continue;
    rmSync(p, { recursive: true, force: true });
    removed.push(entry);
  }

  const configKeysDropped: string[] = [];
  const project = readJsonObject(configPath);
  const defaults = readJsonObject(join(flowDefDir(repoRoot, flowName), 'config.json'));
  // A config.json that will not parse is left exactly as it is: rewriting it means
  // guessing what the developer meant, and `loadFlowConfig` already reports it by
  // name. Same for a missing plugin default, which would make every comparison below
  // vacuous and delete the project's whole file.
  if (project && defaults) {
    const kept: Record<string, unknown> = {};
    const defaultContext = (defaults['context'] ?? {}) as Record<string, unknown>;

    for (const [key, value] of Object.entries(project)) {
      if (key !== 'context') {
        configKeysDropped.push(key);
        continue;
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        configKeysDropped.push('context');
        continue;
      }
      const keptContext: Record<string, unknown> = {};
      for (const [ck, cv] of Object.entries(value as Record<string, unknown>)) {
        const isDead = !LIVE_CONTEXT_KEYS.has(ck);
        const isInheritedDefault = JSON.stringify(cv) === JSON.stringify(defaultContext[ck]);
        if (isDead || isInheritedDefault) configKeysDropped.push(`context.${ck}`);
        else keptContext[ck] = cv;
      }
      if (Object.keys(keptContext).length > 0) kept['context'] = keptContext;
    }

    if (configKeysDropped.length > 0) {
      writeFileSync(configPath, JSON.stringify(kept, null, 2) + '\n');
    }
  }

  if (removed.length === 0 && configKeysDropped.length === 0) return null;
  return { removed, configKeysDropped };
}
