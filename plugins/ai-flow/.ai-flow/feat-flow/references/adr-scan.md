# ADR 查阅协议

每个 stage 入场时查阅项目已有的 ADR，避免重新提议已被否决的方案，并让决策 / 蓝图 / 实施 / 审查都建立在既有架构决策之上。

## 步骤

1. **定位 ADR 目录**
   - 优先读 `docs/adr/README.md` 索引——多数项目的 ADR 目录有 README 充当地图，列出每篇 ADR 的标题与状态，比逐个文件名更易判断相关性
   - 无 README → 退回 `ls docs/adr/` 列文件名
   - 都不存在 → 跳过本协议（首次出现 ADR 候选时，由 stage-6 的 `handle-one-directive` 按需创建 `docs/adr/` + README 索引）

2. **monorepo 多目录发现**
   - 项目可能有多个 `docs/adr/`（仓库根 + 各子 repo）
   - 按本次需求 / 改动涉及的文件区域，定位「最深公共祖先目录」，向上到仓库根，逐层收集路径上存在的 `docs/adr/` 目录（与 stage-6 写入路径解析口径一致）
   - 对每个发现的 ADR 目录都执行步骤 1

3. **相关性筛选**
   - 按与当前需求 / 决策的相关性，筛出 ≤5 篇最相关的 ADR 并读全文

4. **注入**
   - 把筛出的 ADR 作为 context 注入当前 stage，注入方式见下表

## 各 stage 的注入方式

| stage | 用途 |
|-------|------|
| stage-1 | 给问询推荐答案做依据；已有 ADR 决策直接引用，不重复问开发者 |
| stage-2 | 作为精选来源传给 code-architect（按需读） |
| stage-4 | 相关 ADR 路径列表传给 implementer（按需读） |
| stage-5 | reviewer 引用 ADR ID 作为 issue 证据，检查代码是否违反既有 ADR |
