# stage-5 的 /clear 恢复

> **触发**：`/clear` 之后回到 stage-5，不知道停在哪个环节。
> `<base>` = 引擎注入 `[ai-flow:paths]` 块里的 `base_sha_code` 值。

## 先判停在哪个环节

按 **git 状态 + review.md** 判定。关键判据：**环节 C 入场会 `git reset` 到 base，所以 `HEAD == base_sha_code` 是环节 C 的强标志**——环节 A/B 期间 HEAD 一直领先 base。

- **HEAD 提交 body 含 `flow-squash: <flow_id>` 锚点、且 signal 未写** → 环节 C 已 squash、只差 signal：校验完成条件后补写 signal，**不重做任何审查**。
- **`HEAD == base_sha_code` 且工作区非空**（`git status --porcelain` 有输出——涵盖未暂存改动 / untracked 新文件；开发者若手动 stage 过也一并算数）→ 处于**环节 C 人审中**。
  - A/B 期间 HEAD 恒领先 base，故 `HEAD==base` 唯一对应「已 reset 进环节 C」，⚠️ **不再 AND「review.md 该节是否已写」**——reset 与首次写 review.md 之间有窗口，那段时间 review.md 可能还没「人工 review」节。
  - 处理：**不重派双视角**，直接续——重呈相对 base 的全量改动（去 IDE Changes 组看，或 `git diff <base>` 辅以 `git status` 覆盖 untracked 新文件）+ review.md 结论，从「还有其他问题吗」继续人审-修复循环。
  - 若 review.md 还没有「本 flow 改动范围」节，按 `final-review-and-squash.md` 里那条用 task-reports.md 的 `**Commit**` sha 反推。
  - ⛔ **若 review.md 还没有「真机验证」节，先补建清单再续人审**（来源与做法见 `final-review-and-squash.md` 的「真机验证清单」；两处来源都空也要显式写「无 `[manual]` 项」）。清单的建立点在人审循环**之前**，所以 `/clear` 落在「reset 已跑、清单还没写」这个窗口里时，直接从「还有其他问题吗」续就会把它整段跳过——而空清单天然满足完成条件，没有任何东西会报错，squash 就这么放行了。
- **否则** → 处于环节 A/B，按下面重派双视角。

## 审查中途 /clear：重启环节 B

审查者子代理的 agent ID 是 session-scoped，`/clear` 之后就丢了。新 session 重启环节 B：

1. 已 commit 的修复 → 新审查者跑 `git diff <base>..HEAD` 看到的是当前 HEAD，**不会再报已修项**。
2. review.md 累积的「已解决 / 已反驳 / 待开发者决策 / 建议」段保留——重派审查者时把现有 review.md 作为「上次审查的状态」一并传入。
3. 用 **fresh 审查者接力**（不是同一个子代理），两个视角都重派，依靠 review.md 累积上下文避免重复劳动。
4. 已记录的反驳反证 → 新审查者直接评估反证是否成立，不重新提相同问题；review.md 已记录的「建议（非阻塞）」项也**不重复提出**（建议项不改代码，fresh 审查者跑 diff 看不到，靠 review.md 去重）。

⛔ **前提**：每轮处理后必须**立即**写 review.md（各类都即时落盘），不允许积累在主 session 内存——上面每一条恢复路径都以 review.md 为唯一真相源。
