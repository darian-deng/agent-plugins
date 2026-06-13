# feat-flow

## 这是什么

**为中大型功能需求优化的 AI-coding 工作流**。基于 Claude Code 的 ai-flow 引擎实现，覆盖从需求确认到知识沉淀的 6 个阶段。

## 核心使命

按重要性排序：

1. **保障需求的交付质量高**：通过结构化决策、TDD 实施、缺陷右移的多层独立审查（架构审查 + 组装级双视角 + 3 轮验证）、可验证 AC 等机制，让每次交付都经得起审视
2. **团队能按一套规范落地和实践**：固定的 6 stage 流水线 + 文档结构 + 工具调用约定，让不同人在不同需求上产出一致质量
3. **context 长期保持净正向**：通过 ADR 治理、CLAUDE.md 漂移修复、注释保鲜等机制，确保项目越大 AI coding 越好，而非越差

## 设计哲学（贯穿所有 stage）

| 原则 | 含义 |
|------|------|
| **/clear 安全持久化** | 任一 stage 后 /clear 不破坏下游。所有跨 stage 信息必须落盘文件 |
| **ADR 查阅协议** | 每个 stage 入场扫 docs/adr/ 注入相关 ADR，避免 AI 重新提议已被否决的方案 |
| **待沉淀术语** | Stage 4 task 间术语传递，避免命名漂移 |
| **注释与 context 归置** | 优先用代码注释（file header / block / inline）；只有命中以下 4 类才往 context 层走：缘由类（非显然选择或绕过更自然做法）、否定类（验证某方案不可行）、约定类（不确定是否已记录的命名/架构惯例）、边界类（依赖外部条件、条件变化会静默失效）——各类按 ADR / rules / CLAUDE.md / skill 路由，同时命中时多者均记 |
| **从零自建基建** | 首次跑就建知识基础设施（docs/adr/、CLAUDE.md），不等开发者手动建 |
| **缺陷右移到最早可捕获点** | 每类缺陷在信息最早齐备的 stage 抓：需求理解→stage-1，架构/复用→stage-2，局部 bug→stage-4 每 task，组装级（跨 task 一致/集成/需求闭环/整体安全）→stage-5。同一缺陷不在多 stage 重复地毯审 |
| **3 轮验证** | 派发+综合处理记为轮 1，阻塞项修复后由独立 reviewer 复核轮 2、轮 3（硬上限 3 轮），分歧上报开发者——既防模型幻觉（独立复核把失败率 5% 压到 5%×5%）也避免无限循环 |
| **前置产物修订** | 中后期 stage 发现「前面已对齐的东西要改」时（开发者异议 或 AI 自查），按 L1（abort）/ L2（回改 + 下游兜底）/ L3（inline）分级，并评估对**全部**上游产物的影响，禁止 AI 自判 L3 后默默改（详见 `references/revision-protocol.md`） |

## 命令速查

```sh
feat-flow start <自然语言需求描述>   # 启动新 flow，引擎生成 flow_id (<日期>-<rand4>)
feat-flow approve                    # 通过当前 Gate
feat-flow abort                     # 中止当前 flow（创建快照到 docs/feat-flow/<flow_id>/）
feat-flow resume                    # 在新 session 中恢复 flow
feat-flow status                    # 查看当前 stage 和状态
feat-flow help                      # 查看本文档
```

## 6 Stage 流水线

| ID | 名称 | Gate | 关键工具 |
|----|------|------|---------|
| stage-1 | 需求确认（含需求源摄入 / ADR 查阅 / 项目命令 / TDD 基建 / UI / 独立审计） | ✅ | grounded-design + figma MCP + tavily-extract/lark-doc（需求源）+ general-purpose（调研/审计） |
| stage-2 | 实施蓝图（+ 独立架构/复用审查） | ✅ | feature-dev:code-architect + general-purpose（架构审查） |
| stage-3 | 实施计划（plan 原生格式：decisions 切片 + 执行单元；AI 内部三轮 review + 四道结构门，有分歧才 gate） | ❌（内部 review 无分歧时无 Gate） | general-purpose（三轮内部 review）；self-review checklist 内联，无外部 plan skill |
| stage-4 | 代码实施（按执行单元串行派、机械拼装、截断自保护） | ❌（无 Gate） | subagent-driven-development + optimize-claude-context（implementer 子代理跑 assess-candidate 沉淀知识） |
| stage-5 | 质量门（回归 + 组装级双视角 + 人审闭环：集成闭环 + 强制安全 + 人工 review→修复→最终 CR） | ✅ | general-purpose（集成 + 安全 双视角）+ receiving-code-review + optimize-claude-context（assess-candidate 源头过滤 context 候选） |
| stage-6 | 知识沉淀（代码 squash 成单 feat 提交 + 增 / 修 / 退役） | ✅（汇总表即 gate 呈现，approve 结束流程） | optimize-claude-context（handle-one-directive 单工具覆盖 CLAUDE.md/rules/skills/ADR 全 4 层） |

## 产出文件路径

