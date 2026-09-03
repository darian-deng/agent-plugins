# stage-4 异常处理

> **触发**（撞上任意一条就读对应那节）：pre-commit hook 挡住了 commit；子代理报「需补充信息」或「受阻」；子代理报 task 太大做了 `[partial]` 提交；自己或子代理发现前置 stage 有漏 / 错。
> `<FD>` = 本文件所在目录的上一级（定义层，随插件走）。

## pre-commit hook 冲突

因 build 顺序中间态导致的 hook 失败，**不等同「受阻」**。某次 task / 簇内单个 commit 因仓库的 pre-commit hook（如全量 typecheck）失败时：

1. **先判因**：能否在 plan.md 的执行单元 / `depends_on` build 顺序链条里指出具体依据——即这是本 task 设计上必然产生的中间不可编译态（如本 task 先删列、consumer 要等后续某 Task 才补），而不是本 task 自己引入的新问题？**只能引用 plan.md 里的具体 task 依赖关系作依据，不许仅凭「报错看起来像已知那种失败」就下判断。**
2. **依据成立** → 用 `git commit --no-verify` 完成本次提交，commit message 里注明跳过了哪个 hook 及原因（如 `[intermediate, pre-commit hook bypassed: typecheck — consumer fix lands in Task N]`）。继续主循环，不停下问开发者——这类中间态是 plan 设计本身预期的。
3. **依据不成立**（报错原因在已知链条之外，疑似本 task 真引入的问题）→ 不许套用本条跳过 hook，按下方「受阻」正常处理。
4. **为何可以安全默认跳过**：Stage 5 环节 A 强制跑全量 lint / typecheck / 测试，会补跑到这次被跳过的检查；环节 C 会把 base 之后全部 commit squash 成一个 `feat` commit，被跳过 hook 的中间 commit 不会永久留在最终历史里——跳过不等于永久漏检，只是把检查时点从「每个中间 commit」推迟到「这条 build 顺序链条闭合时 + Stage 5」。

## 需补充信息（严于 SDD 默认）

1. 查答案是否在三份 docs / 该 task 相关 ADR 里
2. **在** → 改 prompt 加更明确指向（**此处即给 design.md / architecture.md 兜底路径**——`decisions` 切片不足时，把全文路径补给子代理按需读），重 dispatch 一次；仍报 需补充信息 → 停下问开发者
3. **不在** → 直接停下问开发者，**不许凭空补答案**（主 session 的信息源就是这些 docs；子代理读了还问 = 文档真缺信息 = 主 session 也编不出）。**若反复缺的是某 task 的护栏 → 是 Stage 3 的 `decisions` 切片漏了，走 `<FD>/references/revision-protocol.md` 入口 B 回补 plan**

## 受阻

按 SDD 规则尝试一次（补 context / 换更强模型 / 拆 task / plan 错则上报开发者）；同一 task 第 2 次 受阻 → 停下问开发者。

## 重 dispatch 前（受阻 / 需补充信息 重试）

先确认工作树状态——上次尝试若留下未提交改动，先决定 reset 还是保留，并把这个决定写进重 dispatch 的 prompt（否则会与入场 Step 0「工作树非空」预检在重入时叠加误报）。

## 截断自保护（`[partial]` commit）

这是**无法静态预估的大 task 的运行时兜底**；可预估的已由 Stage 3 `output_size: large` 拆分避免。

子代理近上限、或发现 task 比预期大时**别硬撑到被截断**——先 `git commit` 已完成部分（message 标 `[partial]`）+ 在 task-reports.md 写「剩余工作」清单（差哪些、做到哪、从哪继续）+ 报 `完成但有顾虑` / `受阻`。

**主 session 续跑**：**读清单，不做 git 考古**；续跑 prompt = 原 task 的 `decisions` / `verify` + 剩余清单 + 「前半已 commit 在 `<sha>`，接着做」。

续跑子代理完成后**不新建 commit**，用 `git add -A && git commit --amend` 折回那个 `[partial]` commit（串行下它必是 HEAD）并去掉 `[partial]` 标记。

⛔ **`-A` 之前先照 helper.md 铁律「`git add -A` 前先核范围」核一遍 `git status --porcelain`**，别把主树上与本 task 无关的改动一起 amend 进这笔 commit（下游 `git show <sha>` 与 Stage 5 的 diff 都以它为准）——保住「一 task 一 commit」不变量，最终 SHA 记进 task report 的 `**Commit**`。

## 自查前置 stage 问题（运行时随时可能触发）

implementer 或主 session 发现前置 stage 漏 / 错 → 走 `<FD>/references/revision-protocol.md` 入口 B（已含「L2 改了上游后评估已完成 task 是否需 fix-up task」的兜底）。

⛔ **L1 / L2 必须停下等开发者**——stage-4 无 Gate、又自动连跑，更要主动停，**不能借「连续执行」冲过去**；**L3** 才 inline 修 + 在 task report 的「前置修订」字段注记。
