import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { pruneLegacyInstall } from '../src/lib/legacy-cleanup.js';
import { loadFlowConfig } from '../src/lib/flow-config-loader.js';
import { handleSessionStart } from '../src/lib/session-handler.js';
import { PLUGIN_FLOWS_DIR } from '../src/lib/flow-paths.js';

// `grill-flow` on purpose: the cleanup only acts on flows the PLUGIN ships, so a
// made-up name would exercise the "leave it alone" branch and prove nothing. The
// plugin's own copy is the source of truth these fixtures are compared against.
const BUILTIN = 'grill-flow';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) execSync(`rm -rf "${d}"`);
  dirs = [];
});

function pluginDefaults(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PLUGIN_FLOWS_DIR, BUILTIN, 'config.json'), 'utf-8')) as Record<string, unknown>;
}

/** A project as `/ai-flow:add` left it before 0.69.0: the whole template copied in. */
function legacyInstall(flowName: string, config: unknown) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ai-flow-legacy-'));
  dirs.push(repoRoot);
  const flowDir = join(repoRoot, '.ai-flow', flowName);
  mkdirSync(join(flowDir, 'stages'), { recursive: true });
  mkdirSync(join(flowDir, 'references', 'assets'), { recursive: true });
  mkdirSync(join(flowDir, 'scripts'), { recursive: true });
  mkdirSync(join(flowDir, 'state'), { recursive: true });
  writeFileSync(join(flowDir, 'stages', 'stage-1.md'), '# stale copy\n');
  writeFileSync(join(flowDir, 'references', 'handoff.md'), '# stale copy\n');
  writeFileSync(join(flowDir, 'references', 'assets', 'viewer.css'), 'body{}\n');
  writeFileSync(join(flowDir, 'scripts', 'gate-stage-2.cjs'), 'process.exit(0);\n');
  writeFileSync(join(flowDir, 'helper.md'), '# stale copy\n');
  writeFileSync(join(flowDir, 'preflight.cjs'), 'process.exit(0);\n');
  writeFileSync(join(flowDir, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(flowDir, 'state', 'active.json'), '{"flow_id":"keep-me"}');
  writeFileSync(join(flowDir, 'state', 'flow.log'), 'keep me too\n');
  return { repoRoot, flowDir };
}

describe('pruneLegacyInstall', () => {
  it('deletes every definition entry an old install copied in', () => {
    const { repoRoot, flowDir } = legacyInstall(BUILTIN, pluginDefaults());

    const result = pruneLegacyInstall(repoRoot, BUILTIN);

    expect(result?.removed.sort()).toEqual(
      ['helper.md', 'preflight.cjs', 'references', 'scripts', 'stages']
    );
    for (const gone of ['stages', 'references', 'scripts', 'helper.md', 'preflight.cjs']) {
      expect(existsSync(join(flowDir, gone))).toBe(false);
    }
  });

  it('never touches state/ — it is gitignored, so deleting it loses the flow', () => {
    const { repoRoot, flowDir } = legacyInstall(BUILTIN, pluginDefaults());

    pruneLegacyInstall(repoRoot, BUILTIN);

    expect(readFileSync(join(flowDir, 'state', 'active.json'), 'utf-8')).toContain('keep-me');
    expect(readFileSync(join(flowDir, 'state', 'flow.log'), 'utf-8')).toBe('keep me too\n');
  });

  it('reduces a full copied config.json to an empty override', () => {
    const { repoRoot, flowDir } = legacyInstall(BUILTIN, pluginDefaults());

    const result = pruneLegacyInstall(repoRoot, BUILTIN);

    // Every key matched the plugin's, so nothing in it was a decision.
    expect(JSON.parse(readFileSync(join(flowDir, 'config.json'), 'utf-8'))).toEqual({});
    expect(result?.configKeysDropped).toContain('stages');
    expect(result?.configKeysDropped).toContain('context.wrap_up_at_pct');
  });

  it('drops keys this version no longer has, and defaults copied in at install time', () => {
    // The measured shape: four installs carried `rewarn_delta_pct: 10` — never
    // chosen, just the template's default at the time, frozen by the copy.
    const { repoRoot, flowDir } = legacyInstall(BUILTIN, {
      ...pluginDefaults(),
      context: { warn_at_pct: 50, block_at_pct: 60, rewarn_delta_pct: 10, wrap_up_at_pct: 60 },
    });

    const result = pruneLegacyInstall(repoRoot, BUILTIN);

    expect(JSON.parse(readFileSync(join(flowDir, 'config.json'), 'utf-8'))).toEqual({});
    for (const dead of ['context.warn_at_pct', 'context.block_at_pct', 'context.rewarn_delta_pct']) {
      expect(result?.configKeysDropped).toContain(dead);
    }
  });

  it('keeps a live context key the project set to something other than the default', () => {
    const defaults = pluginDefaults();
    const defaultPct = (defaults['context'] as { wrap_up_at_pct: number }).wrap_up_at_pct;
    const chosen = defaultPct === 70 ? 75 : 70;
    const { repoRoot, flowDir } = legacyInstall(BUILTIN, {
      ...defaults,
      context: { wrap_up_at_pct: chosen },
    });

    pruneLegacyInstall(repoRoot, BUILTIN);

    expect(JSON.parse(readFileSync(join(flowDir, 'config.json'), 'utf-8')))
      .toEqual({ context: { wrap_up_at_pct: chosen } });
  });

  it('leaves a flow the plugin does not ship completely alone', () => {
    // `/ai-flow:create` writes custom flows straight into the project; their stages
    // ARE the flow, so pruning them would delete it.
    const { repoRoot, flowDir } = legacyInstall('my-custom-flow', {
      schema_version: '1.0',
      name: 'my-custom-flow',
      stages: [{ id: 's1', prompt: 'stages/stage-1.md', write_scope: 'unrestricted', completion: { gate: true } }],
    });

    expect(pruneLegacyInstall(repoRoot, 'my-custom-flow')).toBeNull();
    expect(existsSync(join(flowDir, 'stages', 'stage-1.md'))).toBe(true);
    expect(JSON.parse(readFileSync(join(flowDir, 'config.json'), 'utf-8'))).toHaveProperty('stages');
  });

  it('is idempotent — the second run reports nothing to do', () => {
    const { repoRoot } = legacyInstall(BUILTIN, pluginDefaults());

    expect(pruneLegacyInstall(repoRoot, BUILTIN)).not.toBeNull();
    // Null is what callers key "stay silent" off, so this is the difference between
    // migrating once and logging a migration on every session forever.
    expect(pruneLegacyInstall(repoRoot, BUILTIN)).toBeNull();
  });

  it('leaves an unparseable config.json exactly as it is, but still prunes the copies', () => {
    const { repoRoot, flowDir } = legacyInstall(BUILTIN, pluginDefaults());
    writeFileSync(join(flowDir, 'config.json'), '{ not json');

    const result = pruneLegacyInstall(repoRoot, BUILTIN);

    // Rewriting it would mean guessing what the developer meant; loadFlowConfig
    // already reports the file by name.
    expect(readFileSync(join(flowDir, 'config.json'), 'utf-8')).toBe('{ not json');
    expect(result?.configKeysDropped).toEqual([]);
    expect(result?.removed).toContain('stages');
  });
});

