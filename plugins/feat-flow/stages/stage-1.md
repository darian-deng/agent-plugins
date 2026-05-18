---
name: feat-flow-stage-1
description: feat-flow Stage 1 需求确认 — 产出结构化 design.md
disable-model-invocation: true
---

# Stage 1：需求确认

> **前置**：`feat-flow-init.sh` 已运行，`state.json` 已初始化，当前处于 `stage-1`。

## 目标

把用户需求转化为结构化的 design.md，包含明确的功能边界、约束和验收标准。

## 你要做的事

1. 与用户进行结构化需求对话（可使用 `brainstorming` skill）
2. 持续提问直到以下内容清晰：
   - 功能边界（做什么、不做什么）
   - 技术约束（依赖、兼容性、性能要求）
   - 验收标准（如何判断功能完成）
3. 将对话结果整理为 design.md

## 产出文件

路径：`docs/feat-flows/<flow-id>/design.md`

**必须包含以下精确标题**（控制系统机械检测，一字不差）：

```
## 需求
## 验收标准
## STAGE-1-COMPLETE
```

> ⚠️ `## STAGE-1-COMPLETE` 是完成锚点，必须作为独立 `##` 章节存在。内容写"需求确认完成"即可。

### design.md 推荐结构

```markdown
# <需求简名>

## 需求

<功能目标，100-200字>

### 不在范围内

- <明确排除的功能>

## 约束

- <技术约束>

## 验收标准

- <AC1：可测量的验收条件>
- <AC2：...>

## 决策记录

| 决策 | 选择 | 理由 |
|------|------|------|

## STAGE-1-COMPLETE

需求确认完成。
```

## 字数要求

design.md 总字数 ≥ 200 字（控制系统自动检测）。

## 完成流程

1. 写入 design.md，确保所有章节存在且字数达标
2. PostToolUse hook 自动检测（每次 Edit/Write 后）
3. 检测通过 → 系统弹窗显示 token / 终端打印 token
4. **停止操作**，提示用户执行 `/feat-flow-approve stage-1 <token>`
5. 用户审批后系统推进到 stage-2
