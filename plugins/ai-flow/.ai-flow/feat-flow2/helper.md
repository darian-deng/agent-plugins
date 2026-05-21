# feat-flow2

## 这是什么

**中大型功能需求（10+ task / 数天工作量）的 AI-coding 工作流**。基于 Claude Code 的 ai-flow 引擎实现。

不适合：改一行文案 / 单文件小 bug / 任何小于 3 task 量级的需求——简单需求直接对话或调单 skill 即可。

## 核心使命

让项目在持续被 AI 辅助开发的过程中，**context 长期保持净正向**——不随 codebase 规模扩大而让 AI coding 劣化。

## 设计哲学（贯穿所有 stage）

| 原则 | 含义 |
|------|------|
| **Clear-Safe Persistence** | 任一 stage 后 /clear 不破坏下游。所有跨 stage 信息必须落盘文件 |
| **ADR Consultation Protocol** | 每个 stage 入场扫 docs/adr/ 注入相关 ADR，避免 AI 重新提议已被否决的方案 |
| **Pending vocabulary** | Stage 4 task 间术语传递，避免命名漂移 |
| **comment vs ADR placement** | 局部决策用代码注释，跨文件才写 ADR——避免 ADR 目录污染 |
| **Bootstrap from zero** | 首次跑就建知识基础设施（docs/adr/、CLAUDE.md），不等用户手动建 |
| **3 轮互审协议** | reviewer ↔ author 互审最多 3 轮，分歧 escalate 开发者——避免 perform agreement 也避免无限循环 |

## 命令速查

```sh
feat-flow2 start <自然语言需求描述>   # 启动新 flow，引擎生成 flow_id (<日期>-<rand4>)
feat-flow2 approve <token>           # 通过当前 Gate
feat-flow2 abort                     # 中止当前 flow（创建快照到 docs/feat-flow2/<flow_id>/）
feat-flow2 resume                    # 在新 session 中恢复 flow
feat-flow2 status                    # 查看当前 stage 和状态
feat-flow2 help                      # 查看本文档
```

## 6 Stage 流水线

| ID | 名称 | Gate | 关键工具 |
|----|------|------|---------|
| stage-1 | 需求确认（含 UI / 项目命令 / TDD bootstrap / ADR scan） | ✅ | grill-me + figma MCP + feature-dev:code-explorer + tavily/general-purpose |
| stage-2 | 实施蓝图 | ✅ | feature-dev:code-architect |
| stage-3 | 实施计划 | ✅ | superpowers:writing-plans |
| stage-4 | 代码实施 | ❌（无 Gate） | superpowers:subagent-driven-development |
| stage-5 | 质量门（验证 + 3 轮互审，合并） | ✅ | feature-dev:code-reviewer + receiving-code-review |
| stage-6 | 知识沉淀（增 + 修 + 退役 + 归档） | ❌（写入分级用户确认） | /ai-flow:adr + claude-md-management |

## 产出文件路径

```
docs/feat-flows/<flow_id>/
├── design.md                # 需求 / 决策记录 / UI 状态 / 项目命令 / AC（Stage 1 起累积）
├── architecture.md          # 模块定位 / 接口 / 数据流 / build 顺序（Stage 2）
├── plan.md                  # Task 列表（Stage 3 起，Stage 4 维护 [x] 进度）
└── review.md                # 互审结论 + 待开发者决策（Stage 5）

.ai-flow/feat-flow2/state/
├── active.json              # 引擎维护（flow_id、current_stage、base_sha 等）
├── base_sha_code            # Stage 4 起点 commit SHA（用于 Stage 5 diff）
├── signal                   # AI → 引擎 完成信号（用 Write 工具写）
└── transitions.log          # 引擎记录 stage 切换历史

docs/adr/                    # Stage 6 写入；首次跑会 bootstrap
docs/feat-flows/archive/     # Stage 6 归档历史 flow 工件
<deepest-common-ancestor>/CLAUDE.md  # Stage 6 写入（monorepo 兼容路径解析）
```

## 环境要求

### 必需 skills

用 `ls ~/.claude/skills/` 检查：
- `grill-me` — Stage 1 问询
- `writing-plans` — Stage 3 计划
- `subagent-driven-development` — Stage 4 实施
- `receiving-code-review` — Stage 5 处理反馈

### 必需 plugins

- `feature-dev` — 提供 code-explorer / code-architect / code-reviewer subagent
- `claude-md-management` — 提供 revise-claude-md / claude-md-improver

### ai-flow 本身（已自带）

- `adr` skill（`/ai-flow:adr`）
- `create` / `update` / `add` / `optimize-stage-prompt` skill

### 可选但推荐

- `improve-codebase-architecture` — Stage 6 rules 体积闸门触发时调用
- `tavily-search` / `tavily-extract` — Stage 1 外部技术调研
- figma MCP — Stage 1 UI 设计读取

### 系统

- Node.js ≥ 18
- git
- claude CLI（feat-flow2 仅在 Claude Code 内运行）

## 已知偏离 upstream

详见 `docs/feat-flows/feat-flow2-design/design.md` 第九节。简要：

- SDD 默认 implementer-prompt 改为 Curated Sources 模式（主 session 给指针 + subagent 按需读，而非主 session 粘贴完整 architectural context）
- NEEDS_CONTEXT 处理严于 SDD 默认（一次重 dispatch 失败即 escalate 开发者，不允许主 session 凭空补答）
- mattpocock tdd 不在 SDD 内使用（与 fresh subagent 无用户通道冲突），由 SDD 自带的 superpowers test-driven-development 接管

## 异常恢复

`/clear` 后或新 session 进入：引擎自动注入 flow_id / current_stage / requirement + 重读 stage prompt（见 `session-handler.ts`）。多-task stage 通过 plan.md 的 `[x]` 标记自然恢复进度。

需要回滚到更早 stage：双击 Esc 触发 Claude Code 内置 checkpoint，或重新 `feat-flow2 abort` + `feat-flow2 start`。

## 详细设计参考

完整设计沉淀：`docs/feat-flows/feat-flow2-design/design.md`（12 节，约 1000 行）。
