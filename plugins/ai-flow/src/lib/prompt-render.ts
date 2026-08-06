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
 * Placeholder substitution is a no-op for prompts that contain none, but the
 * render itself is NOT a pure pass-through: every rendered prompt also gets
 * `writtenDocLengthNote()` appended (see that function for why it lives here).
 */
export function renderPrompt(content: string, repoRoot: string, flowName: string): string {
  const flowRoot = join(repoRoot, '.ai-flow', flowName);
  const substituted = content
    .replace(/\{\{\s*project_root\s*\}\}/g, repoRoot)
    .replace(/\{\{\s*flow_root\s*\}\}/g, flowRoot);
  return substituted + '\n' + writtenDocLengthNote();
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

/**
 * Universal length discipline for artifacts the stage WRITES TO DISK.
 *
 * Appended by `renderPrompt()` to every stage prompt of every flow — gated or
 * not — so there is one source of truth and flow authors can't forget it.
 *
 * Why: ai-flow's deliverables are almost entirely on-disk Markdown (spec /
 * design / plan / review / long-term memory), and current models write those
 * markedly longer than asked unless length is stated explicitly.
 *
 * Two things the wording must keep doing, both load-bearing:
 *  - scope itself to written DOCUMENTS, never "artifacts" — an implementation
 *    stage's artifact is code, and "be shorter" must not reach it;
 *  - carve out the exhaustiveness rules it would otherwise contradict
 *    (enumerate-every-member lists, decision ledgers, machine-gate sections
 *    that must be present even when empty).
 */
export function writtenDocLengthNote(): string {
  return [
    ``,
    `─── 写盘文档长度（引擎注入 · 只约束写入磁盘的 Markdown 文档，不约束代码）───`,
    `写盘文档以最短可用为准：压缩叙述、删样板与重复，能用条目就不写长段落。`,
    `豁免：要求穷举的清单（批量成员、决策台账等）逐条列全，机器门要求的段落即使无内容也照写——`,
    `简洁只针对叙述与冗余，绝不用它省掉必需条目。`,
  ].join('\n');
}

/**
 * Universal Gate protocol reminder, appended by the engine to ANY gated stage's
 * prompt at injection time (start / advance / session-recovery).
 *
 * Lives here — not in per-flow stage `.md` files — so every flow inherits the
 * invariant automatically, including flows authored later via /ai-flow:create.
 * Flow authors can't forget it and there's a single source of truth.
 *
 * Fixes the failure mode where the AI announces "run approve" WITHOUT first
 * writing the signal: the approve command then rejects it (no pending signal),
 * the user /clear-reenters, and the stage gets redone. The approve prompt must
 * only follow a written signal + the engine's "已提交" confirmation (which the
 * PostToolUse hook emits once the signal lands).
 */
export function gateProtocolNote(): string {
  return [
    ``,
    `─── Gate 协议（本阶段含 Gate · 引擎强制，优先级高于本阶段提示词的任何措辞）───`,
    `到达 Gate 的唯一方式：用 Write 向 signal 文件写入 'done'。**必须先写 signal**——`,
    `写入后引擎会回注一条「Stage 已提交，等待人工确认」的消息，并指示你呈现审查摘要 + approve 提示。`,
    `approve 的提示语以引擎那条为准，不要凭记忆自行复述。`,
    `**未写 signal、未收到引擎确认，绝不向用户提示执行 approve**——此时 signal 不存在，approve 会被引擎拒绝，`,
    `用户 /clear 重入后还得重做本阶段。准备说「approve」前先自查：signal 写了吗？引擎确认收到了吗？没有 → 立即补写 signal。`,
  ].join('\n');
}
