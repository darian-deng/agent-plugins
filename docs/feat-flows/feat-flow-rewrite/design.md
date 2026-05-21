# feat-flow 设计沉淀

> 本文档是 feat-flow 重设计的完整规格 + 待办清单。下一个 session 应在 worktree 中以本文档为唯一输入推进实现。
> 起草日期：2026-05-21

---

## 一、项目概要

### 定位

**feat-flow 是一条覆盖中大型功能需求（10+ task / 数天工作量）从需求确认到知识沉淀的 AI-coding 工作流**。基于 Claude Code 的 ai-flow 引擎实现。

不适合：
- 改一行文案 / locale 文件
- 单文件小 bug 修复
- 任何小于 3 task 量级的需求

### 核心使命

让一个项目在持续被 AI 辅助开发的过程中，**context 长期保持净正向**——不随 codebase 规模扩大而让 AI coding 劣化。

### 重写前后的差异

原 feat-flow（8 stage）→ 重写后 feat-flow（6 stage）。主要修正：
- Stage 1 集成 grill-me + UI 子协议 + 项目命令探测 + TDD bootstrap 决策
- Stage 5 + Stage 6 合并为「质量门」（消除验证-审查套娃）
- 引入 ADR Consultation Protocol（跨 stage）
- 引入 Clear-Safe Persistence Principle
- 引入 Pending vocabulary 机制（task 间术语传递）
- 引入 comment vs ADR placement gate
- Bootstrap from zero（首次跑就建知识基础设施）
- 3 轮互审协议（保留 + 完善）

---

## 二、核心原则（贯穿所有 stage）

### 1. Clear-Safe Persistence Principle

**任一 stage 完成后 /clear，或多-task stage 的任一 task 完成后 /clear，下游工作不受影响。**

测试方法：对每个 stage 边界（和多-task stage 的 task 边界），问：
> 如果此刻 /clear，下游所需信息是否完全在已落盘的产出文件里？

必答"是"。否则：补落盘 / 重新设计边界。

含义：subagent 的 context 是临时的，主 session 的对话历史 /clear 会清空。**只有文件能跨 /clear 存活。**

### 2. 中大需求专用，简单需求不走

凭工程判断走简单路径还是 feat-flow，**判定从严**。

### 3. 不允许"为通过而改测试"

既有测试 break 时默认假设是 regression（修代码）。极少数情况下若测试在测 implementation detail 可改测试，但必须有 testability 理由 + 第二人复核。

### 4. 用户反对意见处理协议（任何 Gate stage 通用）

```
用户对 AI 产出有异议时不允许反射性接受。按下列流程：

步骤 1：识别异议类型
- A. 用户指出 AI 没考虑到的事实约束
- B. 用户给不同偏好但没说理由
- C. 用户的反对与 design.md 已有决策冲突
- D. 用户的反对推翻了前置 stage 已对齐的结论

步骤 2：严谨评估
- A → 接受，检查 design.md 是否需更新
- B → 不接受。要求用户给真实考量（"感觉更好"类无信息量回应不接受）
- C → 与用户逐项过现有决策。改前置决策必须先更新 design.md 含新理由
- D → 同 C

步骤 3：上游影响检查
任何被驳回的 AI 结论 → 完成本 stage 修订前必须检查 design.md 是否需更新
不允许出现「本 stage 产物反映新决策，design.md 还停留旧决策」的分裂状态
```

### 5. 全程禁 git commit 除外清单

| Stage | 允许 commit | 说明 |
|-------|------------|------|
| 1-3 | ❌ | docs 累积，等到 Stage 4 起点一次性 commit |
| Stage 4 起点 | ✅ 一次 | commit 所有 stage 1-3 docs，记录 BASE_SHA_CODE |
| Stage 4 实施中 | ✅ 每 task 一次 | implementer 完成 task 后 commit |
| Stage 5 | ✅ 每个 fix 一次 | 验证 / 审查发现的问题修复后 commit |
| Stage 6 | ❌ | 写入用 git add 暂存，用户最后自决提交 |

### 6. 命令不写死

任何 lint / typecheck / test 命令都不在 stage prompt 里写死。由 Stage 1 探测项目命令记到 design.md「项目命令」节，后续 stage 引用。

---

## 三、6-Stage 流水线

| ID | 名称 | Gate | write_scope | 关键工具 |
|----|------|------|-------------|---------|
| 1 | 需求确认 | ✅ | docs_only: `docs/feat-flows/` | grill-me + figma MCP + feature-dev:code-explorer |
| 2 | 实施蓝图 | ✅ | docs_only: `docs/feat-flows/` | feature-dev:code-architect |
| 3 | 实施计划 | ✅ | docs_only: `docs/feat-flows/` | superpowers:writing-plans |
| 4 | 代码实施 | ❌ | unrestricted | superpowers:subagent-driven-development |
| 5 | 质量门 | ✅ | unrestricted | feature-dev:code-reviewer + receiving-code-review |
| 6 | 知识沉淀 | ❌（写入分级确认） | docs_only: `docs/feat-flows/`, `docs/adr/`, CLAUDE.md 所在目录 | adr-management + claude-md-management |

