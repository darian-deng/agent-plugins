import { readFileSync } from 'fs';
import { stagePromptInjection, readableInOneRead } from './prompt-render.js';
import { materializeRenderedPrompt, armPromptReadLock, clearPromptReadLock } from './state.js';

/**
 * The one way an injection point turns a rendered stage prompt into what it injects. Over
 * the inline budget the prompt is materialised and handed over as a file, and the read lock
 * is armed here — not at each caller — so an injection point cannot hand over a pointer the
 * model is free to skip.
 */
export async function injectStagePrompt(o: {
  repoRoot: string;
  flowName: string;
  stageId: string;
  sessionId: string;
  rendered: string;
  promptPath: string;
  overhead: number;
}): Promise<string> {
  const inj = stagePromptInjection(o.rendered, o.promptPath, o.overhead,
    (text) => materializeRenderedPrompt(o.repoRoot, o.flowName, o.stageId, text));
  // Judged on the file as written — the materialised copy carries a header the rendered
  // text does not — because a lock on a file one Read cannot return whole never releases.
  let lockable = false;
  if (inj.pointedTo) {
    try { lockable = readableInOneRead(readFileSync(inj.pointedTo, 'utf-8')); } catch { /* unreadable → no lock */ }
  }
  if (lockable) {
    await armPromptReadLock(o.repoRoot, o.flowName, inj.pointedTo!, o.stageId, o.sessionId);
  } else {
    // Went inline (or cannot be locked): a lock left from an earlier injection of this same
    // stage — e.g. before a compaction whose SessionStart now fits the prompt inline — would
    // keep refusing a session that already has the prompt.
    await clearPromptReadLock(o.repoRoot, o.flowName);
  }
  return inj.text;
}
