# per-ticket 编排协议（stage-3 每个 ticket）

> 主 session 是**轻量编排器**：实现与评审都外包给 fresh 子代理，主 session 只调度、裁决、把门，不直接写代码（引擎只算主 session context，子代理各有独立窗口、不涨主 session）。mattpocock 原生质量轴是 **Standards + Spec 双轴**，本 flow 叠加 correctness 轴；三轴都是 report-only 子代理。全部是**纪律，不是引擎门**（引擎 stage 内无挂载点），边界强制兜底在 `gate-stage-3.cjs`（fail-closed）+ stage-4 gate。

## 关键：代码 commit 在质量链之后

实施子代理**先不 commit**——实现 + `/simplify` 的改动留工作树，评审/客观地板都审这份未提交改动，编排器最后把**代码**（实现 + simplify + 修复）一次性提交为该 ticket 唯一一笔独立 commit。这笔代码 commit 因此成为"本 ticket 质量已完成"的锚（/clear 重入据此判断）。

**一笔 commit 只含代码，不含记账**：commit 之后写的记账改动（candidates.md、tickets.md 的 `qc:done` / `[x]`）刻意**不进这笔 commit**——`qc:done` 特意写在代码 commit 之后，正是"质量已过、收尾在做"这一重入状态的锚。记账改动留工作树、跨 ticket 累积，归宿见固定顺序下方说明。

## 传入子代理的纪律（精瘦派发——省窗口的关键）

编排器**机械拼装** dispatch prompt，只给指针不灌全文：
- **spec 只切相关段**，不塞整份 spec.md
- **files 用符号锚点**（`@ 导出名`）让子代理自己按需 Read，**不预读整文件、不在 prompt 里粘代码块**
- **前置 ticket 的改动只给 commit SHA 指针**（"自己 `git show <sha>` 看、在此基础上改、勿覆盖"），不灌 diff 正文
- **tracer-bullet 竖切 + 该 ticket 的 decisions/AC 整段**必带（护栏，必须全）
- 相关 ADR 只给**路径**（≤5 条）让子代理按需读
- **注释纪律带 `comment` skill**（ai-flow 内置 `skills/comment/`）：让实施子代理照它写注释——默认不写、只留代码表达不了的「缘由/否定/约定/边界」四类、自包含禁 flow 临时指代（`T<n>` / spec 章节号 / `见上文` 等），能搬进类型/断言的先搬

## 固定顺序（一个 ticket 走完这套编排器再勾 [x]）

1. **实施子代理**（`model='sonnet'`，1M 窗口——实施是机械执行 + TDD 兜底、又是 token 大头，降这里省最多）：按上面传入纪律派发。子代理职责——tdd 只在 stage-2 约定的 seam 上测；实现；跑 `/simplify`(apply) 机械质量修（复用/简化/效率）；**改动留工作树、先不 commit**；回**精简形状**（状态 完成/完成但有顾虑/受阻/需补充信息 + 改了哪些文件做了什么 + 本 ticket 引入的新术语/模式 + 沉淀候选）。
   - **截断自保护**：子代理近上限 / 发现 ticket 比预期大 → 别硬撑到被截断：`git commit` 已完成部分（message 标 `[partial]`）+ 写「剩余工作」清单（差哪些、做到哪、从哪继续）+ 报 完成但有顾虑 / 受阻。编排器续派下一轮做剩余，末轮用 `git add -A && git commit --amend` 折回那个 `[partial]`、去掉标记——保住"一 ticket 一 commit"。（1M 窗口下单 ticket 极少触发；这是运行时兜底，不为它预切 ticket。）
