# ts-eslint-lsp：子代理写盘导致的“幻影诊断”——根因定论与修复

> 状态：调查完成 → 三轮对抗性评审收敛 → 首个修复（G）已随 **v0.1.9** 发布。
> 涉及插件：`plugins/ts-eslint-lsp/`
> 本文面向没有本次上下文的新读者（含未来的 AI agent），用一手证据（真实 session jsonl + 真实 git 提交 + LSP 协议/源码）重建问题、机制与结论，供独立复核。
>
> **重要**：本文修订自一份早期版本。早期版本对机制的归因（“我们的 reloadProjects 抓到重建中途”）和主推方案（`--canUseWatchEvents`）经真实数据核对后被**推翻**，见 §2、§4。若你手上是旧版结论，以本文为准。

## 1. 背景

### 1.1 插件解决什么问题

`ts-eslint-lsp` 是一个 Claude Code 插件，代理 Claude Code 与真实 `typescript-language-server`（下称 tls，包装 tsserver）之间的通信，同时把 ESLint 诊断合并进来，统一喂给 Claude Code 展示。

核心已知问题：Claude Code 的**子代理**（Agent 工具派发的独立 AI 实例）会**直接在磁盘上写文件**，这个写入**不经过主 session 的 LSP**（不触发 `textDocument/didChange`）。tsserver 手里的程序视图因此会跟磁盘脱节，对着旧/中间内容报出磁盘上已不成立的“幻影诊断”（phantom diagnostics）。

### 1.2 已有应对（v0.1.7 / v0.1.8）

两个 hook 检测“子代理是否真的改过 .ts 文件”：
- `PostToolUse:Agent`（`src/agent-refresh-hook.mjs`）：子代理经 Agent 工具返回时触发。
- `SubagentStop`（`src/subagentstop-refresh-hook.mjs`）：子代理真正执行完时触发，作为“后台异步派发”场景的兜底（它**只能触发 reload、无法向主 agent 注入文字**，因为 Claude Code 只经 PostToolUse:Agent 的 `additionalContext` 注入 agent 可见文字——已核实）。

触发后共享 `src/refresh-core.mjs`：按 mtime 扫最近改动的 `.ts/.tsx/.mts/.cts`，命中则 `touch` 一个信号文件。常驻代理 `src/ts-eslint-proxy.mjs` 用 `fs.watchFile`（**1000ms 轮询**）监听信号，检测到后经 **300ms debounce** 向 tls 发 fire-and-forget 的 `_typescript.reloadProjects`。

`agent-refresh-hook.mjs` 命中时还会向主 agent 注入一条 `additionalContext` 提醒。**这条提醒的旧文案是本次事故的一个直接放大器，见 §3/§4。**

## 2. 调查过程与一手证据

### 2.1 事故现场（fe-nexus，session `905ca6e3-267a-41d3-965d-34e470d483d2`）

feat-flow Stage 4，实施子代理 **Task 12**（`run_in_background:false` 同步）06:42:07 派发、06:55:28.069 返回并 commit（提交 `169265cd2`）。时间线（均来自 jsonl 一手读取）：

| 时刻 (UTC) | 事件 |
|---|---|
| 06:55:28.069 | Agent 工具返回；`PostToolUse:Agent` hook 触发（durationMs≈59），touch 信号、输出 additionalContext（旧文案含“diagnostics on files NOT open … are now **accurate**”） |
| 06:55:28.448 | Claude Code 附上 `type:diagnostics` 快照：**5 个文件 13 条诊断，全 `source=typescript`**（+379ms） |
| ~06:55:29.1–29.4 | proxy 才可能真正发出本次 `reloadProjects`（1000ms 轮询 + 300ms debounce） |

当时那个 session 的主 AI 判断：其中 `windowService.ts` 的“Expected 1 arguments got 0”和 `generated-notes/index.ts` 的“Cannot find name queryOne”**看起来像真实编译错误**（区别于它归为“过期缓存”的其它条），需独立核查。

