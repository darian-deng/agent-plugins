# Harness by ai-flow：从提示词到流程控制

## 换一个层次解决问题

提示词层能做的是建议。真正的约束要在更低的层次——在 AI 每次发起工具调用时拦截，在 context 超阈值时阻断，在 gate 没有通过时拒绝继续。

harness engineering 的思路就是：不靠 AI 的"自觉"，靠结构性的约束让它走不了错的路。

feat-flow 是在这个思路下设计的一条工作流，覆盖中大型功能需求从需求确认到知识沉淀的全程。它基于 Claude Code 的 ai-flow 引擎实现，引擎提供 hooks 基础设施，feat-flow 在上面定义 6 个阶段和它们的约束。

两条原则贯穿整个设计。

**质量第一，不追求降低 block 率。** 流程里的强制暂停和人工审批会打断节奏，但这套设计允许它以质量为由存在。这不是遗憾，是取舍。后面每一个 gate 都是这条原则的产物。

**Clear-Safe Persistence：任意时刻 /clear，流程不受损。** 这条原则决定了每个阶段的边界怎么划。凡是下游需要用到的信息，必须在 /clear 之前已经落盘到文件里。subagent 的 context 临时存在，主会话的对话历史 /clear 即消失，只有文件能跨 /clear 存活。

---

## Stage 1：需求确认

AI 在对话里跟你讨论需求，讨论完了，design.md 是 AI 综合对话内容整理出来的。这个过程有两个隐性的质量漏洞。

第一，AI 给的推荐是泛型的，不是基于你项目代码的。"这类场景通常可以这样做"——但你的项目里可能已经有了一个处理同样场景的抽象，AI 不知道。第二，讨论完了之后没人审 design.md 本身：有没有 placeholder，有没有前后矛盾，每条 AC 真的可以被验证吗？

选 grill-me 不选 brainstorming，不是因为 grill-me 更好，而是因为两者的气质完全不同。brainstorming 适合发散，PM 提的需求不需要发散，需要收敛——澄清边界，找出隐性约束，一次问一个问题，给出明确答案。

但 grill-me 有一个缺口：没有自审步骤。brainstorming 的 step 7 是写完文档后通读一遍，检查 placeholder、内部矛盾、范围漂移、AC 可验证性。我把这个 checklist 从 brainstorming 里单独抢救出来，加进了 Stage 1 的 prompt。这个细节让 design.md 的质量从"写完了"变成"写完了且有人审过"。

Stage 1 还有一个强制步骤：入场必须 dispatch 至少一个 code-explorer subagent，等结构化报告回来，再开始问询。这不是可选的。如果 AI 连代码库都没看就给推荐答案，那个推荐是泛型的，不是你项目里的实情。

如果需求涉及 UI，还有一个六维度对齐协议（数据状态/加载状态/错误状态/交互状态/流程分支/响应式）。Figma URL 往往只覆盖 happy path，这个协议的作用是让 AI 逐维度扫描 Figma 没画到的状态，在代码动之前逐一与用户对齐。处理过一次"实施到一半才发现空态没设计"之后，你会理解为什么这里不能偷懒。

---

## Stage 2：实施蓝图

design.md 决策了做什么，然后直接跳进 plan.md 拆任务——谁来决定代码放在哪个目录？接口签名怎么设计？先做哪个模块？这些决策散落在 AI 实施过程中，没有一个地方对齐。结果是 plan.md 里的 task 很难落地：task 1 写完了，task 2 发现接口设计对不上，要么回改要么将就。

code-architect 做的事情很具体：给你一份可执行的骨架，包括具体的文件路径、接口签名、数据流链路、build 顺序，以及与现有代码的集成点。

design.md 是"做什么"的答案，architecture.md 是"怎么做"的骨架。plan.md 只需要把骨架切成可执行的 task，不需要再做架构判断。少了这个翻译层，plan 质量就是不稳定的。

我们最初考虑过 2-3 个 code-architect 并行运行，产出不同方案让用户选。后来放弃了——code-architect 的设计哲学就是"pick one approach and commit"，强制它并行输出多方案是在和工具的设计哲学对着干。而且反锚定在 Stage 1 的 Q&A 决策记录里已经做掉了：每个问题都有问题描述、决策、理由，用户在那一步就参与了选择。到了 Stage 2，architect 只需要基于已有决策做落地，不需要再开一轮方案比较。

