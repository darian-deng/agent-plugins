# Stage 3：implement（编排器逐 ticket 派发）

> grill-flow 第 3/5 步 · [流程总览](../helper.md)
> 当前 stage 目的：编排器逐 ticket 串行派发 fresh 子代理实施，每 ticket 收尾派 Standards/Spec/correctness 评审子代理 + 编排器把门，per-ticket 客观地板兜底。
>
> **元规则**：本 stage 允许 commit。每 ticket 一笔独立**代码** commit（**subject 首行含该票号 `T<n>`**，一笔只认领一票）作**执行期锚点**（/clear 重入靠它判质量完成）；记账改动（candidates.md、tickets.md 的 `qc:done` / `[x]`）留工作树、不单独 commit；收尾由 stage-4 环节 C `git reset` 摊平后 `git add -A` squash 成一笔 feat commit（代码 + 记账一并吸收）。

## 目标

主 session 作为**轻量编排器**，按 tickets.md 的 frontier **串行派发 fresh 子代理**逐 ticket 实现（主 session 只调度、不直接写代码；实现与评审都在子代理里跑、不涨主 session context），每 ticket 走完 `per-ticket-review.md` 的编排协议再勾 `[x]`。

## 前置读取

- `{{project_root}}/docs/grill-flows/<flow_id>/` 下 `spec.md` + `tickets.md`（`<flow_id>` 用 context 注入的实际值，勿自拼）
- `{{flow_root}}/references/per-ticket-review.md` — **每 ticket 收尾的固定顺序与 /clear 重入判据（核心，逐条照做）**
- `{{flow_root}}/references/fowler-smells.md` — Standards 轴子代理携带
- `{{flow_root}}/references/revision-protocol.md`

## 入场动作

**判首次 vs /clear 重入**：注入 context 已含 `base_sha_code` 行，或 tickets.md 已有 `[x]` → 重入，**跳过 Step 1**（重捕会污染 stage-4 diff 基准，引擎也拒覆写），按 `per-ticket-review.md` 重入判据从第一个未 `[x]` 的 ticket 续。

**Step 0 预检**：`git branch --show-current`（在 main/master → 停，要开发者切需求分支）；`git status --porcelain`（含**代码**改动 → 停问开发者；仅 `docs/grill-flows/` 改动属正常，豁免）。

**Step 1 起点 commit + mark-base**：`git add` 全部 flow docs（alignment.md + wayfinder-map.md + spec.md + tickets.md）→ `git commit -m "docs: <feature> stage1-2 outputs"` → 用 Write 写 `{{flow_root}}/state/mark-base`（内容任意如 `capture`）触发引擎捕获 base_sha_code。

## 主循环（编排器逐 ticket 串行派发）

读 frontier = 第一个未勾 `- [ ] T<n>` 且所有 `Blocked by` 已勾的 ticket（**分岔出多张同时够格时，按 tickets.md 文件顺序取第一张——这是确定性 tiebreak（打破平局的默认规则），绝不用 `AskUserQuestion` 问「先做哪条」，顺序不是决策**），然后**严格照 `per-ticket-review.md` 的编排协议**串行走完（**commit 在质量链之后**，让评审审到真实未提交改动）：

