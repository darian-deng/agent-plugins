# Stage 3：实施计划

> feat-flow 第 3/6 步 · [流程总览](../helper.md)
> 当前 stage 目的：把 architecture.md 转成 plan.md——主粒度 = 执行单元（最大内聚切片），串行子代理按执行单元派发

**元规则**：禁止 git commit，stage-4 起点统一提交。

## 目标

产出 `plan.md`——主粒度 = 执行单元（最大内聚切片），每个 task 自带执行所需的全部信息（决策切片 / verify / 文件清单 / 体量标记），让 Stage 4 的 dispatch 退化为机械拼装、不再运行时即兴补信息。生成后由 review subagent 完成三轮内部审查（含三道结构门），无分歧直接写 signal 进 Stage 4；有分歧则**落盘到 plan.md 的「待开发者决策（Stage 3）」节、停下不写 signal**，等开发者决策后再写。

**plan.md 由本 stage 按下方「任务格式规范」直接生成**（feat-flow 原生格式，不依赖外部 plan 生成 skill）。

**核心职责（本 stage 相对旧版的三个上移）**：
1. **粒度上移到执行单元**：主粒度 = fresh subagent 单上下文能做完且可独立 verify 的最大内聚切片；拆分由优先级化轴（截断防御 > 内聚、风险等级独立轴、跨上下文写冲突）决定，不数 `files` 个数（见「粒度标准」）。
2. **决策切片内联**：从 design.md / architecture.md 抽出管每个 task 的决策，内联进 task 的 `decisions` 字段（见「decisions 抽取」），取代「把 design.md 整份路径丢给子代理按需取」。
3. **执行单元清单**：内聚切片即单元、被拆分轴拆开的各自成独立单元，输出「执行单元清单」供 Stage 4 照着串行派（见「执行单元划分」）。

## 前置读取

- `{{project_root}}/docs/feat-flows/<flow_id>/design.md` — 决策、AC、UI 状态、项目命令、TDD 基建决策
- `{{project_root}}/docs/feat-flows/<flow_id>/architecture.md` — 架构决策、build 顺序、文件清单、接口设计

## 步骤

**入场判断（/clear 重入）**：先读 `{{project_root}}/docs/feat-flows/<flow_id>/plan.md`，按下列三种情况分流——

- **plan.md 不存在** → 按完整步骤 1→2→3→4→5 执行。
- **plan.md 存在，且含「## 待开发者决策（Stage 3）」节、其中还有未决条目**（`决策:` 为「待开发者」）→ **不重跑 review、不写 signal**。说明上一段 session 已停在「等开发者拍板」这一步：把这些未决条目原样呈给开发者、等决策，之后走步骤 5 末尾「结果」里的收尾（回填决策 + 按决策改 plan.md + 写 signal）。
- **plan.md 存在，且无该节 / 该节条目全部已决策** → 前者跳过步骤 1–3、直接从步骤 5 重跑三轮 review；后者视为审查已闭环，直接走 Signal（**不重跑 review**——重跑会把同一批分歧再提一遍、把已决策的事重新卡住）。

1. **生成 task 草稿**：按「任务格式规范」+「粒度标准」，把 architecture.md 的模块/接口/build 顺序拆成 task。每 task 填 `done` / `files`（符号锚点）/ `TDD` / `depends_on` / `touches_shared` / `output_size`。
   - TDD 约束：
     - 若 design.md TDD 基建决策为「建立」→ **Task 0 必须是基建**（标 `TDD: 否`，不走 TDD）
     - 若「已有」或「建立」之后的 task → 走 TDD
     - 若「不建立」→ 全部 task 标 `TDD: 否`
   - **逐单元按「粒度标准」自检**（最大内聚切片 + 优先级化拆分轴，命中即拆）。
   - **pre-commit hook 冲突不是决策点**：拆 task 时若发现某个 build 顺序链条会在中间态产生不可编译代码（如先删列、consumer 要等后续某 task 才补），这是正常可预期的实施顺序——**不停下问开发者，也不为规避它而改变拆分方式**。这类冲突已有下游默认处理规则（`stages/stage-4.md`「异常处理」§pre-commit hook 冲突：能在 plan.md 的 build 顺序里找到依据即跳过继续，不问开发者），stage-3 只需照 architecture.md 的 build 顺序正常拆 task。

