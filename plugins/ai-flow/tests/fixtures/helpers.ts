import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import type { FlowConfig } from '../../src/lib/flow-schema.js';
import type { ActiveState } from '../../src/lib/state.js';

// Re-exported so fixtures stay the single import site for test helpers. These used
// to be a second, hand-copied declaration of the same two interfaces; it drifted the
// moment the context state grew a field, and the failure surfaced as "property does
// not exist" on a field that plainly existed in src/. One declaration, one place.
export type { ActiveState, ContextWrapUp } from '../../src/lib/state.js';

export interface FlowTestRepo {
  repoRoot: string;
  flowDir: string;
  cleanup: () => void;
}

/**
 * Every repo this module has handed out, so a global hook can check them.
 *
 * Exists because `expect(out?.permissionDecision ?? 'allow').toBe('allow')` — the
 * shape ~30 assertions use to state "this guard deliberately lets the write
 * through" — is ALSO true when the handler threw: both handlers end in a catch-all
 * that logs `ERROR <hook>` and returns null, i.e. every guard fails OPEN. Verified
 * by feeding a malformed config.json into a passing case: the assertions still
 * passed and the only trace was one line in flow.log that nothing read. That blind
 * spot sits exactly where the config-key removal was argued from (flow-schema.ts
 * drops dead keys instead of rejecting them precisely to avoid that fail-open), so
 * it is checked once, centrally, rather than per assertion.
 */
const createdRepos: Array<{ repoRoot: string; flowName: string }> = [];
let swallowed: string[] = [];

/**
 * Read a repo's flow.log for handler catch-all lines and remember them.
 *
 * Has to run BEFORE the repo is deleted, which is why `cleanup()` calls it rather
 * than the global hook doing all the work: vitest runs afterEach hooks LIFO, so a
 * test file's own `afterEach` (which `rm -rf`s the repo) fires before the one
 * registered in setup.ts. Harvesting at delete time makes the check order-independent.
 */
function harvest(repoRoot: string, flowName: string): void {
  const log = join(repoRoot, '.ai-flow', flowName, 'state', 'flow.log');
  if (!existsSync(log)) return;
  for (const line of readFileSync(log, 'utf-8').split('\n')) {
    if (/\bERROR (pretool|posttool|session|userprompt)\b/.test(line)) swallowed.push(line);
  }
}

/** Fail if any handler swallowed an exception during the test just finished. */
export function assertNoSwallowedHandlerErrors(): void {
  for (const { repoRoot, flowName } of createdRepos) harvest(repoRoot, flowName);
  createdRepos.length = 0;
  const found = swallowed;
  swallowed = [];
  if (found.length > 0) {
    throw new Error(
      'a hook handler threw and its catch-all turned the failure into "allow" '
      + '(guards fail OPEN there). flow.log:\n  ' + found.join('\n  ')
    );
  }
}

export function createFlowTestRepo(
  flowName: string,
  config: FlowConfig,
  opts?: { preflightScript?: string; noPreflight?: boolean }
): FlowTestRepo {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ai-flow-test-'));
  createdRepos.push({ repoRoot, flowName });
  execSync('git init', { cwd: repoRoot });
  execSync('git config user.email "test@test.com"', { cwd: repoRoot });
  execSync('git config user.name "Test"', { cwd: repoRoot });

  const flowDir = join(repoRoot, '.ai-flow', flowName);
  mkdirSync(join(flowDir, 'stages'), { recursive: true });
  mkdirSync(join(flowDir, 'scripts'), { recursive: true });

  writeFileSync(join(flowDir, 'config.json'), JSON.stringify(config, null, 2));

  for (const stage of config.stages) {
    const promptPath = join(flowDir, stage.prompt);
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(
      promptPath,
      `# Stage: ${stage.id}\n\nDo the work.\n\nWhen done, write to \`.ai-flow/${flowName}/state/signal\`.\n`
    );
  }

  if (!opts?.noPreflight) {
    const preflightScript = opts?.preflightScript ?? '#!/bin/sh\nexit 0\n';
    const preflightPath = join(flowDir, 'preflight.sh');
    writeFileSync(preflightPath, preflightScript);
    chmodSync(preflightPath, 0o755);
  }

  const gitignorePath = join(repoRoot, '.gitignore');
  writeFileSync(gitignorePath, '.ai-flow/*/state/\n');

  execSync('git add -A', { cwd: repoRoot });
  execSync('git commit -m "init"', { cwd: repoRoot });

  return {
    repoRoot,
    flowDir,
    cleanup: () => { harvest(repoRoot, flowName); execSync(`rm -rf "${repoRoot}"`); },
  };
}

