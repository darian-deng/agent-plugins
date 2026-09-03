import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { FlowConfigSchema, type FlowConfig, type StageConfig } from './flow-schema.js';
import { flowDefDir } from './flow-paths.js';

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

function readJson(path: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error('config.json must contain a JSON object');
    }
    return v as Record<string, unknown>;
  } catch (e) {
    throw new FlowConfigParseError(path, e);
  }
}

/**
 * Plugin defaults underneath, the project's file on top.
 *
 * Shallow at the top level, one level deep for `context` — the only nested object a
 * project has any reason to tune, and merging it deeply is what lets a project set
 * `wrap_up_at_pct` alone without restating the rest of the block. `stages` is
 * replaced wholesale when the project declares it: a partial stage list has no sane
 * merge (by index? by id? what does a missing entry mean?), and the case it would
 * serve — reordering or re-scoping a shipped flow's stages — is what
 * `/ai-flow:create` is for.
 */
function mergeConfig(
  defaults: Record<string, unknown>,
  overrides: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...defaults, ...overrides };
  const dCtx = defaults['context'];
  const oCtx = overrides['context'];
  if (dCtx && typeof dCtx === 'object' && !Array.isArray(dCtx)
      && oCtx && typeof oCtx === 'object' && !Array.isArray(oCtx)) {
    merged['context'] = { ...(dCtx as object), ...(oCtx as object) };
  }
  return merged;
}

export async function loadFlowConfig(repoRoot: string, flowName: string): Promise<FlowConfig> {
  const configPath = join(repoRoot, '.ai-flow', flowName, 'config.json');
  if (!existsSync(configPath)) throw new FlowNotFoundError(flowName);

  // The project's file is an OVERRIDE layer for a flow the plugin ships, and the
  // whole config for one it does not. It is never validated on its own: a sparse
  // override legitimately has no `name` and no `stages`, both of which the schema
  // requires, so validating before the merge would reject every correct install.
  const defPath = join(flowDefDir(repoRoot, flowName), 'config.json');
  const overrides = readJson(configPath);
  const raw = defPath === configPath
    ? overrides
    : mergeConfig(readJson(defPath), overrides);

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

export function stageIndex(config: FlowConfig, stageId: string): number {
  return config.stages.findIndex((s) => s.id === stageId);
}

export function getStageByPromptPath(config: FlowConfig, flowName: string, filePath: string): string | null {
  // filePath is absolute, like /root/.ai-flow/flowName/stages/work.md
  // stage.prompt is relative like 'stages/work.md'
  for (const stage of config.stages) {
    // Normalize the prompt path to just the basename portion after flowName
    const promptSuffix = stage.prompt.replace(/\\/g, '/');
    // Check if filePath ends with /.ai-flow/{flowName}/{stage.prompt}
    const expectedSuffix = `.ai-flow/${flowName}/${promptSuffix}`;
    if (filePath.replace(/\\/g, '/').endsWith(expectedSuffix)) {
      return stage.id;
    }
  }
  return null;
}