1. **精瘦派发实施子代理**（`sonnet`/1M，传入纪律见 `per-ticket-review.md`）：携该 ticket 的 tracer-bullet 竖切 + spec 相关段 + files 符号锚点 + 前置 ticket 的 commit SHA 指针 + 相关 ADR 路径 → 子代理 TDD 只在 seam、实现、`/simplify` apply、**改动留工作树不 commit**、回精简形状；近上限走**截断自保护**（commit `[partial]` + 剩余清单，编排器续派）。
2. **并行派 Standards / Spec / correctness 三评审子代理**（`opus`，一次并行派三个：只读同一份未提交 `git diff`、不写文件、无 race（竞态），第 3 步裁 findings 处天然汇合）report-only。
3. **编排器裁 findings**：质量 / smell / spec-drift / bug → 派子代理改工作树；**决策型 / 安全型（推翻方案、安全红线、需开发者拍板的取舍）→ 停下 `AskUserQuestion` 问开发者**（编排器模型里人在环的唯一落点）。**「该票需真机 / 鉴权 / 运行时验证」不是停点**——按第 5 步打 `rm:pending` 标、连续跑，真机验证由 stage-4 环节 C 集中做。
4. **编排器跑客观地板**：typecheck + 该 ticket 测试绿 + 假绿检测 + 枚举负空间 + 回归纪律。
5. **编排器 commit**（把该 ticket **代码**——实现 + simplify + 修复——提交为该 ticket 唯一一笔独立 commit、**subject 首行含 `T<n>` 且只含本票号**、执行期锚点，**只含代码**；机器门只解析 subject 逐 commit 一一配对，body 里的票号提及不算数——跳过 hook 之类的说明用第二个 `-m` 写进 body）→ 落候选 candidates.md → 在该 ticket 那条上写 `qc:done`（行内或其缩进子项，写在别处不算）→ **判真机**：该票改动若需真机 / 鉴权 / 运行时验证（触发原生 / 主进程运行时、鉴权登录态流转、设备 I/O、跨端真机行为等，机器地板验不了的）→ 在该 ticket 行加 `rm:pending`（与 `qc:done` 并列）+ 往 tickets.md `## 待真机验证` 段 append 一条 `- T<n> — <一句话验什么>`（**清单条目用 `- T<n> — …` 格式**）→ 勾 `[x]`；**candidates.md / tickets.md 的记账改动留工作树、不单独 commit，跨 ticket 累积，由 stage-4 收尾 `git add -A` squash 统一吸收**（详见 `per-ticket-review.md`）。

**编排器门（推进下一 frontier 前）**：该 ticket 有对应 commit + `qc:done` + `[x]` + 无未裁决的决策/安全项，全过才继续。

- **连续执行**：逐 ticket 串行连做，**不在 ticket 之间做「要不要继续」式 check-in**——过了编排器门就直接 dispatch 下一个 frontier；只有第 3 步的决策/安全 fork 才 `AskUserQuestion` 停下。**frontier 分岔出多张够格 ticket（并行风险线）也不问「先做哪条」——按文件顺序取第一张连做；「某票需真机验证」同样不停（打 `rm:pending` 标继续，留 stage-4 收口）**。（每 ticket 的落盘 / 记账 / 候选重组是必做调度动作，不算 check-in，别为「连续执行」跳过。）
- **切片撑爆子代理窗口**（罕见，1M 下单 ticket 极少触发）→ 靠第 1 步截断自保护跨轮续做；确属上游切片错 → 就地在 tickets.md 重切并知会开发者（引擎无反向 stage 转移）。
- 前置产物要改 → 走 `revision-protocol.md`。

## 输出规格

git commits（每 ticket 一笔**代码** commit，**subject 首行含 `T<n>`**，质量链后置；截断自保护的 `[partial]` 提交末轮 `--amend` 折成该 ticket 单笔）+ `tickets.md` 进度（`qc:done` + `[x]`，真机票另带 `rm:pending` 标 + `## 待真机验证` 段，交 stage-4 环节 C 收口）+ `candidates.md`（沉淀候选，带 ticket ID 前缀）——后两者为**工作树未提交状态**，由 stage-4 收尾 squash 吸收。
验证：机器门 `scripts/gate-stage-3.cjs`（fail-closed）三条断言——① ticket 级项 ≥1 已勾且无未勾（`- [ ] T<n>` / `- [x] T<n>` 之外的非标准复选框写法会被直接拦下）；② **每个 `[x]` ticket 在自己那条上写了 `qc:done`**（该 ticket 行内或其缩进子项；全文别处的 `qc:done` 不算）；③ **每个 `[x]` ticket 在 `base_sha_code..HEAD` 有属于自己的一笔非 merge commit、subject 首行含票号**，且一笔 commit 只能认领一个 ticket（subject 写多个票号会导致相互争用而 fail）。门用 `--no-merges` 排除 merge commit：分支名带票号时（`wt/T<n>`）git 自动生成的 `Merge wt/T<n> into …` 也含票号，不排除的话，一个没写过任何实施 commit 的票能靠它顶过本断言。

## 完成条件

- tickets.md 全部 ticket 级项 `[x]`，且每个都走完 per-ticket 质量流程（有 `qc:done`）。

## Signal

**触发条件**：frontier 空（全 `[x]`），**或**开发者明确表示完成。
**动作**：用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`。引擎跑机器门（`gate-stage-3.cjs`，fail-closed，三条断言见「输出规格」）通过后**自动进 stage-4**（本 stage 无人工 gate——这道门是唯一的引擎兜底）。
