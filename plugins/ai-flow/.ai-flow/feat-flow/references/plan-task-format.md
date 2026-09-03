# plan.md 的 task 格式与粒度标准

> **触发**：要生成或修改 plan.md 里的任何一个 task（stage-3 步骤 1、3，以及后续按 review 意见回改时）。
> `<FD>` = 本文件所在目录的上一级（定义层，随插件走）。

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
decisions:                 # 决策切片，见 plan-decisions.md；每条带 ⟵ 来源
  - "[约束断言]  ⟵ design.md §… / architecture.md §…"
files:                     # 符号锚点定位，禁止行号
  - Modify: path/to/existing.ts @ <导出名/函数名>
  - Create: path/to/new.ts
  - Test: path/to/test.ts
depends_on: [Task N]       # 可选，仅编码线性顺序依赖
touches_shared: [Task N]   # 可选，与哪些前序 task 改同一文件（供 Stage 4 注入前序 diff）
output_size: small | large # large 强制拆骨架+填充，见「粒度标准」
effort_hint: normal | high # 可选，默认 normal；high = 高风险隔离单元 或 非枚举型复杂度 → Stage 4 实施 effort 升 high
```

- stub task 额外必须有 `contract` 字段（见下「Stub / Contract 协议」）。
- ⛔ **`files` 用符号锚点（`@ 导出名/函数名` 或 section 标题），禁止行号**（`:123-145` 会在前序 task commit 后漂移，导致定位错误）。
- **`verify` 必填**：是该 task 实施后必须运行、退出码 0 即验收的命令。推导规则：`done` 含「返回 401」且测试命令为 jest → `npx jest -t "401"`。

## `done` 字段写法要求

- **行为级断言**，不是步骤描述
- **可被测试验证**：能翻译成一条测试断言
- **外部可观测**：从调用方视角描述（入参 → 出参 / 状态变化 / 文件存在）
- ✅ 正确示例：`"POST /api/auth 无 Authorization header 时返回 401，body 含 { error: 'unauthorized' }"`
- ✅ 正确示例：`"UserStore.create(email, role) 返回含持久层生成 id 的 UserType 对象"`
- ❌ 错误示例：`"在 src/middleware/auth.ts 里实现 authMiddleware 函数"`（步骤描述，非行为断言）
- ❌ 错误示例：`"处理认证逻辑"`（不可测试，太模糊）
- ❌ 错误示例：`"authMiddleware 正确处理 Authorization header"`（「正确」无法翻译成测试断言）

## 粒度标准（执行单元 = 最大内聚切片 + 优先级化拆分轴）

**主粒度单位 = 执行单元**：一个 fresh subagent 在单上下文里能正确做完、且能独立 verify 的**最大内聚切片**——不「1 行为 = 1 task」碎拆，也不「先碎拆再合并」。architecture.md 一个模块通常就 = 一个单元。每个单元仍要求：`files` 可枚举列全（**无数量上限**）、能独立 `verify`、若走 TDD 则在单元内逐行为红绿。

内聚是默认归并原则，但被下列**优先级化拆分轴**否决（命中即拆，不留主观判断）：

1. **截断防御 > 内聚（最高优先级）**：单元若需在**单文件**实现**一批已枚举成员**（architecture.md 列明的 N 个方法/导出/handler），或含**跨域多接驳**（同一单元接驳 ≥3 个其它域），**无条件**标 `output_size: large` 拆「骨架（建接口/空壳，编译过）+ 填充（逐批实现）」——**不许用「装不装得下」这种主观词放过**。判据是数 plan 已知量（`files.Create` 数 + architecture 已列明成员数），不是预测代码体量。
2. **风险等级 = 独立拆分轴**：高风险动作（某能力**首次在生产激活**、数据迁移、删除被多处依赖的旧路径）**不与低风险清债 / 纯增量合进同一单元**，即便它们内聚——否则回滚粒度被绑死、单元自带的 verify 会掩盖真正需专项回归才暴露的风险。
3. **跨上下文写冲突**：两段工作改同一文件、却无法放进同一上下文 → 拆成不同单元，用 `touches_shared` 标注、由 Stage 4 注入前序 diff。

**`effort_hint` 标注**（供 Stage 4 选 effort，把无法静态拆开的复杂度落成可读字段）：以下单元标 `effort_hint: high`——① 拆分轴 2 命中的**高风险隔离单元**；② **非枚举型复杂度**（architecture 描述含「重写 / 迁移 / 复杂状态机」，或单元 `done` 蕴含 ≥ ~5 路枚举分派（错误码 / 状态 / 类型），或 `decisions` 含 ≥3 条相互制约约束）——这类拆分轴静态拆不开、但实施需更高 effort。其余默认 `normal`。（`output_size: large` 已独立触发 Stage 4 升 high，被它覆盖的不必再标 `effort_hint`。）

⛔ **output_size 前置门（修截断根因）**：若 architecture.md **没列全**某文件要实现的成员（如只写「包装全部 rpc 方法」却没枚举是哪些），stage-3 **估不出体量 → 不许猜**，走 `<FD>/references/revision-protocol.md` 入口 B 退回要求 Stage 2 补全枚举，再继续。这是把「预测代码体量」这个不可静态化的事，换成「architecture 是否列全」这个可静态检查的前置条件。

> 非枚举型的大（纯逻辑复杂度高、无法静态估）→ 标 `output_size: small` 正常处理，运行时若仍超大由 Stage 4 截断自保护协议兜底。

## Stub / Contract 协议

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
- ⛔ **禁止**在当前 task 里越界实现后续 task 的行为，即使顺手也不行

## 执行单元划分

按上面「粒度标准」切出的内聚切片即**执行单元**，写到 plan.md 末尾「执行单元清单」，供 Stage 4 串行派发。

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

## TDD 约束（生成 task 草稿时一并定）

- 若 design.md TDD 基建决策为「建立」→ **Task 0 必须是基建**（标 `TDD: 否`，不走 TDD）
- 若「已有」或「建立」之后的 task → 走 TDD
- 若「不建立」→ 全部 task 标 `TDD: 否`

## pre-commit hook 冲突不是决策点

拆 task 时若发现某个 build 顺序链条会在中间态产生不可编译代码（如先删列、consumer 要等后续某 task 才补），这是正常可预期的实施顺序——**不停下问开发者，也不为规避它而改变拆分方式**。这类冲突已有下游默认处理规则（stage-4 的 `stage-4-exceptions.md` §pre-commit hook 冲突：能在 plan.md 的 build 顺序里找到依据即跳过继续，不问开发者），stage-3 只需照 architecture.md 的 build 顺序正常拆 task。
