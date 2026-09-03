# plan.md 的内部审查：三轮 review + 七道门 + 独立耦合边界重推导

> **触发**：stage-3 步骤 5——plan.md 草稿已生成、self-review checklist 已过，要跑内部审查。
> `<FD>` = 本文件所在目录的上一级（定义层，随插件走）。

## 三轮 Review 机制

plan.md 生成后由 review subagent 自动完成三轮审查，**不阻塞等待用户**。

**传入**：plan.md 全量 + design.md 全量 + architecture.md 全量——语义维度对齐 AC/接口需要 design.md，`decisions` 溯源核验需要 architecture.md，缺一不可。

### Review subagent 检查维度（语义维度 + 三道结构门，并为一套不另起）

**语义维度**：

1. **`done` 准确性**：每个 `done` 是否是行为级断言？是否与 design.md AC 对齐？能否翻译成测试？
2. **Stub contract 正确性**：stub task 的 `contract` 是否清晰，是否与 architecture.md 接口定义一致？
3. **任务边界干净**：有无 task 的 `done` 实际涵盖了相邻 task 的职责？

**`decisions` 三道结构门**（尽量机械，门 6 只覆盖符号锚定类）：

4. **来源可解析**：每条 `decisions` 必带 `⟵ 来源`，且该 section 在 design/architecture 里真实存在。无效引用 → FAIL。
5. **无 orphan 决策（= 覆盖完整性）**：design.md 每条决策记录 + 每条 AC + architecture.md 每个接口/模块/build order，至少出现在一个 task 的 `decisions` 里。遗漏 → FAIL（补 task 或确认该决策不该存在）。
6. **错配检测（符号锚定类）**：若一条 `decisions` 引用了具体符号（接口名/类型名/文件路径/导出名），该符号必须出现在所属 task 的 `files ∪ read_first` 里；否则疑似错配 → FAIL。**边界**：行为/风格类约束（如「抛 X 而非返回 null」）可能任何 files 都无该符号 → 门 6 放行，错配残差交 Stage 4 per-task 规格审查兜底（规格审本就核「代码是否符合本 task 的 decisions/契约」）。

**结构门**：

7. **粒度/单元/锚点机检**：每单元符合「粒度标准」（最大内聚切片；截断防御命中即拆骨架+填充，含「architecture 未列全则应已退回 Stage 2」；高风险动作不与低风险清债同单元；`files` 可枚举列全）；**高风险隔离单元与非枚举型复杂度单元已标 `effort_hint: high`**（未被 `output_size: large` 覆盖者）；`files` 无行号；执行单元清单存在且符合拆分轴（截断防御 / 风险等级 / 跨上下文写冲突）；每个 TDD task 的 `verify` 依赖的基建 task 在其 `depends_on` 闭包内。

### 三轮流程

- **Round 1**：review subagent 独立检查，输出问题列表
- **Round 2**：主 session 逐条判断——**接受修改**（更新 plan.md）或**有理由维持**（⛔ 必须引用 design.md / architecture.md 中的具体条目作为依据，**不能凭主 session 自判维持**；找不到依据则必须接受修改）
- **Round 3**：只把 Round 2 选择「维持」的条目 + 主 session 为它引用的依据发回 review subagent 最终裁定（不重发全部问题列表）。**跳过条件**——两个同时满足才跳过 Round 3，缺一个都要跑：① 维持集为空（Round 1 的意见全部被接受），**且** ② 下面那次独立耦合边界重推导的结论与 plan.md 的执行单元清单一致（这次重推导是独立派发，与有没有「维持」无关）。

## 独立耦合边界重推导（三轮 review 之外，单独一次 agent 调用）

三轮 review 的结构门 7 只核对 plan.md 自报的 `unit` / `touches_shared` 是否内部自洽（划了的单元符不符合粒度标准），**不核实「该不该合并」这个判断本身对不对**。这道检查专门盯这一件事，和三轮 review 的其它维度互不替代，**不并入三轮**（并进去做不到「没看过 draft 推理过程，从零判断」）。

**执行**：dispatch 一个 fresh `general-purpose` 子代理，只传入：

- architecture.md 全量 + design.md 全量
- 每个 task 的 `files` / `read_first` 字段
- ⛔ **不传** plan.md 已经标好的 `unit` / `touches_shared`（传了就变成核对答案，不是独立判断）

任务：让它自己从架构/设计里判断——哪些 task 之间存在硬耦合判据（① `files` 交集非空，或 ② 某 task 的 `done` 验证依赖另一 task 在同一上下文内的未提交状态，跨子代理传不过去）？产出它认为该合并的 task 组。

**核对**：把它独立推导出的耦合关系，与 plan.md 实际的执行单元清单做 diff：

- 一致 → 通过
- 不一致（它认为该合但没合 / 它认为不该合却合了）→ 主 session 回头核实：找到具体依据维持原判（同 Round 2 纪律，必须引用 architecture.md / design.md 具体条目，不能凭感觉维持），或采纳调整 plan.md 的 unit 划分

**结果路由**：不一致且未能给出依据解决 → 视为「有分歧」，走下面同一条路径；一致或已解决 → 视为「无分歧」的一部分，可与三轮 review 一并写 signal 进入 Stage 4（**不新起一套分歧处理机制**）。

## 结果处理

- **无分歧** → 直接写 signal，进入 Stage 4
- **有分歧**（Round 3 之后，本文件上面那七项检查——语义维度 1–3、`decisions` 结构门 4–6、结构门 7——中**任意一项**仍有未解决的问题 / FAIL，或耦合边界重推导不一致未解决）→ **停下、不写 signal**，按下面三步走：
  1. 把每条未决分歧**先落盘**到 plan.md 末尾「## 待开发者决策（Stage 3）」节（格式见下）——**先落盘再开口**，这样 /clear 掉也能从 plan.md 恢复「卡在等决策」这个状态
  2. 向开发者呈现这些条目并等他拍板（⛔ 本 stage **无引擎 Gate**，`feat-flow approve` 在这里没有意义，**别提示开发者 approve**；就是普通对话里等他回答）
  3. 开发者决策后：按决策改 plan.md 相关 task，并把该节每条的 `决策:` 从「待开发者」回填成实际结论；**全部条目都回填完，才写 signal**

### 「待开发者决策（Stage 3）」节格式

追加在 plan.md 末尾、「执行单元清单」之后：

```markdown
## 待开发者决策（Stage 3）

> 三轮内部 review / 独立耦合边界重推导留下的未决分歧。本节还有未决条目时，Stage 3 不得写 signal。

- D1: <一句话分歧点>
  - 涉及: Task N / U<k>
  - review 立场: <…>
  - 主 session 立场: <…及其 design.md / architecture.md 依据，或「无依据」>
  - 决策: 待开发者
```

决策回填后该条变成 `决策: <开发者结论 + 已据此对 plan 做的改动>`。本节是 flow 内归档，可以用 `Task N` / `U<k>` 这类内部指代。

## 冲突处理

- 开发者提异议 → `<FD>/references/revision-protocol.md`（入口 A）
- AI 自查发现 design.md / architecture.md 漏写 / 错了 → `<FD>/references/revision-protocol.md`（入口 B）
