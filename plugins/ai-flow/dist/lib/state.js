import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
function statePath(repoRoot, flowName, file) {
    return join(repoRoot, '.ai-flow', flowName, 'state', file);
}
function stateDir(repoRoot, flowName) {
    return join(repoRoot, '.ai-flow', flowName, 'state');
}
export async function readActiveState(repoRoot, flowName) {
    const path = statePath(repoRoot, flowName, 'active.json');
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch {
        return null;
    }
}
export async function writeActiveState(repoRoot, flowName, state) {
    mkdirSync(stateDir(repoRoot, flowName), { recursive: true });
    writeFileSync(statePath(repoRoot, flowName, 'active.json'), JSON.stringify(state, null, 2));
}
export async function hasActiveFlow(cwd) {
    // Walk up from cwd to find the nearest .ai-flow directory (monorepo-safe).
    let dir = cwd;
    while (true) {
        const aiFlowDir = join(dir, '.ai-flow');
        if (existsSync(aiFlowDir)) {
            for (const entry of readdirSync(aiFlowDir, { withFileTypes: true })) {
                if (!entry.isDirectory())
                    continue;
                const state = await readActiveState(dir, entry.name);
                if (state)
                    return { flowName: entry.name, state, repoRoot: dir };
            }
            return null; // .ai-flow exists but no active flow inside
        }
        const parent = dirname(dir);
        if (parent === dir)
            return null; // reached filesystem root
        dir = parent;
    }
}
export async function isGateActive(repoRoot, flowName) {
    return existsSync(statePath(repoRoot, flowName, 'gate-token'));
}
export async function writeGateToken(repoRoot, flowName, token) {
    mkdirSync(stateDir(repoRoot, flowName), { recursive: true });
    writeFileSync(statePath(repoRoot, flowName, 'gate-token'), token);
}
export async function deleteGateToken(repoRoot, flowName) {
    const path = statePath(repoRoot, flowName, 'gate-token');
    if (existsSync(path))
        unlinkSync(path);
}
export async function readGateToken(repoRoot, flowName) {
    const path = statePath(repoRoot, flowName, 'gate-token');
    if (!existsSync(path))
        return null;
    return readFileSync(path, 'utf-8').trim();
}
export async function appendTransition(repoRoot, flowName, message) {
    const path = statePath(repoRoot, flowName, 'transitions.log');
    const timestamp = new Date().toISOString();
    appendFileSync(path, `${timestamp} [${flowName}] ${message}\n`);
}
export async function appendViolation(repoRoot, flowName, message) {
    const path = statePath(repoRoot, flowName, 'violations.log');
    const timestamp = new Date().toISOString();
    appendFileSync(path, `${timestamp} [${flowName}] ${message}\n`);
}
export async function appendHookLog(repoRoot, flowName, message) {
    const path = statePath(repoRoot, flowName, 'hooks.log');
    const timestamp = new Date().toISOString();
    appendFileSync(path, `${timestamp} [${flowName}] ${message}\n`);
}
export function nextStage(config, currentStageId) {
    const idx = config.stages.findIndex((s) => s.id === currentStageId);
    if (idx === -1 || idx === config.stages.length - 1)
        return null;
    return config.stages[idx + 1].id;
}
export function signalPath(repoRoot, flowName) {
    return statePath(repoRoot, flowName, 'signal');
}
export function activeJsonPath(repoRoot, flowName) {
    return statePath(repoRoot, flowName, 'active.json');
}
export function gateTokenPath(repoRoot, flowName) {
    return statePath(repoRoot, flowName, 'gate-token');
}
export function scriptsDir(repoRoot, flowName) {
    return join(repoRoot, '.ai-flow', flowName, 'scripts');
}
//# sourceMappingURL=state.js.map