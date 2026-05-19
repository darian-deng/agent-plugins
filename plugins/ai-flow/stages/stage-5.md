---
name: feat-flow-stage-5
description: feat-flow Stage 5 代码实施 — 按 plan.md task 逐一实现
disable-model-invocation: true
---

# Stage 5：实施

> **前置**：stage-4 已通过 GATE，plan.md 已确认。

## 目标

按 plan.md 的 task 列表逐一实施，每个 task 有独立验收。

## 对每个 task 的工作方式

1. dispatch implementer subagent 执行当前 task 的代码修改
2. implementer 返回后，检查是否符合 task 的 AC 要求（语义验收）
3. 可以把 2-3 个相邻小 task 合并给单个 spec reviewer subagent 批量验收
   - 条件：同一模块、合计改动不超过 400 行
4. 控制系统自动运行 lint/typecheck，结果（含具体 errors）会直接告知你

## 重要规则

- 每个 task 完成后必须 git commit（控制系统验证 commit 存在）
- commit message 格式：`feat-flow: <task 名称>`
- lint/typecheck 失败时，控制系统告知具体 errors，修复后重新 commit
- plan.md 中用 `- [x]` 标记完成的 task（替换 `- [ ]`）

## 产出

plan.md 中所有 `- [ ]` 变为 `- [x]`，并在末尾追加：

```
## STAGE-5-COMPLETE
```

> ⚠️ `## STAGE-5-COMPLETE` 必须在所有 task 都标为 `[x]` 之后写入。

## 完成流程

1. 所有 task 均标记为 `[x]`，写入 `## STAGE-5-COMPLETE` 章节
2. PostToolUse hook 自动检测（验证无未完成 task + 有 STAGE-5-COMPLETE）
3. 检测通过 → **无 GATE，自动推进到 stage-6**
4. 你会收到通知，开始等待 stage-6 验证结果
