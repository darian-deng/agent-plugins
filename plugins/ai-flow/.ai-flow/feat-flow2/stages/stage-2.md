# Stage 2：实施蓝图

> feat-flow2 第 2/6 步 · [流程总览](../helper.md)
> 后续：Stage 3 实施计划（Gate）
> 当前 stage 目的：把 design.md 的决策翻译成可执行的实施蓝图（架构层级）
>
> **元规则**：禁止 git commit。文档改动用 `git add` 暂存，Stage 4 起点统一提交。

## 目标

dispatch `feature-dev:code-architect` subagent 产出 `architecture.md`——含文件清单、接口设计、数据流、集成点、build 顺序。code-architect 单 subagent 即可，**不并行多方案**（反锚定职责在 Stage 1 决策记录已尽到，此处只做翻译）。

## 前置读取

- `docs/feat-flows/<flow_id>/design.md` — 需求 / 决策记录 / UI 状态清单 / 项目命令 / TDD bootstrap 决策

## 入场动作

1. **ADR scan**：`ls docs/adr/` + 与 design.md 决策相关性筛 ≤5 篇标题
2. 把相关 ADR 路径列表作为 Curated Sources 待传给 architect

## 步骤

1. dispatch `feature-dev:code-architect` subagent，传入：
   - design.md 全量
   - 相关 ADR 路径列表（Curated Sources，subagent 按需读）
   - 任务：产出实施蓝图（架构层级，非 task 切分）

2. 取回结构化蓝图后，主 session 审视与 design.md 一致性：
   - 蓝图是否覆盖 design.md 每个决策？
   - 蓝图是否引入了 design.md 「不在范围内」的内容？
   - 蓝图是否与 design.md 冲突？冲突时按用户反对意见处理协议处理（见 `references/dissent-protocol.md`）

3. 追加到 `docs/feat-flows/<flow_id>/architecture.md`（新文件）

## 用户审批清单（Gate 前主动呈现）

完成 architecture.md 后向用户输出：

```
请按以下 7 点审 architecture.md：

1. 覆盖：design.md 每个决策是否都在蓝图里有对应实现位置？
2. 模块定位：新建模块/文件的目录位置是否符合项目既有惯例？
3. 接口设计：每个 service / hook / API 的接口形状是否合理？参数粒度、返回值结构、是否有遗漏的关键操作（stats / list / clear 等）
4. 数据流：从 UI 触发到数据持久化（或回流）的完整链条是否清晰？错误如何冒泡？loading 状态由谁管？
5. 集成点：与既有代码的接驳（路由、i18n、错误处理、日志）是否完整？
6. Build 顺序：依赖关系是否合理？能否独立测试每一步？有循环依赖吗？
7. Bootstrap 完整性：若 design.md TDD 决策为「建立」，architecture 是否含 bootstrap 步骤（依赖安装 + 配置 + 第一个 smoke test）？bootstrap task 是否明确标"不走 TDD"？

任一项有问题 → 直接回复指出，我会改后再 signal。
全部 OK → 运行 feat-flow2 approve <token> 进 Stage 3。
```

## 输出规格

文件 → `docs/feat-flows/<flow_id>/architecture.md`

骨架：

```markdown
# 实施蓝图

## 模块定位
（新建模块 / 文件清单 + 目录位置）

## 接口设计
（每个 service / hook 的方法签名）

## 数据流
（端到端链条 + 错误冒泡 + loading 归属）

## 集成点
（路由、i18n、错误处理、日志接驳）

## Build 顺序
（按依赖排的高层步骤，含 bootstrap 若需要）
```

## 完成条件

- `architecture.md` 存在且 5 节齐全
- 与 design.md 无未解冲突
- 用户审批 7 点已主动呈现

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**用户明确表达本阶段已完成。
**动作**：用 Write 工具向 `.ai-flow/feat-flow2/state/signal` 写入任意内容。
