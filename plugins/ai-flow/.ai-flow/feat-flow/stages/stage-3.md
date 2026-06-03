# Stage 3：实施计划

> feat-flow 第 3/6 步 · [流程总览](../helper.md)
> 当前 stage 目的：把 architecture.md 转成 plan.md——每 task = 一个可独立验证的行为变化，串行子代理按序执行

**元规则**：禁止 git commit，stage-4 起点统一提交。

## 目标

调用 `writing-plans` skill 生成 `plan.md`，**按下方「任务格式规范」覆盖 writing-plans 的默认输出格式**。生成后由 review subagent 完成三轮内部审查，无分歧直接进 Stage 4，有分歧 gate 等用户决策。

## 前置读取

- `docs/feat-flows/<flow_id>/design.md` — 决策、AC、UI 状态、项目命令、TDD 基建决策
- `docs/feat-flows/<flow_id>/architecture.md` — 架构决策、build 顺序、文件清单、接口设计

## 步骤

**入场判断（/clear 重入）**：若 `docs/feat-flows/<flow_id>/plan.md` 已存在 → 跳过步骤 1，直接从步骤 2 重跑三轮 review；plan.md 不存在 → 按完整步骤 1→2→3 执行。

1. 调用 `writing-plans` skill，传入：
   - design.md + architecture.md 内容
   - 输出路径：`docs/feat-flows/<flow_id>/plan.md`
   - **强制覆盖任务格式**：按「任务格式规范」，不输出代码块，只输出结构化字段
   - TDD 约束：
     - 若 design.md TDD 基建决策为「建立」→ **Task 0 必须是基建**（标 `TDD: 否`，不走 TDD）
     - 若「已有」或「建立」之后的 task → 走 TDD
     - 若「不建立」→ 全部 task 标 `TDD: 否`
   - **格式覆盖后备**：若 writing-plans 输出不符合任务格式规范，主 session 手工调整格式（不重新调用 skill）

2. 调用 review subagent 完成三轮内部审查（见「内部 Review 机制」）

3. **忽略 writing-plans 的执行交接**：writing-plans 末尾会提示「选择执行方式」——在 feat-flow 里忽略，执行归 Stage 4

## 任务格式规范

每个 task 必须包含以下字段，**禁止输出代码块、实现步骤、伪代码**：

```
### Task N: [action-oriented name]

TDD: 是 | 否
read_first:
  - path/to/file.ts        # 执行前必读，了解现有接口 / 实现
done: "[单句行为断言：什么操作 → 什么可观测结果]"
depends_on: [Task N]       # 可选，有前置依赖时填

Files:
- Create: path/to/new.ts
- Modify: path/to/existing.ts
- Test: path/to/test.ts
```

stub task 额外必须有 `contract` 字段（见「Stub / Contract 协议」）。

### `done` 字段写法要求

- **行为级断言**，不是步骤描述
- **可被测试验证**：能翻译成一条测试断言
- **外部可观测**：从调用方视角描述（入参 → 出参 / 状态变化 / 文件存在）
- ✅ 正确示例：`"POST /api/auth 无 Authorization header 时返回 401，body 含 { error: 'unauthorized' }"`
- ✅ 正确示例：`"UserStore.create(email, role) 返回含持久层生成 id 的 UserType 对象"`
- ❌ 错误示例：`"在 src/middleware/auth.ts 里实现 authMiddleware 函数"`（步骤描述，非行为断言）
- ❌ 错误示例：`"处理认证逻辑"`（不可测试，太模糊）
- ❌ 错误示例：`"authMiddleware 正确处理 Authorization header"`（"正确"无法翻译成测试断言）

### 粒度标准

**一个 task = 一个可独立验证的行为变化**，不是时间估计。

- architecture.md 的模块划分为起点，按行为内聚性切分
- 一个模块对应 1–3 个 task，取决于有几个独立可验证的行为
- 跨模块行为：按主变更模块归属；两模块变更量相当 → 拆两个 task + `depends_on`

### Stub / Contract 协议

当一个 task 需要提供接口供后续 task 使用时，可写空实现（stub）作为契约占位：

```
### Task 2: UserService 接口契约（stub）

TDD: 否
read_first:
  - src/types/user.ts      # 了解现有类型定义
done: "UserService interface 存在，TypeScript 编译通过"
contract: "UserService.create(email: string, role: Role) 必须返回含持久层生成 id 的 UserType；id 由持久层生成，不由调用方传入"

Files:
- Create: src/services/user.ts
```

规则：
- stub task 标 `TDD: 否`，不写测试，TypeScript 编译通过即验收
- `contract` 字段描述后续填充 task **必须验证的语义假设**（接口行为契约）
- 填充 task 的 `done` 里必须包含验证该 contract 的行为断言
- **填充对应有 `contract` 的 stub task 时，TDD 字段必须为 `是`**（除非 design.md 明确决策「不建立 TDD」）
- **禁止**在当前 task 里越界实现后续 task 的行为，即使顺手也不行

## 内部 Review 机制

plan.md 生成后由 review subagent 自动完成三轮审查，**不阻塞等待用户**。

**Review subagent 检查维度**：
1. **覆盖完整性**：architecture.md 的每个模块 / 接口 / build order 是否都有对应 task？
2. **`done` 准确性**：每个 `done` 是否是行为级断言？是否与 design.md AC 对齐？能否翻译成测试？
3. **Stub contract 正确性**：stub task 的 `contract` 是否清晰，是否与 architecture.md 接口定义一致？
4. **任务边界干净**：有无 task 的 `done` 实际涵盖了相邻 task 的职责？

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

格式：每 task = `### Task N` + `TDD` + `read_first` + `done` + `Files` + 可选 `depends_on` + 可选 `contract`（stub task）

## 完成条件

- `plan.md` 存在，所有 task 符合任务格式规范
- 三轮内部 review 完成，无分歧（或有分歧但用户已决策）

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**开发者明确表达本阶段已完成。
**动作**：用 Write 工具向 `.ai-flow/feat-flow/state/signal` 写入 `done`（引擎接受此关键词，自动推进）。
