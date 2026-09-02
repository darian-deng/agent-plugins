import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import type { FlowConfig } from '../../src/lib/flow-schema.js';
import type { ActiveState } from '../../src/lib/state.js';

// Re-exported so fixtures stay the single import site for test helpers. These used
// to be a second, hand-copied declaration of the same two interfaces; it drifted the
// moment `ContextWarning` grew a field, and the failure surfaced as "property does
// not exist" on a field that plainly existed in src/. One declaration, one place.
export type { ActiveState, ContextWarning } from '../../src/lib/state.js';

export interface FlowTestRepo {
  repoRoot: string;
  flowDir: string;
  cleanup: () => void;
}

export function createFlowTestRepo(
  flowName: string,
  config: FlowConfig,
  opts?: { preflightScript?: string; noPreflight?: boolean }
): FlowTestRepo {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ai-flow-test-'));
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
    cleanup: () => execSync(`rm -rf "${repoRoot}"`),
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
    context_warning: { warned: false, warned_at_pct: null, warned_at: null },
    context_blocked: false,
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

export const BLOCKING_CONFIG: FlowConfig = {
  schema_version: '1.0',
  name: 'test-flow',
  context: {
    warn_at_pct: 30,
    rewarn_delta_pct: 5,
    block_at_pct: 60,
  },
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
