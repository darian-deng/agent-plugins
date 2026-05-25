# 不是提示词问题，是流程工程问题

有段时间我靠一个越写越长的 skill 文件来约束 AI 的行为。一开始效果还行——代码风格对，命名遵守了，不该改的文件没动。直到某天跑一个中大型需求，context 窗口用到一半，skill 文件的那些指令就好像从来没写过。AI 开始重新发明已经决策好的方案，改了不该改的文件，输出物在 context 里越来越随机。我花了一个下午看哪里出了问题，最后得出的结论很难接受：文件本身没有问题，提示词写得也不差，是这件事根本不应该用提示词来解决。

## 为什么提示词解决不了

skill 文件的工作方式是把指令注入到 context 的开头。问题是 context 是按时间顺序填满的——你的指令在最前面，后来的对话、代码块、中间产物把它越推越后，AI 的注意力随着距离衰减。到了一个复杂需求的中期，那些精心写好的规范和一张几千轮对话前的便利贴没什么区别。

更要命的是，context 衰减和需求复杂度是正相关的。一个真正值得认真对待的需求，Stage 1 的技术对齐就得跑掉大量 context：讨论技术选型、确认边界、对齐 UI 状态、澄清隐性约束——用到 30% 是完全正常的。这些对齐对话有真实价值，但它们的代价是把 skill 指令越推越深，并且这些对话会一直带着进后续每一轮，不断压缩可用空间。

还有一个问题不在技术层面，而在协作层面：团队里没有人能按同样的方式用 AI。每个人都有自己的一套"提示词直觉"，规范文档没人看完，就算看了也不知道 AI 这次到底在不在遵守。提示词层的东西是建议，不是约束。只要 AI 能绕过，它就会绕过。

这三个问题合在一起指向同一个结论：需要一个不在提示词层工作的系统——一个在 AI 每次执行写操作时都能拦截并判断"这件事现在该不该做"的系统。

## 设计原则：取舍的尺子

两条原则在开始写代码之前就定了。

**质量第一，不追求降低 block 率。** 流程里的强制暂停和人工审批会影响体感，但这套设计允许它以质量为由存在。这不是妥协，是刻意的取舍——后面所有的 gate 机制都是这条原则的产物。

**Clear-Safe Persistence：任意时刻 /clear，流程不受损。** 这条原则直接决定了每个阶段的边界怎么划。凡是下游需要用到的信息，必须在 /clear 之前已经落盘到文件里。subagent 的 context 是临时的，主会话的对话历史 /clear 即消失，只有文件能跨 /clear 存活。

## feat-flow：六个阶段

feat-flow 是基于这套引擎的一条特定流程，把一个功能需求从"PM 说了需求"到"代码上线+知识沉淀"切成 6 个阶段：

| Stage | 名称 | 关键工具 | Gate |
|-------|------|---------|------|
| 1 | 需求确认 | grill-me + code-explorer + Figma MCP | ✅ |
| 2 | 实施蓝图 | code-architect | ✅ |
| 3 | 实施计划 | writing-plans | ✅ |
| 4 | 代码实施 | subagent-driven-development | ❌ |
| 5 | 质量门（验证+互审） | code-reviewer + receiving-code-review | ✅ |
| 6 | 知识沉淀 | adr-manage + optimize-claude-context | ❌ |

用一个真实需求感受一下流程里的产物：桌面端增加全局快捷键功能，支持音频打点、截图打点、文本打点（Electron 应用，Jotai 状态管理）。

**Stage 1 产出：design.md（节选）**
```markdown
## 决策记录
### Q1: 快捷键注册 API 选型
问题：需要选择全局快捷键注册方案。候选：Electron globalShortcut API / 操作系统级 native addon。
决策：Electron globalShortcut API
理由：原生集成，无需额外 native 依赖；支持主流平台；已有 preload bridge 可复用。
未选 native addon：额外打包体积 + 平台适配工作量不匹配收益。

### Q2: 键盘布局处理
问题：快捷键定义应按物理位置还是字符？影响非 QWERTY 键盘用户（AZERTY/QWERTZ）。
决策：使用 e.code（物理位置），通过 CODE_TO_QWERTY_CHAR 映射表存储快捷键
理由：确保不同键盘布局的用户按同一物理位置触发快捷键，体验一致。
```

**Stage 2 产出：architecture.md（节选）**
```markdown
## 模块定位
src/main/services/setting/shortcutService.ts   ← 快捷键注册、冲突检测、生命周期管理
src/main/services/recording/recordingService.ts ← processMarkAudio()，从 ring buffer 截取
src/main/services/highlight/highlightService.ts ← captureAndSaveScreenshot()，多屏适配

## 关键接口
function registerAndSyncStatus(): void
async function processMarkAudio({ blockId, recordingId, timestamp }): Promise<{success: boolean}>
async function captureAndSaveScreenshot({ source }): Promise<{success: boolean, error?}>

## Build 顺序
1. 类型定义（shortcut.ts, highlight.ts）
2. 原子状态（enableGlobalShortcutsAtom, shortcutsConfigAtom）
3. shortcutService 核心注册
4. processMarkAudio / captureAndSaveScreenshot
5. React hook（useShortcuts）+ UI 组件
```

