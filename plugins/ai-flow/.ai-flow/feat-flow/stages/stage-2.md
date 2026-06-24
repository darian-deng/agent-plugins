# Stage 2：实施蓝图

> feat-flow 第 2/6 步 · [流程总览](../helper.md)
> 当前 stage 目的：把 design.md 的决策翻译成可执行的实施蓝图（架构层级）
>
> **元规则**：禁止 git commit，stage-4 起点统一提交。

## 目标

dispatch `feature-dev:code-architect` subagent 产出 `architecture.md`——含架构决策、文件清单、接口设计、数据流、集成点、build 顺序。code-architect 自带代码模式分析能力，且被设计为「决断单一方案、不罗列多选项」，因此**单 subagent 即可，不并行多方案**（反锚定职责在 Stage 1 决策记录已尽到，此处只做翻译）。

## 前置读取

- `{{project_root}}/docs/feat-flows/<flow_id>/design.md` — 需求 / 决策记录 / UI 状态清单 / 项目命令 / TDD 基建决策

## 入场动作

1. **ADR 查阅**：执行 `{{flow_root}}/references/adr-scan.md`，把筛出的 ADR 路径列表作为精选来源待传给 architect

## 步骤

1. dispatch `feature-dev:code-architect` subagent，传入：
   - design.md 全量
   - 相关 ADR 路径列表（精选来源，subagent 按需读）
   - 任务：产出实施蓝图（架构层级，非 task 切分；build 顺序保持高层阶段，task 粒度留给 Stage 3）

2. 取回结构化蓝图后，主 session 审视与 design.md 一致性：
   - 蓝图是否覆盖 design.md 每个决策？
   - 蓝图是否引入了 design.md「不在范围内」的内容？
   - 蓝图是否与 design.md 冲突？
   - 任一处需要改前面已对齐的东西 → 走 `{{flow_root}}/references/revision-protocol.md`（开发者提的走入口 A，AI 自查的走入口 B）

3. 写入新文件 `{{project_root}}/docs/feat-flows/<flow_id>/architecture.md`

## 输出规格

文件 → `{{project_root}}/docs/feat-flows/<flow_id>/architecture.md`

骨架：

```markdown
# 实施蓝图

## 架构决策与权衡
（architect 选定的方案 + 理由 + 主要替代方案为何不选；ADR 候选的主要来源）

## 模块定位
（新建模块 / 文件清单 + 目录位置）

## 接口设计
（每个 service / hook 的方法签名）

**批量成员必须枚举（供 Stage 3 估算任务体量、防截断）**：若某个文件会获得 / 包装 / 注册**一批成员**（如「为 contextIsolation 包装全部 rpc 方法」「建一张含 N 条的映射表 / handler 注册表」），**必须在此列出完整成员清单或明确数量**，不能只写「全部 xxx」。Stage 3 的 `output_size` 体量门依赖这个枚举：列不全 → Stage 3 估不出体量 → 会退回本 stage 补全（`{{flow_root}}/references/revision-protocol.md` 入口 B），徒增往返。

## 数据流
（端到端链条 + 错误冒泡 + loading 归属）

## 集成点
（路由、i18n、错误处理、日志接驳）

## Build 顺序
（按依赖排的高层步骤，含基建若需要）
```

## 架构 & 复用审查（独立批判，Gate 前必跑）

architecture.md 写好后、呈给开发者前，派一个**独立**的 `general-purpose` 子代理（**非 code-architect 本人**）对蓝图做**对抗式审查**（立场：默认怀疑——"这个真的需要吗？有没有更简单的、能复用现有代码的做法？"）。这是"架构不合理 / 没复用现有代码 / 过度工程"的**最早、最便宜捕获点**——代码还没写，改蓝图零成本（等到 Stage 5 木已成舟再发现就是大返工）。

传入：
- architecture.md 全量
- design.md（需求 + 决策记录，作评判基准——已对齐决策不质疑）
- 相关 ADR 路径列表
- 让它自己 grep / Read 现有代码库

审查维度：
1. **复用缺失（重点）**：蓝图新建的模块 / util / 模式，代码库里是否已有可复用的？grep 现有代码确认，别重造轮子。
2. **模块定位**：新建文件的目录位置是否贴合项目既有结构惯例？
3. **过度工程**："这个真的需要吗？" 有没有更简单的等价方案？抽象是否超前于需求？
4. **架构合理性 / 故障模式**：数据流、错误处理、边界是否周全？有无循环依赖？
5. **ADR 合规**：蓝图是否违反既有 ADR？issue 引 ADR ID。

输出分两级：
- 🔴 **阻塞项**：该复用却没复用 / 架构不可行 / 违反 ADR / 严重过度工程。**呈开发者前必须先回改 architecture.md**（与 architect 再 dispatch 一轮，或主 session 直接修），改完重跑相关维度确认。
- 🟡 **建议项**：可选优化，并入开发者审批清单供裁决，不强制改。