**关于 docs_paths**：所有 docs_only stage 的 docs_paths 设为 `docs/feat-flows/`（去掉 `{flow_id}` 子目录限制）。AI 在 Stage 1 创建 `docs/feat-flows/<flow_id>/` 子目录写工件。flow_id 由引擎在 start 时生成（`<date>-<rand4>` 格式，已完成 task #1）。

---

## 四、每 Stage 详细规格

### Stage 1：需求确认

#### 目标
把模糊需求转成结构化的 `design.md`，含可测量 AC、UI 状态清单、决策记录、项目命令。

#### 入场动作（主 session 必做，顺序执行）

1. **ADR 一次性扫描**：
   - `ls docs/adr/`（不存在则跳过）
   - 读相关标题的 ADR（≤5 篇），注入到 system context
   - 后续 grill-me 引用 ADR 决策不必再问用户

2. **强制代码探索**：
   - dispatch ≥1 个 `feature-dev:code-explorer`
   - 等结构化报告回来

3. **项目命令探测**：
   - 读 `package.json` scripts / `pyproject.toml` / `Makefile` 等
   - 提取：单元测试 / 集成测试 / Lint / Typecheck 命令
   - 写到 design.md「项目命令」节
   - 检测不到 → 明确询问用户，**禁止凭推测填**
   - **不查 pre-commit hook**（项目级基建，不归 feat-flow 管）

4. **TDD bootstrap 检测**：
   - 查项目是否有测试框架 + 测试目录
   - 已有完整基建 → design.md 决策记录写 "TDD 基建：已有 [vitest/jest/...]"
   - 无基建 / 部分 → 询问用户：本次 feature 是否顺带建立 TDD 基建？
   - 用户决策写到 design.md 决策记录

#### 步骤

5. **调用 `grill-me` skill 启动审讯式问询**（一次一问 + 推荐答案 + 能查代码先查）
6. **UI 子协议**（若需求涉及 UI，按下方完整流程）
7. **外部技术选型**：涉及外部库 / 最新 API 时 dispatch `general-purpose` 或 `tavily-search` subagent 调研，禁止凭模型既有知识给推荐
8. **每 Q 对齐后立即增量更新 design.md**（不是问完一批批量写）
9. **AC 收集**：每条标 `[auto]`（可执行命令）或 `[manual]`（人工步骤）
10. **load-bearing 决策被拒/反复对线时**：当场提议 ADR 草稿写到 design.md「ADR 候选」节
11. **自审**（抄 brainstorming step 7 + 加一项）：
    - 是否有 placeholder（TBD / 待定 / `<具体值>`）？
    - 内部是否矛盾？
    - 是否范围漂移？
    - 是否歧义？
    - **每条 AC 是否能写成自动化测试或具体验证步骤？**

#### UI 对齐子协议（完整版）

```
步骤 1：识别 UI 来源
询问用户：A. Figma 链接 / B. 文字描述 / C. 允许 AI 提议

步骤 2：列出 UI 涉及的视图与状态维度
对每个视图按六维列出待对齐：
- 数据状态：空 / 单 / 多 / 边界
- 加载状态：初始 / 刷新 / 分页
- 错误状态：网络 / 权限 / 业务 / 校验
- 交互状态：hover / focus / disabled / loading
- 流程分支：成功 / 失败 / 取消 / 撤销 / 确认对话
- 响应式：桌面 / 移动 / 小窗

步骤 3：来源 A 处理（Figma）
- dispatch figma MCP subagent 读取设计稿
- 列 Figma 已明确画出的状态
- 不假设 Figma URL 覆盖了所有状态——用户给的常只是一个 frame

步骤 4：对每一项「未明确覆盖」进行独立代码探索（关键）
- 不依赖 Stage 1 入场时的代码探索
- 对每项 dispatch UI 探索 subagent 或主 session Grep + Read 项目：
  - 公共组件库（src/components/、design-system/）
  - 已实现的相似页面的 fallback
  - 全局错误处理 / loading / 空态

步骤 5：每一项必须显式对齐（不允许默认沿用）
找到现有复用组件：
- 呈现用户："<ComponentName>（path:line）已处理此状态，表现为 X。是否沿用？"
- 用户显式答 yes/no/需变种
- 沿用 → design.md 记 [复用 <ComponentName>，路径，已与用户确认]
未找到：
- 直接进步骤 6

步骤 6：让用户三选一
- 补 Figma URL → 回步骤 3
- 文字描述 → design.md 记 [用户文字]<描述>
- 允许 AI 提议 → design.md 记 [AI 提议，待确认]<描述>

步骤 7：gap closure 硬性要求
不允许 Signal 直到：
- 每个视图、每类维度都在 design.md 有归属
- 每项归属标来源（[Figma] / [复用 <Component>] / [用户文字] / [AI 提议]）
- 复用项含「已与用户确认」标记
```

#### design.md 最终结构

```markdown
# <需求简名>

## 需求
（不限字数）

### 不在范围内

## 约束

## 外部参考
（用户提供的链接 + 一句话用途；无则写"无"）

## 项目命令
| 用途 | 命令 |
|------|------|
| 单元测试 | <具体命令> |
| 集成测试 | <具体命令或"无"> |
| Lint | <具体命令> |
| Typecheck | <具体命令> |

## UI 设计与状态清单
（若涉及 UI；每视图六维度表格 + 来源标注）

## 决策记录
### Q1：<问题描述>
**问题**：<含候选>
**决策**：<选择>
**理由**：<why this + why not 主要替代>

### Q2：...

## ADR 候选
（grill-me 即时提议的草稿；由 Stage 6 兜底再次评估）

## 验收标准
- [auto] AC1 — 验证命令：`...`
- [manual] AC2 — 验证步骤：<打开 X，点击 Y，确认 Z>
```

