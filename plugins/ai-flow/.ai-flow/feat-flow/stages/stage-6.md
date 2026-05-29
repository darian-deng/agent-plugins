# Stage 6：知识沉淀

> feat-flow 第 6/6 步 · [流程总览](../helper.md)
> 末步：本 stage 是流程末步
> 当前 stage 目的：让本次 flow 让项目 context 净正向——增 + 修 + 退役三类操作平衡（不是只增不减）
>
> **元规则**：禁止 git commit。写入用 git add 暂存，开发者最后自决提交。

## 目标

覆盖 4 层 context（CLAUDE.md/rules / 代码注释 / ADR / docs/feat-flows 历史）的：
- 新增（应有的）
- 修复（漂移的）
- 退役（被 supersede 的）

**关键设计**：环节 A 验证 + 候选收集，环节 B 逐条调用 `optimize-claude-context` 的 `handle-one-directive` 处理（它单工具覆盖 CLAUDE.md / rules / skills / ADR 全 4 层的路由、跨源冲突检测、写入与 ADR supersede；遇冲突 / 层分裂 / ADR 重叠当场问开发者），所有写入完成后呈现汇总表，开发者确认后结束 flow。

## 前置读取

- `docs/feat-flows/<flow_id>/design.md` — 含决策记录 + ADR 候选（grill-me 即时草拟的）
- `docs/feat-flows/<flow_id>/architecture.md`
- `docs/feat-flows/<flow_id>/plan.md`
- `docs/feat-flows/<flow_id>/task-reports.md` — **Stage 4 每 task 的 task report 累积文件**。本 stage 只取候选字段 `ADR 候选` / `新术语或模式` / `context 候选`；`注释删除` 已由 Stage 5 视角① 复核、`前置修订` 已在 Stage 4/5 当场走 revision-protocol 处理完，本 stage 不再动它们（仅作存档）
- `docs/feat-flows/<flow_id>/review.md` — 审查结论 + 待开发者决策项（供汇总报告引述「本次核心改动」，不作候选来源——Stage 5 的 context 候选已落在 context-delta.md `## Stage 5`）
- `docs/feat-flows/<flow_id>/` 全部工件

## 环节 A：验证 + 候选收集（静默，不向开发者输出）

> A2 检测到 abort 条件时例外：仅输出 abort 原因（一句话），停止，不进入 环节 B。

### A1. 解析写入根目录（monorepo 兼容）

- 列本次 flow 涉及的所有改动文件路径（`git diff $(cat .ai-flow/feat-flow/state/base_sha_code) HEAD --name-only`）
- 计算「最深公共祖先目录」
- CLAUDE.md / rules 写入对象 = **该目录**的 CLAUDE.md（不是 root，除非根才是公共祖先）

### A2. context-delta 验证

读取 `docs/feat-flows/<flow_id>/context-delta.md`，验证写入完整性：

- `## Stage 2` 节缺失 → **abort**：返回 Stage 2 执行 Context 变化捕获，写入后重新触发 S6
- `## Stage 5` 节缺失 → **abort**：返回 Stage 5 执行 Context 变化捕获，写入后重新触发 S6

### A3. 候选收集（合并去重）

从以下来源收集所有候选项，去除语义重叠的重复项：

- `task-reports.md` 每个 task 的 `ADR 候选`、`context 候选`、`新术语或模式`
- `context-delta.md` `## Stage 2` 和 `## Stage 5` 节的候选
- `design.md` 「ADR 候选」节（Stage 1 grill-me 即时草拟的）

去重规则：来源相同语义时，以措辞更完整的一条为准。

> 注意各来源的路由状态不同：`task-reports.md` 的 `context 候选` 带 Stage 4 `assess-candidate` 给的**临时目标层**（per-task、无跨源冲突检测）；`context-delta.md` 的 S2/S5 节是**无路由的扁平收集**。两者的临时路由都**只作参考**——环节 B 的 `handle-one-directive` 会做权威的跨源冲突检测 + 重新路由（这是 `assess-candidate` 与 `handle-one-directive` 的有意分工，见两者 skill reference）。故去重只比措辞完整度，不必纠结"哪条路由更准"，但去重时保留更完整一条携带的临时路由作 hint。

## 环节 B：逐条处理并呈现汇总表

对 A3 收集的每条候选项（含 `ADR 候选` 与 `context 候选 / 新术语`），调用 `optimize-claude-context` 的 `handle-one-directive`（**manual 模式**）：

> 为什么用 manual 模式而非同名的 `feat-flow` 模式：`feat-flow` 模式跳过 Step 0（拆分），要求调用方保证每条 directive 已原子化。但本 stage 的候选含 grill-me 草拟的 ADR 候选、freeform 的 context-delta 条目，**不保证原子**，需要 manual 模式的 Step 0 解析/拆分兜底。对已原子的条目 Step 0 是廉价空操作。**勿改成 feat-flow 模式。**

- `handle-one-directive` 单工具负责全 4 层：linter 检查（可机械化执行的毕业到 linter 配置，不进 context 层）→ 跨源冲突检测（扫 CLAUDE.md / rules / skills / **ADR 目录**）→ 层路由（CLAUDE.md / rules / skill / **ADR**，Priority 4 的"解释性决策理由"即落 ADR）→ 内容 enrichment → 写入文件（ADR 走 Nygard 模板 + 更新 README 索引）
- **遇到 `CONFLICT`**：当场展示给开发者（附双方内容 + 来源），等待决策后继续处理下一条
- **遇到 `LAYER SPLIT`**：当场展示选项 A/B/C，等待开发者选择后继续
- **遇到 `ADR OVERLAP DETECTED`**（ADR 候选与既有 ADR 语义重叠）：当场展示选项 A（原地更新既有 ADR）/ B（新建 ADR + 把旧的标 supersede），等待开发者选择后继续——**这是「退役 / supersede」的触发点，不可跳过**
- 每次写入后立即 `git add`

所有候选处理完毕后：
1. 在 design.md 末尾追加「Stage 6 沉淀记录」，`git add`
2. 向开发者呈现汇总表

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

**「操作」类型**：新建 ADR / 更新 ADR / supersede ADR（退役旧决策）/ 新增规则 / 更新规则 / 更新文档 / 新增路径规则 / linter 毕业（写进 linter 配置、不入 context 层）

**「改动和原因」写法**：
- 必须包含触发场景（哪个 Task 发现了什么、实施时踩了什么坑）
- 说明不知道这条知识会造成什么后果
- 不写泛泛的分类描述（「更新了命名」是无效原因，「Task 3 实施时触发 ts/dot-notation lint error，$wtFetch 等含 $ 属性名必须用点记法」才是有效原因）

## 完成条件

- A2 context-delta.md 完整性验证通过
- 环节 B 所有候选项已处理（handle-one-directive 逐条完成）
- 所有写入已 git add 暂存
- 开发者已确认汇总表
- design.md 末尾已追加「Stage 6 沉淀记录」

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**开发者明确表达本阶段已完成。
**动作**：用 Write 工具向 `.ai-flow/feat-flow/state/signal` 写入 `flow-complete`（内容必须精确匹配，引擎会校验）。

完成后向开发者报告（**精确区分已 commit / 暂存待提交**）：

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
