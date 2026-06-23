# Stage 6：知识沉淀

> feat-flow 第 6/6 步 · [流程总览](../helper.md)
> 末步：本 stage 是流程末步
> 当前 stage 目的：让本次 flow 让项目 context 净正向——增 + 修 + 退役三类操作平衡（不是只增不减）
>
> **元规则**：环节 B 期间只写文件不 commit（先让开发者审）；待开发者 `feat-flow approve` 后，把知识沉淀 amend 进 stage-5 那笔 `feat:` 提交（整个 flow 仍是单个 commit，`flow-squash` 锚点保留），只 commit 不 push。

## 目标

覆盖 4 层 context（CLAUDE.md/rules / 代码注释 / ADR / docs/feat-flows 历史）的：
- 新增（应有的）
- 修复（漂移的）
- 退役（被 supersede 的）

**关键设计**：环节 A 验证 + 候选收集，环节 B 逐条调用 `optimize-claude-context` 的 `handle-one-directive` 处理（它单工具覆盖 CLAUDE.md / rules / skills / ADR 全 4 层的路由、跨源冲突检测、写入与 ADR supersede；遇冲突 / 层分裂 / ADR 重叠当场问开发者），所有写入完成后呈现汇总表，开发者确认后结束 flow。

## 前置读取

- `{{project_root}}/docs/feat-flows/<flow_id>/design.md` — 含决策记录 + ADR 候选（Stage 1 问询中即时草拟的）
- `{{project_root}}/docs/feat-flows/<flow_id>/architecture.md`
- `{{project_root}}/docs/feat-flows/<flow_id>/plan.md`
- `{{project_root}}/docs/feat-flows/<flow_id>/task-reports.md` — **Stage 4 每 task 的 task report 累积文件**。本 stage 只取候选字段 `ADR 候选` / `新术语或模式` / `context 候选`；`前置修订` 已在 Stage 4/5 当场走 revision-protocol 处理完，本 stage 不再动它（仅作存档）
- `{{project_root}}/docs/feat-flows/<flow_id>/review.md` — 审查结论 + 待开发者决策项（供汇总报告引述「本次核心改动」，不作候选来源——Stage 5 的 context 候选已落在 context-delta.md `## Stage 5`）
- `{{project_root}}/docs/feat-flows/<flow_id>/` 全部工件

## 环节 A：验证 + 候选收集（静默，不向开发者输出）

> A2 检测到 abort 条件时例外：仅输出 abort 原因（一句话），停止，不进入 环节 B。

### A0. 确认代码已 squash（只读校验前置）

代码的 squash 已在 stage-5 环节 C 结尾完成——HEAD 是单个 `feat:` 提交，body 末行带 `flow-squash: <flow_id>` 锚点。进入 stage-6 第一步只读校验这一前置，**环节 B 期间不做任何 reset / commit**；知识沉淀的提交（amend 进这笔 feat）发生在开发者 approve 之后（见 Signal 段）：

```bash
git log -1 --format=%B | grep -q "flow-squash: <flow_id>" || { echo "ERROR: HEAD 无 flow-squash 锚点 — stage-5 未完成 squash，回 stage-5 环节 C 收尾后再进 stage-6"; exit 1; }
```

校验通过后，`base_sha_code..HEAD` 即那一笔 feat 提交，后续 A1 / A3 据此读改动。**环节 B 只写文件不 commit；approve 后再 amend 进这笔 feat。**

### A1. 解析写入根目录（monorepo 兼容）

- 列本次 flow 涉及的所有改动文件路径：
  ```bash
  BASE_SHA="<注入的 base_sha_code 值>"   # = 引擎 [ai-flow:paths] 块里的 base_sha_code
  [ -z "$BASE_SHA" ] || [ "$BASE_SHA" = "<注入的 base_sha_code 值>" ] && { echo "ERROR: base_sha_code 缺失，回 Stage 4 重写 mark-base 重新捕获"; exit 1; }
  git diff "$BASE_SHA" HEAD --name-only
  ```
- 计算「最深公共祖先目录」
- CLAUDE.md / rules 写入对象 = **该目录**的 CLAUDE.md（不是 root，除非根才是公共祖先）

### A2. context-delta 验证

读取 `{{project_root}}/docs/feat-flows/<flow_id>/context-delta.md`，验证写入完整性：

- `## Stage 2` 节缺失 → **abort**：返回 Stage 2 执行 Context 变化捕获，写入后重新触发 S6
- `## Stage 5` 节缺失 → **abort**：返回 Stage 5 执行 Context 变化捕获，写入后重新触发 S6

### A3. 候选收集（合并去重）

从以下来源收集所有候选项，去除语义重叠的重复项：

- `task-reports.md` 每个 task 的 `ADR 候选`、`context 候选`、`新术语或模式`
- `context-delta.md` `## Stage 2` 和 `## Stage 5` 节的候选
- `design.md` 「ADR 候选」节（Stage 1 问询中即时草拟的）

去重规则：来源相同语义时，以措辞更完整的一条为准。

> 各来源路由状态不同：`task-reports.md`（Stage 4）和 `context-delta.md` 的 `## Stage 5` 节都带 `assess-candidate` 的**临时目标层 hint**（都在代码里跑过源头过滤，到这里的是幸存者）；只有 `## Stage 2` 节是**无路由的扁平收集**（Stage 2 无代码，assess-candidate 不适用）。临时 hint **只作参考**——环节 B 的 `handle-one-directive` 做权威的跨源冲突检测 + 重新路由。故去重只比措辞完整度，保留更完整一条的 hint。

## 环节 B：逐条处理并呈现汇总表

