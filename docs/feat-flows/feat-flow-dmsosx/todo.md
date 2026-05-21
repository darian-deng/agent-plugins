# feat-flow 全面重构 · 需求沉淀

> 本文档记录本次 feat-flow 重构的完整背景、已对齐决策、识别的缺口，以及待讨论的开放问题。
> 用于下一轮 Stage 1 正式需求确认的输入基础。

---

## 一、原始需求

对 `plugins/ai-flow/.ai-flow/feat-flow` 的每一个 stage 进行全面重新思考和调整：

1. **站在整体流程**上思考合理性——8 个阶段的编排是否有意义，流程控制是否能在实际项目落地时正常执行
2. **站在每个 stage**上分析是否使用了最佳工具/技术
3. 以**第一性原理**重新审视——可以完全推翻过去的结论
4. 有据可循的历史版本在：`/Users/plaud/Documents/Codes/fe-nexus/docs/archive/ai-flow`
   - 有些内容已过时
   - 有些重要内容在迭代中消失了（如 stage1 的 grill-me、stage5 的 tdd）
5. 关注**流程控制与 stage 衔接**是否在落地时能正常运行

---

## 二、已对齐的决策

| 决策 | 结论 | 理由 |
|------|------|------|
| Stage 1 工具选择 | `brainstorming` 作为骨架，`grill-me` 的提问规范内嵌到问询阶段 | grill-me 的提问更好（一次一问、附推荐答案、可查代码先查），但 brainstorming 提供流程结构和工件产出步骤 |
| Stage 5 TDD | 使用 `tdd` skill（mattpocock），不用 superpowers 默认 TDD | tdd 有 Tracer Bullet + 横向切片反模式警告 + behavior-first 哲学，对 AI 编程时代特别重要 |
| 全局禁 commit | 所有 stage 头部加元规则：禁 git commit，改动用 git add | 任何 skill（brainstorming、writing-plans 等）都可能建议 commit，单 stage 覆盖不全 |
| Signal 路径 | 固定约定，写死在每个 stage prompt 末尾：`.ai-flow/feat-flow/state/signal` | 简单健壮，engine hook 只需匹配 `.ai-flow/*/state/signal` 即可，无需读 config |
| Stage prompt 末尾格式 | 每个 stage prompt 末尾只有一行 signal 写入指令，不解释 gate 机制或"进入下一 stage" | Gate 是 engine 职责，stage prompt 解释它造成 stage 间耦合 |

---

## 三、识别的缺口

### 3.1 结构性缺口（对照 `ai-flow:create` 规范）

**[STRUCT-1] Stage prompt 末尾格式错误**
- 当前：signal 写入在中间，后面跟 "等待用户审批后进入 Stage X" 或 "本阶段无 Gate，自动进入 Stage X"
- 应为：所有 stage prompt 末尾只有一行：`完成本阶段所有产出后，向 .ai-flow/feat-flow/state/signal 写入任意内容。`
- 影响：stage 间耦合（加/删 stage 要改所有相邻 stage 文案）

**[STRUCT-2] preflight.sh 全部检查被注释**
- 当前：skill 检查和 feature-dev 检查均 TODO 注释跳过，直接 exit 0
- 问题：grill-me 从未在检查列表中；claude-md-improver 是 plugin 不是 skill（路径不对）
- 需要：重写 preflight.sh，添加 grill-me 检查，修正 claude-md-management 检查方式

### 3.2 内容缺口（Stage 逻辑层面）

**[STAGE1-1] Stage 1 未使用 grill-me**
- 当前：`可使用 brainstorming skill`（可选）
- 应为：brainstorming 骨架 + grill-me 问询规范内嵌（见已对齐决策）

**[STAGE5-1] Stage 5 未调用 tdd skill**
- 当前：`dispatch implementer subagent 执行代码修改`（无 TDD 要求）
- 应为：每个 task 的 implementer subagent 必须走 `tdd` skill 红绿重构循环

**[STAGE5-2] Stage 5 无 BASE_SHA 记录**
- 当前：stage 5 开始时没有 `git rev-parse HEAD` 记录到 state
- 影响：Stage 7 无法用 `git diff <BASE_SHA>` 获得本次 flow 的精确全量改动
- Stage 7 当前写的是"base_sha 来自 active.json"——但没有人负责写入这个字段

**[STAGE7-1] Stage 7 传给 reviewer 的内容不完整**
- 缺少：使用 BASE_SHA diff（`git diff BASE_SHA HEAD`）
- 缺少：要求 reviewer 每条 issue 必须附 ≤5 行代码片段作证据
- 缺少：明确指定 `feature-dev:code-reviewer` subagent 而非泛指"reviewer subagent"

**[GLOBAL-1] 全局禁 commit 规则缺失**
- Stage 5 明文有 `git commit`，其他依赖 skill 也可能触发 commit
- 需要在每个 stage prompt 头部加元规则

**[SUBAGENT-1] Subagent 类型不明确**
- Stage 2：`Explore subagent`（应为 `feature-dev:code-explorer`）
- Stage 3：`architect subagent`（应为 `feature-dev:code-architect`）
- Stage 7：`reviewer subagent`（应为 `feature-dev:code-reviewer`）
- 泛指导致 AI 自由发挥，行为不可预测

---

## 四、待讨论的开放问题

### 4.1 AI-Friendly Stage Prompts ✅ 已完成