#### 完成条件
- design.md 含全部规定 section
- UI gap closure 已完成（若涉及 UI）
- TDD bootstrap 决策已记录
- 项目命令已记录
- 自审 5 项 checklist 通过

#### Signal
完成所有产出后或用户明确表达"OK 进下一阶段"，用 Write 工具向 `.ai-flow/feat-flow/state/signal` 写入。

---

### Stage 2：实施蓝图

#### 目标
把 design.md 的决策翻译成可执行的实施蓝图（架构层级）。

#### 入场动作（主 session）
- ADR scan：`ls docs/adr/` + 筛与 design.md 决策相关的 ≤5 篇标题
- 把相关 ADR 路径列表作为 Curated Sources 待传给 architect

#### 步骤
1. dispatch `feature-dev:code-architect` subagent，传入：
   - design.md 全量
   - 相关 ADR 路径列表（Curated Sources）
2. 取回结构化蓝图：文件清单 / 组件接口 / 数据流 / build 顺序
3. 主 session 审视蓝图与 design.md 一致性
4. **若蓝图中决策与 design.md 冲突 → 按用户反对意见处理协议处理**
5. 追加到 `docs/feat-flows/<flow_id>/architecture.md`

#### 用户审批清单（Gate 时主动呈现）

```
请按以下 7 点审 architecture.md：

1. 覆盖：design.md 每个决策是否都在蓝图里有对应实现位置？「不在范围内」是否真没被偷偷加进来？
2. 模块定位：新建模块/文件的目录位置是否符合项目既有惯例？
3. 接口设计：每个 service / hook / API 的接口形状是否合理？参数粒度、返回值结构、是否有遗漏的关键操作（stats / list / clear 等）
4. 数据流：从 UI 触发到数据持久化（或回流）的完整链条是否清晰？错误如何冒泡？loading 状态由谁管？
5. 集成点：与既有代码的接驳（路由、i18n、错误处理、日志）是否完整？
6. Build 顺序：依赖关系是否合理？能否独立测试每一步？有循环依赖吗？
7. Bootstrap 完整性：若 design.md TDD 决策为「建立」，architecture 是否包含 bootstrap 步骤（依赖安装 + 配置 + 第一个 smoke test）？bootstrap task 是否明确标"不走 TDD"？

任一项有问题 → 直接回复指出，我会改后再 signal。
全部 OK → 运行 feat-flow approve <token> 进 Stage 3。
```

#### Signal
完成 architecture.md 后写。

---

### Stage 3：实施计划

#### 目标
将 architecture.md 转换为可逐 task 执行的 plan.md。

#### 步骤
1. 调用 `superpowers:writing-plans` skill 生成 plan.md
2. plan.md 路径：`docs/feat-flows/<flow_id>/plan.md`
3. **关键约束**（写在 stage prompt 里给 writing-plans 的输入提示）：
   - 若 design.md TDD 决策为「建立」→ Task 0 必须是 bootstrap（不走 TDD）
   - 若 design.md TDD 决策为「已有」或「建立」之后 → 后续 task 走 TDD
   - 若 design.md TDD 决策为「不建立」→ task 不走 TDD（implementer 只写实现 + 跑既有验证）

#### 用户审批
plan.md 审 task 粒度、AC 可验证性、依赖顺序、覆盖完整性。

#### 决策：是否在 Stage 3 prompt 加 "one red-green pair per task" 约束？
**否**。已通过 round 1-2 subagent 评审确认：writing-plans 默认就是 vertical slicing（一个 task 一个 red-green pair），我们之前担心的 horizontal slicing 是基于对 writing-plans 的误读。无需额外约束。

#### Signal
plan.md 通过自审后写。

---

### Stage 4：代码实施

#### 目标
按 plan.md 逐 task 实施，每 task 一 commit，全部由 subagent 完成。

#### 入场动作（主 session 必做）

**Step 0：Stage 4 起点 commit + 记录 BASE_SHA_CODE**
```sh
git add docs/feat-flows/<flow_id>/
git commit -m "docs: <feature> stage1-3 outputs"
git rev-parse HEAD > .ai-flow/feat-flow/state/base_sha_code
```

**Step 1：ADR scan**
- `ls docs/adr/` + 筛与本 flow 涉及模块相关的 ADR 路径列表

**Step 2：前置读取**
- design.md / architecture.md / plan.md 全量

#### 主循环：调用 SDD

**调用** `superpowers:subagent-driven-development` 执行 plan.md。

**对 SDD 默认 implementer-prompt 的修改**（基于我们三工件拓扑）：

