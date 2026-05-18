import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync, appendFileSync, realpathSync } from 'fs';
import { join } from 'path';
import type { FeatFlowState, ActiveMarker, InitRecord } from './types.js';
import { STATE_NOTE, NEXT_STAGE as NEXT } from './types.js';
import { getPluginDataDir } from './config.js';

// ─── Paths ─────────────────────────────────────────────────────────────────────

export const paths = (repoRoot: string) => ({
  stateDir: join(repoRoot, '.feat-flow'),
  stateJson: join(repoRoot, '.feat-flow/state.json'),
  gateToken: join(repoRoot, '.feat-flow/gate-token'),
  transitionsLog: join(repoRoot, '.feat-flow/transitions.log'),
  violationsLog: join(repoRoot, '.feat-flow/violations.log'),
  marker: join(repoRoot, '.claude/.feat-flow-active'),
});

// ─── Init record (stored in CLAUDE_PLUGIN_DATA, not in project) ────────────────

function realKey(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

function projectsFilePath(dataDir: string): string {
  return join(dataDir, 'projects.json');
}

function readProjects(dataDir: string): Record<string, InitRecord> {
  try {
    return JSON.parse(readFileSync(projectsFilePath(dataDir), 'utf-8')) as Record<string, InitRecord>;
  } catch {
    return {};
  }
}

export function isInitDone(cwd: string, dataDir?: string): boolean {
  const dir = dataDir ?? getPluginDataDir();
  const projects = readProjects(dir);
  return realKey(cwd) in projects;
}

export function writeInitRecord(cwd: string, record: Partial<InitRecord> = {}, dataDir?: string): void {
  const dir = dataDir ?? getPluginDataDir();
  mkdirSync(dir, { recursive: true });
  const projects = readProjects(dir);
  projects[realKey(cwd)] = {
    initialized_at: new Date().toISOString(),
    node_version: process.version,
    git_remote: record.git_remote ?? '',
    ...record,
  };
  writeFileSync(projectsFilePath(dir), JSON.stringify(projects, null, 2));
}

// ─── Read ───────────────────────────────────────────────────────────────────────

export function readState(repoRoot: string): FeatFlowState | null {
  const p = paths(repoRoot);
  try {
    return JSON.parse(readFileSync(p.stateJson, 'utf-8')) as FeatFlowState;
  } catch {
    return null;
  }
}

export function readMarker(repoRoot: string): ActiveMarker | null {
  const p = paths(repoRoot);
  try {
    return JSON.parse(readFileSync(p.marker, 'utf-8')) as ActiveMarker;
  } catch {
    return null;
  }
}

export function hasActiveFlow(repoRoot: string): boolean {
  return existsSync(paths(repoRoot).marker);
}

export function readGateToken(repoRoot: string): string | null {
  try {
    return readFileSync(paths(repoRoot).gateToken, 'utf-8').trim();
  } catch {
    return null;
  }
}

// ─── Write ──────────────────────────────────────────────────────────────────────

export function writeState(repoRoot: string, state: FeatFlowState): void {
  const p = paths(repoRoot);
  mkdirSync(p.stateDir, { recursive: true });

  const toWrite: FeatFlowState = { ...state, _note: STATE_NOTE };
  const tmp = p.stateJson + '.tmp';
  writeFileSync(tmp, JSON.stringify(toWrite, null, 2));
  try {
    renameSync(tmp, p.stateJson);
  } catch {
    writeFileSync(p.stateJson, readFileSync(tmp));
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export function writeMarker(repoRoot: string, flowId: string): void {
  const marker: ActiveMarker = { flow_id: flowId, started_at: new Date().toISOString() };
  const markerPath = paths(repoRoot).marker;
  mkdirSync(join(repoRoot, '.claude'), { recursive: true });
  writeFileSync(markerPath, JSON.stringify(marker, null, 2));
}

export function removeMarker(repoRoot: string): void {
  try { unlinkSync(paths(repoRoot).marker); } catch { /* ok */ }
}

export function writeGateToken(repoRoot: string, token: string): void {
  writeFileSync(paths(repoRoot).gateToken, token);
}

export function removeGateToken(repoRoot: string): void {
  try { unlinkSync(paths(repoRoot).gateToken); } catch { /* ok */ }
}

export function appendTransition(repoRoot: string, event: string): void {
  const ts = new Date().toISOString();
  try {
    appendFileSync(paths(repoRoot).transitionsLog, `[${ts}] ${event}\n`);
  } catch { /* fail-open */ }
}

// ─── State helpers ─────────────────────────────────────────────────────────────

export function makeInitialState(opts: {
  flowId: string;
  requirement: string;
  baseSha: string;
  sessionId: string;
  contextSize: number;
}): FeatFlowState {
  const now = new Date().toISOString();
  return {
    _note: STATE_NOTE,
    schema_version: '1.0',
    flow_id: opts.flowId,
    requirement: opts.requirement,
    current_stage: 'stage-1',
    base_sha: opts.baseSha,
    started_at: now,
    last_session_id: opts.sessionId,
    context_size: opts.contextSize,
    stage_progress: {
      'stage-1': { entered_at: now, completed_at: null, gate_approved_at: null },
    },
    waiting_for_gate: false,
    gate_type: null,
    gate_context: null,
    expected_next: 'read stage-1 document and begin requirements gathering',
    context_warning: { warned: false, warned_at_pct: null, warned_at: null },
    approved_task_gates: [],
  };
}

export function advanceStage(state: FeatFlowState): FeatFlowState {
  const next = NEXT[state.current_stage];
  if (!next) return state;
  const now = new Date().toISOString();
  const updated = { ...state };
  updated.stage_progress = {
    ...state.stage_progress,
    [state.current_stage]: {
      ...state.stage_progress[state.current_stage],
      completed_at: now,
      gate_approved_at: now,
    },
    [next]: { entered_at: now, completed_at: null, gate_approved_at: null },
  };
  updated.current_stage = next;
  updated.waiting_for_gate = false;
  updated.gate_type = null;
  updated.gate_context = null;
  updated.expected_next = `begin ${next}`;
  return updated;
}