Stage 2 有 gate，gate 之前 AI 主动输出 7 点审批清单：覆盖度、模块定位、接口设计、数据流、集成点、build 顺序、TDD bootstrap 完整性。不是等用户发现问题，是主动把检查点摆出来。

---

## Stage 3：实施计划

让 AI 自由拆 task，它倾向于按层拆：先写所有类型定义，再写所有 service，再写所有 UI 组件。这是 horizontal slicing，每个 task 结束时整个 codebase 处于半完工状态，没有可验证的稳定点。

writing-plans 默认产出 vertical slicing——一个 task 是一个完整的功能切片，从接口到实现到测试，每个 task 结束时可以独立跑通和验证。

我们最初在 Stage 3 prompt 里加了一条约束："每个 task 必须包含 one red-green pair"。后来撤回了，不是因为这个原则不对，而是 writing-plans 本来就这么做，加这条等于在重复它已经做的事。如果 plan 质量出了问题，应该优先检查 architecture.md 给的 task 粒度建议，而不是在 prompt 里叠约束。

---

## Stage 4：代码实施

subagent-driven-development（SDD）逐 task 调度 implementer，每次 dispatch 前主会话需要给 implementer 构造 architectural context。这件事本身没问题，但我们的结构和 SDD 假设的不一样。SDD 假设是"一份文档加上原始代码库"，而我们有三份精华工件：design.md / architecture.md / plan.md。让主会话每次 dispatch 前重新把三份文档的相关内容提炼成 context，不只是费 token，还容易漏——主会话自己也不能保证每次提炼都覆盖到关键细节。

我们做的改动：给每个 implementer subagent 一个 Curated Sources 列表（三份文档路径 + 相关 ADR 路径），让它自己按需读。不由主会话反复构造 context，而是给 subagent 一张精确的地图，让它自己取。

这里有一个实际跑起来才发现的问题：task 4 实施时引入了一个新的命名约定（比如 `LRUEvictionPolicy`），task 5 的 implementer 不知道，写了个不一致的名字。所以我们加了 Pending vocabulary 机制：每个 implementer 的 task report 里有一个 `NEW_TERMS_OR_PATTERNS` 字段，主会话把已完成 task 的新术语合并起来，注入下一个 implementer。跨 task 的命名一致性靠这个机制维持，不靠 prompt 里的"请保持命名一致"。

Stage 4 另一个值得说的设计：lint 不在这里跑。项目有 pre-commit hook 就用它兜底，没有就在 Stage 5 统一跑。implementer 的职责是写代码、跑本 task 的单元测试，全局质量门是 Stage 5 的事。

---

## Stage 5：质量门

原来这里是两个独立的 stage——Stage 5 全量验证（跑 lint / typecheck / 测试），Stage 6 代码审查。看起来合理，实际运行是这样：Stage 5 发现问题要修，修完重新验证，验证通过了去 Stage 6 审查，Stage 6 又发现问题要修，修完重新验证——两个 gate 审的是同一轮改动，形成套娃。

合并。一个 stage，一个 gate，自动化验证 + 互审串行完成，全部通过再 signal。

3 轮互审协议专门处理两种失败模式。第一种：author 表演性同意，reviewer 说什么就改什么，没有独立判断，最后代码质量反而变差。第二种：双方无限对话，reviewer 坚持某个 issue，author 坚持 pushback，循环下去。硬性的 3 轮上限解决了第二个问题；receiving-code-review skill 的"严禁表演性同意"机制解决了第一个问题。3 轮后仍有分歧，上报开发者，不再循环。

reviewer 的每条 issue 必须附 ≤5 行代码片段作为证据，不能空口说"这里有问题"。这条要求大幅降低了无效 review 的比例。

---

## Stage 6：知识沉淀

这个阶段是最容易被跳过的，也最容易被做成"把这次的决策加到 CLAUDE.md 里"就完事。两个问题：哪些该进 CLAUDE.md，哪些该写 ADR，哪些其实写一行 inline 注释就够了，没有清晰的判断框架；另一个是 CLAUDE.md 只进不出，越来越肥，最后每一行都在争夺有限的 context 预算。

ADR 有一个四闸门：先看这个决策用代码注释能不能说清楚（能就写注释，不写 ADR）；再看是不是满足"难以反转、无上下文会困惑、真有 trade-off"三个条件（不满足就跳过）；最后检查是否与既有 ADR 冲突（冲突就写 Supersedes）。这个设计让 docs/adr/ 里只留真正需要的决策记录，不让它变成每次 flow 都追加条目的流水账。

