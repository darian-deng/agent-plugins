import type { SessionEndInput } from './types.js';
import { hasActiveFlow, writeActiveState, appendLog } from './state.js';

export async function handleSessionEnd(input: SessionEndInput): Promise<void> {
  const { cwd, session_id } = input;

  const active = await hasActiveFlow(cwd).catch(() => null);
  if (!active) return;

  const { flowName, state, repoRoot } = active;

  // Only clear if this session is the current owner — prevents a non-owner
  // SessionEnd from accidentally releasing a lock it doesn't hold.
  if (state.last_session_id !== session_id) return;

  await writeActiveState(repoRoot, flowName, { ...state, last_session_id: null });
  await appendLog(repoRoot, flowName, session_id, `SESSION_END cleared last_session_id`);
}
