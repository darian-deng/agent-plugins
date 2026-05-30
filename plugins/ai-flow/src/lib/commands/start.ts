import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { loadFlowConfig } from '../flow-config-loader.js';
import { hasActiveFlow, writeActiveState, appendTransition, type ActiveState } from '../state.js';
import { runScript } from '../script-executor.js';
import { contextPct, DEFAULT_CONTEXT_WINDOW } from '../context.js';
import type { CommandResult } from '../types.js';

const BLOCK_START_IF_ABOVE_PCT = 95;

function generateFlowId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${date}-${rand}`;
}

function isWorkingTreeDirty(repoRoot: string): boolean {
  try {
    const out = execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf-8' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function getBaseSha(repoRoot: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

export async function handleStart(
  repoRoot: string,
  flowName: string,
  requirement: string,
  sessionId: string,
  contextSizePct: number
): Promise<CommandResult> {
  if (!requirement.trim()) {
    return { action: 'deny', reason: `A requirement description is required. Usage: ${flowName} start <requirement>` };
  }

  // Use injected value (tests) or compute from transcript if not provided
  const effectivePct = contextSizePct > 0
    ? contextSizePct
    : contextPct(sessionId, repoRoot, DEFAULT_CONTEXT_WINDOW);
  if (effectivePct >= BLOCK_START_IF_ABOVE_PCT) {
    return {
      action: 'deny',
      reason: `Context is at ${effectivePct}%. Run /clear before starting a new flow to free up context space.`,
    };
  }

  let config;
  try {
    config = await loadFlowConfig(repoRoot, flowName);
  } catch (e: unknown) {
    return { action: 'deny', reason: String(e) };
  }

  const active = await hasActiveFlow(repoRoot);
  if (active) {
    return {
      action: 'deny',
      reason: `Flow '${active.flowName}' is already active. Run '${active.flowName} abort' before starting a new flow.`,
    };
  }

  if (isWorkingTreeDirty(repoRoot)) {
    return {
      action: 'deny',
      reason: 'Working tree has uncommitted changes. Run git stash or commit your changes before starting a flow.',
    };
  }

  const preflightPath = join(repoRoot, '.ai-flow', flowName, 'preflight.sh');
  if (existsSync(preflightPath)) {
    const result = await runScript(`sh "${preflightPath}"`, repoRoot);
    if (!result.ok) {
      return {
        action: 'deny',
        reason: `Preflight check failed:\n${result.reason}`,
      };
    }
  }

  const flowId = generateFlowId();
  const baseSha = getBaseSha(repoRoot);
  const firstStage = config.stages[0]!;

  const state: ActiveState = {
    flow_id: flowId,
    flow_name: flowName,
    requirement: requirement.trim(),
    current_stage: firstStage.id,
    base_sha: baseSha,
    started_at: new Date().toISOString(),
    last_session_id: sessionId,
    context_size: DEFAULT_CONTEXT_WINDOW,
    context_warning: { warned: false, warned_at_pct: null, warned_at: null },
    context_blocked: false,
  };

  await writeActiveState(repoRoot, flowName, state);
  await appendTransition(repoRoot, flowName, `STARTED flow_id=${flowId} stage=${firstStage.id}`);

  const promptPath = join(repoRoot, '.ai-flow', flowName, firstStage.prompt);
  let stageContent = '';
  if (existsSync(promptPath)) {
    stageContent = readFileSync(promptPath, 'utf-8');
  }

  const flowRoot = join(repoRoot, '.ai-flow', flowName);
  const ctx =
    `[ai-flow:paths]\nproject_root: ${repoRoot}\nflow_root: ${flowRoot}\n\n` +
    `Flow '${flowName}' started!\n\n` +
    `flow_id: ${flowId}\nrequirement: ${requirement.trim()}\ncurrent_stage: ${firstStage.id}\n\n` +
    stageContent;

  return { action: 'allow', additionalContext: ctx };
}
