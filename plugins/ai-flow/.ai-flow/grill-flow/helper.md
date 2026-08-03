# grill-flow

## 这是什么

**mattpocock/skills v1.1 方法论在 ai-flow 引擎上的完整实现**——散文 spec（不锁实现）+ tracer-bullet 垂直切片 + 编排器逐 ticket 派发 fresh 子代理实施（决策点人在环），配结构化质量把控。

**实现规模不限**；**设计迷雾大**（一次 grilling 聊不出 spec）走 stage-1 的 wayfinder 子模式。

## 核心内核（"轻"在哪、质量在哪）

- **轻 = mattpocock 内核**：散文 spec 不搞接口枚举、tracer-bullet 不搞字段矩阵、提示词薄（细节在 references/）。执行沿用子代理派发（主 session 只编排、context 干净），差异化落在上游散文 spec + tracer-bullet 竖切。
- **质量把控齐**：per-ticket simplify + Standards/Spec 双轴 CR + 客观地板（假绿检测/枚举负空间/回归）；stage-2 对抗性方案审查；收尾组装双轴 + 安全专项；集中沉淀。

## 命令速查

```sh
grill-flow start <自然语言需求描述>   # 启动，引擎生成 flow_id
grill-flow approve                    # 通过当前 gate
grill-flow abort                      # 中止（创建快照）
grill-flow resume                     # 新 session 恢复
grill-flow status                     # 查看当前 stage
grill-flow help                       # 本文档
```

## 5 Stage 流水线

| ID | 名称 | 完成方式 | 关键机制 |
|----|------|---------|---------|
| stage-1 | grill（需求对齐，domain-aware） | **gate** | grilling 一次一问 + wayfinder 迷雾子模式 + research/prototype detour |
| stage-2 | spec + tickets | script + **gate** | 散文 spec + seam + User Stories + 对抗方案审查 + HTML 方案视图 + tracer-bullet 切片(prefactor 前置) |
| stage-3 | implement | script（无 gate，fail-closed） | 编排器串行派 fresh 子代理逐 ticket 实施：tdd→simplify→**三评审子代理并行**(双轴+correctness)→编排器裁/修→客观地板→**commit(含 T号)**→qc marker→**真机票打 rm:pending**→勾[x]（实现在子代理、不涨主 session；commit 后置；frontier 分岔不问顺序、真机票不停） |
| stage-4 | code-review | **gate** | A 全量测试 + B 组装双轴+安全 + C 开发者 IDE 未暂存 diff 亲审闭环**（含真机验证清单收口 rm:pending，全流程唯一真机验证落点）** → squash 一笔 feat commit |
| stage-5 | 沉淀 | **gate** | optimize-claude-context 集中写 CLAUDE.md/rules/ADR |

gate：1 / 2 / 4 / 5。script（秒级 fail-closed 结构门）：2 / 3。

## 产出文件

```
docs/grill-flows/<flow_id>/
├── alignment.md         # 需求/范围/决策/术语/暂缓/沉淀候选/功能覆盖缺口(替换迁移型,stage-1)
├── wayfinder-map.md     # 迷雾大时的决策地图（stage-1 wayfinder 子模式，可选）
├── spec.md              # 散文规格：Problem/Solution/User Stories/Decisions/Testing Decisions/Out of scope/方案审查/跨端跨仓行为契约(涉及时,stage-2)
├── tech-design.html     # 方案视图：gate 主审面（stage-2，从 spec 生成的单向视图）
├── diagram/*.svg        # 配图（mermaid→mmdc）
├── tickets.md           # tracer-bullet 切片 + 进度（stage-2 建，stage-3 维护 qc:done + [x] + 真机票 rm:pending/rm:done + ## 待真机验证段）
├── candidates.md        # 沉淀候选（stage-3 累积）
└── review.md            # 收尾审 findings + 原始测试输出（stage-4）

.ai-flow/grill-flow/state/   # 引擎维护：active.json / signal / mark-base / transitions.log
```

signal 语义：AI 统一写 `done`，引擎自动计算下一步（非 `done` 会被拒）。有 gate 的 stage 写 done 后暂停等 approve；无 gate 的自动推进。

## 环境要求

- **系统**：Node.js ≥ 18、git、claude CLI、mermaid-cli（`mmdc`，stage-2 配图：`npm install -g @mermaid-js/mermaid-cli`）。
- **必需 skill**：`optimize-claude-context`（stage-5 沉淀）。
- **内置命令**：`/simplify`（stage-3 per-ticket 机械型质量修，Claude Code 内置）。correctness 轴不用内置命令，改由子代理携未提交 diff 审 bug（通用、见 `references/per-ticket-review.md`）。
- **内置 skill**：`comment`（注释纪律与清理——实施子代理写时守 + per-ticket 评审标记 + stage-4 收尾专职清理 pass「grep 机械兜底进程指代 + sonnet 判冗余」；随 ai-flow 一起装、无需额外安装）。
- preflight 按上述检测；缺失给安装命令并阻止启动。

> 设计真相源与所有对齐 rationale：仓库根 `docs/grill-flow-design.md`。
