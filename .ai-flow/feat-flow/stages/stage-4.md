# Stage 4：实施计划

## 目标

将选定方案拆解为可追踪的 task 列表，每个 task 含明确验收标准，总工作量可估算。

## 产出文件

`docs/feat-flows/{flow_id}/plan.md`

## plan.md 格式

```markdown
# 实施计划

## Tasks

- [ ] Task 1：<具体描述>
  - AC: <验收条件，可测量>

- [ ] Task 2：<具体描述>
  - AC: <验收条件>
```

## Task 拆分原则

- 每个 task 建议对应约 2-5 分钟的 AI 工作量（约 50-200 行代码改动）
- 单个 task 应可独立完成和验收
- 按依赖顺序排列（被依赖的 task 在前）
- 至少一条 `- AC:` 验收标准

## 完成条件

plan.md 包含「Tasks」章节，且至少有一个 `- [ ]` 格式的 task。

产出满足后，向 `.ai-flow/feat-flow/state/signal` 写入任意内容。等待用户确认计划后进入 Stage 5。