export function writeActiveState(
  repoRoot: string,
  flowName: string,
  state: Partial<ActiveState> & Pick<ActiveState, 'flow_id' | 'flow_name' | 'requirement' | 'current_stage' | 'base_sha'>
): void {
  const stateDir = join(repoRoot, '.ai-flow', flowName, 'state');
  mkdirSync(stateDir, { recursive: true });
  const full: ActiveState = {
    last_session_id: null,
    context_size: 0,
    context_wrap_up: { at_pct: null },
    started_at: new Date().toISOString(),
    ...state,
  };
  writeFileSync(join(stateDir, 'active.json'), JSON.stringify(full, null, 2));
}

export function writeSignal(repoRoot: string, flowName: string, content: string): void {
  const stateDir = join(repoRoot, '.ai-flow', flowName, 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'signal'), content);
}

export function readActiveState(repoRoot: string, flowName: string): ActiveState {
  const path = join(repoRoot, '.ai-flow', flowName, 'state', 'active.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as ActiveState;
}

export function hasPython3(): boolean {
  try {
    execSync('python3 --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const MINIMAL_CONFIG: FlowConfig = {
  schema_version: '1.0',
  name: 'test-flow',
  stages: [
    { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted', completion: {} },
    {
      id: 'review',
      prompt: 'stages/review.md',
      write_scope: 'docs_only',
      docs_paths: ['docs/test-flow/{flow_id}/'],
      completion: { gate: true },
    },
  ],
};

export const GATED_CONFIG: FlowConfig = {
  schema_version: '1.0',
  name: 'gated-flow',
  stages: [
    { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted', completion: { gate: true } },
    { id: 'review', prompt: 'stages/review.md', write_scope: 'unrestricted', completion: { gate: true } },
  ],
};

// A fully configured flow: every stage declares docs_paths, which is what both
// shipped flows do and what the wrap-up refusal needs to have anything to keep open.
// `work` carries them despite being `unrestricted` — scope enforcement ignores them
// there, the wrap-up guard does not. The opposite shape (an `unrestricted` stage with
// none) is legal too and is covered by NO_ESCAPE_CONFIG below.
export const BLOCKING_CONFIG: FlowConfig = {
  schema_version: '1.0',
  name: 'test-flow',
  context: {
    wrap_up_at_pct: 60,
  },
  stages: [
    {
      id: 'work',
      prompt: 'stages/work.md',
      write_scope: 'unrestricted',
      docs_paths: ['docs/test-flow/{flow_id}/'],
      completion: {},
    },
    {
      id: 'review',
      prompt: 'stages/review.md',
      write_scope: 'docs_only',
      docs_paths: ['docs/test-flow/{flow_id}/'],
      completion: { gate: true },
    },
  ],
};

// The shape a custom flow is allowed to have and that the wrap-up cannot enforce:
// `unrestricted` + no docs_paths, so there is no path the refusal could leave open.
// `/ai-flow:create` emits it legitimately — the schema only requires docs_paths for
// `write_scope: 'docs_only'` — and refusing writes on such a stage left the session
// unable to write even the handoff that `/clear` requires.
export const NO_ESCAPE_CONFIG: FlowConfig = {
  schema_version: '1.0',
  name: 'test-flow',
  context: {
    wrap_up_at_pct: 60,
  },
  stages: [
    { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted', completion: {} },
  ],
};

export const SCRIPTED_CONFIG: FlowConfig = {
  schema_version: '1.0',
  name: 'scripted-flow',
  stages: [
    {
      id: 'work',
      prompt: 'stages/work.md',
      write_scope: 'unrestricted',
      completion: { script: { command: 'bash scripts/check.sh', timeout_ms: 5000 } },
    },
    { id: 'review', prompt: 'stages/review.md', write_scope: 'unrestricted', completion: {} },
  ],
};
