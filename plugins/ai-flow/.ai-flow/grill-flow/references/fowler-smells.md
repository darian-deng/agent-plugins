# Fowler Code Smell Baseline（Standards 轴基线）

> per-ticket Standards 轴（stage-3）与收尾组装 Standards 轴（stage-4）的判断依据。子代理**携本文件全文** + diff，只报告 `/simplify` 自动修不动的**判断型** smell，report-only 不 apply。Fowler《Refactoring》经典清单，按本 flow 关注度排序。

## 高优先（tracer-bullet 逐 ticket 实施最易滋生）

- **Duplicated Code**：多个 ticket 各写一份相似逻辑（逐 ticket /clear 看不到彼此，最易漏）。→ 提炼共用。
- **Shotgun Surgery**：一个改动要动很多处；一个概念散落多文件。→ 内聚到一处。
- **Divergent Change**：一个模块因多种不相干原因反复被改。→ 拆分职责。
- **Feature Envy**：方法过度访问别的对象的数据。→ 移动到数据所在处。
- **Wrong Altitude**：抽象层级混乱——高层函数里塞低层细节，或过早抽象出用不上的通用层。

## 中优先

- **Long Function / Large Class**：过长、职责过多。
- **Long Parameter List**：参数过多 → 引入参数对象。
- **Primitive Obsession**：用裸基本类型表达领域概念。
- **Data Clumps**：几个字段总是一起出现 → 成组。
- **Message Chains**：`a.b().c().d()` 链式穿透。
- **Middle Man**：一个类大部分方法只是转发。

## 过度工程（grill-flow 尤其警惕——散文 spec 不锁实现，易过度设计）

- **Speculative Generality**：为"以后可能需要"造的抽象、钩子、参数，当前无用。→ 删。
- **Dead Code**：不再被调用的代码。
- **Lazy Element**：不产生足够价值的类/函数（可内联）。

## 报告纪律

- 只报 `/simplify` 修不动的**判断型**问题（需要架构判断的），机械型（局部复用/简化/效率）simplify 已 apply，不重复报。
- 每条 finding 带：smell 类型 + 具体位置（file:符号）+ 为什么是问题 + 建议方向。不 apply、只报告，交主 session 定夺。