每个 task 的 implementer prompt 改为：
```
## Task Description
<plan.md 该 task 完整文本，paste-in>

## Curated Sources（按需读取，不要批量加载）
- docs/feat-flows/<flow_id>/design.md
- docs/feat-flows/<flow_id>/architecture.md
- docs/feat-flows/<flow_id>/plan.md（仅前后 task 上下文用，禁止跨 task 拿活）
- <相关 ADR 路径列表>
- <Pending vocabulary：前置 task 累积的 NEW_TERMS_OR_PATTERNS>
- git log / git show <commit>（前置 task 已实现细节）

## Focus 约束
- 专注本 task，不探索本 task 范围外的代码或议题
- 优先按 task 描述里的 file:line 直读
- 用 git show 看前置 task diff，不读整个文件

## 本 task 实施要求
- 走 TDD（若 plan task 标注要走）
- 实施完成后跑【全量单元测试】（design.md 项目命令.单元测试），不仅本 task 新写的测试
- 既有单测 break：默认假设是 regression，修代码而非改测试
- 极少数情况认为测试在测 implementation detail → DONE_WITH_CONCERNS 附建议改测试的理由
- 不跑 lint / typecheck / 集成测试（Stage 5 职责）
- 局部决策（≤5 行注释或文件顶部注释能说清的 why）必须在代码位置加 inline / file-top 注释，**不要积到 Stage 6 再评 ADR**
- 删注释 ≥3 行必须在 task report 写理由

## Report Format（在 SDD 默认基础上加）
- INLINE_COMMENTS_ADDED：在哪些代码位置加了哪些 WHY 注释
- NEW_TERMS_OR_PATTERNS：本 task 引入的术语候选（如 "LRUEvictionPolicy"），建议进 rules
- ADR_CANDIDATES：跨文件性质的决策候选（建议 Stage 6 评 ADR）
- COMMENT_DELETIONS：删除注释 ≥3 行的位置 + 理由
- 其他沿用 SDD 默认（DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED + 自审 + Files Changed 等）
```

#### NEEDS_CONTEXT 处理（严于 SDD 默认）

```
implementer 报 NEEDS_CONTEXT 时主 session：
1. 检查问题答案是否在三份 docs / ADR 列表里
2. 在 → 改 implementer prompt 加更明确指向，重 dispatch 一次。仍 NEEDS_CONTEXT → 停下问开发者
3. 不在 → 直接停下问开发者，不允许凭空补答案

理由：主 session 的信息源就是这些 docs。subagent 读了还问 = 文档真缺信息 = 主 session 也编不出。
```

#### BLOCKED 处理

```
按 SDD 规则尝试一次（补 context / 换模型 / 拆 task / plan 错 → escalate）。
第 2 次同一 task BLOCKED → 停下问开发者。
```

#### Pending vocabulary 注入

主 session 在 dispatch 第 N 个 task 时，把已完成 task 的 NEW_TERMS_OR_PATTERNS 段合并起来，作为 Curated Sources 的「Pending vocabulary（未正式入 rules）」注入下一个 implementer。

#### Stage 4 完成判定
- plan.md 所有 task 标 [x]
- `.ai-flow/feat-flow/state/base_sha_code` 文件存在
- 全部 task 都有对应 commit

#### Signal
所有 task 完成后写。

---

### Stage 5：质量门（验证 + 审查合并）

#### 目标
对所有改动做完整自动化验证 + 互审审查，确保提交前代码质量。

#### 步骤

**A. 自动化检查**
按 design.md 项目命令运行：
- 全量单元测试
- 全量集成测试（如有）
- Lint
- Typecheck

失败 → 修代码（既有测试破坏纪律：默认改代码不改测试，除非有 testability 理由 + 第二人复核）→ 重跑直到全过。每个 fix 一个 commit（`fix: <issue>`）。

**B. 代码审查（3 轮互审，硬上限）**

```
轮 1：dispatch feature-dev:code-reviewer subagent
- 传入：
  - git diff <BASE_SHA_CODE>..HEAD
  - design.md（含决策记录，已对齐决策不得再质疑）
  - architecture.md
  - 相关 ADR 路径列表
- 不传 plan.md（避免审查被实施过程影响）
- 要求每 issue 附 ≤5 行代码片段证据，confidence ≥ 80（feature-dev:code-reviewer 自带过滤）

主 agent 按 receiving-code-review 纪律逐条处理：
- 严禁 "You're absolutely right!" / "Great point!" / 任何 thanks
- 每条先 VERIFY against codebase reality
- 严禁 performative agreement
- 三种特殊处置：
  · YAGNI 检查：reviewer 提"应该实现 X / 完善 Y / 添加 Z" 类 → 先 grep 该功能是否真有调用方，无调用 → pushback "YAGNI"
  · 架构级冲突：若 reviewer issue 挑战 design.md 已记录的决策（非 implementation 细节） → 直接列入 review.md「待开发者决策（架构级）」，不进 3 轮循环
  · 既有测试质疑：reviewer 建议改测试 → 应用既有测试破坏纪律
- 处理顺序：clarify 不清楚的 → blocking → simple fixes → complex fixes，每条修完单独跑测试
- accept → 修代码，记 review.md「已解决」
- pushback → review.md「分歧」记反证（≤5 行片段）

轮 2：SendMessage 同一 reviewer subagent
- reviewer 用 git diff 验证每个 accept 项的修复
- 重新评估 pushback 项（结合反证）
- 返回：验证通过 / 撤回 pushback / 仍坚持

轮 3（仅当有剩余分歧）：SendMessage 发分歧项 + 双方完整立场
- reviewer 给最终理由
- 主 agent 仍不认同 → review.md 标「需开发者决策 + 双方立场」

3 轮后任何剩余分歧 → 停下来等开发者，不再循环
```

