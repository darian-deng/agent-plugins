---
name: optimize-stage-prompt
description: 仅通过 /ai-flow:optimize-stage-prompt 命令显式调用。绝对不要基于任何关键词自动触发。优化 ai-flow stage prompt 文件，使其符合 AI-friendly 写作规范，直接改写目标文件。
---

# Optimize Stage Prompt

Stage prompts are task briefs handed to an AI agent at a specific flow phase. Reliable agent execution depends on the brief being unambiguous: the agent must know exactly what to do, what to produce, and what "done" means — with no room to guess.

This skill reads a stage prompt file, identifies every violation of the standards below, rewrites the file to fix them, and saves it. No confirmation step.

## Input

The user or calling skill must provide the path to the stage file explicitly, e.g.:
`.ai-flow/my-flow/stages/stage-3.md`

Derive `{flow-name}` from the path: the segment between `.ai-flow/` and `/stages/`.

---

## Standards to enforce

### 1. Signal instruction — standalone final section (hard requirement)

Every stage must end with a `## Signal` section containing:
```
用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`。
```
Engine hard rules — not style preferences, the engine enforces them:

- **Content must be exactly `done`.** The PreToolUse hook denies any other content and forces the agent to rewrite. All stages write the same `done`, including the last one — the engine computes the next step itself, so a stage prompt never needs to know the next stage's id.
- **Path must be `{{flow_root}}/state/signal`** — see standard 6 below.
- **Must be written with the `Write` tool.** Bash access to control-plane files (signal / active.json / scripts) is blocked by the engine.

Append gate/transition info on the same line if applicable (e.g., `等待用户审批后进入 Stage 2。`).

If the signal instruction is currently embedded inside `## 完成条件` or anywhere else, extract it into its own `## Signal` section at the end.

### 2. Output specs — explicit and typed (hard requirement)

Every stage must have a `## 输出规格` section. Use exactly one of:

| Output type | How to write |
|-------------|--------------|
| File | `` `<path>` — <format/content description> `` |
| Git commits | `` Git commits，格式: `<prefix>: <description>` `` |
| No file output | `无文件产出` |

### 3. Completion condition — verifiable state (hard requirement)

`## 完成条件` must describe an observable, checkable state.

- Good: `plan.md 中所有 task 均标记为 \`- [x]\``
- Bad: `当工作完成时` / `Agent 认为本阶段结束时`

### 4. Section order

Rewrite the file using this exact order:

```
# Stage N：<阶段名>

## 目标

## 前置读取        ← optional: only when this stage depends on prior-stage files

## 步骤

## 输出规格

## 完成条件

## Signal
```

Include `## 前置读取` only when the stage reads files produced by earlier stages. List each file with its path and why it's needed:
```
- `{{project_root}}/docs/feat-flows/{flow_id}/design.md` — 需求与选型结果
```

### 5. Format rules

- **步骤**: bullet list only, no prose paragraphs
- **Comparisons / multi-option content**: table
- **Delete** anything agents already know: how git works, how to run npm/bun, how to write markdown
- **Length**: match the stage's actual complexity — a 3-step docs stage and a multi-task implementation stage do not belong at the same size. There is no fixed token budget. What to cut is boilerplate, text duplicated across stages, and detail that can live in a reference file; what to keep is guardrails and re-entry criteria.
- **Where detail belongs**: the stage file is re-injected in full on every `/clear`; a file under `references/` costs nothing until the agent actually Reads it. So push procedural detail into `{{flow_root}}/references/<topic>.md` and link to it — but keep guardrails and re-entry criteria (how the agent knows where it left off after a `/clear`) inside the stage file, because the engine only guarantees the stage prompt is injected.

### 6. Path anchoring (hard requirement)

Every flow-artifact path in a stage prompt must be anchored on a placeholder, never written relative:

| Placeholder | Expands to |
|-------------|-----------|
| `{{project_root}}` | the project root (where `.ai-flow` lives) |
| `{{flow_root}}` | `<project_root>/.ai-flow/{flow-name}` |

The engine substitutes them when it injects the prompt, so write the placeholders literally into the stage file.

Why it is mandatory: `cd` is unrestricted during a flow, so a relative path is resolved against whatever cwd the agent currently has. A relative signal write is the worst case — it lands somewhere else, the engine never sees the signal, and the flow silently stops advancing with nothing in the log to explain it.

- `{{flow_root}}/state/signal`, not `.ai-flow/{flow-name}/state/signal`
- `{{project_root}}/docs/...`, not `docs/...`

---

## How to apply

1. Read the target file
2. Derive `{flow-name}` from the path
3. Audit against all 6 standards above
4. Rewrite the file with all violations fixed, keeping the original intent intact
5. Write the result back to the same path

---

## Example

**Before** (signal buried in 完成条件 + wrong signal content + relative paths, no 输出规格 section, no 前置读取):

```markdown
# Stage 4：计划拆解

## 目标
把选定方案拆解为可执行的 task 列表。

## 工作步骤
1. 读取 design.md 中的验收标准和选定方案
2. 拆解为独立 task，写入 plan.md，路径 docs/feat-flows/{flow_id}/plan.md
3. 每条 task 格式：`- [ ] <task 名称>`

## 完成条件
plan.md 已生成，包含所有必要 task。产出满足后，向 .ai-flow/feat-flow/state/signal 写入任意内容。等待用户审批后进入 Stage 5。
```

**After**:

```markdown
# Stage 4：计划拆解

## 目标
把选定方案拆解为可执行的独立 task 列表，供 Stage 5 逐一实施。

## 前置读取
- `{{project_root}}/docs/feat-flows/{flow_id}/design.md` — 验收标准与选定方案

## 步骤
- 读取 design.md 的验收标准和「方案选型」章节
- 将每个 AC 拆解为 1-3 个独立 task
- 写入 plan.md，每条格式：`- [ ] <task 名称>`

## 输出规格
`{{project_root}}/docs/feat-flows/{flow_id}/plan.md` — Markdown task 列表

## 完成条件
plan.md 存在且包含至少 1 个 `- [ ]` task 条目。

## Signal
用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`。等待用户审批后进入 Stage 5。
```
