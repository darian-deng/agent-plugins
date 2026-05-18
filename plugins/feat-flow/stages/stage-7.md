---
name: feat-flow-stage-7
description: feat-flow Stage 7 代码审查 — 独立 reviewer subagent
disable-model-invocation: true
---

# Stage 7：代码审查

> **前置**：stage-6 验证通过。

## 目标

以独立视角审查本次 flow 的全部代码改动，确保质量。

## 你要做的事

1. dispatch 一个 reviewer subagent，给它：
   - `git diff <base-sha> HEAD` 的全量 diff
   - design.md（了解需求背景和决策）
   - **不要**给它 plan.md 的 task 列表（审查者不应知道实施过程）
2. reviewer 返回报告后，处理其中的问题：
   - 接受（代码证据充分）：修复，git commit
   - 反驳（证据不足或有反例）：给出反证
3. 最多 3 轮交互（用 SendMessage 继续同一 subagent）
4. 将最终审查结论写入 review.md

## 产出文件

路径：`docs/feat-flows/<flow-id>/review.md`

**必须包含以下精确标题**（控制系统机械检测，一字不差）：

```
## reviewer-subagent-id
## diff-base-sha
## issues
## STAGE-7-COMPLETE
```

> ⚠️ 这 4 个 `##` 标题必须作为独立章节存在，一字不差。

### review.md 格式

```markdown
## reviewer-subagent-id

<36位UUID，格式：xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx>

## diff-base-sha

<base SHA1>

## issues

### 已解决

- <问题描述>：<修复方式>

### 已反驳

- <问题描述>：<反证>

## STAGE-7-COMPLETE

代码审查完成。
```

> ⚠️ `reviewer-subagent-id` 章节下必须有一行纯 UUID（控制系统验证格式）。

## 完成流程

1. 写入 review.md，包含所有必要章节
2. PostToolUse hook 自动检测（验证章节 + UUID 格式）
3. 检测通过 → 生成 GATE token，等待用户确认审查结论
4. **停止操作**，提示用户执行 `/feat-flow-approve stage-7 <token>`
5. 用户审批后推进到 stage-8
