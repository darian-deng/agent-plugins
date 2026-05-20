import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { readActiveState, deleteGateToken, appendTransition } from '../state.js';
function git(args, cwd) {
    return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}
export async function handleAbort(repoRoot, flowName) {
    const state = await readActiveState(repoRoot, flowName);
    if (!state) {
        return { action: 'deny', reason: 'No active flow to abort.' };
    }
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const branchName = `${flowName}/aborted-${timestamp}`;
    try {
        git(['checkout', '-b', branchName], repoRoot);
        const snapshotDir = join(repoRoot, 'docs', flowName, state.flow_id);
        mkdirSync(snapshotDir, { recursive: true });
        writeFileSync(join(snapshotDir, 'state-snapshot.json'), JSON.stringify(state, null, 2));
        git(['add', '-A'], repoRoot);
        try {
            git(['commit', '-m', `${flowName}: abort flow ${state.flow_id}`], repoRoot);
        }
        catch {
            // nothing to commit
        }
        git(['checkout', '-'], repoRoot);
    }
    catch (err) {
        await appendTransition(repoRoot, flowName, `ABORT_ERROR ${String(err)}`);
    }
    const activeJsonPath = join(repoRoot, '.ai-flow', flowName, 'state', 'active.json');
    if (existsSync(activeJsonPath))
        unlinkSync(activeJsonPath);
    await deleteGateToken(repoRoot, flowName);
    await appendTransition(repoRoot, flowName, `ABORTED branch=${branchName}`);
    return {
        action: 'allow',
        additionalContext: `Flow '${flowName}' aborted. Changes saved to branch: ${branchName}\nTo resume: ${flowName} resume ${branchName}`,
    };
}
//# sourceMappingURL=abort.js.map