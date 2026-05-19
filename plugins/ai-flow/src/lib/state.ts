import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync, appendFileSync } from 'fs';
import { join } from 'path';
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
  mkdirSync(stateDir(repoRoot, flowName), { recursive: true });
  writeFileSync(statePath(repoRoot, flowName, 'active.json'), JSON.stringify(state, null, 2));
}

export async function hasActiveFlow(repoRoot: string): Promise<{ flowName: string; state: ActiveState } | null> {
  const aiFlowDir = join(repoRoot, '.ai-flow');
  if (!existsSync(aiFlowDir)) return null;
  const entries = readdirSync(aiFlowDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const state = await readActiveState(repoRoot, entry.name);
    if (state) return { flowName: entry.name, state };
  }
  return null;
}

export async function isGateActive(repoRoot: string, flowName: string): Promise<boolean> {
  return existsSync(statePath(repoRoot, flowName, 'gate-token'));
}

export async function writeGateToken(repoRoot: string, flowName: string, token: string): Promise<void> {
  mkdirSync(stateDir(repoRoot, flowName), { recursive: true });
  writeFileSync(statePath(repoRoot, flowName, 'gate-token'), token);
}

export async function deleteGateToken(repoRoot: string, flowName: string): Promise<void> {
  const path = statePath(repoRoot, flowName, 'gate-token');
  if (existsSync(path)) unlinkSync(path);
}

export async function readGateToken(repoRoot: string, flowName: string): Promise<string | null> {
  const path = statePath(repoRoot, flowName, 'gate-token');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8').trim();
}

export async function appendTransition(repoRoot: string, flowName: string, message: string): Promise<void> {
  const path = statePath(repoRoot, flowName, 'transitions.log');
  const timestamp = new Date().toISOString();
  appendFileSync(path, `${timestamp} ${message}\n`);
}

export async function appendViolation(repoRoot: string, flowName: string, message: string): Promise<void> {
  const path = statePath(repoRoot, flowName, 'violations.log');
  const timestamp = new Date().toISOString();
  appendFileSync(path, `${timestamp} ${message}\n`);
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

export function gateTokenPath(repoRoot: string, flowName: string): string {
  return statePath(repoRoot, flowName, 'gate-token');
}

export function scriptsDir(repoRoot: string, flowName: string): string {
  return join(repoRoot, '.ai-flow', flowName, 'scripts');
}