2. **建决策↔task 矩阵 → 投影 `decisions`**：见「decisions 抽取」。逐 task 填 `decisions`（带 `⟵ 来源` 引用）。

3. **推导 `verify` + 划执行单元**：
   - 读 design.md 项目命令节，把每个 task 的 `done` 翻译成可直接运行的 `verify` 命令，填入 task。
   - 按「粒度标准 / 执行单元划分」把内聚切片定为单元、被拆分轴拆开的各自成独立单元 → 写 plan.md 末尾「执行单元清单」。

4. **self-review checklist（主 session 自查，不依赖外部 skill）**：对照以下四条通用纪律逐条扫 plan，发现问题 inline 修：
   - **spec coverage**：design.md 每条需求 / AC 都有 task 承接（与「决策矩阵无 orphan」同源，见步骤 5 门 5）
   - **placeholder 扫描**：无 TBD / TODO / `<占位>` 等未落实内容
   - **type consistency**：跨 task 的类型名 / 方法名 / 接口签名一致（如 Task 3 用 `clearLayers()`、Task 7 不能写成 `clearFullLayers()`）
   - **file-structure mapping**：每个文件职责单一；改在一起的内容放在一起（按职责切，不按技术层切）

5. 调用 review subagent 完成三轮内部审查（见「内部 Review 机制」，含三道结构门）。

## 任务格式规范

每个 task 必须包含以下字段，**禁止输出代码块、实现步骤、伪代码**：

```
### Task N: [action-oriented name]

unit: U<k>                 # 所属执行单元 id（独立 task 自成单元；耦合簇共享同一 id）
TDD: 是 | 否
done: "[单句行为断言：什么操作 → 什么可观测结果]"
verify: "[可直接运行的验证命令]"   # 由 done + design.md 项目命令推导
read_first:
  - path/to/file.ts        # 执行前必读，了解现有接口 / 实现 / 读依赖
decisions:                 # 决策切片，见「decisions 抽取」；每条带 ⟵ 来源
  - "[约束断言]  ⟵ design.md §… / architecture.md §…"
files:                     # 符号锚点定位，禁止行号
  - Modify: path/to/existing.ts @ <导出名/函数名>
  - Create: path/to/new.ts
  - Test: path/to/test.ts
depends_on: [Task N]       # 可选，仅编码线性顺序依赖
touches_shared: [Task N]   # 可选，与哪些前序 task 改同一文件（供 Stage 4 注入前序 diff）
output_size: small | large # large 强制拆骨架+填充，见「粒度标准」
effort_hint: normal | high # 可选，默认 normal；high = 高风险隔离单元 或 非枚举型复杂度 → Stage 4 实施 effort 升 high（见「粒度标准」）
```

- stub task 额外必须有 `contract` 字段（见「Stub / Contract 协议」）。
- **`files` 用符号锚点（`@ 导出名/函数名` 或 section 标题），禁止行号**（`:123-145` 会在前序 task commit 后漂移，导致定位错误）。
- **`verify` 必填**：是该 task 实施后必须运行、退出码 0 即验收的命令。推导规则同旧版（`done` 含"返回 401" 且测试命令为 jest → `npx jest -t "401"`）。

### `done` 字段写法要求

- **行为级断言**，不是步骤描述
- **可被测试验证**：能翻译成一条测试断言
- **外部可观测**：从调用方视角描述（入参 → 出参 / 状态变化 / 文件存在）
- ✅ 正确示例：`"POST /api/auth 无 Authorization header 时返回 401，body 含 { error: 'unauthorized' }"`
- ✅ 正确示例：`"UserStore.create(email, role) 返回含持久层生成 id 的 UserType 对象"`
- ❌ 错误示例：`"在 src/middleware/auth.ts 里实现 authMiddleware 函数"`（步骤描述，非行为断言）
- ❌ 错误示例：`"处理认证逻辑"`（不可测试，太模糊）
- ❌ 错误示例：`"authMiddleware 正确处理 Authorization header"`（"正确"无法翻译成测试断言）

