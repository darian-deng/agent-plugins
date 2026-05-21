# 前置 stage 问题处理协议

适用于 Stage 2/3/4/5 中，AI（主 session 或 subagent）**自查发现**前置 stage 产出有问题。

**与 dissent-protocol 的区别**：
- `dissent-protocol.md` 处理「**用户对 AI 当前产出有异议**」
- 本协议处理「**AI 自己发现前置文档漏了 / 错了**」

两者不冲突，但触发条件不同，处理路径不同。

---

## 三级分类（必须 AI 主动暴露给用户，禁止自行处理）

| 等级 | 触发条件 | 处理动作 |
|------|---------|---------|
| **L1 大方向** | 推翻前置 stage 已对齐的**核心决策 / AC / 范围** | **stop**，向用户呈现问题 + 建议 abort；用户确认后重 `feat-flow2 start` |
| **L2 中等** | 前置文档**漏写**一个约束 / 集成点 / AC 子项，不推翻已有决策 | **暂停当前 stage**，回 Stage X 更新对应文档并让用户确认，再回当前 stage 继续 |
| **L3 小 case** | 局部命名 / 排版 / 单条 AC 措辞 / 显然遗漏的注释 | inline 修文档同步当前产出，在 task report 或当前 stage 产出里**注记修改了什么** |

---

## 实例对照

| 场景 | 等级 |
|------|------|
| Stage 4 implementer 发现 design.md「使用 IndexedDB」决策与 architecture.md 集成点冲突，二者不能共存 | **L1** — 推翻核心决策 |
| Stage 4 implementer 发现 architecture.md 漏了一个集成点（如 i18n 接驳），但不推翻已有架构选择 | **L2** — 漏写补全 |
| Stage 5 reviewer 发现 design.md「不在范围内」实际漏了一个约束（"不支持 IE"漏写） | **L2** — 范围补全 |
| Stage 3 plan 起草时发现 design.md AC 中某条 AC 标了 [auto] 但实际只能 [manual] | **L3** — AC 措辞修正 |
| Stage 5 reviewer 发现一处注释拼写错误 | **L3** — 直接 inline 修 |

---

## 暴露纪律（防止 AI 自我开脱）

**禁止 AI 自判 L3 后默默改**——必须在以下两个时机之一**主动呈现**给用户：

- 当前 stage 的 Gate 触发前（在「请审下列」清单里加一段「⚠️ 检测到 L? 类前置 stage 问题：<描述>，已按 <动作> 处理」）
- 若当前 stage 无 Gate（如 Stage 4 实施期间），通过 task report 暴露：在 implementer 的 task report 里加 `UPSTREAM_REVISION` 段

**L1 / L2 必须停在当前位置等用户确认**：禁止继续推进当前 stage 直到用户回应。

---

## L2 修文档后的下游影响检查

若 L2 修改了 design.md 或 architecture.md，主 session 必须做：

### 在 Stage 4 中触发 L2 修复时
- grep 已完成 task（plan.md 里所有 `[x]`）的改动文件
- 评估这些改动是否需要追加 **fix-up task**
- 若需要 → 加到 plan.md 末尾作为新 task（如 `### Task X.5 (fix-up)：补 i18n 接驳`），走标准 SDD 流程
- 不允许「悄悄改文档但不修已 ship 的代码」

### 在 Stage 5 中触发 L2 修复时
- L2 修文档 → 通常意味着代码也需要相应改动
- 把对应代码改动加入当前 review 循环
- 修完后重新跑自动化检查 + 进下一轮互审

---

## 与 dissent-protocol 的衔接

如果**用户**针对 AI 自查报告的 L1/L2/L3 又提异议（比如 AI 报 L2，用户认为是 L1），走 `dissent-protocol.md` 的「类型 C/D（与已有决策冲突）」路径，先更新 design.md 再继续。

不要陷入「自查 → 用户反驳 → 再自查」的循环，最多两轮——还不一致就 stop 让用户决定 abort 还是接受。
