# 意图路由细则

## 主路由表（SKILL.md 已列）

简短意图 → 路由：

| 用户说 | 路由 |
|--------|------|
| "新加 ADR" / "记一下这个决策" / "我刚做了 X 决策" / 描述了一个具体决策但没说要干什么 | new |
| "ADR-N 已过时了" / "用新决策替代旧的" / "supersede X" / "推翻 ADR-N" | supersede |
| "项目还没 ADR" / "初始化 ADR" / "bootstrap" | bootstrap |
| "重建索引" / "ADR 列表乱了" / "更新 README" / "索引坏了" | index |
| "查一下提过 X 的 ADR" / "搜 ADR 里有没有 X" / "grep X" | grep |
| "列出 ADR" / "ADR 列表" / "有哪些 ADR" / "show all" | list |
| 单纯说 `/ai-flow:adr` 或描述很模糊 | clarify |

## 边界情况与优先级

### 复合意图

用户可能在一句话里表达多个意图。规则：**主操作优先**。

- "查一下提过 IndexedDB 的 ADR，然后新加一个用 PouchDB 替代它的决策"
  - 主操作：supersede（最终目的）
  - 子操作：grep 用于辅助定位旧 ADR
  - 路由：supersede（执行时内部调用 grep 定位 ID）

- "重建索引，顺便看看有哪些 ADR"
  - 主操作：index
  - 子操作：完成后顺带 list
  - 路由：index（结束时附带列表输出）

### supersede 时旧 ADR 标识

用户可能用三种方式指代旧 ADR：

1. **编号**："ADR-12 过时了" → 直接定位
2. **描述**："上次的 IndexedDB 决策过时了" → 内部调 grep 定位
3. **模糊**："最近做的那个决策过时了" → **必须反问明确**，不允许猜

### 新建 vs supersede 的判断

用户描述一个决策但没说是新还是替代：

- 提到「替代」「以前」「过时」「之前的」等词 → supersede 倾向
- 描述全新方案，没提既往 → new 倾向

不确定时反问：「这是首次决策（new）还是替代既有 ADR（supersede）？」

### bootstrap 触发判断

- 用户说"项目还没 ADR" + `docs/adr/` 不存在 → bootstrap
- 用户说"项目还没 ADR" + `docs/adr/` **已存在** → 提示用户：「目录已存在，是否重建索引（index）？」
- 用户说"初始化 ADR 体系" → bootstrap（无论目录是否存在，先 check）

### grep 范围

- 默认搜全部 ADR
- 用户可指定范围："在 accepted 状态的 ADR 里搜 X" → grep + 后置过滤
- 关键词支持中英文 + 部分匹配

## 拒绝路由的场景

以下场景**不允许路由到任何子能力**：

- 用户问"该不该写 ADR？" → 不属于本 skill 职责，回应：「本 skill 只管理 ADR，不判断是否该写。该判断是 feat-flow2 Stage 6 或用户自决。」
- 用户问"项目有哪些技术决策？" → 模糊；反问：「想列出已有 ADR（list）还是搜索特定内容（grep）？」
- 用户要求删除 ADR → ADR 不应删除（应 supersede 或标 deprecated）。回应：「ADR 不删除以保留追溯。请用 supersede 创建新 ADR 替代，或如确实弃用，明确把旧 ADR 状态改为 Deprecated。」
