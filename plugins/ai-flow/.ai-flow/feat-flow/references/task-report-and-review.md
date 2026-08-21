# 单元回报之后：落盘、评审、越界核查

> **触发**：一个执行单元的实施子代理回报了（状态为 完成 / 完成但有顾虑）。**四步串行 checklist，做完才 dispatch 下一个单元。**
> 读者是主 session。回报是「受阻 / 需补充信息」→ 改走 `stage-4-exceptions.md`。

## 主 session 每 task 终态后按此序处理

串行 checklist，避免并发判断导致漂移：

1. 收到子代理精简回报 → **立即**落盘到 task-reports.md（`## Task N: <标题>`，格式见下）
2. 据回报 + diff 补全 `前置修订` 字段；把回报里的幸存候选 + 路由记入 `context 候选` / `ADR 候选`（**不重判**，理由见下「知识沉淀的归属」）
3. 跑评审 → 回填 `**审查**` 行（见下「单次评审」）
4. 确认本 task 段完整后，再 dispatch 下一执行单元

## task report 格式

implementer 报 完成 / 完成但有顾虑 后，主 session **立即**把下面这段追加到 `task-reports.md`。无内容的字段填「无」。**这是主 session 的落盘模板，不是 dispatch prompt 的一部分——绝不整段塞进子代理 prompt**（子代理只按精简回报形状返回，主 session 据此 + diff 补全本模板各字段）：

```markdown
## Task N: <task 标题>

**状态**: 完成 | 完成但有顾虑
**Commit**: <commit-sha>
**日期**: YYYY-MM-DD
**审查**: 规格 PASS|FAIL，质量 PASS|FAIL

### 新术语或模式
本 task 引入的术语 / 命名规范（如 "LRUEvictionPolicy"）——后续 task 靠它避免命名漂移

### context 候选
子代理 assess-candidate 判定该进 context 层的幸存候选；每条带目标层 + 理由 + file:line（rules/<domain>.md | CLAUDE.md | skill）

### ADR 候选
子代理 assess-candidate 路由到 ADR 的候选（跨文件、有权衡）——Stage 6 评 ADR

### 待人工验证
子代理上报的、机器地板（verify / 单测 / typecheck / lint）验不了的行为，每条一句「验什么」（判据见 dispatch-unit.md「`[manual]` 项」）。**Stage 5 环节 C 从这里汇总成真机验证清单交开发者逐条验，全部收口才允许 squash**——所以这里漏一条，那条行为整个 flow 里没人验过

### 前置修订
本 task 自查发现前置 stage 问题时填：L1/L2/L3 + 描述 + 处理（见 revision-protocol.md 入口 B）

### 遗留顾虑
状态为 完成但有顾虑 时填
---
```

**为什么必须立即落盘**：这些字段是后续 task（待沉淀术语）和 Stage 6（候选收集）的输入。主 session 内存里的 task report，/clear 后即丢——只有落盘才能跨 /clear 重建（入场重建待沉淀术语就是从这个文件读，不依赖对话历史）。若 /clear 落在补全中途（commit 已在、report 不全）——由 stage-4 的入场恢复规则重建。

**知识沉淀的归属**：知识沉淀本身由 implementer 子代理在 task 终态完成（它在代码里，满足 `assess-candidate` 的契约）。主 session **不自己跑 assess-candidate、不重判**（主 session 不读代码，litmus / comment-check / lint 毕业都无现场依据），只把子代理回报的**幸存候选 + 路由**记入 task report 的 `context 候选` / `ADR 候选` 字段。

## 单次评审

SDD 自带，一次读 diff、同时产出规格 + 质量两个 verdict；feat-flow 额外要求落盘。

评审结束**立即**把两个 verdict 回填到 task-reports.md 该 task 的 `**审查**` 行，不得延后。主 session dispatch 下一个 task 前，先确认上一 task 已有 `**审查**` 行（没有则先补跑评审再回填）。补跑评审时，使用 task report 中记录的 commit SHA 执行 `git show <sha>` 获取该 task 的 diff，**不依赖当前工作树状态**。

**diff 截断时的处理**：`git show <sha>` 默认只带 3 行上下文，若某处改动被截断在函数/逻辑块中间、仅凭可见的上下文判断不了正确性，允许用 Read 工具定位到那个具体区域读一小段（不是整个文件），并在评审报告里注明读了哪里、为什么——不因为看不全就放弃判断或凭空猜测。

⛔ **「无法从 diff 判断」的处理**：若某项 verdict 是「无法从 diff 判断」（该项要求落在本次未改动的代码里，reviewer 单看 diff 判不出），主 session **不得当 PASS 也不得当 FAIL 直接放过**——须自行读相关代码核实后再落最终 PASS/FAIL，并在 `**审查**` 行该项后加注 `（主 session 核实）`。

**注释治理不在每 task 评审里顺带做**：历史证明「多轴评审里稀释的一条」会漏（某次 feat-flow 源码留了 54 处进程指代）。每 task 只做**写时预防**（实施子代理守「注释规则」），真正的**清理统一由 stage-5 环节 C 显式调用 `comment` skill 做**（专职；机制见 skill、取最新）；per-task commit message 会在 stage-5 squash 时被自包含的最终 message 取代，不必在此逐条核。

## 规格 verdict 的额外检查维度（越界检查）

在 SDD 单次评审产出的规格 verdict 基础上叠加四条。**这四条违反时不会有任何东西报错**，只有这里查：

- **文件范围越界**：commit diff 中是否包含不在本 task `files` 字段范围内的文件修改？（`git show <sha> --name-only` 机械检查）。**单元是耦合簇时**：对比对象改为**簇 `files` 并集**，并结合子代理回报的「每个 task 实际碰了哪些文件」做 per-task 核对（簇内 task 互写对方文件属正常协作，写到簇并集之外才算越界）。
- **行为越界**：diff 中是否存在与本 task `done` 语义无关的新增函数 / 方法（对比 diff 中新增的函数/方法名是否超出 `done` 断言所描述的行为范围）？
- **枚举负空间检查**：若本 task 的 `done` / `decisions` 蕴含一个有限枚举集（N 个错误码 / N 个状态 / N 路分派），逐项核对 diff 是否每项都有实现 + 对应测试断言，缺项即 FAIL——diff-only 审查只看「写了什么」，此项补审「该写而没写的」负空间（实施侧降档后最易漏的失败模式）。
- **全局性决策核查**：若本 task 的某条 `decisions` 是全局性质（约束全部 task 的规则——如版本下限、命名规范、安全红线，而非本 task 专属的功能点决策），额外核对 diff 里的实现有没有违反它——全局性决策不因为只列在这一个 task 的 `decisions` 里就降低核查强度（Stage 3 不再把全局决策特殊转移，它就和其他决策一样按需重复出现在多个 task 里，**这里是唯一的机械兜底**）。

越界发现 → 规格 FAIL，要求 subagent revert 越界部分后重新 commit。
