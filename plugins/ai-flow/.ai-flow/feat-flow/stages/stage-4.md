# Stage 4：代码实施

> feat-flow 第 4/6 步 · [流程总览](../helper.md)
> 按 plan.md 执行单元（1 task 或耦合簇）**串行**实施，每 task 一个 commit，全部由子代理完成。**主 session 只做调度**——读 plan.md / task-reports.md、**机械拼装** dispatch prompt、记录结果；代码的读写和测试全部发生在子代理里，**禁止主 session 直接写代码**。

## 岔路 → 先读哪份

本页只留主循环骨架，和那几条「违反了不会有任何东西变红」的红线。下面每一格对应一个**可观察的触发事件**，撞上了先读那份再动手，**不要凭记忆推**。文件都在 `{{flow_def}}/references/` 下：

| 触发事件 | 读 |
|---|---|
| 要 dispatch 下一个执行单元（每个单元都重走一遍） | `dispatch-unit.md` |
| 派完了要等 / 收到「完成」通知 / `/clear` 重入 / 子代理迟迟没回报 | `subagent-lifecycle.md` |
| 子代理回报了「完成 / 完成但有顾虑」，要落盘 + 评审 | `task-report-and-review.md` |
| pre-commit hook 挡住 / 受阻 / 需补充信息 / `[partial]` / 前置 stage 有错 | `stage-4-exceptions.md` |
| 要改前置产物（design / architecture / plan） | `revision-protocol.md` |
| 要定位本仓库的 ADR 目录 | `adr-scan.md` |

## 目标

调用 `subagent-driven-development`（下称 SDD）的「fresh subagent + 单次评审」模型编排执行 plan.md：**按执行单元（1 个独立 task 或 1 个耦合簇）串行派发**，每个单元由 fresh 子代理实施 + 一次评审（同时产出规格、质量两个 verdict）。

## 前置读取

- `{{project_root}}/docs/feat-flows/<flow_id>/plan.md` — 主 session 读它拿 **task 列表 + 执行单元清单**；plan.md 的每 task 已自带 `decisions` / `verify` / `files` / `output_size`，dispatch 时机械拼装、不再运行时即兴补信息

⛔ design.md / architecture.md **不在主 session 读取，也不默认注入子代理 prompt**——管每个 task 的决策已由 Stage 3 抽成 `decisions` 切片内联进 plan。两者全文**降级为兜底路径**：仅当某 task 的 `decisions` 切片不足、子代理报 `需补充信息` 时才作为路径给出。主 session 提前读会污染 context，并诱导在主 session 内联写代码。

## 入场动作

**先判首次进入还是 /clear 重入**：看引擎注入的 `[ai-flow:paths]` 块里是否已有 `base_sha_code` 行（Step 1 触发引擎捕获后才会注入它），或 plan.md 是否已有 `[x]`。

- **已含 `base_sha_code`，或 plan.md 已有 `[x]`** → /clear 重入：**跳过 Step 1**（绝不重跑——重新捕获会污染 Stage 5 的 diff 基准；引擎也会在已存在时拒绝覆写）。改为：读 task-reports.md 重建待沉淀术语 → 从第一个未 `[x]` 的 task 续跑主循环（按执行单元清单确定它属哪个单元/簇）。⛔ **续派之前先按 `subagent-lifecycle.md` §三 确认上一轮那个子代理死没死**——`/clear` 不杀在飞子代理，而 feat-flow 全程跑在同一棵主工作树上，撞上就是两个子代理写同一棵树。其中：
  - **已 commit 但 task report 缺失 / 不全的 task**（无 `**审查**` 行，或缺 `context 候选` / `ADR 候选` 等只有子代理能产出的字段）→ 派一个子代理读 `git show <sha>` **重跑评审 + 重跑 assess-candidate**，据回报重建该 task report。主 session 不读代码、跑不了 assess-candidate，故这类字段必须由子代理重建；重跑安全（diff 已含该 task 最终改动）。
  - 有 **`[partial]` commit + 「剩余工作」清单**的 task → 按 `stage-4-exceptions.md` 的「截断自保护」续跑，**不做 git 考古**。
  - Step 0 的**分支与工作树两项复核都仍要做**——⛔ 别只复核分支：重入时工作树里的代码改动正是「上一轮子代理留下的中间态 / 它还在跑」的唯一物理信号，跳过它就等于默认那个代理已经死了。
- **无 `base_sha_code` 且 plan.md 无 `[x]`** → 首次进入，按 Step 0 → 3 顺序走。

**Step 0：分支 + 工作树预检（任何 commit 之前）**

```sh
git branch --show-current
git status --porcelain
```

- **分支**：当前在 `main` / `master`（或仓库默认分支）→ **停下，要求开发者先 checkout 一个需求分支再继续**。绝不在 main 上落任何一笔 commit（连下面起点的 docs commit 也不行）。
- **工作树**：输出非空且含**代码文件**改动 → 停下问开发者：「检测到工作树有未提交的代码改动，是上次 task 执行中途崩溃的残留，还是预期的中间状态？请确认如何处理。」（仅 `docs/feat-flows/` 改动属正常）

**Step 1：起点 commit + 触发引擎记录 base_sha_code**

```sh
git add {{project_root}}/docs/feat-flows/<flow_id>/
git commit -m "docs: <feature> stage1-3 outputs"
```

docs 提交后，**用 Write 工具写 `{{flow_root}}/state/mark-base`（内容任意，如 `capture`）**。引擎据此在「docs 已提交」的此刻捕获 `git rev-parse HEAD` 作为 `base_sha_code`，写入引擎状态并注入后续 context——**stage 自己不碰 active.json**（控制面，直接写会被引擎拒绝）。引擎确认后会回注一行 `base_sha_code: <sha>`。