**C. code-reviewer 硬性 checklist（写进轮 1 dispatch prompt）**
1. 改动函数所在文件的相邻 ±20 行注释是否仍准确？（抓注释 drift）
2. 跨 task 一致性：术语 / 命名是否一致？数据结构跨文件是否对齐？
3. ADR 合规：本次代码改动是否违反既有 ADR？issue 必须引 ADR ID 作证据
4. 删除的注释 ≥3 行：implementer 是否在 task report 写了理由？理由是否充分？

#### review.md 结构

```markdown
# 代码审查

## 审查范围
BASE_SHA_CODE: <SHA>

## 问题处理

### 已解决
- <问题描述>：<修复方式> — 证据：`<≤5 行片段>`

### 已反驳
- <问题描述>：<反证：≤5 行片段>

### 待开发者决策（架构级）
- <问题描述>：reviewer 立场 + author 立场
（这类 issue 不进 3 轮循环，直接列出）

### 测试调整记录
- <如有> 改测试的位置 + 理由 + 复核者意见

## 结论
<总体评估>
```

#### 完成条件
- 自动化检查全过（最后一个 commit 后跑一次确认）
- review.md 存在且完整
- 所有「已解决」类问题已修复 + commit
- 「待开发者决策」类问题由开发者拍板后已应用

#### Signal
满足完成条件后写。

---

### Stage 6：知识沉淀

#### 目标
让本次 flow 让项目 context 净正向（新增 + 修复 + 退役 + 归档，非 add-only）。

#### 前置读取
- design.md（决策记录 + Stage 1 ADR scan + 累积 NEW_TERMS_OR_PATTERNS）
- review.md（互审结论 + 待开发者决策项）
- docs/feat-flows/<flow_id>/ 全部工件

#### Phase A：自动评估（不写文件）

**A1. 解析写入根目录（monorepo 兼容）**
- 列本次 flow 涉及的所有改动文件路径
- 计算「最深公共祖先目录」
- CLAUDE.md / rules 写入对象 = 该目录的 CLAUDE.md（不是 root）

**A2. ADR 候选评估（四闸门）**

```
gate-1（term-anchor 测试）：
  Q：该决策能 grep 出 ≥2 既存文件支持，且 pattern 在 CLAUDE.md / rules/ 已被命名（有"术语锚点"）？
  YES → 跳过 ADR（已被代码 + 命名覆盖）
  NO  → 进 gate-2

gate-2（三条件）：
  1. 难以反转
  2. 无上下文会让人困惑
  3. 真 trade-off（存在 alternative 且有理由选择）
  全 YES → 进 gate-2.5
  任一 NO → 跳过

gate-2.5（placement: comment vs ADR）：
  Q：决策的"为什么"能用以下任一形式说清楚吗？
     a. 某一处具体代码位置的 inline 注释（≤5 行）
     b. 文件顶部的 file-level 注释（涉及该文件整体目的/组织时）
  YES → 在对应位置写注释，不写 ADR
  NO（跨文件 / 跨模块 / 涉及架构层级决策） → 进 gate-3

gate-3（冲突 + supersede 检测）：
  - grep docs/adr/ 检查是否覆写既有 ADR
    → YES：起草 new ADR 标 "Supersedes ADR-NNNN" + why-changed
    → NO：起草 new ADR
  - grep 新 ADR 关键术语命中的其它 ADR
    → 列给用户判断是否冲突（仅提示不自动判定）
```

**A3. CLAUDE.md drift 评估（含 bootstrap）**
- `test -f <写入根目录>/CLAUDE.md`
- 存在 → 调 `claude-md-management:revise-claude-md`（仅扫不写）
- 不存在：
  - 本次 flow 有 rule 候选 → 用 claude-md-management 初始化 + 写本次候选（用户确认）
  - 本次无候选 → 跳过

**A4. NEW_TERMS_OR_PATTERNS 收集 + 跨目录冲突检测**
- 从 task report 收集 implementer NOTES
- 评估哪些进 rules：「未来 ≥2 task 会重复 + 没 rule 时 AI 默认走错」
- monorepo 跨目录检查：`grep -r "<term>" rules/` 命中多处时提示用户

