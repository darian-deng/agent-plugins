# Stage 3：实施计划

> feat-flow 第 3/6 步 · [流程总览](../helper.md)
> 把 architecture.md 转成 plan.md——主粒度 = 执行单元（最大内聚切片），供 Stage 4 串行派发。
>
> **元规则**：本 stage **禁止 git commit**，stage-4 起点统一提交。

## 岔路 → 先读哪份

本页只留步骤骨架，和那几条「违反了不会有任何东西变红」的红线。文件都在 `{{flow_root}}/references/` 下：

| 触发事件 | 读 |
|---|---|
| 要写 / 改任何一个 task（字段、粒度、stub、执行单元划分） | `plan-task-format.md` |
| 要填某个 task 的 `decisions` 字段 | `plan-decisions.md` |
| 草稿写完了，要跑内部审查（三轮 + 七道门 + 耦合边界重推导） | `plan-review.md` |
| 要改前置产物（design / architecture），或开发者提异议 | `revision-protocol.md` |

## 目标

产出 `plan.md`——每个 task 自带执行所需的全部信息（决策切片 / verify / 文件清单 / 体量标记），让 Stage 4 的 dispatch 退化为机械拼装、不再运行时即兴补信息。**plan.md 由本 stage 直接生成**（feat-flow 原生格式，不依赖外部 plan 生成 skill）。

生成后由 review subagent 完成内部审查，无分歧直接写 signal 进 Stage 4；有分歧则**落盘到 plan.md 的「待开发者决策（Stage 3）」节、停下不写 signal**，等开发者决策后再写。

**三个上移**（相对旧版）：

1. **粒度上移到执行单元**：主粒度 = fresh subagent 单上下文能做完且可独立 verify 的最大内聚切片；拆分由优先级化轴（截断防御 > 内聚、风险等级独立轴、跨上下文写冲突）决定，**不数 `files` 个数**。
2. **决策切片内联**：从 design.md / architecture.md 抽出管每个 task 的决策，内联进 task 的 `decisions` 字段，取代「把 design.md 整份路径丢给子代理按需取」。
3. **执行单元清单**：内聚切片即单元、被拆分轴拆开的各自成独立单元，输出「执行单元清单」供 Stage 4 照着串行派。

## 前置读取

- `{{project_root}}/docs/feat-flows/<flow_id>/design.md` — 决策、AC、UI 状态、项目命令、TDD 基建决策
- `{{project_root}}/docs/feat-flows/<flow_id>/architecture.md` — 架构决策、build 顺序、文件清单、接口设计

## 入场判断（/clear 重入）

先读 `{{project_root}}/docs/feat-flows/<flow_id>/plan.md`，按三种情况分流：

- **plan.md 不存在** → 按下面步骤 1→5 完整执行。
- **plan.md 存在，且「## 待开发者决策（Stage 3）」节里还有未决条目**（`决策:` 为「待开发者」）→ ⛔ **不重跑 review、不写 signal**。上一段 session 已停在「等开发者拍板」这一步：把这些未决条目原样呈给开发者、等决策，之后走 `plan-review.md` §结果处理的收尾（回填决策 + 按决策改 plan.md + 写 signal）。
- **plan.md 存在，且无该节 / 该节条目全部已决策** → 前者跳过步骤 1–3、直接从步骤 5 重跑审查；后者视为审查已闭环，**直接走 Signal**。⛔ **不重跑 review**——重跑会把同一批分歧再提一遍、把已决策的事重新卡住。

## 步骤

1. **生成 task 草稿**：按 `plan-task-format.md` 的字段规范 + 粒度标准，把 architecture.md 的模块 / 接口 / build 顺序拆成 task。每 task 填 `done` / `files`（符号锚点）/ `TDD` / `depends_on` / `touches_shared` / `output_size`，并**逐单元按粒度标准自检**（命中拆分轴即拆）。TDD 约束与「pre-commit hook 冲突不是决策点」也在那份里。

2. **建决策↔task 矩阵 → 投影 `decisions`**：逐 task 填 `decisions`（每条带 `⟵ 来源` 引用）。机制、四类够格标准、禁止项见 `plan-decisions.md`。