`base_sha_code` 是 Stage 5/6 的代码 diff 起点（只看代码、不看 docs）。它由引擎管理、随 flow 生命周期绑定——新 flow 自然不会读到上个 flow 的基准 SHA。若引擎回报捕获失败（无提交等），先确认 docs commit 已成功再重写 mark-base。

**Step 2：初始化 task-reports.md**

```sh
touch {{project_root}}/docs/feat-flows/<flow_id>/task-reports.md
```

每 task 完成后主 session 把 task report 追加进来——这是跨 /clear 保留 task 级元信息的唯一手段。

**Step 3：定位 ADR 目录**

按 `references/adr-scan.md` 定位本仓库的 ADR 目录 / 读索引，**知道有哪些 ADR（标题 + 状态）** 即可。**不在此处一次性选定**——每个 task 涉及的模块不同、相关 ADR 也不同，相关性筛选放到每个 task 的 prompt 构造时做。

## 主循环：逐执行单元串行执行

**开跑前**：解析 plan.md 的 task 列表 + 执行单元清单——解析到 0 个 task 或无执行单元清单 → 停下问开发者（疑似 plan.md 损坏或 Stage 3 未完成）。

派发粒度是 plan 末尾的「执行单元」，不是单个 task：

- **单元 = 1 个独立 task** → 一个 fresh subagent 做这一个 task。
- **单元 = 耦合簇（多个 task）** → 一个 fresh subagent 在同一上下文里连续做完整簇，但**簇内仍逐 task commit、逐 task 跑 verify**。

每个单元循环这四步，**每一步的做法都在 references 里，不要凭记忆拼**：

1. **预处理 + 拼 dispatch prompt** → `dispatch-unit.md`（四条预处理、prompt 字段清单、模型分层、实施要求、耦合簇、精简回报形状）
2. **dispatch**，然后**直接结束回合等宿主唤醒**（`subagent-lifecycle.md` §一：串行下你手上没有不依赖它结果的活，结束回合是免费的；⛔ 不要用前台 `sleep` 或轮询循环占位等待）
3. **回报到手 → 先按 `subagent-lifecycle.md` §二 核首行与两条物理信号，确认它真的停了** → 再落盘 + 评审 + 越界核查 → `task-report-and-review.md`（四步 checklist、report 模板、四条越界维度）
4. **确认本 task 段完整**（有 `**审查**` 行），再 dispatch 下一单元

回报是「受阻 / 需补充信息」，或 commit 撞 pre-commit hook → `stage-4-exceptions.md`。

### 五条红线（违反了不会有任何东西报错）

- ⛔ **完成通知不等于子代理已停。** 宿主对「干完了」和「停下了」发的是同一种 `completed`，正文才是差别。**判据是回报首行必须是 `impl-done: <commit sha>`**（不需要理解正文）+ `git log -1` 与 `git status --porcelain` 两条物理复核（`subagent-lifecycle.md` §二）。没核就落盘 / 派下一个 → 两个子代理同写同一棵主工作树，commit 归属错乱且没有任何机器门会拦。
- ⛔ **钉死串行：绝不并行 dispatch 实施子代理。** SDD 本就禁并行 implementer；耦合的 task 已被 Stage 3 合并进同一簇/同一子代理，不存在「并行两个子代理改同一文件」的场景。**即使两个单元无文件交集，也串行派。**
- ⛔ **dispatch = 机械拼装，不即兴。** plan 的每 task 已自带 `decisions` / `verify` / `files`（符号锚点）/ `read_first`，主 session 照着拼、**不补 plan 没给的信息**。要补的信息缺失 = plan 缺信息 = 走异常处理，不在 dispatch 时现编。
- ⛔ **抑制 SDD 的三个越界默认行为**（feat-flow 接管这些，不让 SDD 冲出 stage-4 边界）：
  - **不建 worktree**——feat-flow 在当前工作树跑。理由是本 stage 钉死串行：没有并发写，就没有要隔离的东西，而 SDD 自建的树不受本 flow 管理。⚠️ 不是「引擎做不到」——引擎判得出目录是否在隔离工作树内，`base_sha_code` 在工作树下也照常框得住 diff（grill-flow 就是按票/按组开树并行的）。
  - **不调用 `finishing-a-development-branch`**——merge / PR 收尾归 Stage 6 + 开发者。
  - **不跑 SDD 的「整体 final reviewer」**——整体审查是 Stage 5 的职责（`base_sha..HEAD` + 组装级双视角审查），在此重复且可能给出打架结论。
- ⛔ **「连续执行」不等于省略调度动作。** SDD 默认「task 间不停顿、不向开发者要确认」——这指**不做「要不要继续」式的人类 check-in**，**不等于**省略每 task 之间的落盘 / 待沉淀术语重组 / 审查行回填。这几步是必做的调度动作，不算 check-in。

## 收口（全部 task 完成后）

最后一个 task 的审查行回填后：**不进 SDD 的收尾流程**（不跑 final reviewer、不调 `finishing-a-development-branch`）→ 直接核对下面「完成条件」→ 写 signal。整体质量审查交给 Stage 5。

## 输出规格

- plan.md 所有 task 标 `[x]`，每 task 一个 commit
- `active.json` 含 `base_sha_code` 字段（Step 1 写入）
- `task-reports.md` 累积全部 task report（Stage 6 从此读 ADR 候选 / 新术语或模式 / context 候选）

## 完成条件

- plan.md 所有 task 标 `[x]`
- `active.json` 含 `base_sha_code` 字段
- 全部 task 都有对应 commit
- `task-reports.md` 含全部 task report（每 task 一段，含 `**审查**` 行）

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**开发者明确表达本阶段已完成。
**动作**：用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`（引擎接受此关键词，自动推进）。
