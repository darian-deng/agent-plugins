# Stage 6：知识沉淀

> feat-flow2 第 6/6 步 · [流程总览](../helper.md)
> 末步：本 stage 是流程末步
> 当前 stage 目的：让本次 flow 让项目 context 净正向——增 + 修 + 退役 + 归档四类操作平衡（不是 add-only）
>
> **元规则**：禁止 git commit。写入用 git add 暂存，用户最后自决提交。

## 目标

覆盖 4 层 context（CLAUDE.md/rules / 代码注释 / ADR / docs/feat-flows 历史）的：
- 新增（应有的）
- 修复（drift 的）
- 退役（被 supersede 的）
- 归档（已不需要的）

**关键设计**：Phase A 自动评估（不写文件），Phase B 分级用户确认，Phase C 写入。**写入必须显式确认**——避免笼统 yes 让低质沉淀污染项目档案。

## 前置读取

- `docs/feat-flows/<flow_id>/design.md` — 含决策记录 + Stage 1 ADR scan 结果 + ADR 候选（grill-me 即时草拟的）
- `docs/feat-flows/<flow_id>/architecture.md`
- `docs/feat-flows/<flow_id>/plan.md`
- `docs/feat-flows/<flow_id>/task-reports.md` — **Stage 4 每 task 的 task report 累积文件**，含 `ADR_CANDIDATES` / `NEW_TERMS_OR_PATTERNS` / `COMMENT_DELETIONS` / `UPSTREAM_REVISION` 等关键元信息
- `docs/feat-flows/<flow_id>/review.md` — 互审结论 + 待开发者决策项
- `docs/feat-flows/<flow_id>/` 全部工件（评估归档用）

## Phase A：自动评估（不写文件）

### A1. 解析写入根目录（monorepo 兼容）

- 列本次 flow 涉及的所有改动文件路径（`git diff $(cat .ai-flow/feat-flow2/state/base_sha_code) HEAD --name-only`）
- 计算「最深公共祖先目录」
- CLAUDE.md / rules 写入对象 = **该目录**的 CLAUDE.md（不是 root，除非根才是公共祖先）

### A2. ADR 候选评估（四闸门）

候选来源（合并去重）：
1. `design.md` 决策记录中所有决策（Stage 1 对齐的）
2. `design.md`「ADR 候选」节（Stage 1 grill-me 即时草拟的）
3. **`task-reports.md` 中每个 task 的 `ADR_CANDIDATES` 段**（Stage 4 实施过程发现的跨文件决策）

对每条候选决策跑下面四闸门：

```
gate-1 (term-anchor)：
  Q：该决策能 grep 出 ≥2 既存文件支持，且 pattern 在 CLAUDE.md / rules/ 已被命名？
  YES → 跳过 ADR（已被代码 + 命名覆盖）
  NO  → 进 gate-2

gate-2 (三条件)：
  1. 难以反转
  2. 无上下文会让人困惑
  3. 真 trade-off（存在 alternative 且有理由选择）
  全 YES → 进 gate-2.5
  任一 NO → 跳过

gate-2.5 (placement: comment vs ADR)：
  Q：决策的"为什么"能用以下任一形式说清楚吗？
     a. 某一处具体代码位置的 inline 注释（≤5 行）
     b. 文件顶部的 file-level 注释（涉及该文件整体目的/组织时）
  YES → 在对应位置写注释，不写 ADR
  NO（跨文件 / 跨模块 / 涉及架构层级决策） → 进 gate-3

gate-3 (冲突 + supersede 检测)：
  - grep docs/adr/ 检查是否覆写既有 ADR
    → YES：起草 new ADR 标 "Supersedes ADR-NNNN" + why-changed
    → NO：起草 new ADR
  - grep 新 ADR 关键术语命中的其它 ADR
    → 列给用户判断是否冲突（仅提示不自动判定）
```

### A3. CLAUDE.md drift 评估（含 bootstrap）

- `test -f <写入根目录>/CLAUDE.md`
- **存在** → 调用 `claude-md-management:revise-claude-md` skill（仅扫不写，先评估）
- **不存在**：
  - 本次 flow 有 rule 候选 → 用 claude-md-management 初始化 + 写本次候选（用户确认）
  - 本次无候选 → 跳过

### A4. NEW_TERMS_OR_PATTERNS 收集 + 跨目录冲突检测

- 从 `task-reports.md` 每个 task 的 `NEW_TERMS_OR_PATTERNS` 段收集（不依赖主 session 对话历史）
- 评估哪些进 rules：「未来 ≥2 task 会重复 + 没 rule 时 AI 默认走错」
- monorepo 跨目录检查：`grep -r "<term>" rules/` 命中多处时提示用户

### A5. rules 体积反向闸门

- 涉及目录的 `rules/*.md` 体积 >300 行 → 跳过本次写入，建议运行 `improve-codebase-architecture` 重整

### A6. 工件归档评估

- 列 `docs/feat-flows/<flow_id>/` 工件
- 含 supersede 候选的 design.md → 保留作历史依据
- 普通 plan.md / review.md → 建议移到 `docs/feat-flows/archive/<flow_id>/`

## Phase B：分级用户确认

呈现 Phase A 评估结果分两 tier 确认（避免笼统 yes）：

### Tier-A（必须逐项确认 yes/no）
- 新建 ADR（每条单独 yes/no）
- CLAUDE.md 直接写入（每条 diff 展示 yes/no）
- Supersede 既有 ADR（高风险，必须明示）
- ADR 关键术语命中其他 ADR 的冲突提示（用户判断）

### Tier-B（批量确认带 diff）
- rules/<domain>.md 追加术语
- 工件归档（一句话清单）

## Phase C：写入

按用户确认结果应用：

- **新 ADR** → 调用 `/ai-flow:adr` skill（new 路径），它会自动分配编号 + 更新索引
- **CLAUDE.md** → 调用 `claude-md-management:revise-claude-md` skill
- **Supersede** → 调用 `/ai-flow:adr` skill（supersede 路径），双向链接
- **rules 术语追加** → 直接编辑对应 rules 文件
- **归档** → `git mv docs/feat-flows/<flow_id>/plan.md docs/feat-flows/archive/<flow_id>/plan.md` 等

所有写入用 `git add` 暂存，**不 commit**（用户最后自决提交）。

## 完成条件

- Phase A 6 项全跑完
- Phase B 用户对所有候选明确响应
- Phase C 已写入所有 yes 项（git add 暂存）
- design.md 末尾追加「Stage 6 沉淀记录」：列每条候选 + 用户决定 + 实际操作

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**用户明确表达本阶段已完成。
**动作**：用 Write 工具向 `.ai-flow/feat-flow2/state/signal` 写入任意内容。

完成后向用户报告（**精确区分已 commit / 暂存待提交**）：

```
feat-flow2 流程完成。

📋 本次核心改动：[3-5 条主要变更]
🧪 建议人工测试：[条件性——若 design.md AC 中有 [manual] 项，列对应场景；全部 [auto] 则跳过此行]
📚 知识沉淀：[新建 N 个 ADR / 更新 CLAUDE.md / rules / 归档 X 工件]

代码与修复（Stage 4-5）：已 commit
  → 用 `git log <BASE_SHA_CODE>..HEAD` 看 commit 列表
  → 用 `git show <commit>` 单看某 task

知识沉淀（Stage 6）：用 git add 暂存，未 commit
  → 用 `git diff --cached` 看本 stage 写入了什么
  → 审阅后按团队流程手动 commit + push
```

注：`BASE_SHA_CODE` 在 `.ai-flow/feat-flow2/state/base_sha_code` 文件中。
