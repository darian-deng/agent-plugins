# Stage 1：grill（需求对齐）

> grill-flow 第 1/5 步 · [流程总览](../helper.md)
> 当前 stage 目的：把模糊需求聊到共识，产出散文式 `alignment.md`；设计迷雾大则走 wayfinder 子模式。
>
> **元规则**：禁止 git commit（stage-3 起点统一提交）。prototype 只走 Bash 写 repo 外临时目录、标 throwaway、不 commit。

## 目标

照 grilling 把需求聊透——一次一问、每问给推荐、**Facts 自查 / Decisions 问开发者**、达成共识才动手。Stage 1 错则下游全废，**信息完整 > 速度**。

## 前置读取

- `{{flow_def}}/references/adr-scan.md` — 入场读既有 ADR/glossary（grill-with-docs 内核：复用已决、尊重术语）
- `{{flow_def}}/references/wayfinder.md` — 设计迷雾大时的子模式（**重入时先按它探测 wayfinder-map.md 的四态**）
- `{{flow_def}}/references/revision-protocol.md` — 开发者异议 / 自查前置错时走它
- `{{flow_def}}/references/prototype.md` — 非必经，触发 research/prototype detour（下方步骤）时读，讲怎么选分支、logic/UI 两种形状怎么建

## 步骤

- **重入先探测**：若 `wayfinder-map.md` 存在，按 `wayfinder.md` 四态分派（charting/working/clear）；否则读 `alignment.md`（若有）续，或新起普通 grill。
> **背景怎么传下去**：`/clear` 之后先按 `{{flow_def}}/references/handoff.md` 取本次需求的目标 / 已拍板决策 / 边界（本段的重入判据只回答「物理上走到哪」，不回答「该知道什么」）；本 stage 走之前也照那份契约把交接写下来。

- **入场读 domain**（adr-scan.md）：复用已决决策、sharpen 模糊词到 canonical 术语、术语冲突当场挑战。
- **普通 grill**：把模糊需求拆成 alignment.md，**逐条对齐增量写入、不攒到最后**。提问前先查（grep/read 代码、读需求源、外部选型查官方文档）；能查清的不问。每个待定点归类：finding（陈述带来源）/ 问开发者（意图·取舍·业务规则，走 AskUserQuestion 带推荐）/ ⚠假设（给默认值+后果，不卡）。
- **迷雾浮现 → 提议 wayfinder**：grill 中冒出 ≥3 个互相 blocked、答不出、要调研/原型才能定的架构决策 → 停下向开发者提议升级 wayfinder，同意后按 `wayfinder.md` 建图。**wayfinder 进行中（marker `charting`/`working`）绝不写 signal**——只有 `mode: clear` 且开发者确认对齐后才允许写（误写会冲进 gate-pending、丢 wayfinder 逻辑，见 wayfinder.md 诚实边界）。
- **research/prototype detour**（非必经）：外部事实起后台 research 子代理；状态机/UI 建 throwaway prototype（走 Bash 写 repo 外，怎么选分支、怎么建见 `references/prototype.md`）。拿到答案回 grill。
- **范围外想法** → 记入 alignment.md「暂缓」，拉回当前需求。
- **替换/迁移型需求**（把旧系统/旧实现搬到新的）：额外产出《相对基线的功能覆盖缺口清单》——做完本次后相对被替换对象还差哪些**用户可见**功能，每条标归本期还是后续。先派接地子代理对照被替换对象的真实行为/代码核实（别凭印象攒清单），再逐条与开发者对齐，写进 alignment.md 的 `## 功能覆盖缺口` 段。
- **结账（写 signal 前必做）**：用 `AskUserQuestion` 逐条与开发者敲定高杠杆范围，别把范围决策拖到 stage-2/3 才暴露——①功能对等边界（做到什么程度算完）②本次要删除/废弃的东西 ③明确推迟到未来 flow 的项。逐条结论落 alignment.md（对等边界入「需求」、删除/废弃入「关键决策」、推迟项入「暂缓」）。

## 输出规格

文件 → `{{project_root}}/docs/grill-flows/<flow_id>/alignment.md`
（`flow_id` 用 context 顶部注入的实际值，不自己拼日期。）

骨架：`# <需求简名>` / `## 需求` / `## 不在范围内` / `## 约束` / `## 术语表` / `## 关键决策`（当前态：选择+为何+否决什么，禁演化叙事）/ `## 功能覆盖缺口`（仅替换/迁移型需求：相对基线还差哪些用户可见功能 + 各归本期/后续）/ `## 暂缓` / `## 沉淀候选`（带来源，供 stage-5）。迷雾大时另有 `wayfinder-map.md`（见 wayfinder.md）。

## 完成条件

- `alignment.md` 存在且含全部 section；load-bearing 决策已逐个经开发者拍定并记录。
- 结账已完成：功能对等边界 / 本次删除·废弃项 / 推迟到未来 flow 的项，三类均已用 `AskUserQuestion` 逐条与开发者确认并落 alignment.md。
- 替换/迁移型需求：`## 功能覆盖缺口` 清单经接地子代理核实、逐条与开发者确认。
- 走了 wayfinder 的：`wayfinder-map.md` marker=`clear` 且已综合进 alignment.md。
- 开发者确认达成共识。

## Signal

**触发条件**：完成条件全满足（走 wayfinder 的须 `mode:clear`+已确认），**或**开发者明确表示本阶段完成。
**动作**：用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`（Bash 写会被引擎拒绝，必须用 Write）。
