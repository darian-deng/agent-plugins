# Stage 5：质量门

> feat-flow 第 5/6 步 · [流程总览](../helper.md)
> 全量自动化回归 + **组装级双视角审查**（集成与需求闭环 + 强制安全）+ 开发者亲审闭环，抓只有改动全部组装后才显现的缺陷。**验证与审查合并在一个 stage**，避免传统拆分时的「修了一个又破另一个」套娃。

## 岔路 → 先读哪份

本页只留三环节骨架和红线。文件都在 `{{flow_root}}/references/` 下：

| 触发事件 | 读 |
|---|---|
| 环节 A 全绿，要派组装级双视角审查 | `assembly-review.md` |
| 要往 review.md 写东西 / 拿不准某条记哪一节 | `review-md.md` |
| 环节 B 结束，要交给开发者亲审 → 最终 CR → squash | `final-review-and-squash.md` |
| `/clear` 之后回来，不知道停在哪个环节 | `stage-5-reentry.md` |
| 要定位本仓库的 ADR 目录 | `adr-scan.md` |
| 发现前置 stage（design / architecture / plan）漏了或错了 | `revision-protocol.md` |

## 目标

**stage-5 只审「全部改动组装后才显现」的缺陷**——这是 Stage 1/2/4 任何单点都看不到的视角。

- 逐函数局部 bug / 语法 / 边界已由 **Stage 4 每 task 的单次评审**（规格 + 质量两个 verdict）覆盖，**这里不重做**。
- 架构与方案已由 Stage 2 + 其 Gate 定稿，**这里不重判**（发现真问题走 `references/revision-protocol.md`，不当常规审查项）。

确保 `base_sha_code` 之后的所有改动通过：自动化回归（lint / typecheck / 单元 / 集成）→ 组装级双视角审查（① 集成 & 需求闭环 ② 安全专项，**强制不可跳过**）→ 阻塞项经 **3 轮验证**确认修复到位（模型会幻觉，修复也会——独立审查者复核是核心防线）→ 开发者亲审 + squash。

环节 A/B 只产生**修复类 commit**（`fix: resolve verification errors` / `fix: address review finding`），不新增功能；环节 C 走完后把 base 之后的全部改动 squash 成单个 `feat:` commit。

## 前置读取

- `{{project_root}}/docs/feat-flows/<flow_id>/design.md` — 项目命令、决策记录、AC
- `{{project_root}}/docs/feat-flows/<flow_id>/architecture.md` — 架构基线 + 集成点清单
- `{{project_root}}/docs/feat-flows/<flow_id>/task-reports.md` — 跨 task 元信息（新术语 / 前置修订）
- 引擎注入 `[ai-flow:paths]` 里的 `base_sha_code` — Stage 4 起点 SHA（下文 `<base>` 即此值；**不要去读 active.json**，那是控制面）

## 入场动作

**ADR 查阅**：执行 `references/adr-scan.md`，筛出与本次改动相关的 ADR，产出**相关 ADR 路径列表**——环节 B 两个视角的审查者都按需引用它（视角① 查「是否违反既有 ADR」、视角② 取安全相关 ADR）。无 `docs/adr/` 则列表为空，跳过。

**若这不是首次进入本 stage**（`/clear` 重入）→ 先按 `stage-5-reentry.md` 判停在哪个环节，**别从环节 A 重头跑**。

## 环节 A：自动化回归

按 design.md 项目命令运行：单元测试 / 集成测试（若有）/ Lint / Typecheck。

**失败处理**：

- 修代码（默认）
- 若是既有测试被打破 + 怀疑测试在测**实现细节** → 应用下面「既有测试破坏纪律」
- 修复后 `git add -A && git commit -m "fix: resolve verification errors"`（`-A` 全树暂存，不受当前目录影响）
- 重跑直到全过

### 既有测试破坏纪律

**默认假设**：本次改动是回归，要修代码。

**例外**：若主 session 认为既有测试在测**实现细节**而非**行为**（违反可测试性原则），可提议改测试：

- 必须在 review.md「测试调整记录」节明确列出：哪条测试、为什么是测了实现细节、新测试如何覆盖原意图
- 改完测试可继续环节 A，但该调整**留待环节 B 的视角① 复核**（派发视角① 时明确要求验证「测试调整记录」每条是否成立）
- 若视角① 判定调整不成立 → 当作阻塞项回退

