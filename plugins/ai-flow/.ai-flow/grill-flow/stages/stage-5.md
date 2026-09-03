# Stage 5：沉淀（知识归置）

> grill-flow 第 5/5 步 · [流程总览](../helper.md)
> 当前 stage 目的：把本次需求沉淀的 ADR / 术语 / 规则集中写进项目长期记忆（CLAUDE.md / rules / ADR）。
>
> **元规则**：本 stage 是终端 stage，只写 context 层（CLAUDE.md / rules / ADR）+ 一笔 amend，**不改产品代码**。沉淀写入期间**不 commit**（让开发者在 gate-pending 时审、可 `git restore` 撤回）；**approve 之后**把沉淀 `amend` 进 stage-4 那笔带 `flow-squash` 锚点的 `feat` 提交——整个 flow 仍是单个 commit、锚点保留，**只 commit 不 push**。

## 目标

复用 `optimize-claude-context` 的 `handle-one-directive`（manual 模式），从本 flow 全部产物收集沉淀候选、去重、逐条评估价值后写入 context 层，含跨源冲突检测与 supersede。这是终端 stage——写项目长期记忆不可逆，必带 gate。

## 前置读取

- `{{project_root}}/docs/grill-flows/<flow_id>/` 下 `alignment.md` / `wayfinder-map.md` / `spec.md` / `tickets.md` / `candidates.md`（沉淀候选主来源）/ `review.md`（`<flow_id>` 用 context 注入的实际值）
- `{{flow_def}}/references/adr-scan.md` — 定位既有 ADR 目录（写入口径、冲突/supersede 判断）

## 入场校验（含 /clear 重入）

**A0 只读校验前置**：HEAD 必须是 stage-4 环节 C 收尾的那笔 `feat` squash 提交（body 末行带 `flow-squash: <flow_id>` 锚点）：

```bash
git log -1 --format=%B | grep -q "flow-squash: <flow_id>" || { echo "ERROR: HEAD 无 flow-squash 锚点 — stage-4 未完成 squash，回 stage-4 环节 C 收尾后再进 stage-5"; exit 1; }
```

校验通过后，沉淀写入都在这笔 feat 之上、**不 commit**；approve 后 `amend` 折回它（见 Signal）。

**/clear 重入**：引擎注入的 stage 已是 gate-pending → 沉淀多半已写入工作树（未提交）。重读 candidates.md 与已写的 context 文件重建沉淀清单，approve 后照 Signal 段 amend 幸存文件（`git add -A` 天然只收工作树现存改动）。
> **背景怎么传下去**：`/clear` 之后先按 `{{flow_def}}/references/handoff.md` 取本次需求的目标 / 已拍板决策 / 边界（本段的重入判据只回答「物理上走到哪」，不回答「该知道什么」）；本 stage 走之前也照那份契约把交接写下来。

## 步骤

1. **收候选**：汇总 candidates.md + 从 alignment（关键决策）/ wayfinder-map（被否方案+依据）/ spec（decisions）/ review（findings 暴露的约定）提取候选。去重。
2. **逐条走 handle-one-directive**：对每条候选，用 optimize-claude-context 判定归属层——ADR（缘由/否定类架构决策）/ rules / CLAUDE.md（约定/边界），自带跨层冲突检测、ADR 重叠 → 原地更新 / supersede、README 索引维护。
3. **持久产物自包含**：写进 context 层的知识面向没有本次 session、不翻 docs/grill-flows/ 的未来读者——不得引用 flow 内部临时指代（`T<n>` / 「见上文」等），展开成实质内容。
4. 汇总一张「沉淀清单」（增 / 改 / supersede 了什么）供 gate 呈现，并告知开发者：**approve 后将 amend 进本次 feat 提交**；`git diff HEAD` 查看本次沉淀写入、`git restore <路径>` 可在 approve 前撤回某条（approve 后该文件不进提交）。

## 输出规格

对 `CLAUDE.md` / `.claude/rules/` / `docs/adr/`（含 README 索引）的增改（monorepo 按最深公共祖先路径解析），**approve 后 amend 进 stage-4 那笔 `feat` 提交**（flow 仍单 commit、`flow-squash` 锚点保留）。不改产品代码。

## 完成条件

- 所有候选已逐条评估并归置（写入或明确判定不记，理由留痕）。
- 跨源冲突已检测处理；ADR 重叠已原地更新 / supersede。
- 沉淀清单已备好供 gate 呈现。

## Signal

**触发条件**：完成条件全满足，**或**开发者明确表示完成。**不要**在讨论里自觉「应该结束了」就写 signal——终端 stage 误完成不可逆。
**动作**：用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`。引擎暂停等 `grill-flow approve`——沉淀清单即 gate 呈现，不批 = 就地改再重呈。

**approve 之后**（结束流程前必做）：开发者可能已 `git restore` 撤回部分沉淀，故 amend 放在 approve 后、只收幸存文件——

```bash
git add -A && git commit --amend --no-edit
git log -1 --format=%B | grep -q "flow-squash: <flow_id>" || echo "WARN: amend 后 flow-squash 锚点丢失，检查 HEAD"
```

`--amend --no-edit` 把沉淀并入那笔 `feat`、保留原 message 与 `flow-squash` 锚点，整个 flow 仍单个 commit。**只 commit 不 push**（push 留给开发者）。若开发者撤回了全部沉淀（无改动），amend 为 no-op、安全。amend 完成后向开发者报告本次沉淀（增 / 改 / supersede 了什么）+ 提示 `git show HEAD` 看完整改动、确认后按团队流程 push。
