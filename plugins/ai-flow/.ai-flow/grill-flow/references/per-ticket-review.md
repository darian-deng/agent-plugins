# 一票交付契约（stage-3）

> **读者是执行一票的子代理**；主 session 按本文件拼 dispatch prompt。调度侧的事（算批次、开收 worktree、回合、记账、拍板）在 `stages/stage-3.md`，本文件不复述。
>
> 一票的交付物 = **一笔 commit**（subject 首行含 `T<n>`、只认领本票）+ 一份精简回报。
>
> **不属于你**：`AskUserQuestion`（人在环只在主 session 那侧）、记账（tickets.md 的 `qc:done`/`[x]`/`rm:pending`、candidates.md）、开收 worktree。**子代理不写 `docs/grill-flows/**`**——在 worktree 里提交那里的文件会让后续所有归并被 git 阻断。

## 最重要的一条：路径与 cwd

**每次 Bash 调用之间 cwd 可能被重置回主仓，不要依赖 `cd` 的持久性。** 本票的一切命令都要显式指向自己的 worktree（下称 `<WT>`，主 session 会在 dispatch prompt 里给出绝对路径）：

- git：`git -C <WT> …`（**所有** `git diff` / `status` / `add` / `commit` / `log`）
- 包管理与测试：`npm --prefix <WT> …`，或单条命令内自带 `cd <WT> && …`
- Write / Edit 的 `file_path`：一律 `<WT>/…` 绝对路径

**`<WT>` 是那棵工作树里的项目根**，和你那张票 `Touches` 里的路径同一个基准——`<WT>/` 直接拼 `Touches` 上的路径就是对的。monorepo 里锚点是子项目时，工作树根在项目根之上还有几层，主 session 会把它作为 `<WT_ROOT>` 一并给出；只有改**锚点之外**的包（`Touches` 里写成仓库根相对的那些，如 `packages/net/…`）才用 `<WT_ROOT>/` 拼。拼错的症状是凭空建出一层同名目录（`<WT_ROOT>/src/…`）而机器门不报——**没拿到这两个路径就别猜，回报里问**。

**这不是风格问题**。漏掉 `-C <WT>` 的 `git diff` 会在主仓求值，看到的是空的或别票的记账改动——于是三评审审空 diff、`/simplify` 改不到东西、`comment` skill 的范围算错，整条质量链静默空转而不报错。写文件时漏掉绝对路径更糟：引擎那道「cwd 漂移时禁相对路径」的守卫在 cwd **恰好是主仓**时不触发，于是改动落进主树，本票 commit 缺内容。

## 有疑问先查给你的文档

你手上没有前面两个阶段的对话，只有它们落下来的文件——**而「这个当时定过吗」的答案通常是「定过」**。所以在把任何事情写进「需主 session 拍板」之前，先查：

- **做到什么程度算完 / 为什么是这个方案 / 某写法是不是已经否掉了** → 派发给你的 spec 相关段（`## Decisions` / `## 方案审查` / `## User Stories`）
- **测什么、在哪一层测** → spec 的 `## Testing Decisions`（seam 是 stage-2 定死的，别自己另选一层）
- **本票的预期行为、边界** → 该票的 `AC:`
- **本票该碰哪些文件** → 该票的 `Touches`
- **既有模式/约定** → 给你的 ADR 路径；前置票的 commit（`git show <sha>`）
- **术语** → tickets.md 与 spec 里的用法（主 session 会给 tickets.md 的绝对路径）

查到了就照做。**只有查完确实没有依据，才写进回报**——每一条不必要的上报都会让主 session 停下来问开发者一件他早就定过的事。

## 核心：commit 在质量链之后

实现 + `/simplify` + 修复的改动**先留工作树不提交**（`git -C <WT> diff` 看得到），评审与客观地板都审这份未提交改动，最后一次性提交为本票唯一那笔 commit。这笔 commit 因此就是「本票质量已跑完」的锚——主 session 的重入判据据它判相位。

## 派发时带什么（主 session 机械拼装，只给指针不灌全文）

