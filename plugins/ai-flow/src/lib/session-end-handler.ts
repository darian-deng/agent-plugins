import type { SessionEndInput } from './types.js';
import { resolveActiveFlow, writeActiveState, appendLog, gcRegistry } from './state.js';
import { unbindSession } from './session-registry.js';

export async function handleSessionEnd(input: SessionEndInput): Promise<void> {
  const { cwd, session_id } = input;

  // Resolve + clear the lock FIRST, while this session's binding still exists.
  // Resolution is binding-first (cwd-independent). If we unbound before
  // resolving, a session whose cwd had drifted ABOVE the anchor would fall back
  // to walk-up, find nothing, and never clear last_session_id — leaving the flow
  // permanently locked to a now-dead session.
  const active = await resolveActiveFlow(cwd, session_id).catch(() => null);
  if (active) {
    const { flowName, state, repoRoot } = active;
    // Only clear if this session is the current owner — prevents a non-owner
    // SessionEnd from releasing a lock it doesn't hold.
    if (state.last_session_id === session_id) {
      await writeActiveState(repoRoot, flowName, { ...state, last_session_id: null });
      await appendLog(repoRoot, flowName, session_id, `SESSION_END cleared last_session_id`);
    }
  }

  // Then release this session's binding and prune dead ones on exit.
  unbindSession(session_id);
  await gcRegistry().catch(() => {});
}
