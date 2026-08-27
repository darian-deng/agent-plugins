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
/**
 * How many CHARACTERS a hook's `additionalContext` may carry before the host
 * stops inlining it, writes it to a file, and hands the model a ~2,000-character
 * preview plus a path to that file.
 *
 * Measured, not guessed: across 887 injections in this machine's transcripts the
 * largest that stayed inline was 9,893 characters and the smallest that spilled
 * was 10,003 — so the line is 10,000, and it counts CHARACTERS, not bytes. That
 * distinction matters for Chinese prompts: one character is three bytes, so a
 * byte-based budget understates the overflow by ~1.9x and would set the wrong
 * target size.
 *
 * Why we care: spilling is silent. The model gets the first ~10% of the stage
 * prompt and nothing tells it the rest exists — the path inside the preview
 * points at the HOST's copy of the injection, not at the stage file, and the
 * engine never says "there is more". Observed: a stage prompt at 2.1x this limit
 * delivered 3 of its 23 sections, and the ones that fell off the edge carried the
 * rules whose violation is silent.
 */
export const INLINE_INJECTION_BUDGET = 10_000;

/**
 * Decide what actually gets injected for a stage prompt.
 *
 * Under budget -> the rendered prompt, as before.
 * Over budget -> NOT a truncated prompt. A partial prompt is worse than none: the
 * model cannot tell it is partial and will act on it, which is exactly the failure
 * this replaces. It gets the reason and an order to read the real file instead.
 * Reading the CURRENT stage's own prompt is allowed by the stage-ordering guard
 * (that guard only denies stages AHEAD of the current one), so this is executable.
 */
/**
 * `overhead` is everything the caller will wrap around this prompt before handing it
 * to the host: the `[ai-flow:paths]` preamble plus the framing lines. It is NOT
 * optional bookkeeping — the host's limit applies to the ASSEMBLED `additionalContext`,
 * so checking `rendered` alone under-measures by ~400 characters and lets a prompt
 * that will actually spill sail through as "inline". Callers must pass what they add;
 * `assembledOverhead()` computes it from the caller's own template so the two cannot
 * drift apart.
 *
 * ⚠️ The wrapper is not the only thing appended. A gated stage also gets
 * `gateProtocolNote()` (~347 chars) glued on, and that used to happen AFTER this check —
 * so every gated stage was injected 347 chars longer than anything measured it. Callers
 * must fold that length into `overhead` too, which is why they build the note first and
 * append the same string they measured. The budget test does the same per stage.
 */
/**
 * The banner `userprompt-handler` prepends to every allowed command's `additionalContext`.
 *
 * Lives here rather than in that handler so the command implementations can measure it
 * without importing their own dispatcher (that would be a cycle). They must: the banner is
 * part of what the host receives, so a command that renders a stage prompt has to count it
 * against the same ceiling. Its length varies with the flow name — it appears twice — which
 * is why this is a function and not a constant.
 */
export function commandOutputPrefix(flowName: string): string {
  return (
    `[ai-flow system] Hook intercepted this command for flow '${flowName}'. ` +
    `Do NOT invoke a skill named '${flowName}' — proceed directly with the instructions below.\n\n`
  );
}

/**
 * `materialize` lets the caller park the RENDERED text somewhere the model can Read it and
 * hand back that path. Kept as a callback so this module stays free of `fs` — the caller
 * (which already has repoRoot/flowName) supplies `materializeRenderedPrompt`.
 *
 * Without it we would point at `stages/<id>.md`, which is the TEMPLATE, not this document:
 * its `{{flow_root}}` / `{{project_root}}` are unsubstituted (substitution happens right
 * here in `renderPrompt`, on the injection path only), and it lacks `writtenDocLengthNote()`.
 * (`gateProtocolNote()` is NOT in the copy either — callers staple that onto the injection
 * itself, so it still arrives inline; the pointer message says so rather than claiming the
 * copy is self-contained.) Copying a literal `{{flow_root}}` into Write is silent — it creates a directory
 * by that name and the write lands nowhere. See `materializeRenderedPrompt`.
 */
export function injectableStagePrompt(
  rendered: string,
  promptPath: string,
  overhead: number,
  // Required, not optional: omitting it silently restores the exact behaviour this change
  // exists to remove (pointing at the unsubstituted template). A fifth injection point that
  // forgets it should fail to compile, not fail quietly at runtime. Pass `() => null` to opt
  // into the degraded path deliberately.
  materialize: (rendered: string) => string | null
): string {
  if (rendered.length + overhead <= INLINE_INJECTION_BUDGET) return rendered;
  const readyPath = materialize?.(rendered) ?? null;
  const target = readyPath ?? promptPath;
  return (
    `⛔ 本 stage 的提示词是 ${rendered.length} 字符，超过宿主注入能内联携带的上限（${INLINE_INJECTION_BUDGET} 字符），` +
    `**因此它没有随这次注入送到你手上**。\n\n` +
    `**现在立刻用 Read 工具读完整提示词，读完再开始任何动作：**\n${target}\n\n` +
    (readyPath
      ? `（这是引擎为你落盘的**渲染后**副本：路径占位符已展开、写盘文档长度纪律已在内。` +
        `Gate 协议不在副本里，它随本次注入另给。）\n\n`
      : `⚠️ 落盘渲染副本失败，上面给的是**模板原文**：里面的 \`{{flow_root}}\` / \`{{project_root}}\` ` +
        `**没有被展开**，用本次注入顶部 \`[ai-flow:paths]\` 块里的真实路径代入，⛔ 别照字面写——` +
        `sh 会报错，但 Write 不会，它会建出一个字面名的目录、文件落在那里等于没写。\n\n`) +
    `⚠️ 不要凭这段话推测流程该怎么走——你手上现在没有流程，只有这条指路。` +
    `（宿主可能另外给你一段预览和一个 \`tool-results/…\` 路径，那是它自己落盘的副本；读上面那个路径。）` +
    // The materialized copy already carries this note (it is part of `rendered`). Only the
    // degraded template-pointer path needs it appended, or an oversize stage loses the
    // length discipline entirely.
    (readyPath ? '' : '\n' + writtenDocLengthNote())
  );
}

/**
 * Length of everything a caller wraps around the stage prompt, measured by running the
 * caller's own assembly with an empty body. Deriving it instead of hardcoding a number
 * is the point: the preamble grows with the project's path depth, and the framing text
 * changes whenever someone edits these messages.
 */
export function assembledOverhead(assemble: (body: string) => string): number {
  return assemble('').length;
}

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
 *    that must be present even when empty);
 *  - carve out the rationale prose in human-alignment docs. The exemption list
 *    used to protect only the appendix-grade material above, which made the
 *    compression pressure asymmetric in exactly the wrong direction: the
 *    tech-design contract calls the decision ledger "附录速查表，不是正文主体"
 *    and the embedded 「为什么」 its 命根子, yet only the ledger was shielded.
 *    Developers reported reading the generated doc and still not knowing what
 *    the design was or why — squeezing out the rationale is how that happens.
 */
export function writtenDocLengthNote(): string {
  return [
    ``,
    `─── 写盘文档长度（引擎注入 · 只约束写入磁盘的 Markdown 文档，不约束代码）───`,
    `写盘文档以最短可用为准：压掉铺陈、删样板与重复，能用条目就不写长段落。`,
    `豁免：要求穷举的清单（批量成员、决策台账等）逐条列全；机器门要求的段落即使无内容也照写；要开发者签字的文档里，每个设计点旁的「为什么」与每节的概览段落照写不压。`,
    `简洁只针对样板、重复与铺陈，豁免项不算冗余。`,
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
