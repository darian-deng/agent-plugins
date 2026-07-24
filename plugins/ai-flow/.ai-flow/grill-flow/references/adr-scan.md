# ADR / domain 查阅协议

> grill-flow 是 grill-with-docs 蓝本（不是无状态 grill-me）：stage-1 grill 与 stage-2 spec/切片 入场都要读既有 domain 文档，复用已决决策、尊重术语，避免重决已决之事、术语漂移。

## 步骤

1. **定位 ADR / domain 文档**
   - 优先读 `docs/adr/README.md` 索引（列各 ADR 标题+状态，比逐个文件名易判相关性）；无 README → `ls docs/adr/` 列文件名。
   - 读 `CONTEXT.md`（若有）与项目 glossary。
   - 都不存在 → 跳过（首次出现 ADR 候选时由 stage-5 的 handle-one-directive 按需创建 `docs/adr/` + README）。

2. **monorepo 多目录发现**：项目可能有多个 `docs/adr/`（仓库根 + 各子 repo）。按本次需求涉及的文件区域，定位"最深公共祖先目录"向上到仓库根，逐层收集路径上存在的 `docs/adr/`，各自执行步骤 1（与 stage-5 写入口径一致）。

3. **相关性筛选**：按与当前需求的相关性，筛 ≤5 篇最相关 ADR 读全文。

4. **注入当前 stage**：

| stage | 用途 |
|-------|------|
| stage-1 grill | 给问询推荐答案做依据；已有 ADR 决策直接引用、不重复问开发者；用既有 glossary 术语，**sharpen 模糊词到 canonical 术语**，术语冲突当场挑战 |
| stage-2 spec+tickets | spec 用项目术语、尊重既有 ADR；tracer-bullet 切片尊重相关领域 ADR |
