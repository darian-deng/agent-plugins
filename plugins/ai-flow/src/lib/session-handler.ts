import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { SessionStartInput } from './types.js';
import { hasActiveFlow, writeActiveState, isGateActive, readGateToken, appendHookLog } from './state.js';
import { loadFlowConfig, getStageConfig } from './flow-config-loader.js';
import { contextWindowForModel } from './context.js';


export async function handleSessionStart(
  input: SessionStartInput
): Promise<{ additionalContext: string; systemMessage?: string } | null> {
  const { cwd: repoRoot, session_id, model } = input;

  const active = await hasActiveFlow(repoRoot);
  if (!active) return null;

  const { flowName, state } = active;

  await appendHookLog(repoRoot, flowName, `SESSION source=${input.source} session=${session_id.slice(0, 8)} stage=${state.current_stage}`);

  const isNewSession = state.last_session_id !== session_id;
  // /clear and compact keep the same session_id, so isNewSession stays false.
  // Detect them via source to ensure context state is properly reset.
  const isClear = input.source === 'compact' || input.source === 'clear';

  const updated = {
    ...state,
    last_session_id: session_id,
    ...(input.source === 'startup' && { context_size: contextWindowForModel(model) }),
  };
  if (isNewSession || isClear) {
    updated.context_warning = { warned: false, warned_at_pct: null, warned_at: null };
    updated.context_blocked = false;
  }
  await writeActiveState(repoRoot, flowName, updated);

  const config = await loadFlowConfig(repoRoot, flowName);
  const stageCfg = getStageConfig(config, state.current_stage);

  const lines: string[] = [
    `Flow '${flowName}' is active.`,
    `flow_id: ${state.flow_id}`,
    `current_stage: ${state.current_stage}`,
    `requirement: ${state.requirement}`,
  ];

  let systemMessage: string | undefined;

  const gateActive = await isGateActive(repoRoot, flowName);
  if (gateActive) {
    const token = await readGateToken(repoRoot, flowName);
    const approveCmd = token ? `${flowName} approve ${token}` : `${flowName} approve <token>`;
    lines.push('', `Gate pending — run to approve: ${approveCmd}`);
    // Re-surface the token so the model can give the user the exact command,
    // especially after /clear or session restart when the original system message is gone.
    systemMessage = `[feat-flow] Gate pending for stage '${state.current_stage}'.\nRun: ${approveCmd}`;
  } else {
    const promptPath = join(repoRoot, '.ai-flow', flowName, stageCfg.prompt);
    if (existsSync(promptPath)) {
      try {
        lines.push('', '---', '', readFileSync(promptPath, 'utf-8'));
      } catch { /* non-fatal */ }
    }
    systemMessage = `[feat-flow] Active | stage: ${state.current_stage} | flow: ${state.flow_id}`;
  }

  // After /clear, the user should not need to type "继续" to resume.
  // Instruct the model to immediately output a status summary and continue
  // the task on its very first response, without waiting for user direction.
  if (isClear && !gateActive) {
    lines.unshift(
      `INSTRUCTION (context was just cleared via /clear):`,
      `Your FIRST response must begin with a one-line status: "Resuming ${flowName} · ${state.current_stage} · flow ${state.flow_id}"`,
      `Then immediately continue the task from where you left off — do NOT ask the user what to do next.`,
      ``,
    );
  }

  return { additionalContext: lines.join('\n'), systemMessage };
}
