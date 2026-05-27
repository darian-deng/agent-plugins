import { join, relative } from 'path';
import { randomBytes } from 'crypto';
import { readActiveState, writeActiveState, writeGateToken, appendTransition, appendViolation, appendHookLog, nextStage, gateTokenPath, signalPath } from './state.js';
import { loadFlowConfig, getStageConfig, resolveDocsPaths } from './flow-config-loader.js';
import { runScript } from './script-executor.js';
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
function deny(reason, systemMessage) {
    return { permissionDecision: 'deny', permissionDecisionReason: reason, ...(systemMessage && { systemMessage }) };
}
function allow() {
    return { permissionDecision: 'allow' };
}
function resolvePath(repoRoot, filePath) {
    if (filePath.startsWith('/'))
        return filePath;
    return join(repoRoot, filePath);
}
export async function handlePreTool(input) {
    const { cwd: repoRoot, tool_name, tool_input } = input;
    // Discover which flow is active
    const aiFlowBase = join(repoRoot, '.ai-flow');
    let activeFlowName = null;
    let state = null;
    try {
        const { readdirSync, existsSync } = await import('fs');
        if (!existsSync(aiFlowBase))
            return null;
        for (const entry of readdirSync(aiFlowBase, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            const s = await readActiveState(repoRoot, entry.name);
            if (s) {
                activeFlowName = entry.name;
                state = s;
                break;
            }
        }
    }
    catch {
        return null;
    }
    if (!activeFlowName || !state)
        return null;
    const config = await loadFlowConfig(repoRoot, activeFlowName);
    // ─── Context block enforcement ────────────────────────────────────────────────
    if (state.context_blocked && WRITE_TOOLS.has(tool_name)) {
        const blockedPct = state.context_warning.warned_at_pct;
        const pctInfo = blockedPct !== null ? ` at ${blockedPct}%` : '';
        return deny(`Context blocked${pctInfo}. Run /clear to continue — state is persisted and progress won't be lost.`);
    }
    // ─── Bash interception ────────────────────────────────────────────────────────
    if (tool_name === 'Bash') {
        const command = String(tool_input['command'] ?? '');
        const gateToken = gateTokenPath(repoRoot, activeFlowName);
        const signal = signalPath(repoRoot, activeFlowName);
        const activeJson = join(repoRoot, '.ai-flow', activeFlowName, 'state', 'active.json');
        const scriptsDir = join(repoRoot, '.ai-flow', activeFlowName, 'scripts');
        if (command.includes(gateToken))
            return deny('gate-token is read-protected. The token was shown to the user via system message.');
        if (command.includes(signal))
            return deny('Direct Bash writes to signal are blocked. Use the Write tool to signal stage completion.');
        if (command.includes(activeJson))
            return deny('Direct modification of active.json is blocked (control plane protection).');
        if (command.includes(scriptsDir))
            return deny('Modification of scripts/ via Bash is blocked. Ask the user to replace scripts manually.');
        return null;
    }
    // ─── Read tools ──────────────────────────────────────────────────────────────
    if (READ_TOOLS.has(tool_name)) {
        const fp = String(tool_input['file_path'] ?? '');
        if (!fp)
            return null;
        const abs = resolvePath(repoRoot, fp);
        if (abs === gateTokenPath(repoRoot, activeFlowName)) {
            return deny('gate-token is read-protected. The token was shown to the user via system message.');
        }
        return null;
    }
    if (!WRITE_TOOLS.has(tool_name))
        return null;
    const fp = String(tool_input['file_path'] ?? tool_input['notebook_path'] ?? '');
    if (!fp)
        return null;
    const absPath = resolvePath(repoRoot, fp);
    // ─── Signal interception ─────────────────────────────────────────────────────
    if (absPath === signalPath(repoRoot, activeFlowName)) {
        await appendHookLog(repoRoot, activeFlowName, `SIGNAL_INTERCEPT stage=${state.current_stage} tool=${tool_name}`);
        const stageCfg = getStageConfig(config, state.current_stage);
        if (stageCfg.completion.script) {
            const flowDir = join(repoRoot, '.ai-flow', activeFlowName);
            const scriptOpts = stageCfg.completion.script.timeout_ms !== undefined
                ? { timeout_ms: stageCfg.completion.script.timeout_ms }
                : undefined;
            const scriptResult = await runScript(stageCfg.completion.script.command, flowDir, scriptOpts);
            if (!scriptResult.ok) {
                await appendHookLog(repoRoot, activeFlowName, `SCRIPT_FAIL stage=${state.current_stage} reason=${scriptResult.reason.replace(/\n/g, ' ').slice(0, 80)}`);
                return deny(`Script validation failed:\n${scriptResult.reason}\n\nFix the issues and try again.`);
            }
        }
        if (stageCfg.completion.gate) {
            const token = randomBytes(16).toString('hex');
            await writeGateToken(repoRoot, activeFlowName, token);
            await appendTransition(repoRoot, activeFlowName, `GATE_PENDING stage=${state.current_stage}`);
            await appendHookLog(repoRoot, activeFlowName, `GATE_ISSUED stage=${state.current_stage} token=${token.slice(0, 8)}...`);
            return deny(`Gate checkpoint for stage '${state.current_stage}'. AI has determined this stage is complete.\n` +
                `User notification and approval command have been sent via system message.\n` +
                `Do NOT output "${activeFlowName} approve" in your response. ` +
                `Just acknowledge the gate is pending and direct the user to check the system message above.`, `**${activeFlowName} Stage \`${state.current_stage}\` 已完成，等待人工确认。**\n` +
                `- 如确认本 stage 产物符合预期 → 执行: ${activeFlowName} approve ${token}\n` +
                `- 如认为需要继续完善 → 继续讨论，完成后重新触发`);
        }
        const next = nextStage(config, state.current_stage);
        if (!next) {
            // Last stage — complete the flow
            const { unlinkSync, existsSync } = await import('fs');
            const activeJsonPath = join(repoRoot, '.ai-flow', activeFlowName, 'state', 'active.json');
            if (existsSync(activeJsonPath))
                unlinkSync(activeJsonPath);
            await appendTransition(repoRoot, activeFlowName, `COMPLETED flow_id=${state.flow_id}`);
            await appendHookLog(repoRoot, activeFlowName, `COMPLETED flow_id=${state.flow_id}`);
            return allow();
        }
        const updated = { ...state, current_stage: next };
        await writeActiveState(repoRoot, activeFlowName, updated);
        await appendTransition(repoRoot, activeFlowName, `ADVANCED ${state.current_stage} → ${next}`);
        await appendHookLog(repoRoot, activeFlowName, `ADVANCED ${state.current_stage} → ${next}`);
        return allow();
    }
    // ─── Control plane protection ─────────────────────────────────────────────────
    const rel = relative(repoRoot, absPath);
    const flowBase = join('.ai-flow', activeFlowName);
    // gate-token direct write
    if (absPath === gateTokenPath(repoRoot, activeFlowName)) {
        await appendViolation(repoRoot, activeFlowName, `BLOCKED direct write to gate-token: ${fp}`);
        return deny('Direct writes to gate-token are blocked.');
    }
    // active.json direct write
    if (rel === join(flowBase, 'state', 'active.json')) {
        await appendViolation(repoRoot, activeFlowName, `BLOCKED direct write to active.json`);
        return deny('Direct writes to active.json are blocked (control plane protection).');
    }
    // config.json
    if (rel === join(flowBase, 'config.json')) {
        await appendViolation(repoRoot, activeFlowName, `BLOCKED write to config.json`);
        return deny('config.json is read-only during flow execution.');
    }
    // stages/
    if (rel.startsWith(join(flowBase, 'stages') + '/')) {
        await appendViolation(repoRoot, activeFlowName, `BLOCKED write to stage prompt: ${fp}`);
        return deny('Stage prompt files are read-only during flow execution.');
    }
    // scripts/ — special message
    if (rel.startsWith(join(flowBase, 'scripts') + '/')) {
        await appendViolation(repoRoot, activeFlowName, `BLOCKED write to scripts: ${fp}`);
        return deny('Script files cannot be modified during flow execution. Ask the user to replace them manually.');
    }
    // ─── Write scope enforcement ──────────────────────────────────────────────────
    const stageCfg = getStageConfig(config, state.current_stage);
    if (stageCfg.write_scope === 'docs_only') {
        const docsPaths = resolveDocsPaths(stageCfg.docs_paths ?? [], state.flow_id);
        const allowed = docsPaths.some((p) => rel.startsWith(p) || absPath.startsWith(join(repoRoot, p)));
        if (!allowed) {
            await appendViolation(repoRoot, activeFlowName, `SCOPE_VIOLATION stage=${state.current_stage} path=${fp}`);
            return deny(`Write scope violation: stage '${state.current_stage}' is docs_only.\n` +
                `Allowed paths: ${docsPaths.join(', ')}\n` +
                `Blocked: ${fp}`);
        }
    }
    return null;
}
//# sourceMappingURL=pretool-handler.js.map