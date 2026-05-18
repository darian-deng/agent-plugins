---
name: feat-flow-stage-4
description: feat-flow Stage 4 实施计划 — 产出可追踪的 task 列表
disable-model-invocation: true
---

# Stage 4：实施计划

> **前置**：stage-3 已通过 GATE，用户已确认选定方案。

## 目标

将选定方案拆解为控制系统可追踪的 task 列表，每个 task 含验收标准。

## 你要做的事

1. 基于 design.md 中选定的方案，拆解实施步骤
2. 每个 task 建议为 2-5 分钟 AI 工作量（约 50-200 行代码改动）
3. 为每个 task 写清楚验收标准（AC 字段）

## 产出文件

路径：`docs/feat-flows/<flow-id>/plan.md`

**必须包含以下精确标题**（控制系统机械检测，一字不差）：

```
## Tasks
## STAGE-4-COMPLETE
```

> ⚠️ `## Tasks` 大写 T，`## STAGE-4-COMPLETE` 必须是独立章节。

### plan.md 格式（控制系统机械验证）

```markdown
## Tasks

- [ ] Task 1：实现登录逻辑
  - AC: auth/login.ts 中 login() 函数实现，单测通过
  - AC: 错误情况有正确的错误类型返回

- [ ] Task 2：实现 UI 表单
  - AC: LoginForm 组件渲染正确，表单验证通过

## STAGE-4-COMPLETE

实施计划完成。
```

**格式要求**：
- `- [ ] ` 格式（方括号内有一个空格）
- 每个 task 至少一个 `- AC:` 字段

## 完成流程

1. 创建 plan.md，包含所有 task 和正确格式
2. PostToolUse hook 自动检测（检查格式 + task 数量 ≥ 1）
3. 检测通过 → 生成 GATE token，等待用户确认计划
4. **停止操作**，提示用户执行 `/feat-flow-approve stage-4 <token>`
5. 用户审批后推进到 stage-5
