# Stage 4：代码实施

> feat-flow2 第 4/6 步 · [流程总览](../helper.md)
> 后续：Stage 5 质量门（Gate）
> 当前 stage 目的：按 plan.md 逐 task 实施，每 task 一 commit，全部由 subagent 完成
>
> **元规则**：起点 commit 一次 docs（Stage 1-3 产物）；每 task 一个 commit。除此之外不主动 commit。

## 目标

直接 invoke `superpowers:subagent-driven-development` skill 执行 plan.md。主 session 是调度者，不直接写代码。

## 前置读取

- `docs/feat-flows/<flow_id>/design.md`
- `docs/feat-flows/<flow_id>/architecture.md`
- `docs/feat-flows/<flow_id>/plan.md`

主 session 必须读完三份文档再进入 SDD——因为后续 dispatch 每个 implementer 时要主动构造 Curated Sources。

## 入场动作

**Step 0：Stage 4 起点 commit + 记录 BASE_SHA_CODE**

```sh
git add docs/feat-flows/<flow_id>/
git commit -m "docs: <feature> stage1-3 outputs"
git rev-parse HEAD > .ai-flow/feat-flow2/state/base_sha_code
```

这个 commit 把 stage 1-3 累积的 docs 一次性提交。`base_sha_code` 文件供 Stage 5 用作 diff 起点（只看代码改动，不看 docs）。

**Step 1：ADR scan**

`ls docs/adr/` + 筛与本 flow 涉及模块相关的 ADR 路径列表，作为后续 implementer Context 注入。

## 主循环：调用 SDD

调用 `superpowers:subagent-driven-development` 执行 `docs/feat-flows/<flow_id>/plan.md`。

**对 SDD 默认 implementer-prompt 的修改**（基于我们的三工件拓扑）：

每个 task 的 implementer prompt 改为含以下 Curated Sources（subagent 按需读，不批量加载）：

- 本 task 完整文本（paste-in plan.md 对应段）
- `docs/feat-flows/<flow_id>/design.md`
- `docs/feat-flows/<flow_id>/architecture.md`
- `docs/feat-flows/<flow_id>/plan.md`（**仅前后 task 上下文用，禁止跨 task 拿活**）
- 相关 ADR 路径列表（来自 Step 1）
- **Pending vocabulary**：前置 task 累积的 NEW_TERMS_OR_PATTERNS（主 session 每次 dispatch 重新组装）
- 提示：`git log` / `git show <commit>` 看前置 task 已实现细节

**Focus 约束**（写进 implementer prompt）：
- 专注本 task，不探索本 task 范围外的代码或议题
- 优先按 task 描述里的 file:line 直读，不读整个文件
- 用 git show 看前置 task diff，不读整个文件

**本 task 实施要求**：
- 走 TDD（若 plan task 标注要走）
- 实施完成后跑**全量单元测试**（design.md 项目命令.单元测试），不仅本 task 新写的测试
- 既有单测 break：默认假设是 regression，修代码而非改测试
- 极少数情况认为测试在测 implementation detail → DONE_WITH_CONCERNS 附建议改测试的理由（必须复核）
- **不跑** lint / typecheck / 集成测试（Stage 5 职责）
- 局部决策（≤5 行 inline 注释或 file-level top 注释能说清的 why）必须在代码位置加注释——不要积到 Stage 6 评 ADR
- 删注释 ≥3 行必须在 task report 写理由

**task report 额外字段**（在 SDD 默认 DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT 基础上）：
- `INLINE_COMMENTS_ADDED`：在哪些代码位置加了 WHY 注释
- `NEW_TERMS_OR_PATTERNS`：本 task 引入的术语候选（如 "LRUEvictionPolicy"），建议进 rules
- `ADR_CANDIDATES`：跨文件性质的决策候选（建议 Stage 6 评 ADR）
- `COMMENT_DELETIONS`：删除注释 ≥3 行的位置 + 理由

## NEEDS_CONTEXT 处理（严于 SDD 默认）

implementer 报 NEEDS_CONTEXT 时主 session：

1. 检查问题答案是否在三份 docs / 相关 ADR 列表里
2. **在** → 改 implementer prompt 加更明确指向，重 dispatch 一次。仍 NEEDS_CONTEXT → 停下问开发者
3. **不在** → 直接停下问开发者，**不允许凭空补答案**

理由：主 session 的信息源就是这些 docs。subagent 读了还问 = 文档真缺信息 = 主 session 也编不出。

## BLOCKED 处理

按 SDD 规则尝试一次（补 context / 换模型 / 拆 task / plan 错 → escalate）。第 2 次同一 task BLOCKED → 停下问开发者。

## Pending vocabulary 注入

主 session 在 dispatch 第 N 个 task 时，把已完成 task 的 NEW_TERMS_OR_PATTERNS 段**合并**起来，作为 Curated Sources 的「Pending vocabulary（未正式入 rules）」注入下一个 implementer。这样后续 task 能看到前面 task 沉淀的新术语，避免命名漂移。

## 输出规格

- plan.md 中所有 task 标 `[x]`
- 每 task 对应一个 commit
- `.ai-flow/feat-flow2/state/base_sha_code` 文件存在
- task report 的 ADR_CANDIDATES / NEW_TERMS_OR_PATTERNS / COMMENT_DELETIONS 累积到主 session（Stage 6 用）

## 完成条件

- plan.md 所有 task 标 `[x]`
- `base_sha_code` 文件存在
- 全部 task 都有对应 commit
- SDD final reviewer pass（SDD 自带最后审查）

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**用户明确表达本阶段已完成。
**动作**：用 Write 工具向 `.ai-flow/feat-flow2/state/signal` 写入任意内容。
