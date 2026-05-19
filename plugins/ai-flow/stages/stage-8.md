---
name: feat-flow-stage-8
description: feat-flow Stage 8 知识沉淀 — ADR + rule 更新 + STAGE-8-COMPLETE
disable-model-invocation: true
---

# Stage 8：知识沉淀

> **前置**：stage-7 已通过 GATE，代码审查完成。

## 目标

把本次 flow 产生的洞察落入代码库，防止团队重复踩坑。

## 轻量版（所有需求必做，约 5-10 分钟）

1. 检查 design.md 的决策记录，判断是否有新的架构决策需要写 ADR
2. 检查是否有 rule 文件需要更新（新约束或废弃约束）
3. 在 design.md 末尾新增以下章节（控制系统检测锚点）

## 完整版（复杂需求额外做，约 15-20 分钟）

4. 记录失败教训（flow 过程中踩过的坑）
5. 检查是否有 rule 文字与实际代码不符（反向更新 rule）

## 工具使用

- ADR 新增/修订：使用 `improve-codebase-architecture` skill
- rule 文件修改：使用 `claude-md-improver` skill
- SKILL.md 修改：使用 `skill-surgeon` skill

## 产出

在 `docs/feat-flows/<flow-id>/design.md` 末尾追加以下精确内容（控制系统机械检测）：

```
## Stage 8 评估

- 评估1完成：ADR 评估（是否写了新 ADR）
- 评估2完成：rule 更新评估
- 评估3完成：失败教训评估
- 评估4完成：反向 rule 更新评估

## STAGE-8-COMPLETE
```

> ⚠️ `## STAGE-8-COMPLETE` 必须作为独立 `##` 章节存在。

## 完成流程

1. 完成知识沉淀工作，写入上述章节
2. PostToolUse hook 自动检测 `## STAGE-8-COMPLETE` 存在
3. 检测通过 → **无 GATE，flow 正式结束**
4. 控制系统清除 `.claude/.feat-flow-active` marker
5. 提示用户 flow 已完成
