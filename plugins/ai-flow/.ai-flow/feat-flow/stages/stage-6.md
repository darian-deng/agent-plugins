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

**关键设计**：Phase A 静默自动评估，Phase B 直接执行所有写入并呈现汇总表，用户确认后归档并结束 flow。

## 前置读取

- `docs/feat-flows/<flow_id>/design.md` — 含决策记录 + Stage 1 ADR scan 结果 + ADR 候选（grill-me 即时草拟的）
- `docs/feat-flows/<flow_id>/architecture.md`
- `docs/feat-flows/<flow_id>/plan.md`
- `docs/feat-flows/<flow_id>/task-reports.md` — **Stage 4 每 task 的 task report 累积文件**，含 `ADR_CANDIDATES` / `NEW_TERMS_OR_PATTERNS` / `CONTEXT_CANDIDATES` / `COMMENT_DELETIONS` / `UPSTREAM_REVISION` 等关键元信息
- `docs/feat-flows/<flow_id>/review.md` — 互审结论 + 待开发者决策项
- `docs/feat-flows/<flow_id>/` 全部工件（评估归档用）

## Phase A：自动评估（不写文件，不向用户输出）

> **内部分析阶段**：全程禁止向用户输出任何内容，分析结果仅内部保留，通过 Phase B 汇总表呈现。
> （例外：A2 检测到 abort 条件时，仅输出 abort 原因（一句话），不得附带 Phase A 其余分析内容，然后停止，不进入 Phase B。）

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

gate-3 (现有 ADR 检测)：
  - grep docs/adr/ 检查是否有语义重叠的现有 ADR
    → YES：**直接更新该 ADR（in-place）**
           git 已保障历史记录，不需要新建 supersede 链积累噪音
           在更新内容中记录变更背景（what changed and why）
    → NO：起草新 ADR（Nygard 模板）
  - grep 新决策/更新内容关键术语命中的其他 ADR
    → 列入 Phase B 汇总表「⚠️ 仅供参考」行（无需用户回复）
```

### A4. CLAUDE.md / path rule / skill 候选整理

候选来源（合并去重）：

1. `context-delta.md` `## Stage 2` 和 `## Stage 5` 节的 CLAUDE.md candidates 和 Path rule candidates（routing 已确定，无需重新路由）
2. **`task-reports.md` 中每个 task 的 `CONTEXT_CANDIDATES` 段**（Stage 4 实施过程中「注释无法承载」的知识，按目标层已标注）

**写入前检查**：对每条 CLAUDE.md 候选，先 grep `.claude/rules/*.md` 确认无语义重叠。若已有 path-rule 覆盖相同范围 → 将内容 merge 到该 path-rule，不写 CLAUDE.md（避免同一条知识在两处重复）。

各类候选处理方式：
- CLAUDE.md 类 → 调用 `optimize-claude-context` handle-one-directive（feat-flow mode，Step 1+）写入
- rules/<domain>.md 类 → 同上
- skill 类 → 同上，产出 stub 后通知用户用 skill-creator 完善

去重：与 context-delta.md 候选语义重叠的 CONTEXT_CANDIDATES 条目合并，以 context-delta.md 来源措辞为准。

### A5. NEW_TERMS_OR_PATTERNS 评估

从 `task-reports.md` 收集所有 `NEW_TERMS_OR_PATTERNS` 段。对每条调用 `optimize-claude-context` 的 `handle-one-directive` 命令（manual mode），传入该术语的自然语言描述，handle-one-directive 跑 Step 0-3 产出路由提案（CLAUDE.md / path-rule:\<glob\> / skill / deprecated）。

去重：与 A4 候选语义重叠的条目合并，以 context-delta.md 来源措辞为准（S2/S5 分类时 routing 上下文更完整）。

### A6. 工件归档评估

- 列 `docs/feat-flows/<flow_id>/` 工件
- 含 ADR 历史依据的 design.md → 保留；Phase B 步骤 3 负责在其末尾追加「Stage 6 沉淀记录」
- 普通 plan.md / review.md / architecture.md / task-reports.md → 归档到 `docs/feat-flows/archive/<flow_id>/`（仅当文件实际存在时）
- `context-delta.md` → 归档到 `docs/feat-flows/archive/<flow_id>/context-delta.md`（仅当文件实际存在时）

