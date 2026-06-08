# Stage 1：需求确认

> feat-flow 第 1/6 步 · [流程总览](../helper.md)
> 当前 stage 目的：把模糊需求转成结构化的 design.md，含可测量 AC、UI 状态清单、决策记录、项目命令
>
> **元规则**：禁止 git commit，stage-4 起点统一提交。

## 目标

通过 `grounded-design` 的接地式分层拆解 + feat-flow 专属探测，产出一份足够 subagent 在后续 stage 独立执行的 `design.md`。Stage 1 出错下游全废，**信息完整 > 速度**。

## 入场动作（按顺序，主 session 执行）

1. **需求源记录**
   - 引擎注入的「需求」可能只是一句话，也可能指向一份 PRD 文件 / URL / 飞书文档
   - 把来源（路径 / URL / 链接）记到 design.md「外部参考」节，确保 /clear 后仍能回溯
   - 其内容由 grounded-design 接地时完整读取（本地 Read / URL→tavily-extract / 飞书→lark-doc），此处不重复读取

2. **ADR 查阅**
   - 执行 `references/adr-scan.md`

3. **项目命令探测**
   - 读 `package.json` scripts / `pyproject.toml` / `Makefile` 等
   - 提取：单元测试 / 集成测试 / Lint / Typecheck 命令，写到 design.md「项目命令」节
   - 检测不到 → 明确询问开发者，**禁止凭推测填**
   - 不查 pre-commit hook（项目级基建职责，不归 feat-flow 管）

4. **TDD 基建检测**
   - 查项目是否有测试框架 + 测试目录
   - 已有完整基建 → 记到 design.md 决策记录「TDD 基建：已有 [vitest/jest/...]」
   - 无 / 部分 → 此处不自动决定，留到下方强制必问项确认（见下）

## 调用 grounded-design 进行问询

调用 `grounded-design` skill 驱动需求拆解。它自带:**接地优先**（提任何问题前先查代码 / 文档 / 资料，无根选项禁止呈现）、**三分类**（finding 陈述 / 问开发者 / ⚠ 假设）、**一次一问 + 带依据的推荐**、**选择性呈现**、**清晰度 Gate**（覆盖功能边界 / 技术约束 / 验收标准 / 关键决策）。把 `design.md` 作为它的方案产物，逐条对齐时增量写入——这些机制本 stage 不再重述。

> 验收标准每条必须可测量，标 `[auto]` 命令或 `[manual]` 步骤，写入 design.md「验收标准」节。

在 grounded-design 的通用流程之上，本 stage **追加 feat-flow 专属要求**：

**强制必问项**（无论问询如何展开都必须问到并记录决策）：
- 若入场检测到 TDD 基建「无 / 部分」：本次 feature 是否顺带建立 TDD 基建？决策写到 design.md 决策记录
- **产品安全**：从产品安全角度审视，本方案设计 / 产品设计是否存在漏洞？（权限绕过、数据泄露、状态被滥用、输入未校验、边界条件被利用等）必须主动思考并把结论 / 缓解措施记录到 design.md

**外部技术调研**：grounded-design 要求外部选型 / 易变接口必须查证；feat-flow 额外要求**隔离调研上下文**——优先 dispatch 独立调研 subagent（general-purpose 或 tavily skill），而非主 session 内联查，保持主 session context 干净。

**ADR 草稿**：关键决策（影响下游多个 stage、难以反转）被开发者拒绝，或反复争论未达成一致 → 当场提议 ADR 草稿写到 design.md「ADR 候选」节（供 Stage 6 兜底再次评估）。

## UI 设计来源对齐（若需求涉及 UI）

涉及任何 UI 改动（新页面、新组件、视觉调整）**必须读 `references/ui-protocol.md` 并逐步执行**：六类状态维度逐项 gap closure、每项未覆盖独立代码探索找现有复用组件、复用组件需开发者显式确认沿用。

## 独立审计（写完 design.md 后必做）

dispatch 一个 fresh subagent（general-purpose 类型）对 design.md 做独立审计——自查有盲区，必须用独立上下文。传入 design.md 全文 + 下列 rubric：

- placeholder 扫描（TBD / 待定 / `<具体值>` 等）
- 内部矛盾或前后不一致
- 范围漂移（讨论中超出原需求的内容混入）
- 每条 AC 是否能写成自动化测试或具体验证步骤
- design.md 信息是否足够下游 subagent 独立执行（不依赖本 session 对话历史）
- 产品安全：方案设计 / 产品设计是否存在安全漏洞（权限、数据暴露、状态滥用、边界条件）

处理审计结论：
- 审计指出问题 → 主 session 修正 design.md → 让审计员**再自审**一轮
- 审计员与主 session 对某条结论分歧、无法当场达成一致 → **不私下消化**，列入 Gate 审批清单亮给开发者决定（design.md 已记录哪些是开发者决策项，分歧本就该回到开发者）

不做 stage-5 那种多轮独立复核——Gate 即人类升级点。

## 前置产物修订（开发者异议 / AI 自查）

详见 `references/revision-protocol.md`。开发者对产出有异议走入口 A，AI 自查发现前置漏 / 错走入口 B；均先评估对全部上游产物的影响并分级 L1/L2/L3，不反射性接受、不私下消化。

## 输出规格

文件 → `docs/feat-flows/<flow_id>/design.md`

`flow_id` 是引擎在 start 时生成的唯一标识，AI 看到 context 顶部注入的实际值（形如 `2026-05-21-x7k3`）。直接用此值作为 docs 文件夹名，**不要自己重新拼日期或加描述性后缀**。

design.md 骨架：

```markdown
# <需求简名>

## 需求
（不限字数）

### 不在范围内

## 约束

## 外部参考
（开发者提供的链接 / PRD 路径 / 飞书文档 + 一句话用途；无则写"无"）

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

## ADR 候选
（问询中即时提议的草稿；由 Stage 6 兜底再次评估）

## 验收标准
- [auto] AC1 — 验证命令：`...`
- [manual] AC2 — 验证步骤：<...>
```

## 完成条件

- `docs/feat-flows/<flow_id>/design.md` 存在且包含全部规定 section
- 需求源（若为外部 PRD / URL / 文档）已记入「外部参考」节
- 若涉及 UI：UI 状态清单 gap closure 完成（每项有归属来源）
- TDD 基建决策已记录
- 项目命令 4 项已填（或明确标"无"）
- 独立审计通过；与审计员的分歧（如有）已列入 Gate 审批清单

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**开发者明确表达本阶段已完成。
**动作**：用 Write 工具向 `.ai-flow/feat-flow/state/signal` 写入 `done`（引擎接受此关键词，自动推进）。
