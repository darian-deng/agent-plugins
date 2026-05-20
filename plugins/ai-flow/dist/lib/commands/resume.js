import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { readActiveState, writeActiveState, appendTransition, } from '../state.js';
import { loadFlowConfig, getStageConfig } from '../flow-config-loader.js';
export async function handleResume(repoRoot, flowName, branch) {
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
    function gitTry(args) {
        try {
            return execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe', encoding: 'utf-8' }).trim();
        }
        catch {
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
    let snapshot;
    try {
        snapshot = JSON.parse(snapshotContent);
    }
    catch {
        return { action: 'deny', reason: 'state-snapshot.json is not valid JSON.' };
    }
    const config = await loadFlowConfig(repoRoot, flowName);
    const currentStage = snapshot.current_stage ?? config.stages[0].id;
    const restored = {
        flow_id: snapshot.flow_id ?? `${flowName}-resumed`,
        flow_name: flowName,
        requirement: snapshot.requirement ?? '',
        current_stage: currentStage,
        base_sha: snapshot.base_sha ?? 'HEAD',
        started_at: snapshot.started_at ?? new Date().toISOString(),
        last_session_id: null,
        context_size: 0,
        context_warning: { warned: false, warned_at_pct: null, warned_at: null },
    };
    await writeActiveState(repoRoot, flowName, restored);
    await appendTransition(repoRoot, flowName, `RESUMED from_branch=${trimmedBranch} stage=${currentStage}`);
    const stageCfg = getStageConfig(config, currentStage);
    const promptPath = join(repoRoot, '.ai-flow', flowName, stageCfg.prompt);
    let stageContent = '';
    if (existsSync(promptPath)) {
        stageContent = readFileSync(promptPath, 'utf-8');
    }
    const ctx = `Flow '${flowName}' resumed from branch: ${trimmedBranch}\n` +
        `current_stage: ${currentStage}\nrequirement: ${restored.requirement}\n\n` +
        stageContent;
    return { action: 'allow', additionalContext: ctx };
}
//# sourceMappingURL=resume.js.map