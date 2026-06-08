# Stage 3：实施计划

> feat-flow 第 3/6 步 · [流程总览](../helper.md)
> 当前 stage 目的：把 architecture.md 转成 plan.md——每 task = 一个可独立验证的行为变化，串行子代理按序执行

**元规则**：禁止 git commit，stage-4 起点统一提交。

## 目标

产出 `plan.md`——每 task = 一个可独立验证的行为变化，自带执行所需的全部信息（决策切片 / verify / 文件清单 / 体量标记），让 Stage 4 的 dispatch 退化为机械拼装、不再运行时即兴补信息。生成后由 review subagent 完成三轮内部审查（含四道结构门），无分歧直接进 Stage 4，有分歧 gate 等用户决策。

**plan.md 由本 stage 按下方「任务格式规范」直接生成**（feat-flow 原生格式，不依赖外部 plan 生成 skill）。

**核心职责（本 stage 相对旧版的三个上移）**：
1. **粒度加体量维度**：语义内聚不够，还要文件可枚举、单子代理输出装得进上下文（见「粒度标准」）。
2. **决策切片内联**：从 design.md / architecture.md 抽出管每个 task 的决策，内联进 task 的 `decisions` 字段（见「decisions 抽取」），取代「把 design.md 整份路径丢给子代理按需取」。
3. **执行单元静态划分**：把耦合 task 合并成簇、独立 task 各自成单元，输出「执行单元清单」供 Stage 4 照着串行派（见「执行单元划分」）。

## 前置读取

- `docs/feat-flows/<flow_id>/design.md` — 决策、AC、UI 状态、项目命令、TDD 基建决策
- `docs/feat-flows/<flow_id>/architecture.md` — 架构决策、build 顺序、文件清单、接口设计

## 步骤

**入场判断（/clear 重入）**：若 `docs/feat-flows/<flow_id>/plan.md` 已存在 → 跳过步骤 1–3，直接从步骤 5 重跑三轮 review；plan.md 不存在 → 按完整步骤 1→2→3→4→5 执行。

1. **生成 task 草稿**：按「任务格式规范」+「粒度标准」，把 architecture.md 的模块/接口/build 顺序拆成 task。每 task 填 `done` / `files`（符号锚点）/ `TDD` / `depends_on` / `touches_shared` / `output_size`。
   - TDD 约束：
     - 若 design.md TDD 基建决策为「建立」→ **Task 0 必须是基建**（标 `TDD: 否`，不走 TDD）
     - 若「已有」或「建立」之后的 task → 走 TDD
     - 若「不建立」→ 全部 task 标 `TDD: 否`
   - **粒度三硬门逐 task 自检**（任一不满足必拆，见「粒度标准」）。

2. **建决策↔task 矩阵 → 投影 `decisions`**：见「decisions 抽取」。逐 task 填 `decisions`（带 `⟵ 来源` 引用）。

3. **推导 `verify` + 划执行单元**：
   - 读 design.md 项目命令节，把每个 task 的 `done` 翻译成可直接运行的 `verify` 命令，填入 task。
   - 按「执行单元划分」把耦合 task 合并成簇、独立 task 各自成单元 → 写 plan.md 末尾「执行单元清单」。

4. **self-review checklist（主 session 自查，不依赖外部 skill）**：对照以下四条通用纪律逐条扫 plan，发现问题 inline 修：
   - **spec coverage**：design.md 每条需求 / AC 都有 task 承接（与「决策矩阵无 orphan」同源，见步骤 5 门 5）
   - **placeholder 扫描**：无 TBD / TODO / `<占位>` 等未落实内容
   - **type consistency**：跨 task 的类型名 / 方法名 / 接口签名一致（如 Task 3 用 `clearLayers()`、Task 7 不能写成 `clearFullLayers()`）
   - **file-structure mapping**：每个文件职责单一；改在一起的内容放在一起（按职责切，不按技术层切）

5. 调用 review subagent 完成三轮内部审查（见「内部 Review 机制」，含四道结构门）。

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

### 粒度标准（三硬门，任一不满足必拆）

**一个 task = 一个可独立验证的行为变化**，不是时间估计。在此基础上**三条硬门全过才算合格**：

1. **语义内聚**：一个独立可验证的行为。architecture.md 模块划分为起点；一个模块对应 1–3 个 task；跨模块行为按主变更模块归属，两模块变更量相当 → 拆两个 task + `depends_on`。
2. **文件可枚举且 ≤ 3–4**：`files` 能逐条列全，且数量 ≤ 3–4。列不全或超数 → 拆。
3. **输出体量装得进单上下文（`output_size`）**：判据是**数 plan 已知量，不是预测代码体量**——以 `files.Create` 数量 + architecture.md 中该文件**已列明**需实现的方法/导出/枚举条目数为准。单文件需实现 ≥ 一批已列明成员（如「包装全部 rpc 方法」）→ 标 `output_size: large` → **强制拆骨架 task（建接口/空壳）+ 填充 task（逐批实现）**。

**output_size 前置门（修截断根因）**：若 architecture.md **没列全**某文件要实现的成员（如只写「包装全部 rpc 方法」却没枚举是哪些），stage-3 **估不出体量 → 不许猜**，走 `references/revision-protocol.md` 入口 B 退回要求 Stage 2 补全枚举，再继续。这是把「预测代码体量」这个不可静态化的事，换成「architecture 是否列全」这个可静态检查的前置条件。