### 粒度标准（执行单元 = 最大内聚切片 + 优先级化拆分轴）

**主粒度单位 = 执行单元**：一个 fresh subagent 在单上下文里能正确做完、且能独立 verify 的**最大内聚切片**——不「1 行为 = 1 task」碎拆，也不「先碎拆再合并」。architecture.md 一个模块通常就 = 一个单元。每个单元仍要求：`files` 可枚举列全（**无数量上限**）、能独立 `verify`、若走 TDD 则在单元内逐行为红绿。

内聚是默认归并原则，但被下列**优先级化拆分轴**否决（命中即拆，不留主观判断）：

1. **截断防御 > 内聚（最高优先级）**：单元若需在**单文件**实现**一批已枚举成员**（architecture.md 列明的 N 个方法/导出/handler），或含**跨域多接驳**（同一单元接驳 ≥3 个其它域），**无条件**标 `output_size: large` 拆「骨架（建接口/空壳，编译过）+ 填充（逐批实现）」——**不许用「装不装得下」这种主观词放过**。判据是数 plan 已知量（`files.Create` 数 + architecture 已列明成员数），不是预测代码体量。
2. **风险等级 = 独立拆分轴**：高风险动作（某能力**首次在生产激活**、数据迁移、删除被多处依赖的旧路径）**不与低风险清债 / 纯增量合进同一单元**，即便它们内聚——否则回滚粒度被绑死、单元自带的 verify 会掩盖真正需专项回归才暴露的风险。
3. **跨上下文写冲突**：两段工作改同一文件、却无法放进同一上下文 → 拆成不同单元，用 `touches_shared` 标注、由 Stage 4 注入前序 diff。

**`effort_hint` 标注（供 Stage 4 选 effort，把无法静态拆开的复杂度落成可读字段）**：以下单元标 `effort_hint: high`——① 拆分轴 2 命中的**高风险隔离单元**；② **非枚举型复杂度**（architecture 描述含「重写 / 迁移 / 复杂状态机」，或单元 `done` 蕴含 ≥ ~5 路枚举分派（错误码 / 状态 / 类型），或 `decisions` 含 ≥3 条相互制约约束）——这类拆分轴静态拆不开、但实施需更高 effort。其余默认 `normal`。（`output_size: large` 已独立触发 Stage 4 升 high，被它覆盖的不必再标 `effort_hint`。）

**output_size 前置门（修截断根因）**：若 architecture.md **没列全**某文件要实现的成员（如只写「包装全部 rpc 方法」却没枚举是哪些），stage-3 **估不出体量 → 不许猜**，走 `{{flow_root}}/references/revision-protocol.md` 入口 B 退回要求 Stage 2 补全枚举，再继续。这是把「预测代码体量」这个不可静态化的事，换成「architecture 是否列全」这个可静态检查的前置条件。

> 非枚举型的大（纯逻辑复杂度高、无法静态估）→ 标 `output_size: small` 正常处理，运行时若仍超大由 Stage 4 截断自保护协议兜底。

### Stub / Contract 协议

当一个 task 需要提供接口供后续 task 使用时，可写空实现（stub）作为契约占位：

```
### Task 2: UserService 接口契约（stub）

unit: U2
TDD: 否
done: "UserService interface 存在，TypeScript 编译通过"
verify: "npx tsc --noEmit"
read_first:
  - src/types/user.ts      # 了解现有类型定义
decisions:
  - "id 由持久层生成，不由调用方传入  ⟵ design.md §决策记录 Qx"
contract: "UserService.create(email: string, role: Role) 必须返回含持久层生成 id 的 UserType；id 由持久层生成，不由调用方传入"
files:
- Create: src/services/user.ts
output_size: small
```

