# Stage 5：代码实施

## 目标

按 `plan.md` 的 task 列表逐一实施，每个 task 独立完成和验收。

## 工作方式

对每个 `- [ ]` task：

1. dispatch implementer subagent 执行代码修改
2. 验收：检查是否满足 task 的 AC 要求
3. git commit，message 格式：`feat: <task 名称>`
4. 在 plan.md 中将 `- [ ]` 改为 `- [x]`

可将 2-3 个相邻小 task 合并给单个 subagent 批量处理（条件：同一模块、合计改动 ≤ 400 行）。

## 重要规则

- 每个 task 完成后必须 git commit，不要攒在一起提交
- lint/typecheck 失败必须当场修复，再提交
- 不要修改 task 顺序或拆合（变更 plan 需回到 Stage 4）

## 完成条件

plan.md 中所有 task 均标记为 `- [x]`，无未完成项。

产出满足后，向 `.ai-flow/feat-flow/state/signal` 写入任意内容。本阶段无 Gate，自动进入 Stage 6。