CLAUDE.md 的治理交给 optimize-claude-context skill。它的核心原则是"每一行都在与有限的 context budget 竞争"——不只是新增，还要修复过时的规则、退役已被否定的记录、合并重复的约束。每次 flow 结束后，CLAUDE.md 应该比开始时更精准，而不是更长。

---

## 为什么提示词做不到这些

说到底，上面六个阶段里有几件事，写再好的提示词也保障不了。

Stage 1-3 的 `docs_only` 约束，让 AI 物理上无法写代码文件。PreToolUse hook 在 AI 发起写工具调用时直接 deny，不存在"AI 遵不遵守"这个问题。

Gate 机制：AI 写 signal 文件的动作被引擎拦截，如果当前 stage 有 gate，引擎 deny 写入，生成一个随机 token 发给用户，只有用户执行 `feat-flow approve <token>` 才能前进。AI 无法伪造 token，也无法绕过。Stage 1 和 Stage 2 这两个最需要人工确认的阶段，AI 不论 context 多大都绕不过 gate。

Context 感知阻断：每次写操作完成后，PostToolUse hook 检查 context 使用率。feat-flow 的专属配置是 ≥ 30% 首次提醒（每再增加 5% 再提醒一次），≥ 60% 写工具被 block，必须 /clear。选 60% 不是随意的，中大型需求的 Stage 1 对齐就能用掉 30%，等到 80% 才 block 已经太晚，AI 的行为在那之前就已经开始漂移了。

/clear 之后 session-handler 在会话恢复时，自动重新注入 flow_id、current_stage 和完整 stage prompt。多 task stage 的进度靠 plan.md 里的 `[x]` 标记。所有重要信息都在文件里，不在对话历史里，/clear 对流程无损。

日常使用：
```sh
feat-flow start <需求描述>   # 启动，触发 preflight 检测
feat-flow approve <token>    # 通过 gate，进入下一 stage
feat-flow status             # 当前 stage + context 用量
feat-flow abort              # 中止并存档
```

启动时的 preflight 检测涵盖 claude CLI、Node.js ≥ 18、git、6 个必需 skill（grill-me / writing-plans / subagent-driven-development / receiving-code-review / optimize-claude-context / adr-manage）、feature-dev plugin。任何一项缺失立即 fail，告诉你怎么安装，不是在 Stage 3 才发现 writing-plans 没装。

---

## ai-flow：把这套机制变成你的

feat-flow 是 ai-flow 引擎上的一条特定流程。这套 hooks 控制机制本身是通用的。

`/ai-flow:add feat-flow` 把 feat-flow 安装到当前项目的 `.ai-flow/` 目录下，成为本地文件，可以修改 stage prompt、调整 context 阈值、增减 gate，适配自己项目的规范和风格。

`/ai-flow:create` 是从头创建自己的 flow。你描述想要的工作流，AI 引导你把这个流程翻译成 ai-flow 的格式：config.json（stage 定义和 gate 配置）、preflight.sh（环境检测）、每个 stage 的 prompt 文件。你不需要学会 ai-flow 的配置格式，只需要描述你想要什么流程。AI 会在对话里帮你做关键的设计决策，包括 gate 放在哪里、stage 边界怎么划、preflight 要检测什么。这不是填表单。

`/ai-flow:update` 处理已有 flow 的修改，防的是 AI 在执行流程时顺手改了 stage prompt。有了这个命令，flow 文件的变更走明确的修改路径，有记录可追溯。

bugfix-flow、hotfix-flow、review-flow，任何需要结构化引导的 AI 工作场景都可以用这套机制。context 感知、stage 隔离、写权限控制、环境检测、人工 gate，这些原语可以组合出很多不同的控制策略。

---

我接受这套流程比"随便写"慢一些。前几个 stage 有 gate 会打断节奏。但那些 gate 后来证明是在对的时候问了对的问题——需求边界没对齐、architecture 有漏洞、plan 的 task 粒度不合理——这些问题放进 Stage 4 才发现，代价是整个 flow 回退。放在 Stage 1-3 的 gate 发现，代价是一次审批对话。

质量第一，block 率可以让步。那些 block 本来就该有，只是以前没有机制强制它发生。

如果你想试：`/ai-flow:add feat-flow`，选一个接下来要做的需求，跑一遍 Stage 1，感受一下 grill-me 一次问一个问题审讯你的感觉。
