import { discoverFlows, loadFlowConfig } from '../flow-config-loader.js';
export async function handleHelp(repoRoot) {
    const flows = await discoverFlows(repoRoot);
    if (flows.length === 0) {
        return {
            action: 'allow',
            additionalContext: 'No flows configured in this project. Use /ai-flow to add a flow definition.',
        };
    }
    const sections = [];
    for (const flowName of flows) {
        try {
            const config = await loadFlowConfig(repoRoot, flowName);
            const stageList = config.stages.map((s, i) => `  ${i + 1}. ${s.id}`).join('\n');
            const desc = config.description ? `\n${config.description}` : '';
            sections.push(`## ${flowName}${desc}\n\nStages:\n${stageList}`);
        }
        catch {
            sections.push(`## ${flowName}\n  (config load error)`);
        }
    }
    return { action: 'allow', additionalContext: sections.join('\n\n') };
}
//# sourceMappingURL=help.js.map