对 A3 收集的每条候选项（含 `ADR 候选` 与 `context 候选 / 新术语`），调用 `optimize-claude-context` 的 `handle-one-directive`（**manual 模式**）：

> 为什么用 manual 模式而非同名的 `feat-flow` 模式：`feat-flow` 模式跳过 Step 0（拆分），要求调用方保证每条 directive 已原子化。但本 stage 的候选含 Stage 1 草拟的 ADR 候选、freeform 的 context-delta 条目，**不保证原子**，需要 manual 模式的 Step 0 解析/拆分兜底。对已原子的条目 Step 0 是廉价空操作。**勿改成 feat-flow 模式。**

- `handle-one-directive` 单工具负责全 4 层：linter 检查（可机械化执行的毕业到 linter 配置，不进 context 层）→ 跨源冲突检测（扫 CLAUDE.md / rules / skills / **ADR 目录**）→ 层路由（CLAUDE.md / rules / skill / **ADR**，Priority 4 的"解释性决策理由"即落 ADR）→ 内容 enrichment → 写入文件（ADR 走 Nygard 模板 + 更新 README 索引）
- **写入内容必须自包含**：候选措辞若带 `Task N` / `U<k>` / `Phase X` / 「本次」等临时指代，enrichment 时**展开成实质内容**再写入。汇总表的「改动和原因」不受此限（呈现给开发者、可就地解析）。
- **遇到 `CONFLICT`**：当场展示给开发者（附双方内容 + 来源），等待决策后继续处理下一条
- **遇到 `LAYER SPLIT`**：当场展示选项 A/B/C，等待开发者选择后继续
- **遇到 `ADR OVERLAP DETECTED`**（ADR 候选与既有 ADR 语义重叠）：当场展示选项 A（原地更新既有 ADR）/ B（新建 ADR + 把旧的标 supersede），等待开发者选择后继续——**这是「退役 / supersede」的触发点，不可跳过**

所有候选处理完毕后：
1. 在 design.md 末尾追加「Stage 6 沉淀记录」
2. 向开发者呈现汇总表

### 汇总表格式（严格遵守）

```
Stage 6 知识沉淀完成。所有写入已完成，approve 后将 amend 进本次 feat 提交。

| 操作 | 文件 | 改动和原因 |
|------|------|----------|
| [操作类型] | [文件路径] | [触发场景 + 为什么需要写入，包含具体 Task / 发现 / 不知道会踩什么坑] |

⚠️ 仅供参考（无需回复）
- [ADR 关键术语冲突提示，简述潜在冲突]

查看本次知识沉淀写入：git diff HEAD
撤回某文件：git restore <路径>（approve 后该文件不进提交）

确认无误后执行 `feat-flow approve`——知识沉淀会 amend 进本次 feat 提交，流程结束。
```

**「操作」类型**：新建 ADR / 更新 ADR / supersede ADR（退役旧决策）/ 新增规则 / 更新规则 / 更新文档 / 新增路径规则 / linter 毕业（写进 linter 配置、不入 context 层）

**「改动和原因」写法**：
- 必须包含触发场景（哪个 Task 发现了什么、实施时踩了什么坑）
- 说明不知道这条知识会造成什么后果
- 不写泛泛的分类描述（「更新了命名」是无效原因，「Task 3 实施时触发 ts/dot-notation lint error，$wtFetch 等含 $ 属性名必须用点记法」才是有效原因）

## 完成条件

- A0 只读校验通过：HEAD 为 stage-5 squash 的单个 `feat:` 提交（带 `flow-squash` 锚点）
- A2 context-delta.md 完整性验证通过
- 环节 B 所有候选项已处理（handle-one-directive 逐条完成）
- 所有知识沉淀写入已完成（环节 B 内不 commit；approve 后 amend 进 feat 提交）
- design.md 末尾已追加「Stage 6 沉淀记录」
- 汇总表已呈现给开发者（作为 gate 呈现）

## Signal

**触发条件**：上述「完成条件」全部满足、汇总表已呈现。**不要**在讨论中自觉「应该结束了」就写 signal——终端 stage 的误完成不可逆。
**动作**：用 Write 向 `{{flow_root}}/state/signal` 写入 `done` → 引擎进入 gate-pending，等待开发者 `feat-flow approve` 才结束流程。**汇总表即 gate 呈现**；写 done 后若引擎再提示「呈现审查摘要」，不要重复铺陈，直接等 approve。

**approve 后**（流程结束）：先把知识沉淀 amend 进 stage-5 那笔 `feat:` 提交，再向开发者报告。

approve 前开发者可能已 `git restore` 撤回部分写入，故 amend 必须在 approve 之后执行，只收幸存的文件：

```bash
git add -A && git commit --amend --no-edit
git log -1 --format=%B | grep -q "flow-squash: <flow_id>" || echo "WARN: amend 后 flow-squash 锚点丢失，检查 HEAD"
```

`--amend --no-edit` 把知识沉淀并入那笔 feat、保留原 commit message 与 `flow-squash` 锚点；整个 flow 仍是单个 commit。**只 commit 不 push**（push 留给开发者）。

amend 完成后向开发者报告：

```
feat-flow 流程完成。

📋 本次核心改动：[3-5 条主要变更]
🧪 建议人工测试：[条件性——若 design.md AC 中有 [manual] 项，列对应场景；全部 [auto] 则跳过此行]
📚 知识沉淀：[更新 N 个 ADR / 新增规则]

代码 + 设计文档 + 知识沉淀已全部并入单个 `feat:` 提交（含 docs/feat-flows/ 工件），未 push
  → 用 `git show HEAD` 看完整改动；granular 细节见 docs/feat-flows/<flow_id>/
  → 确认后按团队流程 git push；若知识沉淀需调整，改后再 `git commit --amend --no-edit`
```