### 2.2 逐条核对真相（对照 Task 12 最终提交 `169265cd2`）

| 文件 | 诊断 | 最终提交的真实代码 | 判定 |
|---|---|---|---|
| `…/generatedNotesQueueService.test.ts` ×8 | `2307` Cannot find module `../generatedNotesQueueService` | 模块文件**存在** | 幻影 |
| `src/main/rpc/readAndWriteAtom.ts` | `6133` `generatedNotesQueueAtom` 声明未使用 | import(L46) 且**使用**(L154) | 幻影 |
| `src/main/postInit.ts` ×2 | `6133` 两个 init 函数声明未使用 | import 且**调用**(L121/122) | 幻影 |
| `…/window/windowService.ts` | `2554` Expected 1 arguments, got 0 | 调用 0 参、定义也 0 参，**一致** | 幻影 |
| `…/window/generated-notes/index.ts` | `2304` Cannot find name `queryOne` | 全文**已无 queryOne**（import+调用同次删净） | 幻影 |

**结论：5 条全是幻影，无一是最终代码的真错。** 那个 session 主 AI 单独挑出来当“真错”的两条，和它归为“过期缓存”的，是同一类。（补充：那次判断的**行为**——停下来核实、不直接采信——是对的；真正的过错在信号不可信 + 旧文案的假保证，见 §3。）

早期版本把这 5 条分成“真混合态 / 无害旧值 / 无关的 Task 11 遗留”三类，此分类**不成立**：全部是同一根因的幻影；且诊断附件是**按最近改动范围 scoped 的**（后续快照 07:22/07:52/08:28 都换成别的任务文件），不是“全量快照”。

### 2.3 机制（三轮对抗评审后的定论）

**这是 program 级陈旧，不是 open-buffer 残留。** 依据：
- 主 session 全程**从未** Read/Edit 过这两个文件（jsonl 实测为零）；子代理写盘不走主 LSP（否则子代理 Edit 会发 didChange、tsserver 就有新内容、根本不会有幻影——幻影的存在反证了这一点）。所以这些文件**从不是主 session 的 open buffer**。

**幻影来源：tsserver 自带的文件 watcher，在 Task 12 那 13 分钟里捕到了子代理分步存盘的中间磁盘态。**
- 决定性证据是 `queryOne` 那条：最终磁盘态**根本没有 queryOne**，任何“读最终磁盘内容”的机制都报不出“Cannot find name queryOne”。这条只可能来自一个**中间磁盘态**（import 已删、调用未删，或反之）——即子代理分两步编辑时短暂存在于磁盘上、被 tsserver 的 polling watcher 恰好读到的那一刻。`windowService`（调用新=0参 / 被调函数签名旧=1参）同理，是 tsserver 程序对不同文件的新鲜度不一致。谁触发的读取不可知、也不必知。

**早期版本“我们的 reloadProjects 抓到重建中途”被推翻**：proxy 检测信号是 1000ms 轮询 + 300ms debounce，本次 reload 最早也要 touch 之后 ~300ms、典型 ~1s 才发出。快照在 +379ms，此刻我们的 reload 效果**不可能已体现**（无论它是否恰好已派发）。所以混合态与我们的 reload 无关，来自 tsserver 自带 watcher。

**由此结案早期版本 §4.2.1 的“表面矛盾”**：tsserver 对“从未打开但在 program 内”的文件**会自愈**（`editorServices.ts` 的 `onSourceFileChanged` 对 `!isScriptOpen()` 的文件走 reload；issue #41549 证实默认 polling），**只是慢且非原子**（07:22 它自己收敛干净了）。插件早期注释“已实测：不会自愈”是从 **open-buffer 复现场景**过度外推的——那个“不自愈”只对 open buffer 成立（LSP 规范禁止服务端对 open 文档读盘）。