- **spec 只切相关段**，不塞整份 spec.md
- **files 用符号锚点**（`@ 导出名`）让子代理自己按需 Read，不预读整文件、不在 prompt 里粘代码块
- **前置 ticket 的改动只给 commit SHA 指针**（"自己 `git show <sha>` 看、在此基础上改、勿覆盖"）。`git show` 走共享 object DB，在任何 worktree 里都能读
- **tracer-bullet 竖切 + 该票的 decisions/AC 整段**必带（护栏，必须全）
- 相关 ADR 只给**路径**（≤5 条）
- **`<WT>` 绝对路径 + 上面那条 cwd 纪律**（并行时）+ 该票的 `Touches` 声明
- 三个**绝对路径**——子代理没有 `{{flow_root}}` / `{{project_root}}` 注入，给相对路径它解析不出来：`references/fowler-smells.md`（Standards 轴要携全文）、`docs/grill-flows/<flow_id>/tickets.md`（hook 判因要查 `Blocked by`）、`scripts/gate-stage-3.cjs`（机器门规格的权威副本）
- **注释纪律带 `comment` skill**（ai-flow 内置 `skills/comment/`）

## 固定顺序

1. **实施**（`sonnet`，1M）：TDD 只在 stage-2 约定的 seam 上测 → 实现 → 跑 `/simplify`(apply) 机械质量修（复用/简化/效率）→ 改动留工作树。
   - **近上限 / 发现本票比预期大**：别硬撑到被截断。`git -C <WT> commit` 已完成部分（subject 含 `T<n>` 并标 `[partial]`，如 `feat(T3): … [partial]`——票号一开始就要在）+ 回报里写「剩余工作」清单（差哪些、做到哪、从哪继续）+ 报「完成但有顾虑」。主 session 会续派下一轮做剩余，末轮 `git -C <WT> commit --amend` 折回那笔、去掉标记，保住一票一 commit。这是运行时兜底，不为它预切 ticket；但没有它，被截断就等于该票工作全部返工。
2. **三评审并行**（`opus`，一次并行派三个，都 report-only、不写文件、只读同一份未提交 `git diff`）：
   - **Standards 轴**：携 `references/fowler-smells.md` 全文，只报 simplify 修不动的判断型 smell（架构级重复、错 altitude、过度工程）。这是 mattpocock 的质量轴，别退化成 correctness。
   - **Spec 轴**：携 spec.md 相关段，查该票对 spec 的一致性（偏离 / 漏实现 User Story / 越出 spec）。
   - **correctness 轴**：专审 bug——逻辑错误、边界/空值、错误处理与失败路径、并发/竞态，以及**安全红线五类**（定义见下）。不依赖任何内置 slash 命令，任何仓库通用。
3. **裁 findings**——按可裁性分两类，别混：
   - **机械型**（明确的 bug、spec-drift、simplify 修不动但改法唯一的 smell）→ 就地修（仍不 commit）。
   - **判断型 / 决策型 / 安全型**（要不要重构、是否过度工程、方案层争议、推翻既定方案、命中下方安全红线五类）→ **不自行处置、不 commit、不塞进 candidates 蒙混**，连同评审原文与你的看法一起**回报**，由主 session（`opus`）裁。理由：这类裁决要的是判断力，而本步是 `sonnet` 在裁 `opus` 评审的 findings——把判断层留在主 session 才对得上模型分层。安全红线更是全流程唯一的人在环落点，只在主 session 那侧。
4. **注释清理**：显式调用 `comment` skill（`/ai-flow:comment`，范围 = 本票的未提交已追踪改动 ∪ 本票新建的未追踪文件）。执行方式与判据全在 skill 里、取最新，此处不复述。清理后仍不 commit。
5. **客观地板**：typecheck + 本票测试绿 + **假绿检测**（测试选择器实际匹配 ≥1 个测试——runner 过滤器打空会 exit 0，这是工具属性）+ **枚举负空间**（本票蕴含 N 个错误码/状态/分支时，逐项核 diff 都实现且有断言）+ **回归纪律**（既有测试挂了默认当回归）。
6. **commit**（只含代码）：一次性提交为本票唯一那笔，**subject 首行必须含 `T<n>` 且只含本票号**。机器门只解析 subject、不看 body。
7. **归并前自适配**：见下。
8. **回报**（精简形状）：状态（完成 / 完成但有顾虑 / 受阻 / 需补充信息）+ 改了哪些文件做了什么 + 本票引入的新术语/模式 + 沉淀候选 + **需主 session 落账或拍板的项**：
   - 步骤 3 的判断型 / 决策型 / 安全型 findings（附评审原文）
   - **需真机验证**——判据是「机器地板验不了的」：触发原生 / 主进程运行时、鉴权登录态流转、设备 I/O、跨端真机行为等。**漏报的代价是静默的**：主 session 据此打 `rm:pending`，而 stage-4 的完成条件是「`## 待真机验证` 无 `rm:pending` 残留」——空清单天然满足，于是全流程唯一的真机验证落点被整段跳过。宁可多报一条让开发者驳掉。

