# decisions 抽取（决策切片）

> **触发**：stage-3 步骤 2——task 草稿已生成，要逐 task 填 `decisions` 字段。

每个 task 的 `decisions` = 从 design.md / architecture.md 抽出**只管这个 task** 的决策，内联进 task。

**目的**：取代「把整份 design.md 路径丢给子代理按需取」——整份给是噪音（一个 task 只碰设计的一个切片），按需取把决策可见性变成可选（子代理不读就漏，违反一致性）。切片把可见性变回**保证**。design.md / architecture.md 全文降级为兜底路径（仅 Stage 4 在切片不足时给）。

## 抽取机制：决策↔task 矩阵的投影

1. 建一张**决策↔task 矩阵**：行 = design.md 决策记录条目 + architecture.md 接口/契约 + design.md 验收标准 AC；列 = task。
2. 某 task 的 `decisions` = 它在矩阵里命中的那些行，逐条投影。
3. ⚠️ **诚实区分**：投影（矩阵列→task）是机械的；**填充（某条决策该挂到哪个 task）是判断，不可完全机械化**。所以覆盖门只能查 orphan（零命中），查不出错配（挂错 task）——错配靠 `plan-review.md` 的门 6（符号锚定类）+ Stage 4 per-task 规格审查（行为/风格类）兜。

## 什么够格进 decisions（四类）

只有命中以下四类的进 `decisions`，其余留兜底路径：

1. **接口契约**：本 task 必须遵守/产出的方法签名、返回结构、类型形状 ⟵ architecture.md §接口设计
2. **命名/类型约定**：本 task 必须沿用以保持一致的命名/类型名 ⟵ architecture.md / 前序 task 新术语
3. **验收断言**：本 task 闭合的那条 AC ⟵ design.md §验收标准
4. **显式决策约束**：约束本 task「怎么做」的决策记录条目，**含「为什么不选 X」**（防子代理重探被否决路径）⟵ design.md §决策记录

## 禁止进 decisions

- 实现步骤 / 代码 / 伪代码
- ⛔ 无法回溯到某 doc section 的条目（**无 `⟵ 来源` = placeholder 或凭空发明 = plan failure**）
- 复述 `done`（decisions 是护栏，done 是目标，二者正交）
