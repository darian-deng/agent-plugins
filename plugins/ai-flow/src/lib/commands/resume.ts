import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  readActiveState,
  writeActiveState,
  appendLog,
  type ActiveState,
} from '../state.js';
import { loadFlowConfig, getStageConfig } from '../flow-config-loader.js';
import { renderPrompt, buildAiFlowPreamble, gateProtocolNote, injectableStagePrompt, assembledOverhead, commandOutputPrefix } from '../prompt-render.js';
import type { CommandResult } from '../types.js';

export async function handleResume(
  repoRoot: string,
  flowName: string,
  sessionId: string,
  branch: string
): Promise<CommandResult> {
  const trimmedBranch = branch.trim();
  if (!trimmedBranch) {
    return {
      action: 'deny',
      reason: `Usage: ${flowName} resume <branch>\nExample: ${flowName} resume ${flowName}/aborted-2024-01-01T00-00-00`,
    };
  }

  const existing = await readActiveState(repoRoot, flowName);
  if (existing) {
    return {
      action: 'deny',
      reason: `Flow '${existing.flow_name}' is already active. Run '${existing.flow_name} abort' before resuming.`,
    };
  }

  function gitTry(args: string[]): string | null {
    try {
      return execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe', encoding: 'utf-8' }).trim();
    } catch {
      return null;
    }
  }

  const branchCheck = gitTry(['rev-parse', '--verify', trimmedBranch]);
  if (!branchCheck) {
    return { action: 'deny', reason: `Branch "${branch}" does not exist.` };
  }

  // look for snapshot in docs/{flowName}/*/state-snapshot.json
  const lsOutput = gitTry(['ls-tree', '-r', '--name-only', trimmedBranch, '--', `docs/${flowName}/`]);
  const snapshotPath = lsOutput?.split('\n').find((f) => f.endsWith('state-snapshot.json'));

  if (!snapshotPath) {
    return {
      action: 'deny',
      reason: `No state-snapshot.json found in branch "${branch}". This may not be a valid abort branch.`,
    };
  }

  const snapshotContent = gitTry(['show', `${trimmedBranch}:${snapshotPath}`]);
  if (!snapshotContent) {
    return { action: 'deny', reason: `Could not read state-snapshot.json from branch "${branch}".` };
  }

  let snapshot: Partial<ActiveState>;
  try {
    snapshot = JSON.parse(snapshotContent) as Partial<ActiveState>;
  } catch {
    return { action: 'deny', reason: 'state-snapshot.json is not valid JSON.' };
  }

  const config = await loadFlowConfig(repoRoot, flowName);
  const currentStage = snapshot.current_stage ?? config.stages[0]!.id;

  const restored: ActiveState = {
    flow_id: snapshot.flow_id ?? `${flowName}-resumed`,
    flow_name: flowName,
    requirement: snapshot.requirement ?? '',
    current_stage: currentStage,
    base_sha: snapshot.base_sha ?? 'HEAD',
    started_at: snapshot.started_at ?? new Date().toISOString(),
    // Carry the code-diff baseline across. `abort` snapshots the whole state, so it is in
    // there; this function rebuilds `restored` field by field and used to drop it, which
    // silently lost the baseline on every resume — stage-4 then reads the injected paths
    // block, finds no `base_sha_code`, and is told that case is "extremely rare".
    ...(snapshot.base_sha_code ? { base_sha_code: snapshot.base_sha_code } : {}),
    last_session_id: null,
    // Record the resuming session so it isn't lost (mirrors start.ts). Ownership
    // (last_session_id) is left null so the next SessionStart binds normally.
    history_session_ids: [sessionId],
    context_size: 0,
    context_warning: { warned: false, warned_at_pct: null, warned_at: null },
    context_blocked: false,
    first_prompt_handled: false,
  };

  await writeActiveState(repoRoot, flowName, restored);
  await appendLog(repoRoot, flowName, sessionId, `RESUMED from_branch=${trimmedBranch} stage=${currentStage}`);

  const stageCfg = getStageConfig(config, currentStage);
  const promptPath = join(repoRoot, '.ai-flow', flowName, stageCfg.prompt);
  // Same budget contract as the advance / session-start injection points: this path also
  // hands a rendered stage prompt to the host through `additionalContext`, so it is under
  // the same character ceiling and must degrade to "go read the file" instead of spilling.
  // It used to have no check at all — and its wrapper is the largest of the four, because
  // `requirement` is the user's own text with no length bound: measured on this repo, a
  // ~430-character requirement is enough to push the tightest stage page over the limit,
  // at which point the host silently keeps ~2,000 characters of it.
  const assemble = (body: string) =>
    buildAiFlowPreamble(repoRoot, flowName, restored.base_sha_code) +
    `Flow '${flowName}' resumed from branch: ${trimmedBranch}\n` +
    `current_stage: ${currentStage}\nrequirement: ${restored.requirement}\n\n` +
    body;
  const gateNote = stageCfg.completion.gate ? '\n' + gateProtocolNote() : '';
  let stageContent = '';
  if (existsSync(promptPath)) {
    stageContent = injectableStagePrompt(
      renderPrompt(readFileSync(promptPath, 'utf-8'), repoRoot, flowName),
      promptPath,
      assembledOverhead(assemble) + gateNote.length + commandOutputPrefix(flowName).length
    );
  }
  stageContent += gateNote;

  return { action: 'allow', additionalContext: assemble(stageContent) };
}