规则：
- stub task 标 `TDD: 否`，不写测试，TypeScript 编译通过即验收
- `contract` 字段描述后续填充 task **必须验证的语义假设**（接口行为契约）
- 填充 task 的 `done` 里必须包含验证该 contract 的行为断言
- **填充对应有 `contract` 的 stub task 时，TDD 字段必须为 `是`**（除非 design.md 明确决策「不建立 TDD」）
- **禁止**在当前 task 里越界实现后续 task 的行为，即使顺手也不行

## decisions 抽取（决策切片）

每个 task 的 `decisions` = 从 design.md / architecture.md 抽出**只管这个 task** 的决策，内联进 task。**目的**：取代「把整份 design.md 路径丢给子代理按需取」——整份给是噪音（一个 task 只碰设计的一个切片），按需取把决策可见性变成可选（子代理不读就漏，违反一致性）。切片把可见性变回**保证**。design.md / architecture.md 全文降级为兜底路径（仅 Stage 4 在切片不足时给）。

### 抽取机制：决策↔task 矩阵的投影

1. 建一张**决策↔task 矩阵**：行 = design.md 决策记录条目 + architecture.md 接口/契约 + design.md 验收标准 AC；列 = task。
2. 某 task 的 `decisions` = 它在矩阵里命中的那些行，逐条投影。
3. **诚实区分**：投影（矩阵列→task）是机械的；**填充（某条决策该挂到哪个 task）是判断，不可完全机械化**。所以覆盖门只能查 orphan（零命中），查不出错配（挂错 task）——错配靠下面门 4（符号锚定类）+ Stage 4 per-task 规格审查（行为/风格类）兜。

### 什么够格进 decisions（四类）

只有命中以下四类的进 `decisions`，其余留兜底路径：
1. **接口契约**：本 task 必须遵守/产出的方法签名、返回结构、类型形状 ⟵ architecture.md §接口设计
2. **命名/类型约定**：本 task 必须沿用以保持一致的命名/类型名 ⟵ architecture.md / 前序 task 新术语
3. **验收断言**：本 task 闭合的那条 AC ⟵ design.md §验收标准
4. **显式决策约束**：约束本 task「怎么做」的决策记录条目，**含「为什么不选 X」**（防子代理重探被否决路径）⟵ design.md §决策记录

### 禁止进 decisions
- 实现步骤 / 代码 / 伪代码
- 无法回溯到某 doc section 的条目（无 `⟵ 来源` = placeholder 或凭空发明 = plan failure）
- 复述 `done`（decisions 是护栏，done 是目标，二者正交）

## 执行单元划分

按「粒度标准」切出的内聚切片即**执行单元**，写到 plan.md 末尾「执行单元清单」，供 Stage 4 串行派发。

- **默认**：一个内聚切片 = 一个执行单元（其内部可含多个 task，若该切片自然含多个可验证行为）。
- 被拆分轴拆开的（截断防御的骨架/填充、风险等级隔离、跨上下文写冲突）各自成**独立单元**串行。
- **仅逻辑顺序依赖**（有 `depends_on` 但不共享文件/未提交状态）**不强行并入同一单元**——保持独立单元串行。
- **单元上限**：单元内 `files` 并集若命中截断防御（一批已枚举成员 / 跨域多接驳）→ 必须按拆分轴 1 拆骨架+填充，不许留超大单元导致长上下文 context rot。
- **跨上下文未提交中间状态**（一个 task 的 `done` 验证依赖另一 task 在同一上下文内的未提交状态、跨子代理传不过去）→ 这两个 task 必须落在同一单元（硬 contract 依赖）。

清单格式：

```
## 执行单元（串行）
- U1: [Task 1]                       # 独立
- U2: [Task 2, Task 3]               # 耦合簇（共享 createWindowBase.ts）
- U3: [Task 4-skeleton, Task 4-fill] # output_size=large 拆出的骨架+填充
```

## 内部 Review 机制

