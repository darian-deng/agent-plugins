# Stage 3：implement（逐 ticket 亲做）

> grill-flow 第 3/5 步 · [流程总览](../helper.md)
> 当前 stage 目的：主 session 逐 ticket 亲做，每 ticket 收尾跑 simplify + Standards/Spec 双轴 CR，per-ticket 客观地板兜底。
>
> **元规则**：本 stage 允许 commit。每 ticket 一个独立 commit（引用 ticket 号）作**执行期锚点**（/clear 重入靠它判质量完成）；收尾由 stage-4 环节 C `git reset` 摊平后 squash 成一笔 feat commit。

## 目标

按 tickets.md 的 frontier 逐 ticket 实现——人在主 session 亲做（非 SDD 派发），每 ticket 走完 `per-ticket-review.md` 那套质量流程再勾 `[x]`。

## 前置读取

- `{{project_root}}/docs/grill-flows/<flow_id>/` 下 `spec.md` + `tickets.md`（`<flow_id>` 用 context 注入的实际值，勿自拼）
- `{{flow_root}}/references/per-ticket-review.md` — **每 ticket 收尾的固定顺序与 /clear 重入判据（核心，逐条照做）**
- `{{flow_root}}/references/fowler-smells.md` — Standards 轴子代理携带
- `{{flow_root}}/references/revision-protocol.md`

## 入场动作

**判首次 vs /clear 重入**：注入 context 已含 `base_sha_code` 行，或 tickets.md 已有 `[x]` → 重入，**跳过 Step 1**（重捕会污染 stage-4 diff 基准，引擎也拒覆写），按 `per-ticket-review.md` 重入判据从第一个未 `[x]` 的 ticket 续。

**Step 0 预检**：`git branch --show-current`（在 main/master → 停，要开发者切需求分支）；`git status --porcelain`（含**代码**改动 → 停问开发者；仅 `docs/grill-flows/` 改动属正常，豁免）。

**Step 1 起点 commit + mark-base**：`git add` 全部 flow docs（alignment.md + wayfinder-map.md + spec.md + tickets.md）→ `git commit -m "docs: <feature> stage1-2 outputs"` → 用 Write 写 `{{flow_root}}/state/mark-base`（内容任意如 `capture`）触发引擎捕获 base_sha_code。

## 主循环（每 ticket）

读 frontier = 第一个未勾 `- [ ] T<n>` 且所有 `Blocked by` 已勾的 ticket，然后**严格照 `per-ticket-review.md` 的 11 步顺序**（**commit 在质量链之后**，让审查审到真实未提交改动）：实现（tdd 只在 seam，**先不 commit**）→ `/simplify`(apply) → Standards 轴子代理(report-only) → Spec 轴子代理(携 spec.md) → correctness(Claude Code 内置 /code-review，审未提交 diff) → 修复 findings → 客观地板(typecheck+测试绿+假绿检测+枚举负空间+回归) → **commit(一个独立 commit，执行期锚点)** → 落候选(candidates.md,去重) → 写 `qc:done` → 勾 `[x]`。

- **切片撑爆窗口**（上游切片错）→ **就地在 tickets.md 重切该 ticket 并知会开发者**（引擎无反向 stage 转移）。
- 前置产物要改 → 走 `revision-protocol.md`。

## 输出规格

git commits（每 ticket 一个，质量链后置、一次到位无 amend）+ `tickets.md` 进度（`qc:done` + `[x]`）+ `candidates.md`（沉淀候选，带 ticket ID 前缀）。
验证：机器门 `scripts/gate-stage-3.cjs` 断言 tickets.md ≥1 已勾且无未勾。

## 完成条件

- tickets.md 全部 ticket 级项 `[x]`，且每个都走完 per-ticket 质量流程（有 `qc:done`）。

## Signal

**触发条件**：frontier 空（全 `[x]`），**或**开发者明确表示完成。
**动作**：用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`。引擎跑机器门（`gate-stage-3.cjs`）通过后**自动进 stage-4**（本 stage 无人工 gate）。