### 2.4 结构性竞态（全篇最扎实的一条，已一手核实）

- Claude Code 的 LSP 诊断是 **push + 本地缓存**模型，**不支持 pull**（不声明 `textDocument.diagnostic` 客户端能力）；tls 也**不声明 `diagnosticProvider`**。诊断 100% 经 `publishDiagnostics` 推送。
- Claude Code 在工具返回后**同步读缓存快照**（`getLSPDiagnosticAttachments`），实测在编辑后 ~37ms 就读，而 push 要 ~800ms 才到（见 #17979 时间线）。
- **推论**：对“子代理刚返回那个即时快照”，任何 fire-and-forget 的刷新（现有 `reloadProjects`，或曾被主推的 `didChangeWatchedFiles`）都 settle 不了那么快——**我们必输这一次快照**；刷新只能救后续快照。这不是实现选错，是 tls 无版本戳 push + Claude Code collect-before-settle 的结构性缺口。

## 3. 结论

1. **本次幻影是 program 级中途态**，源于 tsserver 自带 watcher 捕到子代理分步存盘的中间磁盘态；它对 never-opened 文件会自愈但慢且非原子。
2. **根因是结构性竞态，不是“协议没有版本号”**。更正早期表述：LSP 自 3.15 起 `PublishDiagnosticsParams` **就有可选 `version` 字段**，是 tls 这个实现没填；且即便填了也救不了外部写盘场景（无 client didChange ⇒ 无“目标版本”可等）。真正缺的是“没有去等一个本可等的 settle 信号”，而 Claude Code 在子代理返回后是**同步 collect、来不及等**。
3. **对“子代理刚返回的即时快照”，不存在诚实的 100% 根治方案**。要在那一刻让幻影既不出现又不撒谎，只能对改动 URI 撤下/推空 TS 诊断——但那一刻程序态本身不确定，无法区分幻影与真错，撤下=把可自纠错的假阳换成静默的假阴（不接受）。
4. **真高危不是“多跑一次 tsc”，而是“主 agent 相信幻影去改正确代码”**。“防止基于幻影动手 + 把必要核实收窄”是可达的，也是修复应追的目标。
5. **必须永久保留“结果不确定时用真实 tsc/typecheck 核实”这条兜底**——协议层的确认信号缺口不会消失。

## 4. 方案

### 4.1 已做（v0.1.9）：修掉提醒里的谎言（G）

`agent-refresh-hook.mjs` 旧文案断言“未打开文件的诊断**现在准确**”——在竞态窗口内是假的（reload 异步、甚至可能尚未派发），且它是唯一可能诱导 agent 相信幻影去动手的一环。已改为如实提示：reload 异步、不保证在本轮诊断收集前完成，这些文件**及依赖它们的文件**的 TS 诊断可能是中途态，动手前（尤其“修”看似真错前）先 tsc 复核或重读、别单凭它采信；open-buffer 残留降为次要提示。**触发逻辑不变**（仍按 mtime 检测到 TS 改动即触发）。零风险、独立、对所有 ts-eslint-lsp 用户生效（非 feat-flow 专属）。

### 4.2 已否决：`--canUseWatchEvents` + `didChangeWatchedFiles`（早期版本的主推方案）

否决理由（真实数据 + 协议核实）：
1. **救不了本次事故**：它同样是 fire-and-forget、重建异步，settle 不了那个 +379ms 快照（§2.4）。
2. **会关掉 tsserver 自带 watcher**：PR #1057 的设计就是开启后把监听责任**完全交给客户端**、tsserver 停用自带监听。而那个自带 watcher 正是对 never-opened 文件（虽慢但）在收敛的东西（§2.3）。用脆弱的自研 `fs.watch`（Linux 递归/网络盘/容器挂载丢事件是已知问题）去顶替它，是不确定的交易 + 真实下行风险。
3. **也修不了 open-buffer 场景**：LSP 规范禁止服务端对 open 文档读盘，tsserver `onSourceFileChanged` 用 `Debug.assert(!isScriptOpen())` 排除了对 open 文件走磁盘重载——`didChangeWatchedFiles` 对 open buffer 无效，只有 `didChange`/`didClose` 能动（而伪造它们会与 client 文档版本 desync）。