> 非枚举型的大（纯逻辑复杂度高、无法静态估）→ 标 `output_size: small` 正常拆，运行时若仍超大由 Stage 4 截断自保护协议兜底。

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
- 适用于所有 task 的全局条目（属 Stage 4 dispatch 前言，不逐 task 重复）
- 复述 `done`（decisions 是护栏，done 是目标，二者正交）

## 执行单元划分

把 task 归成**执行单元**，写到 plan.md 末尾「执行单元清单」，供 Stage 4 串行派发。单元 = 1 个独立 task，或一个**耦合簇**。

**够格合并成簇的「硬耦合」判据（仅以下两种）**：
1. `touches_shared` 文件交集非空（改同一文件），或
2. 一个 task 的 `done` 验证依赖另一 task 在**同一上下文内**的未提交中间状态（硬 contract 依赖，跨子代理传不过去）。

**仅逻辑顺序依赖（有 `depends_on` 但不共享文件/状态）不够格合并**，保持独立单元串行。

**簇大小上限**：簇内 `files` 并集必须仍满足粒度门 2（≤ 3–4 文件）且不触发 `large`；否则簇过大会回到长上下文 context rot——宁可不合并，保独立单元串行。

清单格式：

```
## 执行单元（串行）
- U1: [Task 1]                       # 独立
- U2: [Task 2, Task 3]               # 耦合簇（共享 createWindowBase.ts）
- U3: [Task 4-skeleton, Task 4-fill] # output_size=large 拆出的骨架+填充
```

## 内部 Review 机制

plan.md 生成后由 review subagent 自动完成三轮审查，**不阻塞等待用户**。

**Review subagent 检查维度**（语义维度 + 四道结构门，并为一套不另起）：

语义维度：
1. **`done` 准确性**：每个 `done` 是否是行为级断言？是否与 design.md AC 对齐？能否翻译成测试？
2. **Stub contract 正确性**：stub task 的 `contract` 是否清晰，是否与 architecture.md 接口定义一致？
3. **任务边界干净**：有无 task 的 `done` 实际涵盖了相邻 task 的职责？

`decisions` 四道结构门（尽量机械，门 4 只覆盖符号锚定类）：
4. **来源可解析**：每条 `decisions` 必带 `⟵ 来源`，且该 section 在 design/architecture 里真实存在。无效引用 → FAIL。
5. **无 orphan 决策（= 覆盖完整性）**：design.md 每条决策记录 + 每条 AC + architecture.md 每个接口/模块/build order，至少出现在一个 task 的 `decisions` 里。遗漏 → FAIL（补 task 或确认该决策不该存在）。
6. **无全局条目伪装成局部**：同一条 `decisions` 逐字出现在 > 3 个 task → 是全局约束，移到 Stage 4 dispatch 前言、从各 task 删 → FAIL until moved。
7. **错配检测（符号锚定类）**：若一条 `decisions` 引用了具体符号（接口名/类型名/文件路径/导出名），该符号必须出现在所属 task 的 `files ∪ read_first` 里；否则疑似错配 → FAIL。**边界**：行为/风格类约束（如「抛 X 而非返回 null」）可能任何 files 都无该符号 → 门 7 放行，错配残差交 Stage 4 per-task 规格审查兜底（规格审本就核「代码是否符合本 task 的 decisions/契约」）。

结构门(8)：
8. **粒度/单元/锚点机检**：每 task 三硬门过（语义内聚 / files≤3–4 / output_size 判据正确，含「architecture 未列全则应已退回 Stage 2」）；`files` 无行号；执行单元清单存在且簇符合硬耦合判据 + 簇大小上限；每个 TDD task 的 `verify` 依赖的基建 task 在其 `depends_on` 闭包内。

**三轮流程**：
- Round 1：review subagent 独立检查，输出问题列表
- Round 2：主 session 逐条判断——**接受修改**（更新 plan.md）或**有理由维持**（必须引用 design.md / architecture.md 中的具体条目作为依据，不能凭主 session 自判维持；找不到依据则必须接受修改）
- Round 3：review subagent 最终裁定

**结果**：
- **无分歧** → 直接写 signal，进入 Stage 4
- **有分歧**（Round 3 仍有任何 `done` 准确性或覆盖完整性问题未解决）→ gate 等用户决策，用户决策后写 signal

冲突处理：
- 开发者提异议 → `references/revision-protocol.md`（入口 A）
- AI 自查发现 design.md / architecture.md 漏写 / 错了 → `references/revision-protocol.md`（入口 B）

## 输出规格

文件 → `docs/feat-flows/<flow_id>/plan.md`

格式：
- 每 task = `### Task N` + `unit` + `TDD` + `done` + `verify` + `read_first` + `decisions` + `files`（符号锚点）+ 可选 `depends_on` / `touches_shared` + `output_size` + 可选 `contract`（stub task）
- plan.md 末尾含「## 执行单元（串行）」清单

## 完成条件

- `plan.md` 存在，所有 task 符合任务格式规范（含 `unit` / `verify` / `decisions` / 符号锚点 / `output_size`）
- 每 task 三硬门过；无 `output_size: large` 未拆者；`files` 无行号
- 每个 `decisions` 条目带可解析 `⟵ 来源`；无 orphan 决策；无全局条目伪装成局部
- 「执行单元清单」存在，簇符合硬耦合判据 + 簇大小上限
- 三轮内部 review（语义维度 + 四道结构门 + 结构门 8）完成，无分歧（或有分歧但用户已决策）

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**开发者明确表达本阶段已完成。
**动作**：用 Write 工具向 `.ai-flow/feat-flow/state/signal` 写入 `done`（引擎接受此关键词，自动推进）。