> 这一步独立于开发者 Gate：独立审查抓 AI 视角的硬伤（尤其复用），开发者 Gate 抓人的领域判断，两者互补不替代。

## Context 变化捕获（写入 context-delta.md）

只**收集**本 stage 引入的 context 候选，**不分类、不写 CLAUDE.md/ADR**——分类路由 + 冲突检测是 Stage 6 `handle-one-directive` 的职责，此处提前分类是重复劳动。

收集两类：
- architecture.md 引入的新约定 / 模式 / 架构选型
- design.md 决策记录中 `**决策**:` 已填写、且未在「ADR 候选」节列入的条目

写入 `{{project_root}}/docs/feat-flows/<flow_id>/context-delta.md`（新文件）。无候选时写「（无）」，不跳过——此节是 Stage 6 验证本 stage 已执行的标记。

```markdown
## Stage 2 — <flow_id>

- <一句话描述> — 来源: <来源节>[；被否决替代: <X> 为何不选]
```

## 生成开发者对齐视图（tech-design.html）

architecture.md + context-delta.md 完成后，按 `{{flow_root}}/references/tech-design-view.md` 生成 `{{project_root}}/docs/feat-flows/<flow_id>/tech-design.html`——把 design.md + architecture.md 蒸馏成一份给开发者签字对齐的专业技术方案（做什么 / 怎么做 / 为什么 / 如何实施）。结构与呈现全遵该契约：术语表靠前、现状落位图建心智模型、提议方案「概览先行→机制下钻 + 嵌入式为什么」、决策台账降为附录速查；配图遵**图优先**原则（凡能讲清的结构/流程/时序/状态都配，每张准确贴合本需求 + 图文同主题）。

配图由一个 **sonnet 子代理**手写 mermaid（`.mmd`）→ 用 `mmdc` 渲染 SVG 写盘（渲染自检 ≤2 轮、禁止再 spawn 子代理）；HTML 由**主 session 增量组装**（骨架 → 逐节填充 → 内联图，绝不 one-shot 整文件）。细节遵该契约。

md 是给执行器的完备产物，tech-design.html 是给人对齐的蒸馏视图——后者是本 Gate 的开发者主审面。

## 开发者审批清单（写 signal 后随引擎确认一并呈现）

> 呈现这份清单是给开发者审阅讨论用，**呈现 ≠ 到达 Gate**。到达 Gate 必须写 signal（见末尾「Signal」段）；只有写入 signal、收到引擎「已提交」确认后，才向开发者提示执行 `feat-flow approve`。不要在没写 signal 时就抛 approve 提示。

完成 architecture.md（架构审查阻塞项已回改）+ context-delta.md + tech-design.html 后，请开发者打开 `tech-design.html` 审阅整体方案，并以下列 7 点 **+ 独立架构审查的建议项**作为审查引导逐项确认：

```
对照 tech-design.html / architecture.md 逐项审：

1. 覆盖：design.md 每个决策是否都在蓝图里有对应实现位置？
2. 模块定位：新建模块/文件的目录位置是否符合项目既有惯例？
3. 接口设计：每个 service / hook / API 的接口形状是否合理？参数粒度、返回值结构、是否有遗漏的关键操作（stats / list / clear 等）。**批量成员是否已枚举**：凡「包装/注册/映射一批成员」的文件，成员清单或数量是否已列全（不是「全部 xxx」）？
4. 数据流：从 UI 触发到数据持久化（或回流）的完整链条是否清晰？错误如何冒泡？loading 状态由谁管？
5. 集成点：与既有代码的接驳（路由、i18n、错误处理、日志）是否完整？
6. Build 顺序：依赖关系是否合理？能否独立测试每一步？有循环依赖吗？
7. TDD 基建完整性：若 design.md TDD 决策为「建立」，architecture 是否含基建步骤（依赖安装 + 配置 + 第一个 smoke test）？基建 task 是否明确标"不走 TDD"？
```

## 完成条件

- `architecture.md` 存在且各节齐全
- 与 design.md 无未解冲突
- **批量成员已枚举**：凡「包装/注册/映射一批成员」的文件,接口设计节已列出完整成员清单或明确数量（供 Stage 3 体量门用，防截断）
- **独立架构审查已跑，阻塞项已回改 architecture.md**
- `context-delta.md` 已创建且包含 `## Stage 2` 节
- **`tech-design.html` 已生成**（按 `{{flow_root}}/references/tech-design-view.md`：术语表靠前、实质默认展开只折附录、图优先且每张准确贴合本需求 + 图文同主题、决策台账作附录速查、正文无时间性叙事、正文/表/图/代码统一内容宽度且无横向滚动条）
- 开发者审批以 tech-design.html 为主审面，7 点 + 架构审查建议项已主动呈现

## Signal

**触发条件**：本阶段「完成条件」全部满足，**或**开发者明确表达本阶段已完成。
**动作**：用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`（引擎接受此关键词，自动推进）。