```
docs/feat-flows/<flow_id>/
├── design.md                # 需求 / 决策记录 / UI 状态 / 项目命令 / AC（Stage 1 起累积）
├── architecture.md          # 模块定位 / 接口 / 数据流 / build 顺序（Stage 2）
├── plan.md                  # Task 列表（Stage 3 起，Stage 4 维护 [x] 进度）
├── task-reports.md          # Stage 4 每 task 的元信息累积（新术语 / ADR 候选 等）
├── review.md                # 审查结论 + 待开发者决策（Stage 5）
└── context-delta.md         # Context 变化提案（Stage 2 创建，Stage 5 追加，Stage 6 读取）

.ai-flow/feat-flow/state/
├── active.json              # 引擎维护（flow_id、current_stage、base_sha 等；含 base_sha_code 字段：Stage 4 起点 SHA，天然 flow-scoped）
├── signal                   # AI → 引擎 完成信号（内容语义化，见下方说明）
├── transitions.log          # 引擎记录 stage 切换历史（状态机事件）
└── hooks.log                # hook 执行诊断（SESSION / SIGNAL_INTERCEPT / GATE_SIGNAL_WRITTEN / ADVANCED）

**signal 文件语义**：AI 统一写入固定关键词 `done`，引擎自动计算下一步：
- 任意 stage 完成（包括最后一个 stage）→ 写 `done`
- 引擎会拒绝非 `done` 的写入（幻觉防护：AI 不需要知道 stage id）
- signal 存在且为 `done` = 当前 stage 已申请推进

写入后有两种行为，由 stage 配置决定：
- **有 Gate 配置的 stage**：引擎暂停，等待开发者 `feat-flow approve`；AI 向开发者呈现产物摘要并等待确认
- **无 Gate 配置的 stage**：引擎立即推进，AI 无需等待开发者确认

session 恢复时引擎会读取 signal 内容自动识别当前状态（gate 等待、自愈推进或正常恢复）

docs/adr/                    # Stage 6 写入；首次出现 ADR 候选时由 handle-one-directive 按需创建目录 + README 索引
<deepest-common-ancestor>/CLAUDE.md  # Stage 6 写入（monorepo 兼容路径解析）
```

## 环境要求

### 必需 skills

用 `ls ~/.claude/skills/` 检查：
- `grounded-design` — Stage 1 接地式需求拆解（来自 [darian-deng/agent-skills](https://github.com/darian-deng/agent-skills)）
- `subagent-driven-development` — Stage 4 实施
- `receiving-code-review` — Stage 5 处理反馈
- `optimize-claude-context` — Stage 6 治理全 4 层 context：CLAUDE.md + .claude/rules/ + .claude/skills/ + **ADR**（其 `handle-one-directive` 的 Priority 4 路由到 ADR，自带跨层冲突检测、ADR 重叠 → 原地更新 / supersede、README 索引维护；来自 [darian-deng/agent-skills](https://github.com/darian-deng/agent-skills)）

### 必需 plugins

- `feature-dev` — 提供 code-architect（Stage 2 蓝图）subagent

> Stage 2 的架构/复用审查、Stage 5 的集成与安全双视角审查均用内置 `general-purpose` 子代理（审查专长写在 stage 提示词里），不依赖额外插件。

### ai-flow 本身（已自带）

- `create` / `update` / `add` / `optimize-stage-prompt` skill

### 可选但推荐

- `tavily-search` / `tavily-extract` — Stage 1 外部技术调研
- figma MCP — Stage 1 UI 设计读取

### 系统

- Node.js ≥ 18
- git
- claude CLI（feat-flow 仅在 Claude Code 内运行）

## 已知偏离 upstream

stage-3/4 重构详见 `docs/feat-flows/stage-3-4-redesign/design.md`（含对抗审查处置）。简要：

- **plan 原生格式（feat-flow 自有，不依赖 writing-plans；self-review checklist 已内联进 stage-3）**：每 task = `unit`（执行单元 id）+ `done`（行为断言）+ `verify`（Stage 3 预推导，非运行时）+ `read_first` + `decisions`（决策切片，带 `⟵ 来源`）+ `files`（**符号锚点，禁行号**）+ 可选 `depends_on` / `touches_shared` + `output_size` + 可选 `contract`（stub）。plan 末尾含「执行单元清单」。
- **粒度三硬门**：语义内聚 ∧ files≤3–4 ∧ output_size 装得进单上下文（`large` 拆骨架+填充；体量靠「数 architecture 已列明成员」估，未列全则退回 Stage 2）。
- **decisions 切片取代 design.md 默认注入**：管每个 task 的决策内联进 plan（矩阵投影 + 四类过滤 + 四道结构门）；design.md/architecture.md 全文降级为 Stage 4 兜底路径。
- **Stage 4 = 机械执行器**：按执行单元串行派（**绝不并行**）、dispatch 机械拼装、`touches_shared` 注入前序 diff、**截断自保护协议**（近上限先 commit + 写「剩余工作」清单，续跑读清单不做 git 考古）、耦合簇内逐 task commit/verify + 越界升簇并集层、verify 假绿检测。
- NEEDS_CONTEXT 处理严于 SDD 默认（一次重 dispatch 失败即 escalate 开发者，不允许主 session 凭空补答；反复缺护栏 = decisions 漏 → 回补 plan）。
- **cwd 漂移防护在引擎层**（pretool-handler 守卫，不在 stage 提示词写「禁止 cd」）。

## 异常恢复

`/clear` 后或新 session 进入：引擎自动注入 flow_id / current_stage / requirement + 重读 stage prompt（见 `session-handler.ts`）。多-task stage 通过 plan.md 的 `[x]` 标记自然恢复进度。