describe('config merge — plugin defaults under the project override', () => {
  function overrideOnly(config: unknown) {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ai-flow-merge-'));
    dirs.push(repoRoot);
    const flowDir = join(repoRoot, '.ai-flow', BUILTIN);
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, 'config.json'), JSON.stringify(config, null, 2));
    return repoRoot;
  }

  it('an empty override yields the plugin config verbatim', async () => {
    const config = await loadFlowConfig(overrideOnly({}), BUILTIN);
    const defaults = pluginDefaults();

    expect(config.name).toBe(BUILTIN);
    expect(config.stages.map((s) => s.id)).toEqual(
      (defaults['stages'] as Array<{ id: string }>).map((s) => s.id)
    );
  });

  it('a context override merges key-by-key instead of replacing the block', async () => {
    // The point of the deep merge: setting one knob must not silently drop the
    // others the plugin ships.
    const config = await loadFlowConfig(overrideOnly({ context: { wrap_up_at_pct: 42 } }), BUILTIN);

    expect(config.context?.wrap_up_at_pct).toBe(42);
    expect(config.stages.length).toBeGreaterThan(0);
  });

  it('a sparse override is not validated on its own', async () => {
    // `{}` has neither `name` nor `stages`, both required by the schema. Validating
    // before the merge would reject every correctly installed project.
    await expect(loadFlowConfig(overrideOnly({}), BUILTIN)).resolves.toBeDefined();
  });
});

describe('end to end — a legacy install starts running the plugin\'s definition', () => {
  it('SessionStart prunes the stale copies and injects the plugin\'s stage prompt', async () => {
    // The claim the whole move rests on, on the path a real project takes: a
    // project installed before 0.69.0 has a full stale copy AND a stale
    // config.json, and the first session in it has to end up executing the
    // definition that ships with the plugin — not the copy sitting right there.
    const { repoRoot, flowDir } = legacyInstall(BUILTIN, {
      ...pluginDefaults(),
      // The stale copy claims a stage list of its own. Left in place it would win
      // the merge and pin the flow to a prompt file that no longer exists.
      stages: [{ id: 'stage-1', prompt: 'stages/stage-1.md', write_scope: 'unrestricted', completion: { gate: true } }],
    });
    execSync('git init -q', { cwd: repoRoot });
    writeFileSync(join(flowDir, 'state', 'active.json'), JSON.stringify({
      flow_id: 'e2e-1', flow_name: BUILTIN, requirement: 'ship the thing',
      current_stage: 'stage-1', base_sha: 'abc', started_at: new Date().toISOString(),
      last_session_id: null, context_size: 0, context_wrap_up: { at_pct: null },
    }));

    const out = await handleSessionStart({
      cwd: repoRoot, session_id: 'sess-e2e', source: 'startup',
    } as Parameters<typeof handleSessionStart>[0]);

    // The stale copy is gone and the override is empty…
    expect(existsSync(join(flowDir, 'stages'))).toBe(false);
    expect(JSON.parse(readFileSync(join(flowDir, 'config.json'), 'utf-8'))).toEqual({});
    // …and what got injected is the plugin's own stage-1, with both roots named.
    const injected = out?.additionalContext ?? '';
    const shipped = readFileSync(join(PLUGIN_FLOWS_DIR, BUILTIN, 'stages', 'stage-1.md'), 'utf-8');
    const marker = shipped.split('\n').find((l) => l.length > 40 && !l.includes('{{'))!;
    expect(injected).toContain(marker);
    expect(injected).not.toContain('# stale copy');
    expect(injected).toContain(`flow_root: ${flowDir}`);
    expect(injected).toContain(`flow_def: ${join(PLUGIN_FLOWS_DIR, BUILTIN)}`);
  });
});
