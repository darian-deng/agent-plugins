import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, appendFileSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';
import { join, dirname } from 'path';
import type { FlowConfig } from './flow-schema.js';

export interface ContextWarning {
  warned: boolean;
  warned_at_pct: number | null;
  warned_at: string | null;
}

export interface ActiveState {
  flow_id: string;
  flow_name: string;
  requirement: string;
  current_stage: string;
  base_sha: string;
  started_at: string;
  last_session_id: string | null;
  context_size: number;
  context_warning: ContextWarning;
  context_blocked: boolean;
  /**
   * Whether this session's first non-command user prompt has already been
   * given the resume guidance (Layer 2 in userprompt-handler). Reset to false
   * by SessionStart on a new session / clear / compact so the next prompt is
   * re-guided. Absent on flows created before this field existed — treat
   * undefined as "not yet handled".
   */
  first_prompt_handled?: boolean;
  /**
   * All session IDs that have ever been the owner of this flow instance.
   * Append-only; used for auditing. Populated by SessionStart.
   */
  history_session_ids?: string[];
  /**
   * Git SHA of the "Stage 1-3 docs" commit created at the start of Stage 4.
   * Stage 5 and Stage 6 use this as the diff base to scope reviews to only
   * the code changes of the current flow. Set by Stage 4 Step 1; absent until
   * then. Stored here (not as a separate file) so it is naturally flow-scoped:
   * a new flow gets a fresh active.json with no base_sha_code, eliminating
   * cross-flow pollution.
   */
  base_sha_code?: string;
}

function statePath(repoRoot: string, flowName: string, file: string): string {
  return join(repoRoot, '.ai-flow', flowName, 'state', file);
}

function stateDir(repoRoot: string, flowName: string): string {
  return join(repoRoot, '.ai-flow', flowName, 'state');
}

export async function readActiveState(repoRoot: string, flowName: string): Promise<ActiveState | null> {
  const path = statePath(repoRoot, flowName, 'active.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ActiveState;
  } catch {
    return null;
  }
}

export async function writeActiveState(repoRoot: string, flowName: string, state: ActiveState): Promise<void> {
  const dir = stateDir(repoRoot, flowName);
  mkdirSync(dir, { recursive: true });
  const tmp = statePath(repoRoot, flowName, `active.json.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, statePath(repoRoot, flowName, 'active.json'));
}

export function findRepoRoot(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, '.ai-flow'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function hasActiveFlow(cwd: string): Promise<{ flowName: string; state: ActiveState; repoRoot: string } | null> {
  // Walk up from cwd to find the nearest .ai-flow directory (monorepo-safe).
  let dir = cwd;
  while (true) {
    const aiFlowDir = join(dir, '.ai-flow');
    if (existsSync(aiFlowDir)) {
      for (const entry of readdirSync(aiFlowDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const state = await readActiveState(dir, entry.name);
        if (state) return { flowName: entry.name, state, repoRoot: dir };
      }
      return null; // .ai-flow exists but no active flow inside
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

export function readSignal(repoRoot: string, flowName: string): string | null {
  const path = statePath(repoRoot, flowName, 'signal');
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return null;
  }
}

export function writeSignalFile(repoRoot: string, flowName: string, content: string): void {
  const dir = stateDir(repoRoot, flowName);
  mkdirSync(dir, { recursive: true });
  const tmp = statePath(repoRoot, flowName, `signal.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, content);
  renameSync(tmp, statePath(repoRoot, flowName, 'signal'));
}

export function isGatePending(signal: string | null, config: FlowConfig, currentStageId: string): boolean {
  if (!signal) return false;
  const stage = config.stages.find((s) => s.id === currentStageId);
  if (!stage) return false;
  if (!stage.completion.gate) return false;
  // New protocol: AI writes 'done'; hook rewrites to stage-id/flow-complete later
  if (signal === 'done') return true;
  // Backward compat: posttool already rewrote signal to stage-id or 'flow-complete'
  const expected = nextStage(config, currentStageId);
  if (expected !== null) {
    return signal === expected;
  }
  return signal === 'flow-complete';
}

export async function appendTransition(repoRoot: string, flowName: string, message: string): Promise<void> {
  const path = statePath(repoRoot, flowName, 'transitions.log');
  const timestamp = new Date().toISOString();
  appendFileSync(path, `${timestamp} [${flowName}] ${message}\n`);
}

export async function appendViolation(repoRoot: string, flowName: string, message: string): Promise<void> {
  const path = statePath(repoRoot, flowName, 'violations.log');
  const timestamp = new Date().toISOString();
  appendFileSync(path, `${timestamp} [${flowName}] ${message}\n`);
}

export async function appendHookLog(repoRoot: string, flowName: string, message: string): Promise<void> {
  const path = statePath(repoRoot, flowName, 'hooks.log');
  const timestamp = new Date().toISOString();
  appendFileSync(path, `${timestamp} [${flowName}] ${message}\n`);
}

export function nextStage(config: FlowConfig, currentStageId: string): string | null {
  const idx = config.stages.findIndex((s) => s.id === currentStageId);
  if (idx === -1 || idx === config.stages.length - 1) return null;
  return config.stages[idx + 1]!.id;
}

export function signalPath(repoRoot: string, flowName: string): string {
  return statePath(repoRoot, flowName, 'signal');
}

export function activeJsonPath(repoRoot: string, flowName: string): string {
  return statePath(repoRoot, flowName, 'active.json');
}

export function scriptsDir(repoRoot: string, flowName: string): string {
  return join(repoRoot, '.ai-flow', flowName, 'scripts');
}