3. **推导 `verify` + 划执行单元**：
   - 读 design.md 项目命令节，把每个 task 的 `done` 翻译成可直接运行的 `verify` 命令，填入 task。
   - 按粒度标准把内聚切片定为单元、被拆分轴拆开的各自成独立单元 → 写 plan.md 末尾「执行单元清单」。

4. **self-review checklist**（主 session 自查，不依赖外部 skill）：对照四条通用纪律逐条扫 plan，发现问题 inline 修——
   - **spec coverage**：design.md 每条需求 / AC 都有 task 承接
   - **placeholder 扫描**：无 TBD / TODO / `<占位>` 等未落实内容
   - **type consistency**：跨 task 的类型名 / 方法名 / 接口签名一致（如 Task 3 用 `clearLayers()`、Task 7 不能写成 `clearFullLayers()`）
   - **file-structure mapping**：每个文件职责单一；改在一起的内容放在一起（按职责切，不按技术层切）

5. **跑内部审查** → `plan-review.md`（三轮 review + 七道门 + 独立耦合边界重推导 + 分歧落盘格式）。

## 三条红线（违反了不会有任何东西报错）

- ⛔ **`files` 用符号锚点（`@ 导出名/函数名` 或 section 标题），禁止行号**——`:123-145` 会在前序 task commit 后漂移，Stage 4 照它定位就定到别处，而没有任何东西会报错。
- ⛔ **每条 `decisions` 必须带可回溯的 `⟵ 来源`**。无来源 = placeholder 或凭空发明 = plan failure；它会被 Stage 4 当作护栏原样注入子代理。
- ⛔ **有未决分歧时，先落盘再开口**。先把每条写进 plan.md 末尾的「## 待开发者决策（Stage 3）」节，再向开发者呈现——这样 /clear 掉也能从 plan.md 恢复「卡在等决策」这个状态。本 stage **无引擎 Gate**，`feat-flow approve` 在这里没有意义，**别提示开发者 approve**。

## 输出规格

文件 → `{{project_root}}/docs/feat-flows/<flow_id>/plan.md`

- 每 task = `### Task N` + `unit` + `TDD` + `done` + `verify` + `read_first` + `decisions` + `files`（符号锚点）+ 可选 `depends_on` / `touches_shared` + `output_size` + 可选 `effort_hint` + 可选 `contract`（stub task）
- plan.md 末尾含「## 执行单元（串行）」清单
- 有未决分歧时再追加「## 待开发者决策（Stage 3）」节——这是 /clear 重入时识别「卡在等开发者拍板」的唯一落盘依据

## 完成条件

- `plan.md` 存在，所有 task 符合任务格式规范（含 `unit` / `verify` / `decisions` / 符号锚点 / `output_size` / 命中项的 `effort_hint`）
- 每单元符合粒度标准（最大内聚切片 + 优先级化拆分轴）；无 `output_size: large` 未拆者；`files` 无行号
- 每个 `decisions` 条目带可解析 `⟵ 来源`；无 orphan 决策
- 「执行单元清单」存在，符合拆分轴（截断防御 / 风险等级 / 跨上下文写冲突），无超大单元
- 三轮内部 review（语义维度 + 三道结构门 + 结构门 7）完成，无分歧（或分歧已落盘、开发者已逐条决策、plan.md 已按决策更新）
- **独立耦合边界重推导已跑**：独立子代理基于 architecture.md / design.md 重新判断的耦合关系与执行单元清单已核对一致（或不一致项已给出依据解决 / 已落盘待决策节并由开发者决策）
- plan.md 若有「## 待开发者决策（Stage 3）」节，**其中不得残留 `决策: 待开发者` 的条目**——有残留 = 还没到写 signal 的时候

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**开发者明确表达本阶段已完成。
**动作**：用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`（引擎接受此关键词，自动推进）。

⚠️ 写前最后一查：plan.md 的「## 待开发者决策（Stage 3）」节（若存在）已无 `决策: 待开发者` 的残留条目。
