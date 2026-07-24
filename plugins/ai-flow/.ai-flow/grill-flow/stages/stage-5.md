# Stage 5：沉淀（知识归置）

> grill-flow 第 5/5 步 · [流程总览](../helper.md)
> 当前 stage 目的：把本次需求沉淀的 ADR / 术语 / 规则集中写进项目长期记忆（CLAUDE.md / rules / ADR）。
>
> **元规则**：本 stage 允许 commit。

## 目标

复用 `optimize-claude-context` 的 `handle-one-directive`（manual 模式），从本 flow 全部产物收集沉淀候选、去重、逐条评估价值后写入 context 层，含跨源冲突检测与 supersede。这是终端 stage——写项目长期记忆不可逆，必带 gate。

## 前置读取

- `{{project_root}}/docs/grill-flows/<flow_id>/` 下 `alignment.md` / `wayfinder-map.md` / `spec.md` / `tickets.md` / `candidates.md`（沉淀候选主来源）/ `review.md`（`<flow_id>` 用 context 注入的实际值）
- `{{flow_root}}/references/adr-scan.md` — 定位既有 ADR 目录（写入口径、冲突/supersede 判断）

## 步骤

1. **收候选**：汇总 candidates.md + 从 alignment（关键决策）/ wayfinder-map（被否方案+依据）/ spec（decisions）/ review（findings 暴露的约定）提取候选。去重。
2. **逐条走 handle-one-directive**：对每条候选，用 optimize-claude-context 判定归属层——ADR（缘由/否定类架构决策）/ rules / CLAUDE.md（约定/边界），自带跨层冲突检测、ADR 重叠 → 原地更新 / supersede、README 索引维护。
3. **持久产物自包含**：写进 context 层的知识面向没有本次 session、不翻 docs/grill-flows/ 的未来读者——不得引用 flow 内部临时指代（`T<n>` / 「见上文」等），展开成实质内容。
4. 汇总一张「沉淀清单」（增 / 改 / supersede 了什么）供 gate 呈现。

## 输出规格

对 `CLAUDE.md` / `.claude/rules/` / `docs/adr/`（含 README 索引）的增改（monorepo 按最深公共祖先路径解析）。可 commit。

## 完成条件

- 所有候选已逐条评估并归置（写入或明确判定不记，理由留痕）。
- 跨源冲突已检测处理；ADR 重叠已原地更新 / supersede。
- 沉淀清单已备好供 gate 呈现。

## Signal

**触发条件**：完成条件全满足，**或**开发者明确表示完成。
**动作**：用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`。引擎暂停等 `grill-flow approve`——gate 呈现沉淀清单，开发者拍板后结束 flow。不批 = 就地改再重呈。