> Phase A 结束。进入 Phase B 前不得向用户输出任何分析内容。（A2 abort 条件已在上方处理。）

## Phase B：执行并呈现汇总表

Phase A 分析完成后，**直接执行所有知识写入**（不等用户逐项确认），用 git add 暂存，然后向用户呈现汇总表。

### 执行顺序

**归档不在此阶段执行**，Phase C 负责。下面四步均不包含 git mv 归档操作：

1. 调用 `optimize-claude-context` handle-one-directive（feat-flow mode）写入所有 CLAUDE.md / rules / skill 候选
2. 更新或新建 ADR（调用 `adr-manage` skill）
3. 在 design.md 末尾追加「Stage 6 沉淀记录」
4. 所有写入 `git add` 暂存，**不 commit**

### 汇总表格式（严格遵守）

```
Stage 6 知识沉淀完成。所有改动已 git add 暂存，未 commit。

| 操作 | 文件 | 改动和原因 |
|------|------|----------|
| [操作类型] | [文件路径] | [触发场景 + 为什么需要写入，包含具体 Task / 发现 / 不知道会踩什么坑] |

⚠️ 仅供参考（无需回复）
- [ADR 关键术语冲突提示，简述潜在冲突]

查看所有改动：git diff --cached
撤回某文件：git restore --staged <路径>

确认无误后告知，归档将自动执行并结束 feat-flow。
```

**「操作」类型**：新建 ADR / 更新 ADR / 新增规则 / 更新规则 / 更新文档 / 新增路径规则

**「改动和原因」写法**：
- 必须包含触发场景（哪个 Task 发现了什么、实施时踩了什么坑）
- 说明不知道这条知识会造成什么后果
- 不写泛泛的分类描述（「更新了命名」是无效原因，「Task 3 实施时触发 ts/dot-notation lint error，$wtFetch 等含 $ 属性名必须用点记法」才是有效原因）

**归档不出现在表格中**：归档是 flow 结束时的机械收尾，在用户确认后自动执行。

## Phase C：用户确认后执行归档

用户确认汇总表无误后，自动执行工件归档。**以 A6 实际列出的文件为准，不存在的文件跳过，不执行 git mv：**

```sh
# 逐一检查文件是否存在，存在则 git mv
git mv docs/feat-flows/<flow_id>/architecture.md  docs/feat-flows/archive/<flow_id>/architecture.md
git mv docs/feat-flows/<flow_id>/plan.md          docs/feat-flows/archive/<flow_id>/plan.md
git mv docs/feat-flows/<flow_id>/review.md        docs/feat-flows/archive/<flow_id>/review.md
git mv docs/feat-flows/<flow_id>/task-reports.md  docs/feat-flows/archive/<flow_id>/task-reports.md
git mv docs/feat-flows/<flow_id>/context-delta.md docs/feat-flows/archive/<flow_id>/context-delta.md
```

（design.md 保留——含 ADR 历史依据及 Stage 6 沉淀记录）

git add 所有归档操作，然后写入 signal。

## 完成条件

- Phase A 6 项全跑完（含 A2 context-delta.md 完整性验证通过）
- Phase B 所有写入已执行并 git add 暂存
- 用户已确认汇总表
- Phase C 归档已执行并 git add 暂存
- design.md 末尾已追加「Stage 6 沉淀记录」

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**用户明确表达本阶段已完成。
**动作**：用 Write 工具向 `.ai-flow/feat-flow/state/signal` 写入任意内容。

完成后向用户报告（**精确区分已 commit / 暂存待提交**）：

```
feat-flow 流程完成。

📋 本次核心改动：[3-5 条主要变更]
🧪 建议人工测试：[条件性——若 design.md AC 中有 [manual] 项，列对应场景；全部 [auto] 则跳过此行]
📚 知识沉淀：[更新 N 个 ADR / 新增规则 / 归档 X 工件]

代码与修复（Stage 4-5）：已 commit
  → 用 `git log <BASE_SHA_CODE>..HEAD` 看 commit 列表
  → 用 `git show <commit>` 单看某 task

知识沉淀（Stage 6）：用 git add 暂存，未 commit
  → 用 `git diff --cached` 看本 stage 写入了什么
  → 审阅后按团队流程手动 commit + push
```

注：`BASE_SHA_CODE` 在 `.ai-flow/feat-flow/state/base_sha_code` 文件中。
