import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { SessionStartInput, SessionOutput } from './types.js';
import { hasActiveFlow, writeActiveState, isGateActive } from './state.js';
import { loadFlowConfig, getStageConfig } from './flow-config-loader.js';
import { contextWindowForModel } from './context.js';

export async function handleSessionStart(
  input: SessionStartInput
): Promise<{ additionalContext: string } | null> {
  const { cwd: repoRoot, session_id, model } = input;

  const active = await hasActiveFlow(repoRoot);
  if (!active) return null;

  const { flowName, state } = active;
  // Reset context_warning whenever session changes, including when last_session_id is null
  // (which happens after resume). null means "unknown previous session" — treat as new.
  const isNewSession = state.last_session_id !== session_id;

  const updated = {
    ...state,
    last_session_id: session_id,
    // Only startup events carry a reliable model name; other sources (resume/clear/compact) do not.
    ...(input.source === 'startup' && { context_size: contextWindowForModel(model) }),
  };
  if (isNewSession) {
    updated.context_warning = { warned: false, warned_at_pct: null, warned_at: null };
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

  const gateActive = await isGateActive(repoRoot, flowName);
  if (gateActive) {
    lines.push('', `Gate pending — waiting for: ${flowName} approve <token>`);
    lines.push(`(The token was delivered to the user via system message.)`);
  } else {
    const promptPath = join(repoRoot, '.ai-flow', flowName, stageCfg.prompt);
    if (existsSync(promptPath)) {
      try {
        lines.push('', '---', '', readFileSync(promptPath, 'utf-8'));
      } catch { /* non-fatal */ }
    }
  }

  return { additionalContext: lines.join('\n') };
}
