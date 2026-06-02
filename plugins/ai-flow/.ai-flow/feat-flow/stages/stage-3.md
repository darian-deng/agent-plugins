# Stage 3：实施计划

> feat-flow 第 3/6 步 · [流程总览](../helper.md)
> 当前 stage 目的：把 architecture.md 转成可逐 task 执行的 plan.md，每 task 一个独立的 red-green 测试循环（先失败测试，后实现通过）
>
> **元规则**：禁止 git commit，stage-4 起点统一提交。

## 目标

调用 `writing-plans` skill 生成 `plan.md`。writing-plans 默认就是纵向切分（每 task = 一个独立的 red-green 循环），不需要额外的横向切分防护约束。

## 前置读取

- `docs/feat-flows/<flow_id>/design.md` — 决策、AC、UI 状态、项目命令、TDD 基建决策
- `docs/feat-flows/<flow_id>/architecture.md` — 架构决策、build 顺序、文件清单、接口设计

## 步骤

1. 调用 `writing-plans` skill，传入：
   - design.md + architecture.md 内容
   - 输出路径：`docs/feat-flows/<flow_id>/plan.md`（覆盖 writing-plans 默认的 `docs/superpowers/plans/` 路径）
   - TDD 约束：
     - 若 design.md TDD 基建决策为「建立」→ **Task 0 必须是基建**（不走 TDD，明确标 `**TDD: 否**`）
     - 若 design.md TDD 基建决策为「已有」，或「建立」之后的 task → 走 TDD
     - 若 design.md TDD 基建决策为「不建立」→ 全部 task 不走 TDD

2. writing-plans 产出后，主 session 审视：
   - 每个 task 是否引用 architecture.md 的具体文件路径 / 接口？
   - 每个 task 是否含可验证 AC？
   - task 依赖顺序是否与 architecture.md build 顺序一致？

3. 与开发者审 plan.md：
   - task 粒度（2-5 分钟 AI 工作量）
   - AC 可验证性
   - 依赖顺序
   - 覆盖完整性（design.md AC 是否都被 plan task 覆盖）

冲突处理：
- 开发者提异议 → `references/revision-protocol.md`（入口 A）
- AI **自查**发现 design.md / architecture.md 漏写 / 错了 → `references/revision-protocol.md`（入口 B；L1 abort / L2 暂停回改 / L3 inline 修）

**忽略 writing-plans 的执行交接**：writing-plans 末尾会提示「选择执行方式（Subagent-Driven / Inline）」并准备开跑——在 feat-flow 里忽略它。本 stage 产出 + 自查 + 开发者审完即停，执行是 Stage 4（Gate 通过后）的职责，统一用 subagent-driven-development。不要在此处开始执行或让开发者选执行方式。

## 输出规格

文件 → `docs/feat-flows/<flow_id>/plan.md`

格式由 writing-plans skill 控制（每 task = `### Task N` + Files + Steps + Commit）。

## 完成条件

- `plan.md` 存在且通过 writing-plans skill 的自查（规格覆盖 / placeholder 扫描 / 类型一致性）
- 开发者审批 task 粒度 / AC / 依赖顺序

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**开发者明确表达本阶段已完成。
**动作**：用 Write 工具向 `.ai-flow/feat-flow/state/signal` 写入 `done`（引擎接受此关键词，自动推进）。