**结论**：
- 新增 `optimize-stage-prompt` skill（内置到 ai-flow 插件），直接改写 stage 文件，强制规范 section 结构（目标→前置读取→步骤→输出规格→完成条件→Signal）
- `create`/`update`/`add`/`optimize-stage-prompt` 四个 skill 改为仅 slash command 触发
- `create` skill：逐一追问访谈风格 + 全局连贯性校验 + stage 模板对齐 optimize-stage-prompt 规范
- `update` skill：Step 5 加 stage 规范合规检查，Step 6 stage 文件约束升级
- 版本号升至 0.12.0，已 push 到 main

### 4.2 各 Stage 的第一性原理审视（待逐一讨论）

以下问题在本次对话中尚未深入讨论，需要在正式 Stage 1 需求确认时覆盖：

**Stage 2（代码探索）**
- 是否应强制使用 `feature-dev:code-explorer`？
- 探索结果如何与 stage 1 的 design.md 结合？
- 无重大发现时是否真的需要 gate？（当前 config 无 gate）

**Stage 3（方案选型）**
- 是否应强制使用 `feature-dev:code-architect`？
- 当只有一个明显方案时，是否仍需要 2-3 个 architect subagent？
- gate 是必要的吗？

**Stage 4（实施计划）**
- 是否应调用 `writing-plans` skill？
- task 粒度（"2-5 分钟 AI 工作量"）在实际落地时是否可执行？
- gate 设计是否合理？

**Stage 5（代码实施）**
- 加入 TDD 后，per-task 流程如何设计？
- 是否需要 spec reviewer + code reviewer 双 review 循环（来自 archive）？
- BASE_SHA 何时记录、记录到哪里？
- git add vs git commit 的边界

**Stage 6（全量验证）**
- 是否有 gate 的必要？（当前有 gate）
- 如果验证失败，stage 应如何处理？
- 调用 `verification-before-completion` skill 还是直接描述验证步骤？

**Stage 7（代码审查）**
- 三轮 SendMessage 互审是否在实际中可行？（archive 里有，但当前版本没有）
- reviewer 的反馈如何处理（accept vs push back）？
- review.md 格式是否需要标准化？

**Stage 8（知识沉淀）**
- 哪些 skill 应该被调用？（`improve-codebase-architecture`、`claude-md-improver`、`skill-surgeon`）
- 触发 ADR 的三条件是否需要写进 stage prompt？
- 这个 stage 是否过于笼统？

### 4.3 全局流程控制问题

- **跨 session 接续**：helper.md 提到 "SessionStart hook 会在新 session 开始时自动注入当前阶段上下文"——这个 hook 实际上有实现吗？stage prompt 本身是否需要为接续做准备？
- **flow 失败回退**：某个 stage 失败时，如何回到上一 stage？stage prompt 是否需要描述这种情况？
- **stage 5 retry 机制**：某个 task 的 implementer 反复失败时，stage prompt 应如何引导 AI？

---

## 五、待实现的 Task 列表

### 优先级 P0（先做，解锁后续工作）

- [x] **T0-1**：获取 optimize-agents-md 规则，识别适用于 stage prompt 的原则，用 `skill-creator` 提炼「更新 stage 内容」skill，内置到 ai-flow 插件（`plugins/ai-flow/`）
- [ ] **T0-2**：修复 preflight.sh（添加 grill-me 检查，修正 claude-md-management 检查，恢复 feature-dev 检查）

### 优先级 P1（通用性修复，影响所有 stage）

- [ ] **T1-1**：所有 stage prompt 末尾统一为单行 signal 写入指令，移除 gate/auto-advance 解释
- [ ] **T1-2**：所有 stage prompt 头部加全局元规则（禁 commit，用 git add）
- [ ] **T1-3**：明确 stage 2/3/7 的 subagent 类型（feature-dev 系列）
- [ ] **T1-4**：按 optimize-agents-md 原则重写所有 stage prompt（依赖 T0-1）

### 优先级 P2（Stage 特定修复）

- [ ] **T2-1**：Stage 1 — 集成 brainstorming + grill-me 混合模式
- [ ] **T2-2**：Stage 5 — 添加 tdd skill 调用，重写 per-task 闭环
- [ ] **T2-3**：Stage 5 — 添加 BASE_SHA 记录机制
- [ ] **T2-4**：Stage 7 — 使用 BASE_SHA diff，添加代码片段证据要求，三轮 SendMessage 互审

### 优先级 P3（深度讨论后再动）

- [ ] **T3-1**：Stage 2 的 gate 策略重新评估
- [ ] **T3-2**：Stage 4 的 task 粒度规范
- [ ] **T3-3**：Stage 6 的 gate 必要性和失败处理
- [ ] **T3-4**：Stage 8 的细化
- [ ] **T3-5**：跨 session 接续机制验证

---

## 六、参考资料

| 资源 | 用途 |
|------|------|
| `/Users/plaud/Documents/Codes/fe-nexus/docs/archive/ai-flow/research/ai-coding-pipeline-2026-04-29.md` | 历史调研结论（可完全推翻，但作为参考） |
| `/Users/plaud/Documents/Codes/fe-nexus/docs/archive/ai-flow/ai-flow-design.md` | 历史设计稿（2026-05-11 最新版） |
| `https://www.skills.sh/plaited/development-skills/optimize-agents-md` | AI-friendly prompt 写法规范（待获取） |
| `.ai-flow/feat-flow/` | 当前 feat-flow 所有文件 |
| `plugins/ai-flow/` | ai-flow 插件源码 |
