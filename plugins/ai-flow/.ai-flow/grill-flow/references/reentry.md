# stage-3 重入：/clear 之后怎么判走到哪一步

> **触发**：`/clear` 之后回到 stage-3；或注入 context 里已有 `base_sha_code`、或 tickets.md 已有 `[x]`（都表示不是首次进入）。
> `<flow_root>` = 本文件所在目录的上一级；stage-3 提示词里 `{{flow_root}}` 展开出来的就是它。

引擎只恢复到「stage-3」，不记进度。**第一步必须枚举，不能直接看 tickets.md 就重派**：

```sh
git worktree prune && git worktree list --porcelain
```

列出的条目里有 `wt/<flow_id>-` 分支的 → 先收口存量，**不得重派**（重派会撞 `fatal: a branch named 'wt/<flow_id>-T<n>' already exists`，并留下孤儿 worktree）。

⚠️ **车道模式除外**：`R<n>` 的树按设计长驻，看到它不代表有残留要收口——正确动作往往是往同一棵树派下一票。判据见下面「车道模式的重入」。

车道模式下再跑一次 `node <flow_root>/scripts/worktree.cjs status <flow_id>`，它一屏给出各车道的 `ahead / dirty / 是否 HEAD 后继 / 待补依赖 / 静默时长`。

## 逐票判相位

**锚 = 该票那笔 commit（在主分支或在它自己的分支上）+ 票面上的 `impl:done` / `qc:done`**。一票走两段（实施 → 质量链），`impl:done` 是主 session 在实施段交付后写下的落盘标记，它是「树里有未提交改动」这一个物理状态的唯一区分器：

| 该票 commit 在哪 | worktree | 相位 | 动作 |
|---|---|---|---|
| 不存在 | 无 | 未派 | 正常派发 |
| 不存在（分支零 commit） | 有，且干净 | 已开未派 | **别 close**（对零 commit 分支 ff 会 "Already up to date" 并成功拆除，看起来像交付了、实则一行代码没有——`close` 现在会拦）。直接派发子代理 |
| 不存在 | 有未提交改动，票上**有** `impl:done` | 实施已交付；质量链未跑**或正在跑** | ⚠️ **`impl:done` 只说明实施段交付过，不说明质量链没在跑**——质量链期间机械型 findings 就地修、不 commit，产出的正是这个状态。派人之前先按 `subagent-lifecycle.md` 确认在飞代理死没死（`/clear` 不杀它）。确认已停 → 按 `quality-chain.md` 派质量链代理接手，**别重做实现** |
| 不存在 | 有未提交改动，票上**无** `impl:done` | 实施在飞 | 先定夺工作树（reset 重来 or 在现状上续，把决定写进重派 prompt），续跑实施段契约。⚠️ 先按 `subagent-lifecycle.md` 确认原子代理死没死——`/clear` 不杀在飞子代理 |
| 有 `[partial]` 标记，票上**无** `impl:done` | 有，且干净 | 续做段没派或没交付 | 按票面 `rest:` 字段续派**实施代理**（⛔ 不是质量链——它会只审那笔 `[partial]` 就 `--amend` 摘掉标记，静默交付半成品；`quality-chain.md` 形态乙那条 fail-closed 就是拦这个）|
| 有 `[partial]` 标记 + `rest:`，票上**无** `impl:done` | 有未提交改动 | 截断待续做 | 按 `rest:` 续派**实施代理**（**不做 git 考古**；那一轮不再 commit，改动留树上累积）。⚠️ 它交付后主 session 要写 `impl:done`，否则下次重入会落回本行、把同一份清单再做一遍 |
| 有 `[partial]` 标记，票上**有** `impl:done` | 有未提交改动 | 续做已交付、待质量链 | 派质量链代理（`quality-chain.md` **形态乙**，prompt 里把 `rest:` 内容标成「已由续做代理做完」）→ 由它 `--amend` 去掉 `[partial]`。⛔ 别再派实施代理——`subagent-lifecycle.md` 记过同款事故：两个 agent 同时写一棵车道树，来回三轮 |
| 有 `[partial]` 标记，票上**有** `impl:done` | 有，但**干净** | 记账与物理状态冲突 | ⛔ **停下**，不许 `--amend`、不许续派。`impl:done` 声称续做已交付（那意味着树里该有未提交改动），而树是空的——改动要么被别人提交了、要么被 reset 掉了。先按 `subagent-lifecycle.md` 查在飞代理、再查 `git reflog` 判改动去哪了。⚠️ 这一格若误按上一行处理，质量链形态乙的 fail-closed **按设计不触发**（`rest:` 被标成「已做完」时树允许是干净的），于是 `[partial]` 标记被摘掉、票面上再没有东西说它没做完，而机器门四条断言全过 |
| 在 `wt/<flow_id>-T<n>` 上、未合回来，**且 subject 不含 `[partial]`** | 有 | 已交付未回合 | **别重派**——先裁回报（主循环第 4 步）再走回合（第 5 步）。⛔ 漏掉这个前提会把一张只做了一半的票 `--ff-only` 合进需求分支 |
| 在 `wt/<flow_id>-T<n>` 上、未合回来 | 无（分支还在） | 已交付、工作目录被清掉 | 上面那步 `git worktree prune` 本身就会制造这个状态（有人手动删过目录）。`git worktree add <path> <branch>` 复用该分支恢复，再按上一行走。**别重派**——重派会撞「分支已存在」 |
| 在主分支上 | 还在（`close` 里 ff 成功但 remove 失败） | 已回合未拆 | `git worktree remove` 补拆，再按下一行继续 |
| 在主分支上、无 `qc:done` | 无 | 已回合未记账 | 补主循环第 6 步的记账（**含 `rm:pending` 判定**），不重跑质量链 |
| 在主分支上、有 `qc:done` 无 `[x]` | 无 | 记账收尾 | 补勾 |
| 在主分支上、`qc:done` + `[x]` | 无 | 完成 | 进下一票 |

**按树遍历时多一行**（车道模式）：某条车道名下已无未勾票、树却还在 → 本组末票 `close` 时忘了去掉 `--keep` → `git worktree remove <path>` 补拆 + `git branch -D wt/<flow_id>-R<n>`。不补拆，机器门⑤ 会在写 signal 时拦「未收口的 worktree」。

**查该票 commit**：`git log --oneline --no-merges <base>..HEAD`（在主分支）与 `git log --oneline <base>..wt/<flow_id>-T<n>`（在票分支）。只看 subject 首行，别翻 body——body 里有对未来票号的前向引用。

## 车道模式的重入

票↔车道的映射只存在于 `lane:` 字段里（这就是它必须先落盘的原因）。相位仍按上表判，只把「worktree」一列读成「该票所属车道那棵树」，并改一条判据：

- **车道树存在 ≠ 该票在飞**（树是长驻的）——在飞看的是车道分支上有没有未回合的 commit：`git log --oneline <需求分支>..wt/<flow_id>-R<n>`（需求分支名用 `git branch --show-current` 取）。
- **先看 `wip:` 字段，再看 commit**：有 `wip: R<n>` 的票就是该车道在飞的那张（子代理从派发到 commit 之间车道分支毫无变化，只看 commit 会把「正在做」读成「还没派」，于是同一棵树被派进第二个子代理）。
- 两者都没有 = 该组上一票已回合、下一票还没派。

## 两种「不是实施问题」的情形

- 切片本身错（不是实施问题）→ 就地在 tickets.md 重切并知会开发者（引擎无反向 stage 转移）。
- 前置产物要改 → 走 `revision-protocol.md`。