plan.md 生成后由 review subagent 自动完成三轮审查，**不阻塞等待用户**。

**传入**：plan.md 全量 + design.md 全量 + architecture.md 全量——语义维度对齐 AC/接口需要 design.md，`decisions` 溯源核验需要 architecture.md，缺一不可。

**Review subagent 检查维度**（语义维度 + 三道结构门，并为一套不另起）：

语义维度：
1. **`done` 准确性**：每个 `done` 是否是行为级断言？是否与 design.md AC 对齐？能否翻译成测试？
2. **Stub contract 正确性**：stub task 的 `contract` 是否清晰，是否与 architecture.md 接口定义一致？
3. **任务边界干净**：有无 task 的 `done` 实际涵盖了相邻 task 的职责？

`decisions` 三道结构门（尽量机械，门 4 只覆盖符号锚定类）：
4. **来源可解析**：每条 `decisions` 必带 `⟵ 来源`，且该 section 在 design/architecture 里真实存在。无效引用 → FAIL。
5. **无 orphan 决策（= 覆盖完整性）**：design.md 每条决策记录 + 每条 AC + architecture.md 每个接口/模块/build order，至少出现在一个 task 的 `decisions` 里。遗漏 → FAIL（补 task 或确认该决策不该存在）。
6. **错配检测（符号锚定类）**：若一条 `decisions` 引用了具体符号（接口名/类型名/文件路径/导出名），该符号必须出现在所属 task 的 `files ∪ read_first` 里；否则疑似错配 → FAIL。**边界**：行为/风格类约束（如「抛 X 而非返回 null」）可能任何 files 都无该符号 → 门 6 放行，错配残差交 Stage 4 per-task 规格审查兜底（规格审本就核「代码是否符合本 task 的 decisions/契约」）。

结构门(7)：
7. **粒度/单元/锚点机检**：每单元符合「粒度标准」（最大内聚切片；截断防御命中即拆骨架+填充，含「architecture 未列全则应已退回 Stage 2」；高风险动作不与低风险清债同单元；`files` 可枚举列全）；**高风险隔离单元与非枚举型复杂度单元已标 `effort_hint: high`**（未被 `output_size: large` 覆盖者）；`files` 无行号；执行单元清单存在且符合拆分轴（截断防御 / 风险等级 / 跨上下文写冲突）；每个 TDD task 的 `verify` 依赖的基建 task 在其 `depends_on` 闭包内。

**三轮流程**：
- Round 1：review subagent 独立检查，输出问题列表
- Round 2：主 session 逐条判断——**接受修改**（更新 plan.md）或**有理由维持**（必须引用 design.md / architecture.md 中的具体条目作为依据，不能凭主 session 自判维持；找不到依据则必须接受修改）
- Round 3：review subagent 最终裁定

**结果**：
- **无分歧** → 直接写 signal，进入 Stage 4
- **有分歧**（Round 3 仍有任何 `done` 准确性或覆盖完整性问题未解决）→ **停下、不写 signal**，按下面三步走：
  1. 把每条未决分歧**先落盘**到 plan.md 末尾「## 待开发者决策（Stage 3）」节（格式见下）——**先落盘再开口**，这样 /clear 掉也能从 plan.md 恢复「卡在等决策」这个状态
  2. 向开发者呈现这些条目并等他拍板（本 stage 无引擎 Gate，`feat-flow approve` 在这里没有意义，**别提示开发者 approve**；就是普通对话里等他回答）
  3. 开发者决策后：按决策改 plan.md 相关 task，并把该节每条的 `决策:` 从「待开发者」回填成实际结论；全部条目都回填完，才写 signal

「待开发者决策（Stage 3）」节格式（追加在 plan.md 末尾，「执行单元清单」之后）：

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

冲突处理：
- 开发者提异议 → `{{flow_root}}/references/revision-protocol.md`（入口 A）
- AI 自查发现 design.md / architecture.md 漏写 / 错了 → `{{flow_root}}/references/revision-protocol.md`（入口 B）

