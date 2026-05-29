import { join, relative, resolve } from 'path';
import { hasActiveFlow, appendViolation, appendHookLog, nextStage, signalPath, } from './state.js';
import { loadFlowConfig, getStageConfig, resolveDocsPaths, stageIndex, getStageByPromptPath } from './flow-config-loader.js';
import { runScript } from './script-executor.js';
import { truncateError } from './format.js';
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
    const { cwd, tool_name, tool_input } = input;
    const active = await hasActiveFlow(cwd).catch(() => null);
    if (!active)
        return null;
    const { flowName: activeFlowName, state, repoRoot } = active;
    try {
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
            const signal = signalPath(repoRoot, activeFlowName);
            const activeJson = join(repoRoot, '.ai-flow', activeFlowName, 'state', 'active.json');
            const scripts = join(repoRoot, '.ai-flow', activeFlowName, 'scripts');
            if (command.includes(signal))
                return deny('Direct Bash writes to signal are blocked. Use the Write tool to signal stage completion.');
            if (command.includes(activeJson))
                return deny('Direct modification of active.json is blocked (control plane protection).');
            if (command.includes(scripts))
                return deny('Modification of scripts/ via Bash is blocked. Ask the user to replace scripts manually.');
            return null;
        }
        // ─── Read tools ──────────────────────────────────────────────────────────────
        if (READ_TOOLS.has(tool_name)) {
            const fp = String(tool_input['file_path'] ?? '');
            if (!fp)
                return null;
            const abs = resolvePath(repoRoot, fp);
            // Stage file ordering: deny reads of future stage files
            const targetStageId = getStageByPromptPath(config, activeFlowName, abs);
            if (targetStageId !== null) {
                const currentIdx = stageIndex(config, state.current_stage);
                if (currentIdx === -1)
                    return null; // unknown current stage — fail open, don't lock AI out
                const targetIdx = stageIndex(config, targetStageId);
                if (targetIdx > currentIdx) {
                    return deny(`Stage file '${targetStageId}' is ahead of the current stage '${state.current_stage}'. ` +
                        `You may only read stage files for the current stage or earlier stages.`);
                }
            }
            return null;
        }
        if (!WRITE_TOOLS.has(tool_name))
            return null;
        const fp = String(tool_input['file_path'] ?? tool_input['notebook_path'] ?? '');
        if (!fp)
            return null;
        // ─── cwd ≠ repoRoot guard (subdir-write protection) ───────────────────────────
        // repoRoot is always cwd or an ancestor (hasActiveFlow walks up to find .ai-flow).
        // When the session cwd is a subdirectory, a RELATIVE file_path is resolved by the
        // write tool against cwd — so it silently lands at <cwd>/<fp> instead of the flow
        // root, and the scope check below (which assumes repoRoot) would validate the wrong
        // path. Write also auto-creates parent dirs, so the misplacement is silent. Force
        // an absolute, repoRoot-anchored path before any path-based check runs.
        if (!fp.startsWith('/') && resolve(cwd) !== resolve(repoRoot)) {
            await appendViolation(repoRoot, activeFlowName, `CWD_MISMATCH cwd=${cwd} path=${fp}`);
            return deny(`feat-flow expects the working directory to be the flow root (${repoRoot}), but the current ` +
                `cwd has drifted into a subdirectory (${cwd}). Relative paths resolve against cwd, so '${fp}' ` +
                `would be written under the subdirectory — not the flow root — and Write would silently create ` +
                `it there. Re-issue the write with an absolute path to the location you actually intend: ` +
                `a flow artifact rooted at the flow root is ${join(repoRoot, fp)}; ` +
                `a file under the current subdirectory is ${resolve(cwd, fp)}.`);
        }
        const absPath = resolvePath(repoRoot, fp);
        // ─── Signal interception ─────────────────────────────────────────────────────
        if (absPath === signalPath(repoRoot, activeFlowName)) {
            await appendHookLog(repoRoot, activeFlowName, `SIGNAL_INTERCEPT stage=${state.current_stage} tool=${tool_name}`);
            const stageCfg = getStageConfig(config, state.current_stage);
            const signalContent = String(tool_input['content'] ?? '').trim();
            // Determine expected signal content
            const next = nextStage(config, state.current_stage);
            const expectedContent = next !== null ? next : 'flow-complete';
            // Validate signal content
            if (signalContent !== expectedContent) {
                await appendHookLog(repoRoot, activeFlowName, `SIGNAL_INVALID expected=${expectedContent} got=${signalContent}`);
                return deny(`Invalid signal content. Expected '${expectedContent}' for stage '${state.current_stage}'. ` +
                    `Got: '${signalContent}'. Write exactly '${expectedContent}' to the signal file.`);
            }
            // Script validation (if configured)
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
            // Gate type: ALLOW (PostToolUse will detect gate via signal content and handle pending state)
            if (stageCfg.completion.gate) {
                await appendHookLog(repoRoot, activeFlowName, `GATE_SIGNAL_WRITTEN stage=${state.current_stage}`);
                return allow();
            }
            // None/script type (non-gate): ALLOW — PostToolUse will advance stage and inject next prompt
            await appendHookLog(repoRoot, activeFlowName, `SIGNAL_ALLOW stage=${state.current_stage}`);
            return allow();
        }
        // ─── Control plane protection ─────────────────────────────────────────────────
        const rel = relative(repoRoot, absPath);
        const flowBase = join('.ai-flow', activeFlowName);
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
            // Normalize: ensure trailing slash to prevent "docs/feat-flows-evil" matching "docs/feat-flows"
            const allowed = docsPaths.some((p) => {
                const norm = p.endsWith('/') ? p : p + '/';
                return rel.startsWith(norm) || absPath.startsWith(join(repoRoot, norm));
            });
            if (!allowed) {
                await appendViolation(repoRoot, activeFlowName, `SCOPE_VIOLATION stage=${state.current_stage} path=${fp}`);
                return deny(`Write scope violation: stage '${state.current_stage}' is docs_only.\n` +
                    `Allowed paths: ${docsPaths.join(', ')}\n` +
                    `Blocked: ${fp}`);
            }
        }
        return null;
    }
    catch (e) {
        try {
            await appendHookLog(repoRoot, activeFlowName, `ERROR pretool tool=${tool_name}: ${truncateError(e)}`);
        }
        catch { /* appendHookLog itself failed */ }
        return null;
    }
}
//# sourceMappingURL=pretool-handler.js.map