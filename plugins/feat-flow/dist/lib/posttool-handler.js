import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { readState, writeState, hasActiveFlow, paths, writeGateToken, appendTransition, advanceStage, } from './state.js';
import { contextPct } from './context.js';
import { WARN_PCT, URGENT_PCT, REWARN_DELTA_PCT, STAGES_DIR, HELPER_PATH } from './config.js';
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
// ─── Stage completion detection ────────────────────────────────────────────────
function hasAnchors(content, ...anchors) {
    return anchors.every(a => content.includes(a));
}
function wordCount(content) {
    return content.trim().split(/\s+/).filter(Boolean).length;
}
function checkCompletion(state, repoRoot, writtenFile) {
    const flowDir = join(repoRoot, 'docs/feat-flows', state.flow_id);
    const design = join(flowDir, 'design.md');
    const plan = join(flowDir, 'plan.md');
    const review = join(flowDir, 'review.md');
    const verDir = join(flowDir, 'verification');
    const readSafe = (p) => {
        try {
            return existsSync(p) ? readFileSync(p, 'utf-8') : '';
        }
        catch {
            return '';
        }
    };
    const stage = state.current_stage;
    switch (stage) {
        case 'stage-1': {
            const d = readSafe(design);
            if (hasAnchors(d, '## 需求', '## 验收标准', '## STAGE-1-COMPLETE') && wordCount(d) >= 200)
                return { triggered: true, type: 'stage', context: 'stage-1 requirements confirmed' };
            break;
        }
        case 'stage-2': {
            const d = readSafe(design);
            if (hasAnchors(d, '## 探索摘要', '## 影响范围', '## STAGE-2-COMPLETE'))
                return { triggered: true, type: 'stage', context: 'stage-2 exploration complete' };
            break;
        }
        case 'stage-3': {
            const d = readSafe(design);
            if (hasAnchors(d, '## 方案选型', '## 决策记录', '## STAGE-3-COMPLETE') && wordCount(d) >= 500)
                return { triggered: true, type: 'stage', context: 'stage-3 architecture selected' };
            break;
        }
        case 'stage-4': {
            const p = readSafe(plan);
            const taskCount = (p.match(/^- \[/gm) ?? []).length;
            if (hasAnchors(p, '## Tasks', '## STAGE-4-COMPLETE') && taskCount > 0)
                return { triggered: true, type: 'stage', context: 'stage-4 plan approved' };
            break;
        }
        case 'stage-5': {
            // Check for task-level [GATE] in plan.md
            const p = readSafe(plan);
            const lines = p.split('\n');
            for (const line of lines) {
                // Match: - [x] Task N: ... [GATE]
                if (/^- \[x\].*\[GATE\]/.test(line)) {
                    const taskLabel = line.replace(/^- \[x\]\s*/, '').replace(/\[GATE\].*$/, '').trim();
                    // Skip if already approved
                    if (!state.approved_task_gates.includes(taskLabel)) {
                        return { triggered: true, type: 'task', context: taskLabel };
                    }
                }
            }
            // Check for stage completion: all tasks [x] + STAGE-5-COMPLETE
            // Use line-start regex to avoid false matches inside code blocks or descriptions
            if (hasAnchors(p, '## STAGE-5-COMPLETE') && !/^- \[ \]/m.test(p))
                return { triggered: true, type: 'stage', context: 'stage-5 implementation complete' };
            break;
        }
        case 'stage-6': {
            if (existsSync(join(verDir, 'lint.txt')) &&
                existsSync(join(verDir, 'typecheck.txt')) &&
                existsSync(join(verDir, 'test.txt')))
                return { triggered: true, type: 'stage', context: 'stage-6 verification passed' };
            break;
        }
        case 'stage-7': {
            const r = readSafe(review);
            const hasUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/m.test(r);
            if (hasAnchors(r, '## reviewer-subagent-id', '## diff-base-sha', '## issues', '## STAGE-7-COMPLETE') && hasUuid)
                return { triggered: true, type: 'stage', context: 'stage-7 review complete' };
            break;
        }
        case 'stage-8': {
            const d = readSafe(design);
            if (hasAnchors(d, '## STAGE-8-COMPLETE'))
                return { triggered: true, type: 'stage', context: 'stage-8 knowledge captured' };
            break;
        }
    }
    return { triggered: false };
}
// Stages that need a human GATE before advancing
const GATED_STAGES = new Set(['stage-1', 'stage-3', 'stage-4', 'stage-7']);
function needsGate(stage, decision) {
    if (decision.type === 'task')
        return true;
    return GATED_STAGES.has(stage);
}
// ─── Context window monitoring ─────────────────────────────────────────────────
function buildContextWarning(pct, level) {
    const emoji = level === 'urgent' ? '🚨' : '⚠️';
    const threshold = level === 'urgent' ? URGENT_PCT : WARN_PCT;
    return (`${emoji} Context 已用 ${pct}%（阈值 ${threshold}%）\n` +
        `建议：完成当前 task 后执行 /clear，然后重开 session。\n` +
        `feat-flow 支持随时 /clear，state.json 持久化，进度不丢失。`);
}
// ─── Main handler ──────────────────────────────────────────────────────────────
export async function handlePostToolUse(input) {
    const { cwd, session_id, tool_name, tool_input } = input;
    if (!hasActiveFlow(cwd))
        return null;
    if (!WRITE_TOOLS.has(tool_name))
        return null;
    const state = readState(cwd);
    if (!state)
        return null;
    if (state.waiting_for_gate)
        return null; // no re-trigger
    const writtenFile = (tool_input['file_path'] ?? '');
    // ── Stage completion check ──
    const decision = checkCompletion(state, cwd, writtenFile);
    let output = null;
    if (decision.triggered) {
        const gated = needsGate(state.current_stage, decision);
        if (gated) {
            // Generate token
            const token = randomBytes(8).toString('hex');
            writeGateToken(cwd, token);
            const updatedState = {
                ...state,
                waiting_for_gate: true,
                gate_type: decision.type,
                gate_context: decision.context,
                expected_next: 'feat-flow approve <token>',
            };
            writeState(cwd, updatedState);
            appendTransition(cwd, `GATE_TRIGGERED stage=${state.current_stage} type=${decision.type}`);
            const tokenHint = `如弹窗已关闭，执行：! cat ${paths(cwd).gateToken}\n` +
                `然后输入：feat-flow approve <token>`;
            const ctx = `[feat-flow] ${state.current_stage} 完成条件已满足（${decision.type}）。\n` +
                `GATE token 已生成，已通过 systemMessage 告知用户。\n` +
                `请停止工作，提示用户执行：feat-flow approve <token>\n` +
                `AI 无法自行通过审批——这是设计约束，不是 bug。\n` +
                `如需了解规则：${HELPER_PATH}`;
            const postOut = { hookEventName: 'PostToolUse', additionalContext: ctx };
            output = {
                systemMessage: `✅ feat-flow: ${state.current_stage} 完成条件已满足\n\n${tokenHint}`,
                hookSpecificOutput: postOut,
            };
        }
        else {
            // Auto-advance
            const nextState = advanceStage(state);
            writeState(cwd, nextState);
            appendTransition(cwd, `AUTO_ADVANCE from=${state.current_stage} to=${nextState.current_stage}`);
            const nextStageDoc = join(STAGES_DIR, `${nextState.current_stage}.md`);
            let stageContent = '';
            try {
                if (existsSync(nextStageDoc))
                    stageContent = '\n\n' + readFileSync(nextStageDoc, 'utf-8');
            }
            catch { /* ignore */ }
            const ctx = `[feat-flow] ${state.current_stage} 完成，自动推进到 ${nextState.current_stage}。\n` +
                `请继续执行下一阶段任务。${stageContent}`;
            const postOut = { hookEventName: 'PostToolUse', additionalContext: ctx };
            output = { hookSpecificOutput: postOut };
        }
    }
    // ── Context window check ──
    const pct = contextPct(session_id, cwd, state.context_size);
    const warning = state.context_warning;
    const prevPct = warning.warned_at_pct ?? 0;
    if (pct >= URGENT_PCT && (!warning.warned || pct >= prevPct + REWARN_DELTA_PCT)) {
        const msg = buildContextWarning(pct, 'urgent');
        const updatedState = {
            ...(output ? readState(cwd) ?? state : state),
            context_warning: { warned: true, warned_at_pct: pct, warned_at: new Date().toISOString() },
        };
        writeState(cwd, updatedState);
        if (output) {
            output.systemMessage = (output.systemMessage ? output.systemMessage + '\n\n' : '') + msg;
        }
        else {
            const postOut = {
                hookEventName: 'PostToolUse',
                additionalContext: msg,
            };
            output = { systemMessage: msg, hookSpecificOutput: postOut };
        }
    }
    else if (pct >= WARN_PCT && (!warning.warned || pct >= prevPct + REWARN_DELTA_PCT)) {
        const msg = buildContextWarning(pct, 'warn');
        const updatedState = {
            ...(output ? readState(cwd) ?? state : state),
            context_warning: { warned: true, warned_at_pct: pct, warned_at: new Date().toISOString() },
        };
        writeState(cwd, updatedState);
        if (output) {
            output.systemMessage = (output.systemMessage ? output.systemMessage + '\n\n' : '') + msg;
        }
        else {
            const postOut = {
                hookEventName: 'PostToolUse',
                additionalContext: msg,
            };
            output = { systemMessage: msg, hookSpecificOutput: postOut };
        }
    }
    return output;
}
//# sourceMappingURL=posttool-handler.js.map