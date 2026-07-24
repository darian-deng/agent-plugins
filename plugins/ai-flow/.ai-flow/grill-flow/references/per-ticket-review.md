# per-ticket 收尾质量（stage-3 每个 ticket 完成时）

> mattpocock 原生 per-ticket 收尾就是 **Standards + Spec 双轴 code-review**（不是内置 `/code-review` 能给的——内置版审 current diff、不吃 spec.md）。加上 `/simplify` 和客观地板。全部是**纪律，不是引擎门**（引擎 stage 内无挂载点），强制兜底在 stage-4 gate。

## 固定顺序（一个 ticket 走完这套再勾 [x]）

**关键：commit 在质量链之后**——审查/simplify 要审到真实改动，所以实现完**先不 commit**，全部质量步骤跑在未提交工作树上，最后一次性 commit。commit 因此成为"本 ticket 质量已完成"的锚（重入据此判断）。

1. **实现**：tdd 只在 stage-2 约定的 seam 上测。改动**留在工作树、先不 commit**。
2. **`/simplify`**（Claude Code 内置）：自动 **apply** 机械型质量修——复用/简化/效率（作用于未提交改动）。
3. **Standards 轴子代理**：携 `references/fowler-smells.md` 全文 + 该 ticket 的未提交 diff（`git diff`），**只报告 simplify 修不动的判断型 smell**（架构级重复、错 altitude、过度工程）。**report-only 不 apply**——与 simplify 的 apply 分工，两者不重叠、都保留。这是 mattpocock 的质量轴，别退化成 correctness。
4. **Spec 轴子代理**：携 `spec.md` 全文 + 该 ticket 的未提交 diff，用自定义 prompt 查**该 ticket 对 spec 的一致性**（有没有偏离/漏实现 User Story / 越出 spec）。**内置 skill 给不了这个（它不吃 spec.md），必须自定义子代理 prompt。早期抓 spec-drift，不拖到收尾。**
5. **correctness**：用 **Claude Code 内置 `/code-review`** 抓 bug（默认审当前未提交 diff——此刻 ticket 改动全在工作树未提交，正好被它看到；不需要 PR、勿加 `--comment`）。
6. **修复 findings**：按 3/4/5 的结论直接改工作树（仍未提交）；修复也会幻觉 → 关键修复独立复核兜底。
7. **客观地板**（AI 自觉纪律）：typecheck + 该 ticket 相关测试绿；**假绿检测**=测试选择器实际匹配 ≥1 个测试；**枚举负空间检查**=ticket 蕴含 N 个错误码/状态/分支时，逐项核 diff 都实现且有断言；**回归纪律**=既有测试挂了当回归、改代码不改测试糊弄。
8. **commit**：把该 ticket 的实现 + simplify + 修复**一次性提交为一个独立 commit**（message 引用 ticket 号），**钉死不 squash**。无需 --amend（改动一次到位）。
9. **落沉淀候选**：带 ticket ID 前缀、append 前 grep 去重，写 candidates.md。
10. **写 qc marker**：在 tickets.md 该条加 `qc:done` 子标记。
11. **勾 [x]**：最后一步才把 ticket 级 `- [ ] T<n>` 改成 `- [x] T<n>`。

## 子代理纪律

- Standards / Spec / correctness 三个子代理**都不开 worktree**——必须看到未提交 diff（引擎只算主 session context，子代理不计入，所以派子代理跑不涨主 session、~30 ticket 约 4-6 次 /clear 是 mattpocock 预期节奏）。

## /clear 重入判据（防质量步骤被静默跳过）

引擎只恢复到"stage-3"，不记 ticket 内做到第几步。commit 在质量链之后，所以**"有无该 ticket 的 commit"就是"质量有没有跑完"的锚**。重入看当前 frontier ticket（用 `git log --oneline <base>..HEAD` 看有无对应 commit）：
- **无 commit，但工作树有该 ticket 未提交改动**（质量链中途 /clear）→ 质量没走完 → 从头重跑质量链（simplify/双轴/correctness 幂等可重跑）→ 地板 → commit → 候选 → qc → [x]。
- **有 commit 但无 `qc:done`** → 已提交（质量已过）、收尾没做完 → 补落候选 + 写 qc marker + 勾选。**不是"见 commit 就直接补勾"跳过收尾**。
- **有 `qc:done` 但无 [x]**（marker 与勾选间 /clear）→ 直接补勾。
- **有 commit + `qc:done` + [x]** → 该 ticket 完成，进下一个。
