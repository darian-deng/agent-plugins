# Stage 4：code-review（收尾组装审 + 开发者 IDE 人审 + squash）

> grill-flow 第 4/5 步 · [流程总览](../helper.md)
> 当前 stage 目的：整轮改动过 AI 组装审 + 开发者 IDE 亲审，最终 squash 成一笔 feat commit。
>
> **元规则**：本 stage 允许 commit。环节 A/B 产生 `fix:` commit；环节 C reset 摊平后 squash 成单个 `feat:` commit。**环节 C 走完前绝不写 signal。**

## 先查文档，再问开发者

本 stage 与开发者来回最频繁（环节 C 的人审-修复循环），也最容易把早就定过的事重新翻出来问。**有疑问先按 `stage-3.md` 顶部那张「岔路 → 先读哪份」的表查文档，查不到才问**（本 stage 用得上的只有 `recovery.md` 与 `revision-protocol.md` 两格，其余是 stage-3 执行期专用）。

两条本 stage 特有的：

- **开发者提的改进与已记录决策冲突时，不反射性接受**（「你说得对」+ 立即改是失败模式）。走 `revision-protocol.md` 的入口 A——它对「指出了 AI 没考虑的事实约束」「只是偏好没有理由」「与已记录决策冲突」「推翻前置结论」分了四类，处理方式不同，其中两类要停下做影响评估。
- **本 stage 产生的结论同样要落盘**：人审过程中定下的取舍不能只留在 `review.md` 的问题记录里——那是「改了什么」的流水，不是决策本身。属于方案层的写进 `spec.md` 的 `## Decisions`，改动范围或已对齐结论的走修订协议回写 `alignment.md`。下一步 stage-5 做知识沉淀时读的是这些文件。

## 目标

三环节收尾（**严格照 `assembly-review.md` 逐步做**）：A 全量测试 → B AI 组装审（Standards / Spec 两轴按规模可跳过，安全专项永不跳）→ C 开发者 IDE 人审闭环 + squash。让开发者在 IDE 未暂存 diff 上亲审整轮改动（语言服务可用）、提改进、确认无误后 squash 一笔。

## 前置读取

- `{{project_root}}/docs/grill-flows/<flow_id>/spec.md` — Spec 轴对照 User Stories（`<flow_id>` 用 context 注入的实际值）
- `{{flow_def}}/references/assembly-review.md` — **收尾三环节完整流程 + reset/人审/squash + /clear 重入判据（逐条照做）**
- `{{flow_def}}/references/fowler-smells.md` — Standards 轴子代理携带
- `{{flow_def}}/references/revision-protocol.md`
- 引擎注入 `[ai-flow:paths]` 的 `base_sha_code` — reset 与 diff 基准（不读 active.json）

## 步骤

**先判 /clear 重入**（照 assembly-review.md 重入判据，用 git 状态）：HEAD body 含 `flow-squash` → 补 signal；`HEAD==base_sha_code` 且工作区非空 → 续环节 C 人审循环；否则（HEAD 领先 base）→ 环节 A/B。
> **背景怎么传下去**：`/clear` 之后先按 `{{flow_def}}/references/handoff.md` 取本次需求的目标 / 已拍板决策 / 边界（本段的重入判据只回答「物理上走到哪」，不回答「该知道什么」）；本 stage 走之前也照那份契约把交接写下来。

1. **环节 A 全量测试**：AI 跑（假绿检测：测试数>0），失败修代码，原始输出（通过/失败计数 + commit SHA）落 review.md。
2. **环节 B 组装审 + 安全专项**（组装审一次、不套娃；**安全阻塞项有「修复后一次独立复核」例外**）：`general-purpose` 子代理并行审 `git diff <base>..HEAD`——Standards（携 fowler-smells.md，跨 ticket smell）+ Spec（携 spec.md，User Stories 闭环）+ 安全专项。⚖️ **派几个不是固定的**：先按 `assembly-review.md` 的「派几个先算一次」节走那一节的全部判据——都成立时只派安全专项。⛔ **判据本身以那一节为准，本行不复述**（阈值一改就会漂）；跳过与否连各条依据一起写进 review.md，**跳过时还要把「跨票反向读取对」列成人审点名项**。阻塞项修复 → `fix:` commit。**安全专项的对抗立场 / 扫查类别 / 独立复核例外一律以 `assembly-review.md` 为准，本行不复述细节**（细节复述必漂移）。
3. **环节 C 开发者 IDE 人审 + squash**：reset 前先 `git diff --name-only <base>..HEAD` 记下**本 flow 代码改动范围**写入 review.md（squash 前 scope 核对的依据，跨 /clear 保留）→ `git reset <base>` 摊平为未暂存全量 → 告知开发者去 IDE Changes 组亲审（勿手动 stage，保语言服务）→ **真机验证清单**（若 tickets.md 有 `## 待真机验证` 段：逐票请开发者做真机 / 鉴权 / 运行时验证，验过 → 把该票 `rm:pending` 改 `rm:done`，验出问题 → 并入人审-修复循环。这是全流程唯一的真机验证落点）→ **人审-修复循环**（开发者提问题 → AI 改工作树 → 重跑全量测试 → 记 review.md）→ 开发者确认无更多问题**且 `## 待真机验证` 段登记的每张票都已 `rm:done` 或已明确豁免**（判据细节见下面「完成条件」，⛔ 别简化成「grep 到空」——豁免的票标记不会被改写） → 最终 CR（条件式，子代理用 `git diff --staged <base>`）→ **squash 前工作树 scope 核对**（见下）→ **squash 成单个 feat commit**（body 末行 `flow-squash: <flow_id>`）。