### 4.3 已评估并否决：诊断“门控”提醒

设想：proxy 把“当前带 TS 诊断的 URI 集”非阻塞转储到小文件，hook 只在“确有诊断”时才提醒（降噪）。否决理由：它 gate 在**滞后于原因、且与诊断收集赛跑的效果**上——hook 读 diagMap 的时刻 ≠ 快照捕诊断的时刻（实测间隔 7–578ms），会**漏掉 gap 内才 materialize 的幻影，且漏的偏向最新写、最高危的文件**。对一条安全提醒，宁可像 §4.1 那样按“原因”（子代理改了 TS 文件）多喊，也不该按“滞后效果”漏喊。真实数据也表明噪音有限（3 小时 session 诊断附件仅 5 次，只读审查子代理零附件），门控收益小、不值其复杂度与漏报。

### 4.4 永久保留

“看起来像真错、但可能是子代理刚改动波及区的中途态 ⇒ 先 tsc/typecheck 复核再动手”这条兜底永久保留（现由 §4.1 的 additionalContext 承载）；协议层确认信号缺口不消失，它就不会失去价值。

## 5. 关键引用（均一手核对）

- 插件源码：`plugins/ts-eslint-lsp/src/{ts-eslint-proxy.mjs,agent-refresh-hook.mjs,subagentstop-refresh-hook.mjs,refresh-core.mjs}`
  - proxy 无任何 pull diagnostics 处理；诊断纯经 `publishDiagnostics` push（`sendToClient`）；`armRefreshWatcher` 用 `watchFile{interval:1000}`+300ms debounce；`REQUEST_TIMEOUT_MS=15000`；frame parser 用 Buffer 字节长度。
- LSP 3.17 `publishDiagnostics`：`version?: integer`（@since 3.15）—— **协议有可选 version，是 tls 实现未填**。
- typescript-language-server PR #1057（`--canUseWatchEvents`，merged 2026-05-10；要求 TS≥5.4.4；开启后经 `client/registerCapability` 注册 watcher、并**停用 tsserver 自带监听**）。
- tsserver `editorServices.ts::onSourceFileChanged`（`Debug.assert(!isScriptOpen())`——磁盘→重载只对未 open 文件）。
- microsoft/TypeScript #41549（tsserver 默认固定 polling 监听）。
- anthropics/claude-code #17979（CLOSED，诊断陈旧，时间线证实 collect 早于 push；修复“等 LSP 稳定”于 2.1.111，细节未公开）；#64239（OPEN，project-references 场景同构，其自述根因是 didChange version 恒定 #30622，与本文机制不同、仅症状同构）；#33035（CLOSED，Bash 删文件未发 didChangeWatchedFiles）。

## 6. 本文局限与复核指引

本文由 AI（Claude）在对话中调查、经三轮独立对抗评审收敛，但仍建议未来复核：
- (a) 源码行号可能随版本漂移，实施时以当时最新 `src/` 为准。
- (b) 外部 issue/PR 请打开原文核对摘要。
- (c) **两项“待实测/待核实”**（不影响 §4.1 已做的 G，但若要再往前走需先解决）：① 若将来重启“门控”类思路，其漏喊/空喊率**只能埋点实测**（记录 hook 时刻 diagMap 快照 vs attachment 时刻诊断）；② “LSP server 发不出 agent 可见文字、agent-facing 文字只有 hook additionalContext 一条路”是从 Claude Code 文档沉默推断的强判断，非官方明文，动更大改动前建议再核实。
