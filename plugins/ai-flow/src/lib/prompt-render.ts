import { join } from 'path';

/**
 * Substitute path placeholders in a stage prompt before injecting it.
 *
 * Stage prompts should anchor every flow-artifact path on `{{project_root}}`
 * (the absolute anchor where `.ai-flow` lives) instead of writing relative
 * paths like `.ai-flow/<flow>/state/signal` or `docs/...`. Relative paths
 * resolve against the agent's CURRENT cwd, which is free to drift once cd is
 * unrestricted — so a relative path would silently land in the wrong place.
 * Absolute, project_root-anchored paths make the agent's writes correct
 * regardless of where it has cd'd to.
 *
 * Placeholders:
 *   {{project_root}} → the anchor dir (repoRoot)
 *   {{flow_root}}    → <repoRoot>/.ai-flow/<flowName>
 *
 * No-op for prompts that contain no placeholders (backward compatible).
 */
export function renderPrompt(content: string, repoRoot: string, flowName: string): string {
  const flowRoot = join(repoRoot, '.ai-flow', flowName);
  return content
    .replace(/\{\{\s*project_root\s*\}\}/g, repoRoot)
    .replace(/\{\{\s*flow_root\s*\}\}/g, flowRoot);
}

/**
 * Build the `[ai-flow:paths]` preamble injected ahead of every stage prompt.
 *
 * It gives the agent the ABSOLUTE anchor (project_root) and flow dir (flow_root)
 * so it never has to rely on cwd, and surfaces `base_sha_code` when captured so
 * stages read it from here instead of poking active.json (which the control-plane
 * guard blocks and which is not cwd-safe).
 */
export function buildAiFlowPreamble(repoRoot: string, flowName: string, baseSha?: string | null): string {
  const flowRoot = join(repoRoot, '.ai-flow', flowName);
  const lines = [
    `[ai-flow:paths]`,
    `project_root: ${repoRoot}`,
    `flow_root: ${flowRoot}`,
  ];
  if (baseSha) lines.push(`base_sha_code: ${baseSha}`);
  return lines.join('\n') + '\n\n';
}
