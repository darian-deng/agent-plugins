import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { discoverFlows, loadFlowConfig } from '../flow-config-loader.js';
import type { CommandResult } from '../types.js';

export async function handleHelp(repoRoot: string, flowName?: string): Promise<CommandResult> {
  // Flow-specific help: inject helper.md so AI can answer questions interactively
  if (flowName) {
    const helperPath = join(repoRoot, '.ai-flow', flowName, 'helper.md');
    if (existsSync(helperPath)) {
      const content = readFileSync(helperPath, 'utf-8');
      return { action: 'allow', additionalContext: content };
    }
    // Fallback: build summary from config
    try {
      const config = await loadFlowConfig(repoRoot, flowName);
      const stageList = config.stages
        .map((s, i) => {
          const gate = s.completion.gate ? ' [Gate]' : '';
          const script = s.completion.script ? ' [Script]' : '';
          return `  ${i + 1}. ${s.id}${gate}${script}`;
        })
        .join('\n');
      const desc = config.description ? `\n${config.description}\n` : '';
      return {
        action: 'allow',
        additionalContext:
          `# ${flowName}${desc}\n\nStages:\n${stageList}\n\n` +
          `Run \`${flowName} status\` to check current progress.`,
      };
    } catch {
      return {
        action: 'allow',
        additionalContext: `No configuration found for flow '${flowName}'. Use /ai-flow:add or /ai-flow:create.`,
      };
    }
  }

  // Generic help: list all flows in the project
  const flows = await discoverFlows(repoRoot);
  if (flows.length === 0) {
    return {
      action: 'allow',
      additionalContext:
        'No flows configured in this project.\n' +
        '  /ai-flow:add    — install a built-in flow template\n' +
        '  /ai-flow:create — design a new custom flow',
    };
  }

  const lines: string[] = ['Available flows in this project:\n'];
  for (const name of flows) {
    try {
      const config = await loadFlowConfig(repoRoot, name);
      const desc = config.description ? ` — ${config.description}` : '';
      lines.push(`  ${name}${desc} (${config.stages.length} stages)`);
    } catch {
      lines.push(`  ${name} (config load error)`);
    }
  }
  lines.push('\nRun `{flow-name} help` for details on a specific flow.');

  return { action: 'allow', additionalContext: lines.join('\n') };
}