**Stage 3 产出：plan.md（节选）**
```markdown
- [ ] Task 1：实现 registerAndSyncStatus() + findInternalConflicts()，单元测试冲突场景
- [ ] Task 2：实现 processMarkAudio()，含 AudioRingBuffer（40秒环形缓冲）
- [ ] Task 3：实现 captureAndSaveScreenshot()，含多屏 DPI 适配（Windows dipToScreenPoint）
- [ ] Task 4：useShortcuts() hook，键盘事件转换 + 系统级冲突检测
- [ ] Task 5：快捷键设置 UI（ShortcutRow + 绑定对话框）
```

这三份文档是整个流程的骨干。Stage 4 的每个 implementer subagent 读这三份文档就能拿到它需要的全部上下文——不依赖主会话的对话历史，天然 clear-safe。

## 这套系统怎么工作

feat-flow 能"强制"执行是因为它不在提示词层——它在 Claude Code 的 hooks 层。

**PreToolUse hook**：AI 发起任何写工具调用（Edit/Write/NotebookEdit）时，引擎在这里拦截。如果当前 stage 是 `docs_only`（Stage 1-3），AI 想写代码文件就会被直接 deny——不是"建议不要写"，是物理层面拒绝执行。Signal 文件的写入也在这里拦截：如果当前 stage 有 gate，AI 写 signal → 引擎 deny 并生成一个随机 token 发给用户 → 只有用户执行 `feat-flow approve <token>` 才能让流程前进。AI 无法伪造 token，也无法绕过。

**PostToolUse hook**：每次写操作完成后，引擎检查 context 使用率。阈值是这样配的（feat-flow 专属）：≥ 30% 首次提醒，每再增加 5% 再提醒一次；≥ 60% 写工具被 block，所有后续写操作被 deny，必须 /clear。

为什么选 60% 而不是更高？因为在中大型需求里，Stage 1 的技术对齐对话用掉 30% 是正常的。再往后 context 增长很快，等到 80% 才 block 就太晚了——AI 的行为已经因为 context rot 开始漂移。宁可早一点 block，保证后续每一轮都从清洁的 context 开始。

**/clear 无损续跑**：session-handler 在每次会话恢复时，自动重新注入 flow_id、current_stage 和当前 stage 的完整 prompt。多 task stage 的进度靠 plan.md 里的 `[x]` 标记——AI 重新进来就知道从哪里继续。所有重要信息都在文件里，不在对话历史里。

## 每个阶段在做什么，以及为什么是它

**Stage 1：需求确认**

这里用的是 grill-me，不是 brainstorming。区别很重要：brainstorming 是发散的，主动帮你想你没想到的方向；grill-me 是收敛的，一次问一个问题，强迫你给出明确答案。PM 提需求的场景通常需要收敛——需求已经有了，要做的是澄清、对齐、找出隐性约束。

grill-me 有一个机制值得一提：它被设计成"能查代码先查"，每个问题在给出推荐答案前，先从代码库找证据，而不是靠训练数据推测。但它有一个缺口：没有"自审"步骤。所以 Stage 1 的 prompt 从 brainstorming 里把它的自审 checklist 单独抢救出来加了进去——placeholder 检查、内部矛盾检查、范围漂移检查、AC 可验证性检查。这个细节让 design.md 的质量从"写完了"变成"写完了且有人审过"。

另一个强制步骤是代码探索：Stage 1 入场必须 dispatch 至少一个 code-explorer subagent。如果 AI 在连代码库都没看过的情况下给出推荐答案，那个推荐是泛型的，不是基于你项目实情的。如果需求涉及 UI，还有一个六维度对齐协议（数据/加载/错误/交互/流程分支/响应式），Figma URL 往往只覆盖 happy path，这个协议的作用是找出 Figma 没画到的状态，在代码动之前就对齐清楚。

**Stage 2：实施蓝图**

code-architect 产出的是"可执行的骨架"——具体文件路径、接口签名、build 顺序。design.md 告诉你做什么，architecture.md 告诉你怎么做。后者直接决定了 plan.md 里的每个 task 能不能落地。Stage 2 完成后向用户输出 7 点审批清单（覆盖度、模块定位、接口设计、数据流、集成点、build 顺序、TDD bootstrap 完整性），Gate 之前主动呈现，不是等用户问。

**Stage 3：实施计划**

用 writing-plans skill 而不是让 AI 自由拆解，原因是结构化输出质量更稳定。writing-plans 默认就是 vertical slicing——一个 task 一个完整的 red-green 循环，而不是先写所有测试、再写所有实现这种 horizontal slicing。这个细节在实际运行中影响很大：vertical slicing 保证每个 task 结束时代码处于可验证的稳定状态。

**Stage 4：代码实施**

