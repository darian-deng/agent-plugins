import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import {
  readActiveState,
  writeActiveState,
  readGateToken,
  deleteGateToken,
  isGateActive,
  appendTransition,
  appendHookLog,
  nextStage,
} from '../state.js';
import { loadFlowConfig, getStageConfig } from '../flow-config-loader.js';
import type { CommandResult } from '../types.js';

export async function handleApprove(
  repoRoot: string,
  flowName: string,
  token: string
): Promise<CommandResult> {
  const state = await readActiveState(repoRoot, flowName);
  if (!state) {
    return { action: 'deny', reason: 'No active flow. Run the flow start command first.' };
  }

  const gateActive = await isGateActive(repoRoot, flowName);
  if (!gateActive) {
    return { action: 'deny', reason: `No pending gate for flow '${flowName}'.` };
  }

  const storedToken = await readGateToken(repoRoot, flowName);
  if (!storedToken || token !== storedToken) {
    return { action: 'deny', reason: 'Invalid token. Check the system message for the correct token.' };
  }

  await deleteGateToken(repoRoot, flowName);

  const config = await loadFlowConfig(repoRoot, flowName);
  const next = nextStage(config, state.current_stage);

  if (!next) {
    // last stage — flow complete
    const activeJsonFile = join(repoRoot, '.ai-flow', flowName, 'state', 'active.json');
    if (existsSync(activeJsonFile)) rmSync(activeJsonFile);
    await appendTransition(repoRoot, flowName, `COMPLETED flow_id=${state.flow_id}`);
    await appendHookLog(repoRoot, flowName, `APPROVED_COMPLETE flow_id=${state.flow_id}`);
    return { action: 'allow', additionalContext: `Flow '${flowName}' is complete! All stages finished.` };
  }

  const updated = { ...state, current_stage: next };
  await writeActiveState(repoRoot, flowName, updated);
  await appendTransition(repoRoot, flowName, `APPROVED ${state.current_stage} → ${next}`);
  await appendHookLog(repoRoot, flowName, `APPROVED ${state.current_stage} → ${next}`);

  const nextStageCfg = getStageConfig(config, next);
  const promptPath = join(repoRoot, '.ai-flow', flowName, nextStageCfg.prompt);
  let stageContent = '';
  if (existsSync(promptPath)) {
    stageContent = readFileSync(promptPath, 'utf-8');
  }

  const ctx = `Gate approved. Now in stage '${next}'.\n\n${stageContent}`;
  return { action: 'allow', additionalContext: ctx };
}
