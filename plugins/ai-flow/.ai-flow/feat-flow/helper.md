# feat-flow

## 这是什么

**为中大型功能需求优化的 AI-coding 工作流**。基于 Claude Code 的 ai-flow 引擎实现，覆盖从需求确认到知识沉淀的 6 个阶段。

## 核心使命

按重要性排序：

1. **保障需求的交付质量高**：通过结构化决策、3 轮互审、TDD 实施、可验证 AC 等机制，让每次交付都经得起审视
2. **团队能按一套规范落地和实践**：固定的 6 stage 流水线 + 文档结构 + 工具调用约定，让不同人在不同需求上产出一致质量
3. **context 长期保持净正向**：通过 ADR 治理、CLAUDE.md drift 修复、注释保鲜等机制，确保项目越大 AI coding 越好，而非越差

## 设计哲学（贯穿所有 stage）

| 原则 | 含义 |
|------|------|
| **Clear-Safe Persistence** | 任一 stage 后 /clear 不破坏下游。所有跨 stage 信息必须落盘文件 |
| **ADR Consultation Protocol** | 每个 stage 入场扫 docs/adr/ 注入相关 ADR，避免 AI 重新提议已被否决的方案 |
| **Pending vocabulary** | Stage 4 task 间术语传递，避免命名漂移 |
| **comment vs context placement** | 优先用代码注释（file header / block / inline）；只有超出当前文件、未来新代码必须遵循、有被放弃的替代方案、或可复用多步流程，才进 context 层（rules / CLAUDE.md / skill / ADR）——避免 ADR 目录污染，也避免遗漏非 ADR 类知识 |
| **Bootstrap from zero** | 首次跑就建知识基础设施（docs/adr/、CLAUDE.md），不等用户手动建 |
| **3 轮互审协议** | reviewer ↔ author 互审最多 3 轮，分歧 escalate 开发者——避免 perform agreement 也避免无限循环 |
| **前置 stage 问题三级处理** | 中后期 stage 发现前置文档漏 / 错时，按 L1（大方向 abort）/ L2（漏写补全 + 回改）/ L3（小修 inline）分级处理，禁止 AI 自判 L3 后默默改（详见 `references/upstream-revision-protocol.md`） |

## 命令速查

```sh
feat-flow start <自然语言需求描述>   # 启动新 flow，引擎生成 flow_id (<日期>-<rand4>)
feat-flow approve <token>           # 通过当前 Gate
feat-flow abort                     # 中止当前 flow（创建快照到 docs/feat-flow/<flow_id>/）
feat-flow resume                    # 在新 session 中恢复 flow
feat-flow status                    # 查看当前 stage 和状态
feat-flow help                      # 查看本文档
```

## 6 Stage 流水线

| ID | 名称 | Gate | 关键工具 |
|----|------|------|---------|
| stage-1 | 需求确认（含 UI / 项目命令 / TDD bootstrap / ADR scan） | ✅ | grill-me + figma MCP + feature-dev:code-explorer + tavily/general-purpose |
| stage-2 | 实施蓝图 | ✅ | feature-dev:code-architect |
| stage-3 | 实施计划 | ✅ | superpowers:writing-plans |
| stage-4 | 代码实施 | ❌（无 Gate） | superpowers:subagent-driven-development |
| stage-5 | 质量门（验证 + 3 轮互审，合并） | ✅ | feature-dev:code-reviewer + receiving-code-review |
| stage-6 | 知识沉淀（增 + 修 + 退役 + 归档） | ❌（直接写入，汇总表确认后归档） | adr-manage + optimize-claude-context |

## 产出文件路径

```
docs/feat-flows/<flow_id>/
├── design.md                # 需求 / 决策记录 / UI 状态 / 项目命令 / AC（Stage 1 起累积）
├── architecture.md          # 模块定位 / 接口 / 数据流 / build 顺序（Stage 2）
├── plan.md                  # Task 列表（Stage 3 起，Stage 4 维护 [x] 进度）
├── task-reports.md          # Stage 4 每 task 的元信息累积（NEW_TERMS / ADR_CANDIDATES 等）
├── review.md                # 互审结论 + 待开发者决策（Stage 5）
└── context-delta.md         # Context 变化提案（Stage 2 创建，Stage 5 追加，Stage 6 读取后归档）

.ai-flow/feat-flow/state/
├── active.json              # 引擎维护（flow_id、current_stage、base_sha 等）
├── base_sha_code            # Stage 4 起点 commit SHA（用于 Stage 5 diff）
├── signal                   # AI → 引擎 完成信号（用 Write 工具写）
├── transitions.log          # 引擎记录 stage 切换历史（状态机事件）
└── hooks.log                # hook 执行诊断（SESSION / SIGNAL_INTERCEPT / GATE_ISSUED / ADVANCED）

docs/adr/                    # Stage 6 写入；首次跑会 bootstrap
docs/feat-flows/archive/<flow_id>/  # Stage 6 归档历史 flow 工件（含 context-delta.md）
<deepest-common-ancestor>/CLAUDE.md  # Stage 6 写入（monorepo 兼容路径解析）
```

## 环境要求

### 必需 skills

用 `ls ~/.claude/skills/` 检查：
- `grill-me` — Stage 1 问询
- `writing-plans` — Stage 3 计划
- `subagent-driven-development` — Stage 4 实施
- `receiving-code-review` — Stage 5 处理反馈
- `optimize-claude-context` — Stage 6 治理 CLAUDE.md + .claude/rules/ + .claude/skills/（来自 [darian-deng/agent-skills](https://github.com/darian-deng/agent-skills)）
- `adr-manage` — Stage 6 管理 ADR（new / supersede / index / bootstrap，来自 [darian-deng/agent-skills](https://github.com/darian-deng/agent-skills)）

### 必需 plugins

- `feature-dev` — 提供 code-explorer / code-architect / code-reviewer subagent

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

详见 `docs/feat-flows/feat-flow-design/design.md` 第九节。简要：

- SDD 默认 implementer-prompt 改为 Curated Sources 模式（主 session 给指针 + subagent 按需读，而非主 session 粘贴完整 architectural context）
- NEEDS_CONTEXT 处理严于 SDD 默认（一次重 dispatch 失败即 escalate 开发者，不允许主 session 凭空补答）

## 异常恢复

`/clear` 后或新 session 进入：引擎自动注入 flow_id / current_stage / requirement + 重读 stage prompt（见 `session-handler.ts`）。多-task stage 通过 plan.md 的 `[x]` 标记自然恢复进度。
