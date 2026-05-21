# Architecture Decision Records

本目录记录项目的架构决策（Architecture Decision Records, ADR）。

## 什么时候写 ADR

满足以下**全部**条件才写：

1. **难以反转**：改回去成本大
2. **没有上下文会让人困惑**：未来读者会问"为什么这样做"
3. **是真正的 trade-off**：有 alternative 且选择有理由
4. **跨文件性质**：决策"为什么"无法用某一处代码注释说清楚

任一条不成立 → 不写。局部决策应该用代码注释承载。

详见 [ADR-0000: Record Architecture Decisions](./0000-record-architecture-decisions.md)。

## 怎么写

不要手写。在 Claude Code 里：

```
/ai-flow:adr 我刚做了一个 <description> 的决策
```

skill 会自动分配编号、按 Nygard 模板生成结构、更新本索引。

## 索引

<!-- AUTO-GENERATED INDEX BEGIN -->

| # | Title | Status | Date | Supersedes | Superseded by |
|---|-------|--------|------|------------|---------------|
| [0000](./0000-record-architecture-decisions.md) | Record Architecture Decisions | Accepted | {DATE} | — | — |

<!-- AUTO-GENERATED INDEX END -->

> 索引表由 `/ai-flow:adr` skill 自动重建。不要手工编辑表格——改完会被覆盖。