2. **三评审子代理并行派发**（步骤 2–4 一次并行派、都 report-only，第 5 步裁 findings 处汇合；只读同一份未提交 diff、不写文件、无 race——**「串行」纪律只约束实施子代理，见下方「子代理纪律」**）——**① Standards 轴子代理**（`model='opus'`）：携 `references/fowler-smells.md` 全文 + 该 ticket 未提交 diff（`git diff`），**只报告 simplify 修不动的判断型 smell**（架构级重复、错 altitude、过度工程）。report-only 不 apply。这是 mattpocock 的质量轴，别退化成 correctness。（注释治理不在评审里顺带做——见第 5 步 commit 前**显式调用 `comment` skill**。）
3. **② Spec 轴子代理**（`model='opus'`）：携 `spec.md` 相关段 + 该 ticket 未提交 diff，自定义 prompt 查该 ticket 对 spec 的一致性（有没有偏离 / 漏实现 User Story / 越出 spec）。report-only。早期抓 spec-drift，不拖到收尾。
4. **③ correctness 轴子代理**（`model='opus'`）：携该 ticket 未提交 diff，自定义 prompt 专审 correctness bug——逻辑错误、边界/空值、错误处理与失败路径、并发/竞态、以及注入/鉴权/密钥类安全隐患。report-only。**不依赖任何内置 slash 命令或子项目配置**，任何仓库/子项目都通用。
5. **编排器裁 findings**：
   - 质量 / smell / spec-drift / bug → **派子代理改工作树**（携 findings + diff，仍不 commit）；修复也会幻觉 → 关键修复独立复核兜底。
   - **注释清理（每票 CR，commit 前必做）→ 编排器显式调用 `comment` skill**（`/ai-flow:comment`，范围=该票未提交 diff）：它自带 grep 符号候选 + sonnet 语义判断（含文字类进程指代/冗余/失效）+ 删完重测，清理本票新增注释；改动与其它 fix 一并留工作树、仍不 commit。**判据在 skill 里，不在此复述。**
   - **决策型 / 安全型**（推翻方案、安全红线、需开发者拍板的取舍）→ **停下 `AskUserQuestion` 问开发者**，别自作主张 ship、也别塞进 candidates 蒙混过去——这是编排器模型里人在环的落点。
   - **需真机 / 鉴权 / 运行时验证**（原生 / 主进程运行时、鉴权登录态流转、设备 I/O、跨端真机行为等，机器地板验不了的）→ **不是停点**：正常实现 + 地板 + 提交，在步骤 9 打 `rm:pending` 登记，连续跑；真机验证由 stage-4 环节 C 集中做。别为它停下问「先做哪条」或「要不要现在验」。
6. **编排器跑客观地板**：typecheck + 该 ticket 相关测试绿；**假绿检测**=测试选择器实际匹配 ≥1 个测试；**枚举负空间检查**=ticket 蕴含 N 个错误码/状态/分支时，逐项核 diff 都实现且有断言；**回归纪律**=既有测试挂了当回归、改代码不改测试糊弄。
7. **编排器 commit（只含代码）**：把该 ticket 的实现 + simplify + 修复**一次性提交为该 ticket 唯一一笔独立 commit**，**message 必须含 ticket 号 `T<n>`**（`gate-stage-3.cjs` 据此机械核对 ticket↔commit）作执行期锚点。这笔 commit **只含代码**、不含随后步骤 8-10 的记账改动。这些 per-ticket 代码 commit 会在 stage-4 环节 C 被 `git reset` 摊平、最终 squash 成一笔 feat commit——执行期尽管每 ticket 留痕，不必担心历史零碎。
8. **落沉淀候选**：带 ticket ID 前缀、append 前 grep 去重，写 candidates.md（含子代理回报的候选）。
9. **写 qc marker + 判真机**：在 tickets.md 该条加 `qc:done` 子标记；若步骤 5 判该票需真机 / 鉴权 / 运行时验证 → 同一行再加 `rm:pending`（与 `qc:done` 并列）+ 往 tickets.md `## 待真机验证` 段 append 一条 `- T<n> — <一句话验什么>`（**必须 `- T<n> — …` 非复选框格式**——写成 `- [ ] T<n>` 会被 `gate-stage-3.cjs` 误判为未勾 ticket 而 fail）。真机验证不在本 stage 做、留 stage-4 环节 C；`rm:pending` 是「已裁决、延到 stage-4」的结果，不算编排器门的「未裁决决策项」。
10. **勾 [x]**：最后一步才把 ticket 级 `- [ ] T<n>` 改成 `- [x] T<n>`。

**记账改动的归宿（步骤 8-10）**：candidates.md 与 tickets.md 的 `qc:done` / `[x]` 一律**留工作树、不单独 commit**——它们跨 ticket 在工作树累积，最终由 stage-4 环节 C 的 `git reset <base>` + `git add -A` 一并吸收进那笔 feat squash commit（环节 B 的组装审 diff 用 `:(exclude)docs/grill-flows/*` 排除这类 doc churn，不受它们干扰）。因此本 ticket 只产生**一笔 commit（代码）**，记账不是"未规定的第二笔"，而是明确交给收尾 squash 兜底。gate 与 /clear 重入都直接读工作树里的 tickets.md（`qc:done` / `[x]` 无须提交即可判定），此归宿不破坏重入。

## pre-commit hook 冲突（步骤 7 代码 commit 时）

