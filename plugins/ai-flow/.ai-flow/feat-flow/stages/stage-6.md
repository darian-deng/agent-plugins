# Stage 6：知识沉淀

> feat-flow 第 6/6 步 · [流程总览](../helper.md)
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

- 列本次 flow 涉及的所有改动文件路径（`git diff $(cat .ai-flow/feat-flow/state/base_sha_code) HEAD --name-only`）
- 计算「最深公共祖先目录」
- CLAUDE.md / rules 写入对象 = **该目录**的 CLAUDE.md（不是 root，除非根才是公共祖先）

### A2. Context Delta 验证

读取 `docs/feat-flows/<flow_id>/context-delta.md`，验证写入完整性：

- `## Stage 2` 节存在 → 继续
- `## Stage 2` 节缺失 → **abort**：返回 Stage 2 执行 Context Delta Capture，写入后重新触发 S6（无需重走 Gate，直接续 Phase A）
- `## Stage 5` 节存在 → 继续
- `## Stage 5` 节缺失 → **abort**：返回 Stage 5 执行 Context Delta Capture（即使无候选也必须写此节），写入后重新触发 S6

### A3. ADR 候选评估（四闸门）

候选来源（合并去重）：
1. `design.md`「ADR 候选」节（Stage 1 grill-me 即时草拟的）
2. `context-delta.md` `## Stage 2` 节的 ADR candidates
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

### A4. CLAUDE.md / path rule 候选整理

读取 `context-delta.md` `## Stage 2` 和 `## Stage 5` 节的 CLAUDE.md candidates 和 Path rule candidates：

- CLAUDE.md candidates → 进 Phase B Tier-A（逐项展示 diff，yes/no）
- Path rule candidates → 进 Phase B Tier-B（批量确认带 diff）

Routing 已在 S2/S5 确定，无需重新路由决策。

### A5. NEW_TERMS_OR_PATTERNS 评估

从 `task-reports.md` 收集所有 `NEW_TERMS_OR_PATTERNS` 段。对每条调用 `optimize-claude-context` 的 `handle-one-directive` 命令（manual mode），传入该术语的自然语言描述，handle-one-directive 跑 Step 0-3 产出路由提案（CLAUDE.md / path-rule:\<glob\> / skill / deprecated）。

去重：与 A4 候选语义重叠的条目合并，以 context-delta.md 来源措辞为准（S2/S5 分类时 routing 上下文更完整）。

产出：路由提案清单，进 Phase B 确认。

### A6. 工件归档评估

- 列 `docs/feat-flows/<flow_id>/` 工件
- 含 supersede 候选的 design.md → 保留作历史依据
- 普通 plan.md / review.md → 建议移到 `docs/feat-flows/archive/<flow_id>/`
- `context-delta.md` → 归档到 `docs/feat-flows/archive/<flow_id>/context-delta.md`（作为规则引入决策溯源文档）

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

- **新 ADR** → 调用 `adr-manage` skill（自然语言意图："新建 ADR，内容是 <填决策内容>"），skill 自动分配编号 + Nygard 模板 + 更新索引
- **CLAUDE.md / path rule 写入** → 对每条已确认条目，调用 `optimize-claude-context` 的 `handle-one-directive` 命令（**feat-flow mode**，从 Step 1 开始，跳过 Step 0），传入 directive 文本 + 预分类的 scope + target layer：
  - Steps 1-3 仍会执行（linter check、现有 directive 冲突检查、routing）；Step 3 路由结论应与 context-delta.md / A5 预分类一致，若不一致以 handle-one-directive 路由结果为准
  - A4 来源（context-delta.md）和 A5 来源均适用此模式
- **Supersede ADR** → 调用 `adr-manage` skill（自然语言意图："supersede ADR-NNNN，新决策是 <内容>"），skill 自动双向链接
- **归档** → `git mv docs/feat-flows/<flow_id>/plan.md docs/feat-flows/archive/<flow_id>/plan.md` 等
- **context-delta.md 归档** → `git mv docs/feat-flows/<flow_id>/context-delta.md docs/feat-flows/archive/<flow_id>/context-delta.md`

所有写入用 `git add` 暂存，**不 commit**（用户最后自决提交）。

## 完成条件

- Phase A 6 项全跑完（含 A2 context-delta.md 完整性验证通过）
- Phase B 用户对所有候选明确响应
- Phase C 已写入所有 yes 项（git add 暂存）
- context-delta.md 已归档到 `docs/feat-flows/archive/<flow_id>/`（git add 暂存）
- design.md 末尾追加「Stage 6 沉淀记录」：列每条候选 + 用户决定 + 实际操作

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**用户明确表达本阶段已完成。
**动作**：用 Write 工具向 `.ai-flow/feat-flow/state/signal` 写入任意内容。

完成后向用户报告（**精确区分已 commit / 暂存待提交**）：

```
feat-flow 流程完成。

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

注：`BASE_SHA_CODE` 在 `.ai-flow/feat-flow/state/base_sha_code` 文件中。