## 归并前自适配（并行票）

**触发时机不是"走到第 7 步"**：各票通常同时结束，那时需求分支还没前进，自适配是空跑（提前跑还会因为各票同时追加适配行而造出原本不存在的冲突）。真正需要它的时刻是**主 session 回合本票失败、把票退回给你**——那说明别的票已经先回合了。

```sh
node <flow_root>/scripts/worktree.cjs sync <flow_id> T<n>   # rebase 到需求分支
# 有冲突 → 在 <WT> 里解 → git -C <WT> rebase --continue
# 重跑第 5 步客观地板
git -C <WT> commit --amend                                   # 折回本票那笔，保持一票一 commit
```

用 `sync` 而不是自己敲 `git rebase <某分支>`：需求分支叫什么只有主仓知道（`git branch --show-current`），照字面跑 `git rebase main` 会把本票 replay 到 main 之上，此后回合永久失败而你看不出错在哪。

**绝不用 `git merge`（含 `-X ours`）做适配**，两个理由都实测过：`-X ours` 在无文本冲突时输出 `Auto-merging` 并**静默丢弃**一侧改动，而 `--ff-only` 会把这个结果照单收进主历史（`close` 现在会拦，机器门④ 是最后兜底）；且 merge 之后 `git commit --amend` 改的是 merge commit 而不是本票那笔，冲突路径下更是直接 `fatal: You are in the middle of a merge -- cannot amend`。rebase 只重写本票**尚未回合**的那笔，已回合票的 SHA 不动，所以上游给下游的「前置 ticket commit SHA 指针」仍有效。

**适配有时不得不改另一票的文件**（往对方新建的 registry 里注册这类）。照做，然后在回报里点明——机器门⑥⑦ 会因此报越界/相交，那是预期情形，由主 session 按门的提示补 `Touches` 或撤掉本批 `batch:` 标记。

## 安全红线五类（定义，余处引用此节）

**鉴权绕过 / 注入 / 密钥·敏感数据外泄 / 越权 / RCE**。

命中这五类之一 → 报给主 session 停下问开发者。纯防御性加固、不涉及可利用路径的当常规 bug 内联修，不必上报。correctness 轴要主动去发现这五类；「何时上报」以本节为准。

## 模型分层

实施 `sonnet`（1M）；三评审 `opus`。评审只读 diff 本身很便宜，不与实施同档。

## 领域事实：预期的中间不可编译态

本 flow 的切片策略**刻意**会产出中间不可编译态——wide-refactor 走 expand → 分批迁移 → contract，本票先动一处、consumer 要等后续某票才补齐。

所以第 6 步 commit 撞 pre-commit hook（如全量 typecheck）时：能在 tickets.md 的 `Blocked by` / 切片顺序里指出**具体依据**（哪张票会补齐）→ `git commit --no-verify`，跳过原因写 body 不写 subject（双 `-m`，subject 首行仍只含本票号）；指不出依据 → 当实施缺陷正常修掉再提交，不许套用本条。第 5 步的地板已在 commit 前跑过，stage-4 环节 A 还会全量重跑补上被跳过的检查。

## 机器门规格（写成什么格式才过得去）

以下四条不合就 fail-closed 拦下。完整七条断言与各自理由在 `scripts/gate-stage-3.cjs` 的头部注释里（主 session 会在 dispatch prompt 里给你这个脚本的绝对路径）：

- commit subject **首行**含票号、**且只含本票号**（提及别的票写进 body——门只读首行；首行出现多个票号会让票↔commit 的配对不唯一，两票都会被误报越界）
- 历史**线性**：区间内不得有 merge commit
- 本票实际改的文件 ⊆ 声明的 `Touches`（记账区不计）
- 本票那笔 commit 的 diff **不能是空的**（空提交会被当成「没有交付物」拦下）