subagent-driven-development（SDD）负责逐 task 调度实施。这里做了一个和 SDD 默认行为不同的选择：不让主会话反复为每个 task 构造 architectural context，而是给每个 implementer subagent 一个 Curated Sources 列表（design.md / architecture.md / plan.md / 相关 ADR），让它自己按需读。主会话每次 dispatch 前，把已完成 task 的新术语作为 Pending vocabulary 注入下一个 implementer——确保后续 task 能看到前面 task 沉淀的命名约定，避免同一概念在不同 task 里叫了不同名字。

**Stage 5：质量门**

把自动化验证（lint / typecheck / 全量测试）和代码审查合并成一个 stage。如果拆开，Stage 5 发现问题要修 → 修完重新验证 → 验证完去 Stage 6 审查 → 审查发现问题再修 → 又要重新验证。两个 gate 审的是同一轮改动，是套娃。合并后一个 stage 一个 gate，更干净。

3 轮互审协议（code-reviewer ↔ receiving-code-review）：每条 issue 必须附代码片段证据，reviewer 不能空口说"这里有问题"；3 轮后仍有分歧，上报开发者，不再循环。这个机制防的是两件事：author 表演性同意（reviewer 说什么就改什么，没有技术判断），以及 reviewer 和 author 无限对话直到一方认输。

**Stage 6：知识沉淀**

这是整个流程里最容易被省略、价值最容易被低估的阶段。核心使命是让这次 flow 之后，项目的 AI coding 能力是净正向的——不只是新增，还有修复过时的 CLAUDE.md 规则、退役已被否定的决策记录、把这次实施中发现的新 pattern 写进 rules。

用 adr-manage 处理架构决策，有一个四闸门决定是否应该写 ADR：先看是否能用代码注释说清楚（能注释的不写 ADR），再看是否满足"难以反转、无上下文会困惑、真有 trade-off"三条件，最后检查是否与既有 ADR 冲突。这个设计避免了 ADR 目录被低价值条目淹没。CLAUDE.md 的治理交给 optimize-claude-context skill——它带 lean 原则，帮你裁决哪些进 CLAUDE.md、哪些进 rules、哪些丢弃，同时控制文件体积不失控。

## 流程之外的管控

**Preflight 检测**在 `feat-flow start` 时执行，不是在中途才发现缺了什么。检测清单：claude CLI、Node.js ≥ 18、git、6 个必需 skill（grill-me / writing-plans / subagent-driven-development / receiving-code-review / optimize-claude-context / adr-manage）、feature-dev plugin。任何一项缺失就 fail，明确告诉你怎么安装。

**日常命令：**
```sh
feat-flow start <需求描述>   # 启动，触发 preflight + 生成 flow_id（如 2026-05-22-x7k3）
feat-flow approve <token>    # 通过当前 gate，进入下一 stage
feat-flow status             # 查看当前 stage 和 context 用量
feat-flow resume             # /clear 后恢复（引擎自动注入状态，通常不需要手动 resume）
feat-flow abort              # 中止并存档
```

**Write scope 限制**：Stage 1-3 的 `docs_only` 配置让 AI 在前三个阶段物理上无法写代码文件。不是靠提示词说"请不要修改代码"，是 PreToolUse hook 直接 deny 掉写代码文件的请求。

## 把它变成自己的：ai-flow plugin

feat-flow 是一条基于 ai-flow 引擎的特定流程。ai-flow 这套控制系统本身是通用的，有三个命令。

**`/ai-flow:add feat-flow`**：把 feat-flow 安装到当前项目的 `.ai-flow/` 目录下。安装后就是本地文件，可以直接修改 stage prompt、调整 context 阈值、增减 gate——适配自己项目的规范和风格。

**`/ai-flow:create`**：从头创建一个自己的 flow。你描述想要的工作流是什么，AI 会引导你把这个流程翻译成 ai-flow 的格式——config.json（stage 定义和 gate 配置）、preflight.sh（环境检测）、每个 stage 的 prompt 文件。你不需要学会 ai-flow 的配置格式，只需要描述你想要什么流程，AI 帮你生成符合最佳实践的配置。这是这套系统里我觉得最有"AI 时代气质"的交互。

**`/ai-flow:update`**：修改已有的 flow。防的是 AI 在执行流程时顺手改了 stage prompt——有了这个命令，flow 文件的变更走明确的修改路径，有记录，可追溯。

同一套机制，完全可以用来做 bugfix-flow、hotfix-flow、review-flow，任何需要结构化引导的 AI 工作场景都可以。context 感知、stage 隔离、写权限控制、环境检测、人工 gate——这些原语可以组合出很多不同的控制策略。feat-flow 是其中一个，但不是边界。

---

我接受这套流程比"随便写"慢一些，前几个 stage 有 gate 会打断节奏。但在中大型需求上，那些 gate 后来证明是在对的时候问了对的问题。设计原则说"质量第一，不追求降低 block 率"——这不是因为不在乎效率，而是那些 block 本来就该有，只是以前没有机制强制它发生。

如果你想试，第一步：`/ai-flow:add feat-flow`，选一个接下来要做的需求，跑一遍 Stage 1，感受一下 grill-me 审讯你的感觉。
