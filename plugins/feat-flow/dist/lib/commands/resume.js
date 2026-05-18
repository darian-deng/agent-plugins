import { execSync } from 'child_process';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { writeState, writeMarker, paths, appendTransition } from '../state.js';
import { STAGES_DIR, HELPER_PATH } from '../config.js';
export async function handleResume(input) {
    const { cwd, user_prompt } = input;
    const branch = user_prompt.replace(/^feat-flow\s+resume\s*/i, '').trim();
    if (!branch) {
        const out = {
            hookEventName: 'UserPromptSubmit',
            permissionDecision: 'deny',
            permissionDecisionReason: '请提供要恢复的 abort branch 名称。\n\n' +
                '用法：feat-flow resume <branch>\n' +
                '例如：feat-flow resume feat-flow/aborted-2026-01-15T10-30-00\n\n' +
                '查看可用 abort 分支：git branch | grep feat-flow/aborted',
        };
        return { hookSpecificOutput: out };
    }
    // Validate branch name to prevent shell injection
    if (!/^[\w./-]+$/.test(branch)) {
        const out = {
            hookEventName: 'UserPromptSubmit',
            permissionDecision: 'deny',
            permissionDecisionReason: `无效的 branch 名称：${branch}`,
        };
        return { hookSpecificOutput: out };
    }
    const exec = (cmd) => {
        try {
            return execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();
        }
        catch {
            return null;
        }
    };
    // Check branch exists
    const branchCheck = exec(`git rev-parse --verify ${branch}`);
    if (!branchCheck) {
        const out = {
            hookEventName: 'UserPromptSubmit',
            permissionDecision: 'deny',
            permissionDecisionReason: `Branch "${branch}" 不存在。\n\n` +
                '查看可用 abort 分支：\n  git branch | grep feat-flow/aborted',
        };
        return { hookSpecificOutput: out };
    }
    // Find state-snapshot.json in the branch (search in docs/feat-flows/*/state-snapshot.json)
    const snapshotSearch = exec(`git ls-tree -r --name-only ${branch} -- docs/feat-flows/ 2>/dev/null`);
    const snapshotPath = snapshotSearch
        ?.split('\n')
        .find(f => f.endsWith('state-snapshot.json'));
    if (!snapshotPath) {
        const out = {
            hookEventName: 'UserPromptSubmit',
            permissionDecision: 'deny',
            permissionDecisionReason: `Branch "${branch}" 中没有找到 state-snapshot.json。\n` +
                '这可能不是一个 feat-flow abort 分支，或者 abort 时没有保存状态快照。',
        };
        return { hookSpecificOutput: out };
    }
    // Checkout the snapshot from the branch
    const snapshotContent = exec(`git show ${branch}:${snapshotPath}`);
    if (!snapshotContent) {
        const out = {
            hookEventName: 'UserPromptSubmit',
            permissionDecision: 'deny',
            permissionDecisionReason: `无法读取 ${branch} 中的 state-snapshot.json。`,
        };
        return { hookSpecificOutput: out };
    }
    let snapshot;
    try {
        snapshot = JSON.parse(snapshotContent);
    }
    catch {
        const out = {
            hookEventName: 'UserPromptSubmit',
            permissionDecision: 'deny',
            permissionDecisionReason: `state-snapshot.json 格式无效，无法解析。`,
        };
        return { hookSpecificOutput: out };
    }
    const flowId = snapshot.flow_id ?? 'resumed-flow';
    const currentStage = snapshot.current_stage ?? 'stage-1';
    // Initialize .feat-flow/ from snapshot
    const p = paths(cwd);
    mkdirSync(p.stateDir, { recursive: true });
    const restoredState = {
        _note: '此文件由 feat-flow 控制系统自动管理。请勿手动修改。如需查看当前状态，请运行 feat-flow status。',
        schema_version: '1.0',
        flow_id: flowId,
        requirement: snapshot.requirement ?? '',
        current_stage: currentStage,
        base_sha: snapshot.base_sha ?? 'HEAD',
        started_at: snapshot.started_at ?? new Date().toISOString(),
        last_session_id: input.session_id,
        context_size: snapshot.context_size ?? 1_000_000,
        stage_progress: snapshot.stage_progress ?? {},
        waiting_for_gate: false,
        gate_type: null,
        gate_context: null,
        expected_next: snapshot.expected_next ?? `continue ${currentStage}`,
        context_warning: { warned: false, warned_at_pct: null, warned_at: null },
        approved_task_gates: snapshot.approved_task_gates ?? [],
    };
    writeState(cwd, restoredState);
    writeMarker(cwd, flowId);
    appendTransition(cwd, `FLOW_RESUMED from_branch=${branch} stage=${currentStage}`);
    // Inject stage context
    const stageDoc = join(STAGES_DIR, `${currentStage}.md`);
    let stageContent = '';
    try {
        if (existsSync(stageDoc)) {
            stageContent = '\n\n--- ' + currentStage + ' 指令 ---\n' + readFileSync(stageDoc, 'utf-8');
        }
    }
    catch { /* non-fatal */ }
    const ctx = `✅ feat-flow 已从 ${branch} 恢复\n\n` +
        `flow_id:      ${flowId}\n` +
        `需求:         ${restoredState.requirement}\n` +
        `当前阶段:     ${currentStage}\n` +
        `base_sha:     ${restoredState.base_sha}\n\n` +
        `前面已完成的工作已保存在 ${branch} 分支，可用 git log ${branch} 查看。\n` +
        `如需了解工作流规则：${HELPER_PATH}` +
        stageContent;
    const out = {
        hookEventName: 'UserPromptSubmit',
        additionalContext: ctx,
    };
    return {
        systemMessage: `✅ feat-flow 已从 ${branch} 恢复 | 当前阶段: ${currentStage}`,
        hookSpecificOutput: out,
    };
}
//# sourceMappingURL=resume.js.map