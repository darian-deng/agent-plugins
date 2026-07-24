# 收尾组装审（stage-4）

> 全部 ticket 完成后跑一次组装级审查——补 per-ticket 各自 /clear 窗口**看不到整体 diff** 的洞（跨 ticket 的 Duplicated Code / Shotgun Surgery / 集成断裂）。不替代 per-ticket 双轴，是**叠加**。

## 1. 全量测试（AI 跑，不进 script 门）

- AI 亲自跑全量测试（异步可见、不冻 UI）。**不能塞进 script 门**——script 是同步 hook，30s 超时/1MB 上限/冻 UI，全量测试必崩。
- **假绿检测**：确认执行测试数 > 0（选择器空跑不算绿）。
- 原始输出（通过/失败计数 + 关键 stdout 尾部 + 当前 commit SHA）落 `review.md` 报告段——**gate 时贴给开发者亲验**。
- **诚实边界**：测试真绿无法机器证明（报告是 AI 写的）。真防线 = 假绿检测 + 开发者在 gate 看原始输出。

## 2. 双轴并行子代理（判断型 review）

diff 基准：`git diff <base_sha_code>..HEAD -- . ':(exclude)docs/grill-flows/*'`（pathspec 排除 doc churn，否则 checkbox/候选变更混进代码 diff）。两个子代理并行、都不开 worktree：

- **① Standards 轴**：携 `references/fowler-smells.md` 全文，审整体 diff 的跨 ticket smell——重点 Duplicated Code（多个 ticket 各写一份类似逻辑）、Shotgun Surgery、错 altitude、过度工程。
- **② Spec 轴**：携 `spec.md`，对 **User Stories 逐条**查需求闭环——每条 US 是否被某 ticket 兑现、有无缺失/偏离。

## 3. 安全专项（有界清单，钉死不外扩）

feat-flow 抢救回来的（"mattpocock code-review 忽略安全"是**假设**、未从源证实）。只看本 diff 的三类，不做全仓安全审计：
- 注入（SQL/命令/路径）
- 鉴权/越权
- 密钥/敏感数据处理

## 4. 呈现 + gate

- findings（双轴 + 安全）+ AI 贴的原始测试输出 → 汇总进 `review.md`。
- **不 squash**：保留每 ticket 独立 commit（tracer-bullet 的 landability——每片可独立 demo/回退是内核）。
- gate：开发者交付签收 approve。**不批 = 就地改代码/产物再重呈**（引擎无 reject 语义）。
