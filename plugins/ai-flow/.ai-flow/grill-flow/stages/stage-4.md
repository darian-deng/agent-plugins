# Stage 4：code-review（收尾组装审）

> grill-flow 第 4/5 步 · [流程总览](../helper.md)
> 当前 stage 目的：全部 ticket 完成后跑一次组装级审查——补 per-ticket 看不到整体 diff 的洞（跨 ticket smell / 集成 / 需求闭环 / 安全）。
>
> **元规则**：本 stage 允许 commit（修复用 `--amend` 并入对应 ticket commit，或新 fixup commit）。**钉死不 squash**——保留每 ticket 独立 commit。

## 目标

一次组装级 review（叠加在 per-ticket 双轴之上，不替代）：全量测试 + Standards/Spec 双轴子代理 + 安全专项 → 汇总 `review.md` → gate 让开发者交付签收。

## 前置读取

- `{{project_root}}/docs/grill-flows/<flow_id>/spec.md` — Spec 轴对照 User Stories 闭环（`<flow_id>` 用 context 注入的实际值）
- `{{flow_root}}/references/assembly-review.md` — **收尾审的完整流程（逐条照做）**
- `{{flow_root}}/references/fowler-smells.md` — Standards 轴子代理携带
- `{{flow_root}}/references/revision-protocol.md`

## 步骤（照 assembly-review.md）

1. **全量测试**：AI 亲自跑（异步、不进 script 门），假绿检测（执行测试数 > 0），原始输出（通过/失败计数 + 关键 stdout 尾部 + commit SHA）落 `review.md`。
2. **双轴并行子代理**（都不开 worktree）：diff 基准 `git diff <base_sha_code>..HEAD -- . ':(exclude)docs/grill-flows/*'`（`<base_sha_code>` 用引擎注入 context 的 `base_sha_code:` 行的值——stage-3 的 mark-base 捕获，勿自己猜 HEAD~N）。① Standards 轴（携 fowler-smells.md，抓跨 ticket 重复/Shotgun Surgery/过度工程）② Spec 轴（携 spec.md，逐条查 User Stories 闭环/缺失/偏离）。
3. **安全专项**（有界清单，钉死不外扩）：只看本 diff 的注入 / 鉴权越权 / 密钥处理。
4. **汇总 `review.md`**：findings（双轴+安全）+ 原始测试输出。发现前置产物要改 → 走 `revision-protocol.md`。

## 输出规格

文件 → `{{project_root}}/docs/grill-flows/<flow_id>/review.md`（findings + 原始测试输出）。可能有修复 commits。

## 完成条件

- 全量测试已跑、原始输出（含通过/失败计数 + commit SHA）落 review.md。
- 双轴 + 安全 findings 已汇总；阻塞项已处理或列入 gate 待开发者定。
- 未 squash（每 ticket 独立 commit 保留）。

## Signal

**触发条件**：完成条件全满足，**或**开发者明确表示完成。
**动作**：用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`。引擎暂停等 `grill-flow approve`——gate 呈现 findings + **AI 贴出的原始测试输出**给开发者交付签收。不批 = 就地改再重呈（引擎无 reject）。
