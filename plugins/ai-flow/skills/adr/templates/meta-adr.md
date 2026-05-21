# ADR-0000: Record Architecture Decisions

- **Status**: Accepted
- **Date**: {DATE}

## Context

随项目演进，会做出一些**架构层面的决策**——选择特定库、定义模块边界、确立 pattern 等。这些决策的「为什么」如果不记录，几个月后回看：

- 团队新成员无法理解为什么这样做
- 改动该领域时容易无意推翻已有决策
- AI 编程时缺乏关键上下文，可能重新提议已被否决的方案

## Decision

采用 Michael Nygard 提出的 **Architecture Decision Records (ADR)** 实践：每个跨文件 / 跨模块层面的关键决策记录为一份不可变 ADR 文件，放在 `docs/adr/` 目录。

### ADR 触发条件（满足以下**全部**才写）

1. **难以反转**：改回去成本大
2. **没有上下文会让人困惑**：未来读者会问"为什么这样做"
3. **是真正的 trade-off 选择结果**：确实有 alternative 且选择有理由
4. **跨文件性质**：决策的"为什么"无法用某一处代码注释（≤5 行 inline 或 file-level top 注释）说清楚

任一条不成立 → 不写 ADR。**局部决策应该用代码注释承载**，避免 ADR 目录被低价值条目淹没。

### ADR 格式

采用 Nygard 模板：

- `Status` — Accepted / Superseded by ADR-NNNN / Deprecated
- `Date` — YYYY-MM-DD
- `Context` — 为什么需要这个决策（背景、约束）
- `Decision` — 选择是什么（具体到方案 / pattern / 接口形状）
- `Consequences` — 带来的后果（positive / negative / neutral）
- `Alternatives Considered` — 考虑过的其他方案 + 为什么没选

### 编号与索引

- 编号 `NNNN` 四位数零填充，从 0001 开始（本 ADR 是 0000，meta ADR）
- `docs/adr/README.md` 维护索引表，按编号升序
- 编号一旦分配不再回收（即使 ADR 被 supersede 也保留编号）

### Supersede（决策被推翻）

ADR 不被删除。新决策推翻旧 ADR 时：

1. 创建新 ADR，header 加 `**Supersedes**: ADR-NNNN`
2. 旧 ADR header 改 `Status: Superseded by ADR-NNNN`
3. 双向链接保留追溯

## Consequences

### Positive
- 关键决策可追溯
- 新成员 / AI 编程时有上下文
- 强制做决策时思考 trade-off（写 ADR 的过程本身是质量检查）

### Negative
- 维护成本（写 + 维护索引）
- 容易误用——把局部决策也写成 ADR，导致目录膨胀

### Neutral
- ADR 是补充不是替代——代码注释 / CLAUDE.md / rules 各有职责，ADR 只承载"跨文件 + 难以反转 + 有 trade-off"的子集

## Alternatives Considered

- **不记录任何决策**：默认状态，但已被业界证实长期演进时不可持续
- **写在 CLAUDE.md 里**：CLAUDE.md 是"项目规则"（is），ADR 是"决策历史"（was/why）——性质不同
- **写在 commit message 里**：commit 散落、难以索引、改名后失去链接性
- **用纯代码注释**：局部决策合适，但跨文件决策没有单一锚点（这正是 ADR 的价值所在）

## 参考

- Michael Nygard, [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- ThoughtWorks Tech Radar: ADRs 已列入 "Adopt" 多年
