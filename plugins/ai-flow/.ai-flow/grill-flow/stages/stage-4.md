# Stage 4：code-review（收尾组装审 + 开发者 IDE 人审 + squash）

> grill-flow 第 4/5 步 · [流程总览](../helper.md)
> 当前 stage 目的：整轮改动过 AI 组装审 + 开发者 IDE 亲审，最终 squash 成一笔 feat commit。
>
> **元规则**：本 stage 允许 commit。环节 A/B 产生 `fix:` commit；环节 C reset 摊平后 squash 成单个 `feat:` commit。**环节 C 走完前绝不写 signal。**

## 目标

三环节收尾（**严格照 `assembly-review.md` 逐步做**）：A 全量测试 → B AI 双轴组装审 + 安全 → C 开发者 IDE 人审闭环 + squash。让开发者在 IDE 未暂存 diff 上亲审整轮改动（语言服务可用）、提改进、确认无误后 squash 一笔。

## 前置读取

- `{{project_root}}/docs/grill-flows/<flow_id>/spec.md` — Spec 轴对照 User Stories（`<flow_id>` 用 context 注入的实际值）
- `{{flow_root}}/references/assembly-review.md` — **收尾三环节完整流程 + reset/人审/squash + /clear 重入判据（逐条照做）**
- `{{flow_root}}/references/fowler-smells.md` — Standards 轴子代理携带
- `{{flow_root}}/references/revision-protocol.md`
- 引擎注入 `[ai-flow:paths]` 的 `base_sha_code` — reset 与 diff 基准（不读 active.json）

## 步骤

**先判 /clear 重入**（照 assembly-review.md 重入判据，用 git 状态）：HEAD body 含 `flow-squash` → 补 signal；`HEAD==base_sha_code` 且工作区非空 → 续环节 C 人审循环；否则（HEAD 领先 base）→ 环节 A/B。

1. **环节 A 全量测试**：AI 跑（假绿检测：测试数>0），失败修代码，原始输出（通过/失败计数 + commit SHA）落 review.md。
2. **环节 B 双轴组装审**（一次，不套娃）：两个 general-purpose 子代理并行审 `git diff <base>..HEAD`——Standards（携 fowler-smells.md，跨 ticket smell）+ Spec（携 spec.md，User Stories 闭环）+ 安全专项（有界清单）。阻塞项修复 → `fix:` commit。
3. **环节 C 开发者 IDE 人审 + squash**：`git reset <base>` 摊平为未暂存全量 → 告知开发者去 IDE Changes 组亲审（勿手动 stage，保语言服务）→ **人审-修复循环**（开发者提问题 → AI 改工作树 → 重跑全量测试 → 记 review.md）→ 开发者确认无更多问题 → 最终 CR（条件式，子代理用 `git diff --staged <base>`）→ **squash 成单个 feat commit**（body 末行 `flow-squash: <flow_id>`）。

前置产物要改 → 走 `revision-protocol.md`。

## 输出规格

`{{project_root}}/docs/grill-flows/<flow_id>/review.md`（findings + 人审记录 + 原始测试输出）+ **单个 feat squash commit**（base 之后全部改动，body 末行 `flow-squash: <flow_id>`）。

## 完成条件

- 全量测试全过；双轴 + 安全已跑、阻塞项已修。
- **环节 C 走完**：开发者确认无更多问题、人审改动全过回归、最终 CR 干净（或条件跳过）。
- **全部改动已 squash 成单个 `feat` commit**（body 带 `flow-squash: <flow_id>` 锚点），working tree 干净。

## Signal

**触发条件**：完成条件全满足——**含环节 C 走完 + squash 完成**。在此之前绝不写 signal（即便开发者说「可以了」，也要先跑完最终 CR + squash）。
**动作**：用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`。引擎进 gate-pending，开发者 `grill-flow approve` 推进沉淀。不批 = 就地改再重呈。
