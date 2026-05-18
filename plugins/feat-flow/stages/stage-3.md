---
name: feat-flow-stage-3
description: feat-flow Stage 3 方案对比 — 并行探索多个技术方向
disable-model-invocation: true
---

# Stage 3：方案选型

> **前置**：stage-2 已完成，design.md 含探索摘要和影响范围。

## 目标

通过并行探索多个技术方向，找到最优解，避免直接执行第一个想到的方案。

## 你要做的事

1. 从 design.md 中识别真正不同的技术决策轴（至少 2 个）
2. 并行 dispatch 2-3 个 architect subagent，每个负责一个方向
3. 每个 subagent 的任务：
   - 在自己的技术方向上提出完整方案
   - 列出主要风险、工作量估算（S/M/L）和关键设计点
   - 提供 `architect-uuid: <uuid>`
4. 综合各方案，制作对比表，给出推荐理由

## 关键原则

- 每个 architect subagent 只知道 design.md 的需求和探索摘要，不知道其他方案
- 如果只有两个真实方向，就用两个——不要为凑数制造虚假对比

## 产出

在 design.md 中追加以下精确标题章节（控制系统机械检测）：

```
## 方案选型
## 决策记录
## STAGE-3-COMPLETE
```

> ⚠️ 这 3 个 `##` 标题必须一字不差。

### 各章节要求

**`## 方案选型`**：包含对比表（方案名、优缺点、工作量、风险）+ 推荐方案及理由。每个方案含 `architect-uuid: <uuid>`。

**`## 决策记录`**：在已有决策记录下追加选定方案的决策条目。格式：`| 选型 | <方案名> | <理由> |`

**`## STAGE-3-COMPLETE`**：写"方案选型完成"即可。

## 字数要求

design.md 总字数 ≥ 500 字（控制系统自动检测）。

## 完成流程

1. 将上述章节追加写入 design.md
2. PostToolUse hook 自动检测
3. 检测通过 → 生成 GATE token，等待用户确认选定方案
4. **停止操作**，提示用户执行 `/feat-flow-approve stage-3 <token>`
