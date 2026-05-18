---
name: feat-flow-stage-2
description: feat-flow Stage 2 代码探索 — 无偏见地了解代码库现状
disable-model-invocation: true
---

# Stage 2：代码探索

> **前置**：stage-1 已通过 GATE，design.md 的需求部分已确认。

## 目标

在设计方案之前，无偏见地了解代码库的真实状态，发现现有实现和架构约束。

## 你要做的事

1. 根据 design.md 的需求范围，确定需要探索的代码区域
2. 并行 dispatch 1-3 个 subagent 分别探索相关模块
3. 每个 subagent 的任务：
   - 找到相关的入口文件和关键调用链
   - 发现现有的相关实现（如有）
   - 找出需要修改的区域
   - 报告与需求相关的架构约束
4. 将探索结果整理后追加到 design.md

## 关键原则

- subagent 之间不共享信息（各自独立探索，防止确认偏差）
- 如果发现重大情况（现有实现重叠、架构障碍），在 design.md 新增 `## 重大发现` 章节

## 产出

在 design.md 中追加以下精确标题章节（控制系统机械检测）：

```
## 探索摘要
## 影响范围
## STAGE-2-COMPLETE
```

> ⚠️ 这 3 个 `##` 标题必须一字不差。

### 各章节要求

**`## 探索摘要`**：包含每个 subagent 的 UUID（格式：`subagent-uuid: <uuid>`），入口文件，关键调用链，发现的架构约束。

**`## 影响范围`**：需要修改的文件列表，含大致行号范围。

**`## STAGE-2-COMPLETE`**：写"代码探索完成"即可。

## 完成流程

1. 将上述章节追加写入 design.md
2. PostToolUse hook 自动检测
3. 检测通过 → **无 GATE，自动推进到 stage-3**
4. 你会收到 additionalContext 通知，开始执行 stage-3-architect.md