## 独立耦合边界重推导（三轮 review 之外，单独一次 agent 调用）

三轮 review 的结构门 7 只核对 plan.md 自报的 `unit` / `touches_shared` 是否内部自洽（划了的单元符不符合粒度标准），**不核实"该不该合并"这个判断本身对不对**。这道检查专门盯这一件事,和三轮 review 的其它维度互不替代,**不并入三轮**（并进去做不到"没看过 draft 推理过程,从零判断"）。

**执行**：dispatch 一个 fresh `general-purpose` 子代理，只传入：
- architecture.md 全量 + design.md 全量
- 每个 task 的 `files` / `read_first` 字段
- **不传** plan.md 已经标好的 `unit` / `touches_shared`（传了就变成核对答案，不是独立判断）

任务：让它自己从架构/设计里判断——哪些 task 之间存在硬耦合判据（① `files` 交集非空,或 ② 某 task 的 `done` 验证依赖另一 task 在同一上下文内的未提交状态,跨子代理传不过去)？产出它认为该合并的 task 组。

**核对**：把它独立推导出的耦合关系,与 plan.md 实际的执行单元清单做 diff：
- 一致 → 通过
- 不一致（它认为该合但没合 / 它认为不该合却合了）→ 主 session 回头核实：找到具体依据维持原判（同 Round 2 纪律，必须引用 architecture.md / design.md 具体条目，不能凭感觉维持），或采纳调整 plan.md 的 unit 划分

**结果路由**：不一致且未能给出依据解决 → 视为「有分歧」，走上面「结果」同一条路径（落盘「待开发者决策（Stage 3）」节 + 停下不写 signal + 等开发者拍板）；一致或已解决 → 视为「无分歧」的一部分,可与三轮 review 一并写 signal 进入 Stage 4（不新起一套分歧处理机制）。

## 输出规格

文件 → `{{project_root}}/docs/feat-flows/<flow_id>/plan.md`

格式：
- 每 task = `### Task N` + `unit` + `TDD` + `done` + `verify` + `read_first` + `decisions` + `files`（符号锚点）+ 可选 `depends_on` / `touches_shared` + `output_size` + 可选 `effort_hint` + 可选 `contract`（stub task）
- plan.md 末尾含「## 执行单元（串行）」清单
- 有未决分歧时，plan.md 再追加「## 待开发者决策（Stage 3）」节（格式见「内部 Review 机制」§结果）——这是 /clear 重入时识别「卡在等开发者拍板」的唯一落盘依据

## 完成条件

- `plan.md` 存在，所有 task 符合任务格式规范（含 `unit` / `verify` / `decisions` / 符号锚点 / `output_size` / 命中项的 `effort_hint`）
- 每单元符合「粒度标准」（最大内聚切片 + 优先级化拆分轴）；无 `output_size: large` 未拆者；`files` 无行号
- 每个 `decisions` 条目带可解析 `⟵ 来源`；无 orphan 决策
- 「执行单元清单」存在，符合拆分轴（截断防御 / 风险等级 / 跨上下文写冲突），无超大单元
- 三轮内部 review（语义维度 + 三道结构门 + 结构门 7）完成，无分歧（或分歧已落盘「待开发者决策（Stage 3）」节、开发者已逐条决策、plan.md 已按决策更新）
- **独立耦合边界重推导已跑**：独立子代理基于 architecture.md/design.md 重新判断的耦合关系与 plan.md 执行单元清单已核对一致（或不一致项已给出依据解决 / 已落盘待决策节并由开发者决策）
- plan.md 若有「## 待开发者决策（Stage 3）」节，**其中不得残留 `决策: 待开发者` 的条目**——有残留 = 还没到写 signal 的时候

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**开发者明确表达本阶段已完成。
**动作**：用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`（引擎接受此关键词，自动推进）。

⚠️ 写前最后一查：plan.md 的「## 待开发者决策（Stage 3）」节（若存在）已无 `决策: 待开发者` 的残留条目。