**A5. rules 体积反向闸门**
- 涉及目录的 rules/*.md 体积 >300 行 → 跳过本次写入，建议运行 `improve-codebase-architecture` 重整

**A6. 工件归档评估**
- 列 docs/feat-flows/<flow_id>/ 工件
- 含 supersede 候选的 design.md → 保留作历史依据
- 普通 plan.md / review.md → 建议移到 docs/feat-flows/archive/<flow_id>/

#### Phase B：分级用户确认

**Tier-A（必须逐项确认 yes/no）**
- 新建 ADR（每条单独）
- CLAUDE.md 直接写入（每条 diff 展示）
- Supersede 既有 ADR（高风险）
- ADR 关键术语命中其他 ADR 的冲突提示（用户判断）

**Tier-B（批量确认带 diff）**
- rules/<domain>.md 追加术语
- 工件归档（一句话清单）

#### Phase C：写入
- 新 ADR → 调用 `adr-management new` skill 写入 + 重建索引
- CLAUDE.md → 调用 `claude-md-management:revise-claude-md` 写入
- Supersede → 调用 `adr-management supersede` skill 双向链接
- rules → 追加（不直接 Write，用 skill if available）
- 归档 → `git mv`
- 全用 git add 暂存，**不 commit**（用户最后自决）
- design.md 末尾追加「Stage 6 沉淀记录」

#### 完成条件
- A 全跑完
- B 用户对所有候选明确响应
- C 已写入所有 yes 项

#### Signal
完成 Phase C 后写。

---

## 五、横切协议汇总

### ADR Consultation Protocol（多 stage 注入）

| Stage | 何时查 ADR | 怎么注入 |
|-------|----------|---------|
| Stage 1 | 入场即扫，grill-me 给推荐答案前 | 主 session `ls docs/adr/` + 筛 ≤5 篇 → system context |
| Stage 2 | dispatch architect 前 | 相关 ADR 路径作为 Curated Sources 传给 architect |
| Stage 4 | dispatch implementer 前 | 与 task 模块相关的 ADR 路径列表作为 Curated Sources |
| Stage 5 | reviewer 评审时 | 主动 Read，issue 必须引 ADR ID 作证据 |
| Stage 6 | gate-3 supersede / 冲突检测 | 自身职责 |

**约束**：禁止全量加载 ADR 目录。只 ls 标题，按相关性选读。

**enforce 机制**（不只靠 prompt 提醒）：在每个 stage 入场 / dispatch 前，**主 session 主动执行 ADR scan**，把结果作为硬步骤注入下游 prompt。不依赖 subagent 自己记得查。

### 3 轮互审协议（Stage 5 用）

见 Stage 5 详细规格。

### Clear-Safe Persistence Principle

见第二节。

### 用户反对意见处理协议

见第二节。

### 既有测试破坏纪律

见第二节 + Stage 4 / 5 详细规格。

### UI 对齐子协议

见 Stage 1 详细规格。

---

## 六、adr-management skill 完整规格

### 定位
仅通过 `/ai-flow:adr` 命令显式调用。绝对不要基于任何关键词自动触发。内部智能识别用户意图。

### 调用模式

**用户直接调用**：
```
/ai-flow:adr 我刚做了一个用 IndexedDB 替代 SQLite 的决策
→ skill 路由到 new
```

**feat-flow stage 调用**：
```
（Stage 6 prompt 中）调用 adr-management skill 起草新 ADR：内容是 <从 design.md 决策记录提取>
→ skill 路由到 new
```

### 内部路由

| 用户/调用方说 | 路由到 |
|--------------|-------|
| "新加 ADR" / "记一下这个决策" | new |
| "ADR-12 已经过时了" / "用新决策替代旧的" | supersede |
| "项目还没 ADR" / "初始化" | bootstrap |
| "重建索引" / "ADR 列表乱了" | index |
| "查一下提过 X 的 ADR" | grep |
| "列出 ADR" | list |
| 模糊 | 反问用户「新建 / 修改 / 查询 / 其他？」 |

### 子能力详细规格

#### `adr new <自然语言描述>`
- 自动分配 NNNN 编号（扫描 docs/adr/ 找最大编号 +1）
- Nygard 模板：
  ```markdown
  # ADR-NNNN: <Title>

  - Status: Accepted
  - Date: YYYY-MM-DD

  ## Context
  <为什么需要这个决策>

  ## Decision
  <选择是什么>

  ## Consequences
  <带来的后果，含 positive + negative + neutral>

  ## Alternatives Considered
  <考虑过的其他方案 + 为什么没选>
  ```
- 自动更新 docs/adr/README.md 索引

#### `adr supersede <old-id> <new-content>`
- 创建新 ADR，标 "Supersedes ADR-<old-id>"
- 旧 ADR header 加 "Status: Superseded by ADR-<new-id>"
- 双向链接

#### `adr index`
- 重建 docs/adr/README.md 索引表
- 表头：编号 / 标题 / 状态 / 日期 / Supersedes / Superseded by
- 按编号排序

#### `adr list [--status accepted/superseded/deprecated]`
- 按状态筛选
- 返回简短列表（编号 + 标题 + 状态）

#### `adr grep <term>`
- ADR 内容内搜索
- 返回命中条目 + 上下文片段

#### `adr bootstrap`
- 项目从零初始化 docs/adr/
- 创建 docs/adr/README.md 模板（含使用说明）
- 创建 docs/adr/0000-record-architecture-decisions.md（meta ADR：why we use ADRs）

### 实现路径
1. 用 `/skill-creator` 起手生成 SKILL.md 骨架
2. 在 plugins/ai-flow/skills/adr-management/ 完整实现
3. 加到 plugins/ai-flow/.claude-plugin/plugin.json 的 skill 注册
4. preflight.sh 检查 skill 安装

---

## 七、配套 skill 修改清单

### create skill（plugins/ai-flow/skills/create/SKILL.md）

用 `/skill-surgeon` 修改，新增以下内容：

#### A. Clear-Safe Persistence Principle（加在「全局连贯性校验」section 增补）

完整内容见本文档第二节。包含：
- 原则陈述
- /clear 测试方法
- 常见违反模式（错误 vs 正确对照）
- Stage 拆分决策三问 + 实例对照表

#### B. Signal 触发条件（修改现有 Signal 描述）

当前：
```
向 `.ai-flow/{flow-name}/state/signal` 写入任意内容。
```

改为：
```
**触发条件**：本阶段「完成条件」全部满足，**或**用户明确表达本阶段已完成。
**动作**：用 Write 工具向 `.ai-flow/{flow-name}/state/signal` 写入任意内容（Bash 写入会被引擎拒绝）。
```

#### C. 任务拆解指南（加在「第三阶段：生成文件」section）

```
若 stage 包含多个独立 task：
- 在 stage prompt 中要求 AI 维护一个 task 列表文件（如 plan.md）
- 每个 task 含 AC，完成一个就 [ ] → [x]
- 这样 /clear 后 AI 能通过读文件恢复进度
- Task 粒度建议 2-5 分钟 AI 工作量
```

#### D. 用户反对意见处理协议（加在「第三阶段：生成文件」section，作为可复用模板）

完整内容见本文档第二节。

#### E. Stage 模板顶部固定结构（加在「第三阶段：生成文件」section）

```
推荐的 Stage prompt 顶部固定结构：

# Stage N：<阶段名>

> <flow-name> 第 N/M 步 · [流程总览](../helper.md)
> 后续：Stage N+1（<名> · Gate/无 Gate）
> 当前 stage 目的：<一句话>

> **元规则**：<本 stage 的 commit 政策>
```

### update skill（plugins/ai-flow/skills/update/SKILL.md）

用 `/skill-surgeon` 修改：

#### F. 加 Clear-Safe 检查（在「第五步：分析改动的合理性」第 6 项）

```
6. Clear-Safe 检查：改动是否破坏「任一 stage / task 后 /clear，后续仍可执行」承诺？

测试方法：
- 模拟在改动涉及的 stage 末尾 /clear
- 检查下一 stage 所需信息是否全部在落盘的产出文件里
- 不在 → 改动必须包含"补落盘"机制，或调整边界

常见违反场景：
- 新加 stage 依赖前 stage 的 subagent 探索细节（subagent context 已销毁）
- 调整 stage 顺序后，前置依赖的产出还没生成
- 合并 stage 后，原来分两次 gate 审的内容压成一次 gate，但产出未对应合并
```

---

## 八、engine 改动

### 已完成（Task #1）
- `plugins/ai-flow/src/lib/commands/start.ts:12-15` 修改 `generateFlowId`
- 从 `flowName-rand6` 改为 `<date>-<rand4>` 格式
- 不再需要 flowName 参数

### 无其他 engine 改动

---

## 九、已知偏离 upstream + 风险声明

### 偏离 1：SDD 默认 implementer-prompt Context 模式

**SDD 默认**：主 session 粘贴 task 全文 + 主 session 构造 architectural context  
**feat-flow 改为**：主 session 给 task 文本 + 给 Curated Sources（design.md / architecture.md / plan.md / 相关 ADR / Pending vocabulary），subagent 按需读

**理由**：
- 我们有 3 个精华工件，SDD 假设的"1 工件 + 原始代码库"拓扑不成立
- 主 session 反复构造 context 烧 token 且易漏
- subagent 读策划过的文档不是游荡

**剩余风险**：
- subagent 可能游荡 → 跑通几个 flow 后观察
- 游荡频发 → 回退到 SDD 默认（主 session 构造）

### 偏离 2：NEEDS_CONTEXT 不允许主 session 凭推测补答

**SDD 默认**：主 session 处理 NEEDS_CONTEXT（可补 context、可换模型）  
**feat-flow 改为**：第 1 次 NEEDS_CONTEXT → 主 session 检查问题答案是否在 docs 里，在 → 改 prompt 重 dispatch 一次；不在 → 直接 escalate 开发者

**理由**：主 session 信息源 = docs。subagent 读完还问 = docs 缺，主 session 也编不出。

**剩余风险**：开发者打断频次可能增加 → 接受，符合 ai-flow gate-heavy 哲学。

### 偏离 3：mattpocock tdd 不在 SDD 内使用

**参考文档原方案**：用 0-foundation.mdc override 强制 SDD 内 implementer 用 mattpocock tdd  
**feat-flow 改为**：不做 override，SDD 内用其自带的 superpowers test-driven-development

**理由**：mattpocock tdd Workflow 1 要求"Confirm with user"，fresh subagent 无用户通道，本质冲突。

**风险**：horizontal slicing 防护更弱 → 由 plan 阶段的 task 粒度约束代偿（writing-plans 默认就是 vertical slice）。

---

## 十、剩余待办（下一 session 执行）

### Task #2：新建 adr-management skill
**目标**：plugins/ai-flow/skills/adr-management/SKILL.md + 配套 reference 文档  
**关键步骤**：
1. 用 `/skill-creator` 在主 session 起手对话产 skill 骨架
2. 完整实现 7 个子能力（new / supersede / index / list / grep / bootstrap + 智能路由）
3. 加到 plugins/ai-flow/.claude-plugin/plugin.json 的 skill 列表
4. 在 plugins/ai-flow/.ai-flow/feat-flow/preflight.sh 加 adr-management 安装检测  
**Acceptance**：
- 能用 `/ai-flow:adr` 调用并自动路由
- 创建 ADR 自动分配编号 + 更新索引
- supersede 自动双向链接
- bootstrap 能在空项目初始化

### Task #3：create skill 修补
**目标**：plugins/ai-flow/skills/create/SKILL.md 加 5 项内容（见本文档第七节 A-E）  
**工具**：`/skill-surgeon`  
**Acceptance**：5 项内容齐全 + skill 跑通 sanity test（创建一个虚构 flow 验证 prompt 风格符合新要求）

### Task #4：update skill 修补
**目标**：plugins/ai-flow/skills/update/SKILL.md 加 1 项（见本文档第七节 F）  
**工具**：`/skill-surgeon`  
**Acceptance**：第五步含 Clear-Safe 检查

### Task #5：重新生成 feat-flow 全套文件
**目标**：删 plugins/ai-flow/.ai-flow/feat-flow/ 旧文件，按本文档规格生成新文件  
**清单**：
- config.json（6 stages，docs_paths 改为 `docs/feat-flows/`）
- stages/stage-1.md ~ stage-6.md（按本文档第四节每 stage 详细规格）
- helper.md（含哲学说明 + 6 stage 列表 + 命令速查 + 环境要求）
- preflight.sh（去 pre-commit hook 检测，加 adr-management 检测）
- scripts/（如有 Script Validator 需求）  
**Acceptance**：
- claude plugin validate 通过
- feat-flow start <某个测试需求> 能起跑且 Stage 1 prompt 注入正常

### Task #6：版本号 bump + commit + push
- plugins/ai-flow/package.json: 0.12.0 → 0.13.0
- plugins/ai-flow/.claude-plugin/plugin.json: 0.12.0 → 0.13.0
- .claude-plugin/marketplace.json: ai-flow 条目 0.12.0 → 0.13.0
- commit 信息：`feat(ai-flow): redesign feat-flow with 6-stage knowledge-stewardship architecture`
- push 到 main 触发 CI build dist/

---

## 十一、依赖关系

```
Task #1 (engine) [✅ 完成]
   ↓ 独立
Task #3 (create skill) ─┐
Task #4 (update skill) ─┤  ← 可并行
Task #2 (adr-management)┘
   ↓ 全部完成后
Task #5 (feat-flow 文件)
   ↓
Task #6 (版本 bump + commit)
```

并行可能性：
- Task #2, #3, #4 互相独立，可并行进展（但 skill-creator / skill-surgeon 一次只能 invoke 一个 skill 流程，实操是串行）
- Task #5 必须等 #2 #3 #4 完成（feat-flow prompt 会引用 adr-management 调用方式）

---

## 十二、本设计的元决策（why we made these choices）

为了未来回看时不丢失上下文，记录几个关键元决策：

1. **为什么 6 stage 而不是 8**：原 feat-flow 的 Stage 5（验证）和 Stage 6（审查）会套娃修复，合并避免；UI 对齐合进 Stage 1 因为它与功能性决策耦合强

2. **为什么不写死 lint 命令**：feat-flow 要做到任意项目通用，不能假设 npm / pnpm / cargo

3. **为什么 adr-management 是独立 skill 而非 stage 内嵌**：ADR 管理有结构性需求（编号 / 索引 / supersede 链接），AI 自由发挥会写出不一致的格式

4. **为什么 Stage 4 不跑 lint**：lint 是 pre-commit 兜底职责，feat-flow 不替项目做基建工作

5. **为什么 implementer 用 Curated Sources 模式**：我们有 3 个精华工件（不是 SDD 假设的 1 工件 + 原始代码库），主 session 反复构造 context 浪费 + 易漏

6. **为什么 NEEDS_CONTEXT 严于 SDD 默认**：主 session 信息源 = docs，subagent 读完还问 = 结构问题，主 session 凭推测会做错事

7. **为什么 ADR 加 gate-2.5 (comment vs ADR placement)**：业界 ADR 实践没明确划分 inline 注释 vs ADR 的边界，导致 docs/adr/ 充斥低价值条目。明确"能写在注释里就写注释"避免 ADR 膨胀

8. **为什么 Stage 6 评估写入分离**：避免用户一次性 yes 全过笼统化沉淀

9. **为什么 bootstrap from zero**：feat-flow 是项目知识管家，从第一次跑就建基础设施才有连续性，不能"等用户先手动建"

---

## 附录：本设计的来源

本设计经过约 25 轮 grilling 形成，期间：
- 3 次 subagent 对立评审（最终一轮明确 GO + 2 微调）
- 多次基于 SKILL.md 实际内容修正基于推测的判断
- 主 session 多次主动撤回错误立场（撤回理由：新证据 / 用户证据驱动）

文档作者立场反转记录：
- 撤回「单个 architect」硬约束（YAGNI）
- 撤回「one red-green pair per task」约束（基于对 writing-plans 误读）
- 撤回「Stage 1 即时构造 implementer context」（让 subagent 自服务）
- 撤回「skip if no docs/adr/」（bootstrap from zero）
- 撤回「UI 放 Stage 2」（保留 Stage 1，但 UI 协议升级）

参考资料：
- `/Users/plaud/Documents/Codes/fe-nexus/apps/plaud-desktop/docs/ai-coding-pipeline-2026-04-29.md`（R1-R10 决策论证）
- superpowers / mattpocock / feature-dev skill 实际 SKILL.md
- claude-md-management plugin
- ai-flow 引擎源码（plugins/ai-flow/src/lib/）
