# README.md 索引表格式规范

## 整体 README.md 结构

README.md 应包含三段：

1. **头部说明文字**（人工维护，索引重建时**不动**）
2. **索引表**（`<!-- AUTO-GENERATED INDEX BEGIN -->` / `<!-- AUTO-GENERATED INDEX END -->` 之间，自动重建）
3. **尾部说明**（如有，索引重建时**不动**）

## 索引表格式

```markdown
<!-- AUTO-GENERATED INDEX BEGIN -->

| # | Title | Status | Date | Supersedes | Superseded by |
|---|-------|--------|------|------------|---------------|
| [NNNN](./NNNN-slug.md) | Title text | Status | YYYY-MM-DD | — / [NNNN](./...) | — / [NNNN](./...) |
| ... | ... | ... | ... | ... | ... |

<!-- AUTO-GENERATED INDEX END -->
```

## 字段规范

| 字段 | 内容 | 缺失时 |
|------|------|--------|
| `#` | ADR 编号 + 文件链接：`[NNNN](./NNNN-slug.md)` | 不允许缺失（必填） |
| Title | 直接 copy 自 ADR 文件的 `# ADR-NNNN: <Title>` 中 Title 部分 | 不允许缺失 |
| Status | `Accepted` / `Superseded by ADR-XXXX` / `Deprecated` / `Proposed` 等 | 默认 `Accepted` |
| Date | 直接 copy 自 ADR header 的 Date 字段，YYYY-MM-DD | 缺失 → `—` |
| Supersedes | 该 ADR 替代的旧 ADR：`[NNNN](./NNNN-old-slug.md)` | 无 → `—` |
| Superseded by | 替代该 ADR 的新 ADR：`[NNNN](./NNNN-new-slug.md)` | 无 → `—` |

## 排序

按编号升序（0000 → 0001 → 0002 → ...）。

## 边界情况

### Status 字段含 supersede 信息

若 ADR header 写 `**Status**: Superseded by ADR-0007 — 2026-05-21`，索引表里：
- Status 列填 `Superseded by ADR-0007`
- Superseded by 列填 `[0007](./0007-...md)`
- 同步信息，**两处都要**

### 缺 metadata 字段

若某 ADR 文件 header 缺 Date / Status 等，索引相应位置填 `—`，但**索引重建时打印警告**：
```
⚠️ ADR-NNNN <Title> 缺 Date 字段（README 已用 — 占位）
```

### 链接破损

若文件名与索引中的 link 不一致 → 索引重建警告，但仍按文件名生成 link：
```
⚠️ ADR-NNNN 文件名为 NNNN-foo.md，索引按此生成；如需更新链接，重命名后重跑 index
```

## 示例

```markdown
# Architecture Decision Records

本目录记录项目的架构决策。

## 什么时候写 ADR

...

## 索引

<!-- AUTO-GENERATED INDEX BEGIN -->

| # | Title | Status | Date | Supersedes | Superseded by |
|---|-------|--------|------|------------|---------------|
| [0000](./0000-record-architecture-decisions.md) | Record Architecture Decisions | Accepted | 2026-05-21 | — | — |
| [0001](./0001-use-indexeddb-for-cache.md) | Use IndexedDB for local cache | Accepted | 2026-05-21 | — | — |
| [0002](./0002-use-atom-rpc-pattern.md) | Use atom-RPC pattern | Superseded by ADR-0007 | 2026-05-23 | — | [0007](./0007-switch-to-trpc.md) |
| [0007](./0007-switch-to-trpc.md) | Switch from atom-RPC to tRPC | Accepted | 2026-06-15 | [0002](./0002-use-atom-rpc-pattern.md) | — |

<!-- AUTO-GENERATED INDEX END -->

> 索引表由 `/ai-flow:adr` 自动重建。不要手工编辑表格。
```
