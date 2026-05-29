# Stage 6：知识沉淀

> feat-flow 第 6/6 步 · [流程总览](../helper.md)
> 末步：本 stage 是流程末步
> 当前 stage 目的：让本次 flow 让项目 context 净正向——增 + 修 + 退役三类操作平衡（不是 add-only）
>
> **元规则**：禁止 git commit。写入用 git add 暂存，用户最后自决提交。

## 目标

覆盖 4 层 context（CLAUDE.md/rules / 代码注释 / ADR / docs/feat-flows 历史）的：
- 新增（应有的）
- 修复（drift 的）
- 退役（被 supersede 的）

**关键设计**：Phase A 验证 + 候选收集，Phase B 逐条调用 `optimize-claude-context` 处理（遇冲突当场问用户），所有写入完成后呈现汇总表，用户确认后结束 flow。

## 前置读取

- `docs/feat-flows/<flow_id>/design.md` — 含决策记录 + Stage 1 ADR scan 结果 + ADR 候选（grill-me 即时草拟的）
- `docs/feat-flows/<flow_id>/architecture.md`
- `docs/feat-flows/<flow_id>/plan.md`
- `docs/feat-flows/<flow_id>/task-reports.md` — **Stage 4 每 task 的 task report 累积文件**，含 `ADR_CANDIDATES` / `NEW_TERMS_OR_PATTERNS` / `CONTEXT_CANDIDATES` / `COMMENT_DELETIONS` / `UPSTREAM_REVISION` 等关键元信息
- `docs/feat-flows/<flow_id>/review.md` — 互审结论 + 待开发者决策项
- `docs/feat-flows/<flow_id>/` 全部工件

## Phase A：验证 + 候选收集（静默，不向用户输出）

> A2 检测到 abort 条件时例外：仅输出 abort 原因（一句话），停止，不进入 Phase B。

### A1. 解析写入根目录（monorepo 兼容）

- 列本次 flow 涉及的所有改动文件路径（`git diff $(cat .ai-flow/feat-flow/state/base_sha_code) HEAD --name-only`）
- 计算「最深公共祖先目录」
- CLAUDE.md / rules 写入对象 = **该目录**的 CLAUDE.md（不是 root，除非根才是公共祖先）

### A2. Context Delta 验证

读取 `docs/feat-flows/<flow_id>/context-delta.md`，验证写入完整性：

- `## Stage 2` 节缺失 → **abort**：返回 Stage 2 执行 Context Delta Capture，写入后重新触发 S6
- `## Stage 5` 节缺失 → **abort**：返回 Stage 5 执行 Context Delta Capture，写入后重新触发 S6

### A3. 候选收集（合并去重）

从以下来源收集所有候选项，去除语义重叠的重复项：

- `task-reports.md` 每个 task 的 `ADR_CANDIDATES`、`CONTEXT_CANDIDATES`、`NEW_TERMS_OR_PATTERNS`
- `context-delta.md` `## Stage 2` 和 `## Stage 5` 节的候选
- `design.md` 「ADR 候选」节（Stage 1 grill-me 即时草拟的）

去重规则：来源相同语义时，以 context-delta.md 的措辞为准（S2/S5 收集时路由上下文更完整）。

## Phase B：逐条处理并呈现汇总表

对 A3 收集的每条候选项，调用 `optimize-claude-context`（manual 模式）：

- `handle-one-directive` 负责：linter 检查 → 冲突检测 → 层路由 → 内容 enrichment → 写入文件
- **遇到 CONFLICT**：当场展示给用户（附双方内容 + 来源），等待决策后继续处理下一条
- **遇到 LAYER SPLIT**：当场展示选项 A/B/C，等待用户选择后继续
- 每次写入后立即 `git add`

所有候选处理完毕后：
1. 在 design.md 末尾追加「Stage 6 沉淀记录」，`git add`
2. 向用户呈现汇总表

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

确认无误后告知，flow 将结束。
```

**「操作」类型**：新建 ADR / 更新 ADR / 新增规则 / 更新规则 / 更新文档 / 新增路径规则

**「改动和原因」写法**：
- 必须包含触发场景（哪个 Task 发现了什么、实施时踩了什么坑）
- 说明不知道这条知识会造成什么后果
- 不写泛泛的分类描述（「更新了命名」是无效原因，「Task 3 实施时触发 ts/dot-notation lint error，$wtFetch 等含 $ 属性名必须用点记法」才是有效原因）

## 完成条件

- A2 context-delta.md 完整性验证通过
- Phase B 所有候选项已处理（handle-one-directive 逐条完成）
- 所有写入已 git add 暂存
- 用户已确认汇总表
- design.md 末尾已追加「Stage 6 沉淀记录」

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**用户明确表达本阶段已完成。
**动作**：用 Write 工具向 `.ai-flow/feat-flow/state/signal` 写入 `flow-complete`（内容必须精确匹配，引擎会校验）。
**写入后**：引擎立即完成整个 flow，无需用户 approve。

完成后向用户报告（**精确区分已 commit / 暂存待提交**）：

```
feat-flow 流程完成。

📋 本次核心改动：[3-5 条主要变更]
🧪 建议人工测试：[条件性——若 design.md AC 中有 [manual] 项，列对应场景；全部 [auto] 则跳过此行]
📚 知识沉淀：[更新 N 个 ADR / 新增规则]

代码与修复（Stage 4-5）：已 commit
  → 用 `git log <BASE_SHA_CODE>..HEAD` 看 commit 列表
  → 用 `git show <commit>` 单看某 task

知识沉淀（Stage 6）：用 git add 暂存，未 commit
  → 用 `git diff --cached` 看本 stage 写入了什么
  → 审阅后按团队流程手动 commit + push
```

注：`BASE_SHA_CODE` 在 `.ai-flow/feat-flow/state/base_sha_code` 文件中。
