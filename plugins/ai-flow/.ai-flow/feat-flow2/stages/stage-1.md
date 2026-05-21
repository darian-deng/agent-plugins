# Stage 1：需求确认

> feat-flow2 第 1/6 步 · [流程总览](../helper.md)
> 后续：Stage 2 实施蓝图（Gate）
> 当前 stage 目的：把模糊需求转成结构化的 design.md，含可测量 AC、UI 状态清单、决策记录、项目命令
>
> **元规则**：禁止 git commit。文档改动用 `git add` 暂存，Stage 4 起点统一提交。

## 目标

通过 grill-me 风格的审讯式问询 + 必要时的代码 / 外部调研，产出一份足够 subagent 在后续 stage 独立执行的 `design.md`。Stage 1 出错下游全废，**信息完整 > 速度**。

## 入场动作（按顺序，主 session 执行）

1. **ADR 一次性扫描**
   - `ls docs/adr/` 列标题（不存在跳过）
   - 与 requirement 相关性筛 ≤5 篇，读后注入 system context
   - 后续给推荐答案时引用已有 ADR 决策，避免重复问用户

2. **强制代码探索**
   - dispatch ≥1 个 `feature-dev:code-explorer` subagent
   - 等结构化报告

3. **项目命令探测**
   - 读 `package.json` scripts / `pyproject.toml` / `Makefile` 等
   - 提取：单元测试 / 集成测试 / Lint / Typecheck 命令
   - 写到 design.md「项目命令」节
   - 检测不到 → 明确询问用户，**禁止凭推测填**
   - 不查 pre-commit hook（项目级基建职责，不归 feat-flow2 管）

4. **TDD bootstrap 检测**
   - 查项目是否有测试框架 + 测试目录
   - 已有完整基建 → design.md 决策记录写 "TDD 基建：已有 [vitest/jest/...]"
   - 无 / 部分 → 询问用户：本次 feature 是否顺带建立 TDD 基建？决策写到 design.md

## 调用 grill-me 进行问询

调用 `grill-me` skill 启动审讯式问询：一次一问 + 附推荐答案 + 能查代码先查。直到下列内容全部清晰：

- 功能边界（做什么、明确不做什么）
- 技术约束（依赖、兼容性、性能要求）
- 验收标准（每条必须可测量，标 `[auto]` 命令或 `[manual]` 步骤）

**问询纪律**：
- 每 Q 与用户对齐后**立即增量更新 design.md**，不批量
- 涉及外部技术选型 / 最新 API → dispatch `general-purpose` 或 `tavily-search` subagent 调研，禁止凭模型既有知识给推荐
- 涉及代码细节 → 主 session 直接 grep / read
- load-bearing 决策被拒 / 反复对线时 → 当场提议 ADR 草稿写到 design.md「ADR 候选」节

## UI 设计来源对齐（若需求涉及 UI 必须执行）

详见 `references/ui-protocol.md`。要点：
- 不假设 Figma URL 覆盖所有状态——按六类维度（数据 / 加载 / 错误 / 交互 / 流程分支 / 响应式）逐项 gap closure
- 每一项「未明确覆盖」必须**独立代码探索**（不依赖入场时的探索），找现有复用组件
- 找到复用组件**仍需用户显式确认沿用**（不允许默认沿用）

## 自审（写完 design.md 后必做）

通读一遍，按 5 项 checklist 自查：

- [ ] 有无 placeholder（TBD / 待定 / `<具体值>` 等）？
- [ ] 内部有无矛盾或前后不一致？
- [ ] 有无范围漂移（讨论中超出原需求的内容混入）？
- [ ] 有无歧义表述？
- [ ] 每条 AC 是否能写成自动化测试或具体验证步骤？

发现问题 → 修正 → 再读。

## 用户反对意见处理协议

详见 `references/dissent-protocol.md`。要点：识别异议类型 → 严谨评估（B 类必须给真实理由不接受「感觉更好」）→ 上游影响检查（不允许 design.md 与本 stage 产物分裂）。

## 输出规格

文件 → `docs/feat-flows/<日期>-<需求 slug>/design.md`

flow_id 由引擎在 start 时生成（`<日期>-<rand4>`），AI 看到 context 顶部注入的实际值；docs 文件夹用此 flow_id。

design.md 骨架：

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

## ADR 候选
（grill-me 即时提议的草稿；由 Stage 6 兜底再次评估）

## 验收标准
- [auto] AC1 — 验证命令：`...`
- [manual] AC2 — 验证步骤：<...>
```

## 完成条件

- `docs/feat-flows/<flow_id>/design.md` 存在且包含全部规定 section
- 若涉及 UI：UI 状态清单 gap closure 完成（每项有归属来源）
- TDD bootstrap 决策已记录
- 项目命令 4 项已填（或明确标"无"）
- 自审 5 项 checklist 通过

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**用户明确表达本阶段已完成。
**动作**：用 Write 工具向 `.ai-flow/feat-flow2/state/signal` 写入任意内容。
