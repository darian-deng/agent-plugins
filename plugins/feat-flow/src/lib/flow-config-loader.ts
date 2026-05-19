import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { FlowConfigSchema, type FlowConfig, type StageConfig } from './flow-schema.js';

export class FlowNotFoundError extends Error {
  constructor(flowName: string) {
    super(`Flow '${flowName}' not found. use /ai-flow to add it to this project.`);
    this.name = 'FlowNotFoundError';
  }
}

export class FlowConfigParseError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`Failed to parse config.json at ${filePath}: ${String(cause)}`);
    this.name = 'FlowConfigParseError';
  }
}

export class FlowConfigValidationError extends Error {
  constructor(flowName: string, details: string) {
    super(`Invalid config for flow '${flowName}':\n${details}`);
    this.name = 'FlowConfigValidationError';
  }
}

export async function loadFlowConfig(repoRoot: string, flowName: string): Promise<FlowConfig> {
  const configPath = join(repoRoot, '.ai-flow', flowName, 'config.json');
  if (!existsSync(configPath)) throw new FlowNotFoundError(flowName);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (e) {
    throw new FlowConfigParseError(configPath, e);
  }

  const result = FlowConfigSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  [${i.path.join('.')}] ${i.message}`)
      .join('\n');
    throw new FlowConfigValidationError(flowName, details);
  }
  return result.data;
}

export async function discoverFlows(repoRoot: string): Promise<string[]> {
  const aiFlowDir = join(repoRoot, '.ai-flow');
  if (!existsSync(aiFlowDir)) return [];
  const entries = readdirSync(aiFlowDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && existsSync(join(aiFlowDir, e.name, 'config.json')))
    .map((e) => e.name);
}

export function getStageConfig(config: FlowConfig, stageId: string): StageConfig {
  const stage = config.stages.find((s) => s.id === stageId);
  if (!stage) throw new Error(`Stage '${stageId}' not found in flow '${config.name}'`);
  return stage;
}

export function resolveDocsPaths(paths: string[], flowId: string): string[] {
  return paths.map((p) => p.replace(/\{flow_id\}/g, flowId));
}