⛔ **绝对禁止**：通过修改测试断言让测试「通过」而不解释为什么。

## 环节 B：组装级双视角审查

两个视角**并行派发**，都用内置 `general-purpose` 子代理（能跑 git）——主 session 只给 `<base>`，让审查者自己 `git diff <base>..HEAD` / `git log` / 按需 Read 文件。

**完整做法在 `assembly-review.md`**：视角① 的传入清单与九条组装级维度、视角② 的 OWASP/CWE 逐项清单与依赖审计判定脚本、综合处理的 `receiving-code-review` 纪律、阻塞项的 3 轮硬上限。

⛔ **视角② 安全专项强制，不可跳过**——无论改动类型每次都跑。安全是最高代价缺陷类，跨模块可利用性只有组装后才看得全。

## 环节 C：人工 review 闭环 + 最终 CR + squash

环节 A/B 是 AI 自查，这一环是**开发者**把关。**完整做法在 `final-review-and-squash.md`**（reset 摊平、注释清理两次、人审-修复循环、条件式最终 CR、Context 变化捕获、squash message 格式）。

⛔ **本环节走完前绝不写 signal**，即便讨论中开发者说「可以了」，也要先跑完最终 CR 并 squash。

## 自查前置 stage 问题（本 stage 期间随时可能触发）

任一视角的审查者或主 session 自查发现前置 stage 漏写 / 错了 → 走 `references/revision-protocol.md`（入口 B）：

- **L1**（推翻决策）→ 停下问开发者，建议 abort
- **L2**（漏写补全）→ 暂停 Stage 5，回更新前置文档，让开发者确认，再回 Stage 5 继续
- **L3**（小修）→ inline 修文档，review.md 加注记

注：问题挑战 design.md 已记录决策的「架构级冲突」处理（见 `assembly-review.md` §综合处理）是本协议的特例。

## 四条红线（违反了不会有任何东西报错）

- ⛔ **环节 C 入场的顺序不能反**：先 `git diff --name-only <base>..HEAD` 把范围**写进 review.md**，才 `git reset <base>`。reset 之后 `<base>..HEAD` 是空的，那份范围再也算不出来——而它是收尾 `git add -A` 前 scope 核对的唯一依据。
- ⛔ **`git add -A` 之前先核范围**：逐条对 `git status --porcelain`，只把落在本 flow 范围内的改动纳入（判据见 helper.md 铁律）。有范围外的改动 → 不要 `-A`，停下问开发者。monorepo 里一把 `-A` 会把别的子项目 stray 一起吞进 squash。
- ⛔ **reset 之后派任何子代理看改动，一律用 `git diff --staged <base>`，不用 `<base>..HEAD`**——后者此时是空 diff，子代理会对着空 diff 写出一份「没发现问题」，而这不报任何错误。
- ⛔ **每轮处理后立即写 review.md**，不允许积累在主 session 内存。review.md 是本 stage 唯一的跨 `/clear` 真相源，全部恢复路径都读它。

## 完成条件

- 自动化回归全过（squash commit 前在 working tree 跑一次确认）
- **视角① 与视角② 都已跑**（安全视角强制，不可跳过）
- **环节 C 已走完**：开发者确认无更多问题，人审改动全部过回归，最终 CR 已跑（或按条件跳过）且干净
- **环节 C 已把全部改动 squash 成单个 `feat` commit**（body 末行带 `flow-squash: <flow_id>` 锚点），working tree 干净
- review.md 存在且完整（**含安全节**）
- 所有阻塞项（视角① 阻塞 + 安全 Critical/High）已修复
- 「待开发者决策」类问题由开发者拍板后已应用
- 建议项已呈开发者（非阻塞，无需全部修）
- `context-delta.md` 已追加 `## Stage 5` 节（**无候选时也要写 `（无）`**）且已纳入 squash commit

## Signal

**触发条件**：本阶段「完成条件」全部满足——**含环节 C 走完（开发者确认无更多问题 + 最终 CR 干净 + 全部改动已 squash 成单个 feat commit）**。在此之前不写 signal。
**动作**：用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`。写入后引擎进入 gate-pending，开发者 `feat-flow approve` 方才推进。