**squash 前工作树 scope 核对**（`git add -A` 之前必做，防 monorepo 里把跨子项目 stray 改动一并吞进 squash）：逐条核对 `git status --porcelain`，只有落在**本 flow 范围**内的改动才纳入 squash。

**万一 /clear 落在「reset 已跑、范围还没写进 review.md」的窗口里**：别凭工作区现状硬划范围——那等于把 stray 也算进来。本 flow 范围可以从 tickets.md **重新算出来**：已勾票的 `Touches` 并集（机器门⑥ 已逐票验过「实际改动 ⊆ 声明」，所以这个并集必然覆盖全部真实改动；它偏宽，只会少抓几个边缘 stray，不会误伤本 flow 的改动）。要更精确就 `git reflog` 找回 reset 前的那个 HEAD，再 `git diff --name-only <base>..<那个 sha>`。本 flow 范围 = reset 前记下的代码改动范围 ∪ `docs/grill-flows/**`（记账 tracking：candidates.md、tickets.md 的 `qc:done` / `[x]`——属本 flow、**必须纳入** squash，别把它们排除掉，收尾吸收记账靠的就是它们）∪ `.ai-flow/**`（flow 定义；**运行中升级过插件就会有它**，`close` 在 stage-3 已按同一口径豁免过，它不能单独 commit——机器门③ 要求每笔 commit 都归属某一票——所以只能在这里被吸收，**同样必须纳入**）。落在范围外的**跨子项目 stray 代码改动**（本 flow 未触及、其他子项目的改动）→ **不 `git add` 进 squash**，停下问开发者如何处理，别一把 `git add -A` 吞进去。

**squash commit 撞 pre-commit hook**：按 `per-ticket-review.md` 的「领域事实：预期的中间不可编译态」处理——不默认 `--no-verify` 裸奔。squash 是环节 A/B/人审均已过后的**最终态、应干净**：失败落在上面 scope 核对判定的本 flow 范围内 → 修代码、不跳过；失败落在 flow 范围外的其他子项目 stray 上（依据即 scope 核对结论）→ 才用 `--no-verify` 并在 message 注明跳过的 hook 及原因。

前置产物要改 → 走 `revision-protocol.md`。

## 输出规格

`{{project_root}}/docs/grill-flows/<flow_id>/review.md`（findings + 人审记录 + 原始测试输出）+ **单个 feat squash commit**（base 之后全部改动，body 末行 `flow-squash: <flow_id>`）。

## 完成条件

- 全量测试全过；安全专项已跑，Standards / Spec 两轴**已跑或已按规模跳过且依据记进 review.md**；跳过的话**点名项在人工 review 节有独立结论**（与「已知碰撞面逐行点名」同一纪律，不许一句「已查」带过）；阻塞项已修。
- **tickets.md 末尾的「已知会撞的文件」清单已逐行点名**，每行在 review.md 有独立结论（清单不存在 → 明写「无已知碰撞面」）。这是车道模式下机器门⑦ 失效之后唯一的替代保护，做法见 `assembly-review.md`。
- **环节 C 走完**：开发者确认无更多问题、人审改动全过回归、最终 CR 干净（或条件跳过）；**tickets.md `## 待真机验证` 段登记的每一张票，其票行上的标记都已从 `rm:pending` 变成 `rm:done`（或开发者对该票明确豁免、并在 review.md 注明原因）**。
  ⛔ **别去 `## 待真机验证` 段里 grep `rm:pending`**：该段的条目格式是 `- T<n> — 验什么`（stage-3 记账第 2 项定的），**根本不含这个词**，所以「该段无 `rm:pending` 残留」这种查法恒为真、清单非空时同样为真。标记在**票行**上，正确查法是拿该段列出的票号去票行核：`grep -n 'rm:pending' tickets.md` —— **每一条命中都必须在 review.md 有对应结论**（验过了→该票行本该已改成 `rm:done`；开发者明确豁免→review.md 里写明豁免原因）。⚠️ **不要要求这条 grep 为空**：被豁免的票没有任何指令改写它的票行标记，要求为空会让豁免场景永不可满足，逼人把标记直接删掉、连「这票被豁免过」这个事实一起丢。
- **全部改动已 squash 成单个 `feat` commit**（body 带 `flow-squash: <flow_id>` 锚点），working tree 干净。
- **stage-3 留下的票分支已清理**（`git branch --list "wt/<flow_id>-*"` 为空）——它们在 stage-3 被刻意保留供重入判相位，squash 之后再无用途，不删会跨 flow 累积。
- **人审过程中定下的取舍已落盘**（方案层进 `spec.md` 的 `## Decisions`，范围/已对齐结论的走修订协议回写 `alignment.md`），不是只记在 `review.md` 的问题流水里——stage-5 的沉淀读的是前者。

## Signal

**触发条件**：完成条件全满足——**含环节 C 走完（真机票 `rm:pending` 已收口）+ squash 完成**。在此之前绝不写 signal（即便开发者说「可以了」，也要先跑完最终 CR + squash）。
**动作**：用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`。引擎进 gate-pending，开发者 `grill-flow approve` 推进沉淀。不批 = 就地改再重呈。
