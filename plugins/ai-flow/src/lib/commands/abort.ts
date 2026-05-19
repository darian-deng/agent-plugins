import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { readActiveState, deleteGateToken, appendTransition } from '../state.js';
import type { CommandResult } from '../types.js';

export async function handleAbort(repoRoot: string, flowName: string): Promise<CommandResult> {
  const state = await readActiveState(repoRoot, flowName);
  if (!state) {
    return { action: 'deny', reason: 'No active flow to abort.' };
  }

  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const branchName = `${flowName}/aborted-${timestamp}`;

  const exec = (cmd: string) =>
    execSync(cmd, { cwd: repoRoot, stdio: 'pipe', encoding: 'utf-8' }).trim();

  try {
    exec(`git checkout -b "${branchName}"`);

    const snapshotDir = join(repoRoot, 'docs', flowName, state.flow_id);
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(
      join(snapshotDir, 'state-snapshot.json'),
      JSON.stringify(state, null, 2)
    );

    exec('git add -A');
    try {
      exec(`git commit -m "${flowName}: abort flow ${state.flow_id}"`);
    } catch {
      // nothing to commit
    }

    exec('git checkout -');
  } catch (err) {
    await appendTransition(repoRoot, flowName, `ABORT_ERROR ${String(err)}`);
  }

  const activeJsonPath = join(repoRoot, '.ai-flow', flowName, 'state', 'active.json');
  if (existsSync(activeJsonPath)) unlinkSync(activeJsonPath);
  await deleteGateToken(repoRoot, flowName);
  await appendTransition(repoRoot, flowName, `ABORTED branch=${branchName}`);

  return {
    action: 'allow',
    additionalContext: `Flow '${flowName}' aborted. Changes saved to branch: ${branchName}\nTo resume: ${flowName} resume ${branchName}`,
  };
}