步骤 7 提交本 ticket 代码时，子项目的 pre-commit hook（如全量 typecheck）可能失败——**这不等同"受阻"，也不默认 `git commit --no-verify` 裸奔**（一次裸奔就跳过了全部 pre-commit 检查）：

1. **先判因**：该失败能否在 tickets.md 的 `Blocked by` 依赖链 / tracer-bullet 切片顺序（如 wide-refactor 的 expand→迁移→contract）里指出具体依据——即这是本 ticket 设计上必然产生的中间不可编译态（本 ticket 先动一处、consumer 要等后续某 ticket 才补齐），而非本 ticket 自己引入的新问题？**只许引用 tickets.md 里的具体 ticket 依赖关系作依据，不许仅凭"报错看着像已知那种失败"就下判断**。
2. **依据成立** → 用 `git commit --no-verify` 完成本笔 ticket 代码 commit，message 里注明跳过了哪个 hook 及原因（如 `[中间态, 跳过 pre-commit: typecheck — consumer 修复落在 T<n>]`），继续主循环、不停下问开发者——这类中间态是切片顺序本身预期的。
3. **依据不成立**（报错在已知依赖链之外，疑似本 ticket 真引入的问题）→ 不许套用本条跳过 hook，按实施缺陷正常处理：派子代理修工作树 → 重跑步骤 6 客观地板 → 再 commit；确属 spec/切片层错则停下问开发者。
4. **为何"文档化的跳过"≠永久漏检**：本 ticket 步骤 6 客观地板已跑过 typecheck + 该 ticket 测试（commit 前即绿）；stage-4 环节 A 还会全量重跑 lint/typecheck/测试，补跑到这次被跳过的检查；环节 C 的 `git reset` 摊平 + `git add -A` squash 会把这些 per-ticket commit 合并成一笔 feat commit，被跳过 hook 的中间 commit 不会永久留在最终历史。跳过只是把检查时点从"这一笔中间 commit"推迟到"依赖链闭合 + stage-4"，不是把检查删掉。

**编排器门（推进下一 frontier 前）**：该 ticket 有对应代码 commit（message 含 `T<n>`）+ `qc:done` + `[x]` + 无未裁决的决策/安全项，全过才 dispatch 下一个。

## 子代理纪律

- 四个子代理（实施 + Standards / Spec / correctness 三评审）**都不开 worktree**——评审必须看到未提交 diff，实施也在当前工作树改（引擎按 session 绑定定位 flow、用 `base_sha_code` 框代码 diff，worktree 会另起工作树使基准失效）。
- **模型分层**：实施 `sonnet`（1M，token 大头、降这里省最多、提速最明显）；三评审 `opus`（评审是让实施敢用便宜模型的质量门，只读 diff 本身很便宜，降它省不了多少却拆掉整道安全网——绝不与实施同档）。
- **实施串行、评审并行**：**实施子代理**绝不并行派（避免两个子代理改同一文件的 race）；耦合的改动应在 stage-2 切进同一 ticket。**但三评审子代理（Standards / Spec / correctness）反过来——一次并行派**：它们只读同一份未提交 diff、不写文件、无 race，第 5 步裁 findings 处天然汇合，与 stage-4 环节 B 的双轴并行审一致。这条「串行」只管实施，别误伤评审。

## /clear 重入判据（防质量步骤被静默跳过）

引擎只恢复到"stage-3"，不记 ticket 内做到第几步。commit 在质量链之后，所以**"有无该 ticket 的 commit"就是"质量有没有跑完"的锚**。编排器重入看当前 frontier ticket（`git log --oneline <base>..HEAD` 看有无 message 含 `T<n>` 的 commit）：
- **无 commit，但工作树有该 ticket 未提交改动**（质量链中途 /clear）→ 先定夺工作树（reset 重来 or 在现状上续，把决定写进重派 prompt）→ 重跑编排（实施续/重派 → 三评审 → 裁 → 地板 → commit → 候选 → qc → [x]）。
- **有 `[partial]` commit + 剩余清单**（截断自保护留下的）→ 按清单续派实施（不做 git 考古）→ 末轮 `--amend` 折回、去 `[partial]` → 走评审/地板/收尾。
- **有 commit 但无 `qc:done`** → 已提交（质量已过）、收尾没做完 → 补落候选 + 写 qc marker + 勾选。**不是"见 commit 就直接补勾"跳过收尾**。
- **有 `qc:done` 但无 [x]**（marker 与勾选间 /clear）→ 直接补勾。
- **有 commit + `qc:done` + [x]** → 该 ticket 完成，进下一个。
