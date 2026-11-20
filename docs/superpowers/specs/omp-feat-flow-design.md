# omp-feat-flow 技术方案

状态：compact／clear 接续修正案已完成 OMP 18.22.2 源码核查和独立反证 ACCEPT，HTML 恢复章节冷读 READY；仍待开发者对设计及公开测试 seams 定稿。仅设计；未实现本插件或执行其 E2E，未提交发布。

## 1. 产品边界

交付一个标准、user-scope 安装的 OMP 插件，源码放在 `darian-deng/agent-plugins` 的 `plugins/omp-feat-flow`。服务 GitHub + Linear 的需求开发；跨项目差异由项目配置表达，cmux 可选。不迁移 ai-flow 通用引擎，不做任意 flow DSL、多 tracker 平台或新的聊天运行时。

用户要控制的是实施授权，不是让模型自动判定“讨论够了”。A/B 两个入口都执行完整 grilling：目标、非目标、业务边界、异常路径、验收都要有明确处理。已有资料中的可靠答案直接沿用，不重复问；矛盾和未知必须提出。没有固定题数，也没有小/中/大分类器。

- A：已有产品 Linear 单与 PRD，读取并关联同一张单；PRD 存在不代表边界清楚。
- B：当前 session 已有探索，承接实际讨论，由 AI 整理实质内容并创建一张需求单，不创建空壳单，不让开发者重述。
- 小需求用短方案和直接验收；复杂需求按依赖做内部垂直切片，必要时调研、原型、独立规格和方案反证。需求内串行编码，不内建并行写手/分支归并器；不同需求可以并行。
- 每个 run 只关联一张需求 Linear 单、一个需求分支和一个需求 PR；内部切片不自动制造子单。
- 必须先批准可见技术方案才写产品实现。模型 signal、普通聊天、已有 PRD、native tool approval 都不能替代它。
- 开发者在 PR 上看代码。删除 PR 前人工代码亲审、reset/squash/amend 确认门；保留独立 AI 代码审查，以及有实际长期知识 diff 时的独立人工批准。

输入采用不可变截面：A 保存实际使用的 issue/PRD 内容及来源版本；B 保存 sourceSessionId、sessionFile、leafEntryId、实际分支中的相关原始条目和选定探索产物。不是只存 AI 摘要，也不恢复时读取不断增长的“最新会话”。助手推测单列；新资料显式导入、形成输入修订。旧 checkout 的探索代码不整份复制，沿用增量先进入方案，批准后应用。

## 2. 开发者看到的命令与路径

全部通过 extension `registerCommand` 注册；不用 `commands/*.md` 的 prompt 命令，不保留嵌套命令或兼容别名。

| 命令 | 唯一职责 |
|---|---|
| `/feat-flow-start [需求或 Linear 链接]` | 创建/承接需求；已绑定 run 则恢复，不重复建单、分支或工作区 |
| `/feat-flow-status` | 显示真实阶段、等待原因、owner、基线、运行/已装 build、失效证据和下一操作；这是公开观测面 |
| `/feat-flow-approve` | 展示当前确切的方案或知识 diff 候选，并接收该候选的显式批准；没有候选则不批准任何东西 |
| `/feat-flow-sync` | 为当前 run 受控同步 PR 目标分支，保护本地进度、解决冲突、更新集成基线并使旧质量证据失效 |
| `/feat-flow-update` | 检查/采用当前 run 的依赖内容更新，处理兼容性；执行代码需更新时给原生安装/重启指引，不自建热加载器 |
| `/feat-flow-finish` | PR 交接后的显式安全清理，不自动合并、发包或后台回收 |

命令从当前绑定或登记的 worktree 确定 run；共享项目配置不保存 currentRun。多个候选不猜第一条。`start` 允许创建本需求的跟踪资源和隔离工作区，不授予产品实现权限；方案批准明确列出实现、必要提交/推送、单 PR 与 Linear 交接的授权范围，不暗含 merge 或发布。

从任意原分支调用，读取项目约定后 fetch 固定起点，创建专用分支和 worktree，再从新 cwd 启动 OMP 承接。Plaud Web 项目实例已确认起点 `origin/staging`、PR 目标 `staging`；这不是所有项目的默认值，也不是插件仓库自举的配置。起点与 PR 目标分别保存，按实际目标仓库独立核定，不读当前分支猜测。禁止切换、stash、reset 或覆盖原 checkout。

cmux 内每个需求使用一个 `feat: <短标题>` group，需求 workspace 与该需求的独立 bug workspace 可同组；不抓取/移动其他 live workspace。确认当前 cmux 环境、使用真实 window/group/workspace UUID，创建或复用登记资源后选中新需求 workspace。普通终端给出准确的 `cd <worktree> && omp ...` 接续命令；不假装能在旧进程跨 cwd 切换。源 session 保留定位，不强制关闭。

## 3. 标准发布与原生升级：删掉自建 kernel loader

新建独立 `.omp-plugin/marketplace.json`，catalog 名拟定 `darian-omp-plugins`，只列 `omp-feat-flow`。既有 `.claude-plugin` catalog、ai-flow 及旧 feat-flow 全部保留，不卸载、不清缓存、不迁移旧运行态。扁平命令不等于两套旧/新引擎已经获得跨协议互斥；本插件只管理自己登记的 run。

原生安装路径：

```text
omp plugin marketplace add darian-deng/agent-plugins
omp plugin install omp-feat-flow@darian-omp-plugins --scope user
omp plugin upgrade omp-feat-flow@darian-omp-plugins
```

`package.json` 的 `omp.extensions` 指向发布入口。发布时将自有代码与 stage/reviewer 等静态资源打包为单个模块，静态绑定宿主公开 SDK；不在运行中从插件安装目录 lazy import/read 执行代码、提示词或方法资源。例外仅是只读原生安装登记及小型 `release.json` 元数据，用来发现已装更新，绝不把它们当运行中执行资源。源码仍是维护真源；发布准备生成入口、构建指纹和 catalog 元数据，安装端不临时编译或拉取开发依赖。CI 验证发布内容与源输入匹配；本轮不执行发布。

每次已加载的 controller 模块实例有自己的不可变资源和 processInstanceId；通常是一个顶层 OMP 进程，不声称一个 PID 永远只有一份模块实例。只读 SDK helper 消费已捕获的角色文本，不另起 helper CLI/worker 从磁盘加载所谓旧 controller。

删除旧提案的 `packages/<H>` 完整代码留存、install/snapshot 双模式、内部多版本 kernel loader、第二个 `-e H` 入口和升级 supervisor。理由：用户需要安装更新后继续最新流程，不需要全局升级后仍在新进程精确执行旧 build。外部 skill 的 run 内容快照仍保留，两者不能混为一谈。

保留简单 buildId：发布作业以规范化源/资源输入及构建配置生成指纹，编译进发布模块，同时写入 `release.json`；排除生成物自身，避免递归哈希。running buildId 只取已加载模块常量，installed buildId 只取原生安装登记指向的该包 `release.json`。版本号、缓存路径不是内容身份。同版本重装也比较两者；替换窗口读不到时记 unknown，不假报一致。不据此声称防恶意篡改。

升级行为：

1. 在相关 `input`、流程命令或活动 checkpoint 等可观测边界检查安装信息，使用宿主当前 profile 的原生目录/安装契约，不每次启动子 CLI 全量扫描。没有持续轮询或 reload 完成事件。
2. `/reload-plugins` 只刷新 skills、文件命令、agents、MCP，不重评 TS handler。可以观察其输入并提醒，但不吞掉/覆盖 builtin，也不宣称 reload 成功握手。
3. 当前已无在途写/helper且进度已落盘，才提示“现在执行原生 `/restart` 可采用新版”；忙碌时明确列出需要先结束的工作。`/restart` 不替本插件安全排空，`ctx.shutdown()` 也不是可取消的升级移交 API。
4. 原生 `/restart` 保留终端、启动参数并恢复 session；没有公开 extension restart API，不伪造自动代按。新 controller 先取得本 run 的互斥租约，校验 stateSchemaVersion、对账未知副作用、完成兼容迁移，再取得新的 ownerEpoch 和写资格，显示 oldBuildId → newBuildId。
5. 用户在忙碌时直接 restart/崩溃，仍按 dispatched/unknown 账对账，不能视为未执行。exec 可能保留 PID 和 sessionId；新 processInstanceId/ownerEpoch 必须使旧回执失效。
6. A 升级重启不改变仍活着的 B 模块实例和资源。B 日后恢复会装载当时已安装的新 build，经兼容检查继续；不承诺精确恢复旧代码。未知/过新的 schema 拒绝写入，不能猜字段继续。
7. buildId 改变本身不机械要求重批业务方案。改变批准编码、操作/恢复语义的发布须显式迁移及失效相应授权/证据；不能只 bump semver。

初期源码/接口核查基于 OMP 18.22.0，最终独立审查观察到同一安装位置已更新为 18.22.2。首次真实 E2E 须冻结并记录当时实际宿主版本/build，不把旧源码观察冒称新版本已运行通过；发布声明最低版本/能力，不冒称所有旧 OMP 或跨平台 TUI 均已验证。新 worktree 使用普通 user-scope 发现，不覆盖用户 extensions 数组、不 blanket `--no-extensions`、不重复加载本插件。

## 4. 项目默认值与并发隔离

布局在 Git common directory 的 `omp-feat-flow/`，不进入产品 PR：

| 内容 | 职责 |
|---|---|
| `project.json` | 有 schema/revision 的项目默认值；无全局 currentRun/currentSha/owner |
| `runs/<runId>/` | 唯一权威运行状态、封存输入、技能内容、批准及必要证据/操作记录 |
| 固定 lock sidecar | 同项目配置或同 run 的短事务锁、当前 owner 的排他租约；不是临时占位文件 |
| worktree 的 Git 管理目录内定位符 | 仅 runId／仓库定位，不含阶段、owner 或授权；clear／新会话不靠聊天找 run |

只保存需要反复使用的决定：规范 repository/remote、起点和 PR base、worktree 根、Linear workspace/team/状态 ID 与实际工具绑定、现有准备/验证入口、项目知识入口、真实共享资源 lease、交付环境提醒、明确的模型策略。凭据留给宿主原有存储，不写入项目配置。

先从真实仓库、Linear 和现有项目约定取事实；只对无法代决的取舍集中询问一次。effective config 在每个 run 封存；修改共享默认不偷偷影响其他 run。更新检查时间、提示是否读过等易变状态不混入业务授权摘要。共享配置也拒绝未知新 schema。

稳定身份为规范 repository + Git common directory，需求使用 Linear issue UUID，标题只作显示。同一 common directory 内同需求恢复同一 run；不声称跨 clone/机器分布式互斥。不同 run 的分支、worktree、owner、基线、批准、实际配置和采用 build 均独立；只给真实共享 dev 资源加资源 lease，不用项目级长锁串行全部开发。

start 用项目级短预约事务检查同一 issue/input key 是否已有 run，分配并落盘后立即释放，绝不跨网络持锁。A 按 issue UUID 唯一关联；B 在 issue 未创建前以源 session/leaf/规范输入定位同一次启动预约，外部创建后回填 UUID 时再次检查唯一性。marker 只用于查找和对账，不授予 owner 或产品权限；不另建一份流程状态。

启动源 session 先完成受控准备，再显式交出该 run；新 worktree 中的真实 session 取得租约并完成恢复后才成为 owner。源 session 仅留下非活动接续定位，可继续在其他 checkout 工作；对已登记需求 worktree 的普通文件写仍检查真实 owner，不把源 session 的旧身份当通行证。

## 5. 三个权限阶段，不把技能数量变成 stage 数

| 阶段 | 权限与离开条件 |
|---|---|
| 对齐 | 读取/研究、隔离 scratch 原型、整理同一需求单和方案；禁止产品实现。只有当前方案的真实显式批准才离开 |
| 实施 | 在批准意图内逐片实现、验收、独立审查和相关知识维护；范围/关键契约/验收改变则回对齐 |
| 交付 | 冻结产品写，只执行已授权提交、push、单 PR、Linear 回写；必须按实际结果结算 |

暂停、待方案/知识批准、外部结果未知、恢复中是等待原因；handed_off/finished 是终态标记，不再造一串业务 stages。模型判断低风险、边界清楚、候选 ready 都不推进权限，也不自动弹出批准 UI 迫使开发者进入下一步。

方案批准绑定 run、输入修订、精确展示的方案/授权包、实质有效配置和方案 revision。当前基线记录为当时评估依据，不把不断变化的 SHA 硬塞进授权相等式而迫使每次 sync 重批。受控同步后必须重新评估方案适用性；实质未变可保留业务授权，改变或不确定才重新 grilling/批准。

批准 UI 的一次尝试绑定当前 owner/epoch 与候选 digest；提交时再次核对，过期回答不落权。成功授权随后按语义对象保存，不因正常 owner 重启/换 epoch 自动失效。普通提交改变 HEAD 不等于业务方案变更。

## 6. 每轮提问与方案的冷读契约

对象是技术开发者，但不知道 AI 探索过什么。每轮必须给出当前事实、相关背景、真正待决点、为何此时要定、选项后果、推荐及批准意味着什么；不只给文件路径或内部术语。已有确定事实不转嫁给人查询。一次 frontier 批量冷读，不为每个字段另派 agent。

采用一个小型受控 `feat_flow_ask` 工具，配置/向导命令复用同一内部 askRound；不只挂在普通 `ask` 的 `tool_call` 上。原因：后续 extension 可改写入参；原生 ask 的 HTML 在 RPC 会派生成逐字段提示；命令直接调用 UI 又不经过 model tool_call。

执行边界的契约：

1. 在受控工具 execute 内，以最终入参生成确定的 native question packet；包含每个 `select`/`input`/`editor` 的确切 title、选项、说明及默认值。公共背景出现在每个字段的实际提示中，RPC 不丢上下文。不重造 UI 框架。
2. 对实际投递给原生 UI API 的序列化 packet 求摘要，由全新 in-memory SDK 会话只看这份 packet 和冷读职责。不给探索历史、项目 context、tools、MCP 或父会话 system/history；不用会继承父历史的 runEphemeralTurn。
3. 仅接受真实完成、身份/修订/摘要匹配的结构化 ACCEPT。REVISE 返回可改意见，不展示问题；失败/超时是 unavailable，不冒充通过。任何展示字节变化都重审。
4. 原样重放已审 packet；一轮只冷读一次。所有 feat-flow `select/input/editor/confirm` 一律不传 `dialogOptions.timeout`：原生 TUI selector 到期可能自动选择当前项，confirm 的首项甚至是 Yes。只用 abort signal/明确取消路径；宿主报告 timedOut 则视失败，整轮部分答案丢弃，不以默认值补决定。模型冷读的请求超时与人的 UI 等待完全分离。
5. 自定义 tool call 展示只写“正在准备已审问题”，不在默认展开树中提前展示未审问题。遵守宿主安全策略；业务问答不授予产品写权限。

`/feat-flow-approve` 是唯一写入方案/知识授权的程序入口。候选 ready 只保存/通知；命令读取当前候选，冷读包含完整方案或知识 diff、版本和批准后果的实际确认包，再调用原生 confirm。只有显式 true 且关闭时仍是同一候选才能授权；取消、超时、tool/session approval、模型说“人同意了”均无效。无知识 diff 不制造知识批准。

无模型/凭据时只显示静态的原生 `/login`、`/model` 等配置指引并停止，不先发未经冷读的 wizard 问题。默认模型遵守宿主/项目明确策略，可沿用当前已选择模型的新上下文；不要求其他开发者拥有本次审查的 Kimi 账户。不得静默 fallback。

保证边界是传给原生 OMP UI 的确切内容，不是任意第三方 RPC 客户端的像素或其 debug 原始帧。stage 指令要求问题走受控入口；普通聊天问句/回答不推进流程。插件不能形式化禁止主模型在自由文本里冒出问句，也不接管整个模型输出流。OMP 自身登录/安全授权 UI 保持宿主行为。独立冷读降低上下文缺失风险，不证明事实或推荐正确。

## 7. 实际采用的 Matt 方法与外部升级

已逐项评审上游 39 份 SKILL.md：27 正式、4 冻结 misc、8 in-progress；审过的 HEAD 为 `5863806dd4e15c63174bee4e7515a4256792ecfa`。完整逐项取舍见 `omp-feat-flow-skills-audit.md`。这不是声称未来所有上游版本已经审过。

| 类别 | 采用内容 |
|---|---|
| 核心运行依赖 | `grilling`、`tdd`、`code-review` |
| 实际风险触发才需用 | `research`、`prototype`、`codebase-design`、`to-spec`、`to-tickets`、`wizard`、`wayfinder`、`diagnosing-bugs`、`to-questionnaire` |
| 设计/编写参考，不要求额外安装 | `pr` 的 Summary / Evidence / Merge Danger、`writing-for-agents`、`handoff` |
| 不引入运行编排 | `grill-with-docs`、`implement`、`implement-spec`、`setup-matt-pocock-skills` 以及其余不适用方法 |

外部依赖由开发者已有安装方式维护，不随本插件捆绑技能正文。当前三项原生解析来源是 `~/.agents/skills`；安装记录指向 mattpocock/skills，但不能用锁里的上游 tree SHA 冒充本地内容校验。不因同名就另装一份 OMP Matt 插件或改全局发现优先级。

新用户不必先拥有管理器或已安装技能。发布包只附依赖元数据与静态指引：上述三个规范名称/上游子目录、规范仓库、已审兼容 ref、由该 ref 实际文件生成的完整性清单和核对规则，不附正文。核心缺失时，在创建需求单、分支或 workspace 前停止；条件方法只在触发时处理。若有可用模型，安装选择同样走冷读；没有则只给静态原生命令和来源说明。

全新安装有两条明确路径，不自动替人选：

- 沿用已有 skills CLI：官方选择性命令为 `npx skills add mattpocock/skills --skill grilling tdd code-review --global --agent pi`。只有对应运行时/管理器可用且用户明确选择才执行；缺少时不偷偷下载管理器或增加 Node 依赖。
- 不想增加 skills 管理器：使用原生 `omp plugin marketplace add mattpocock/skills`，再 `omp plugin install mattpocock-skills@mattpocock --scope user`。这会安装官方整包 27 项，须明确说明并获同意；不能冒充仅装三项。该路线更新也是整包，超出“仅选定 skills”的既有有限自动更新许可时须另取整包许可，不擅自升级其他 24 项。

先展示副作用，再安装并重新核对实际来源/内容；上游 ref 比已审基线新时检查变化与契约，不把“最新版”当作已验证兼容。已有正确外部副本不因这两条新用户指引再安装同名第二份。这里只实现本插件选定依赖的引导，不做通用依赖管理平台。

开始及实际需要条件方法时核对来源/内容和可用更新。用户单独允许：只对本流程选定、来源已核对且确认无本地修改的外部副本自动更新。全局变化可影响其他引用该目录的工具；来源未知、本地修改或不能核对时不覆盖，展示情况再问。不顺手更新所有 skills，不重造通用安装器，不偷偷安装/升级管理器。

每个 run 保存实际调用的方法目录及必要配套文件、来源和实际内容摘要；复制中变化/不完整拒绝采用，不向可变全局目录补缺。方法默认通过固定内容加入执行上下文，不依赖裸同名 skill 动态解析。此绑定不替换 OMP 全机 skills 发现，也不阻止开发者手动阅读其他版本。外部引用/脚本超出可封存边界时明确处理，不能谎称闭包完整。

活动 run 不因全局更新换方法；开发者通过 `/feat-flow-update` 显式切换，先结算在途工作、核对新内容与流程契约、形成新的绑定修订，并重做受影响检查/审查。已确认产品事实不机械清空重访谈；新方法揭示未决边界则继续 grilling。上游变化与控制契约冲突时停止采用并说明，不静默忽略新规则后冒称原样复用。

显式适配：原生 UI/独立冷读是本流程新增；Linear、单需求单、权限/提交/交付由唯一控制器管理；to-spec/to-tickets 不执行上游发布/标签动作；research 不强制固定代理人头；code-review 的两真值轴按读集组织。保留来源、许可及适配说明，不把改写行为冒称上游原生功能。

## 8. 可选活动与 agent 的必要性

必要结果只有：完整边界对齐、可批准方案、授权内实现、真实验收、独立代码反证、相关知识必要性判断、单 PR 和 Linear 交接。不要求每项独立长文件，不写“无”占位产物。

事实未知先查一手代码/文档；只有确实独立且足够大的读集才并发 research。能用隔离原型证伪时用 prototype；复杂依赖需要可执行切片时用 to-spec/to-tickets；关键决定尚不可落实才用 wayfinder；需要人做凭据/设置动作才用 wizard，不每次跑安装仪式。

方案反证在接口/数据兼容、权限安全、并发/生命周期、持久化迁移、跨模块、依赖/lockfile、构建发布/运行配置、外部契约或重大未知时启用。只有有证据排除这些风险、验收直接且范围受限才可跳过；UI/行数不是豁免条件。不确定走保守反证。选择与跳过一次醒目展示规则及本次证据，不让人逐项批准步骤。

独立代码审查始终对照 Standards 与批准 Spec。大读集可两轴并发，小的实质变更可由一个新上下文给出两个独立章节；公开这项对固定双代理的适配。知识 diff 审查可并入规范轴，但同时看实施前指导、实际代码和知识 diff，不固定再养一个人。

依据是隔离作者锚定、区分规范与目标真值并强制证据，不是多模型投票或“agent 越多越好”。可确定地检查独立会话、输入快照、实际执行和回执绑定；不能保证 LLM 判断正确或统计独立。

SDK helper 显式 cwd、核准模型、宿主 modelRegistry/authStorage、in-memory SessionManager 和私有 AgentRegistry；关闭 ambient extensions/context/skills/commands、MCP、写工具、process-state 绑定和 cache warming。冷读无工具，事实/代码审查只给有限只读工具；LSP 只查询。固定策略禁用静默模型 fallback，报告实际选择器。等待 terminal 完成，校验结构化任务/epoch/快照回执；取消先阻止新工作，finally dispose，不清父会话资源。

## 9. 受控 sync：起始历史与当前审查基线分开

`startSha` 永久记录 worktree 的创建基线；`currentIntegrationSha` 是本 run 最近一次成功同步采用的上游提交；`baselineRevision` 随成功同步递增。实际质量证据还绑定本次代码/知识内容。绝不把 HEAD 覆盖成基线，也不拿最早 SHA 做 reset/squash。

`/feat-flow-sync` 及 PR 前主动同步走同一 Git 操作协议：

1. 暂停新写，结算活跃写和 helper；核对 run/worktree/branch、原有 rebase/merge 及 dirty 归属。释放短锁等待，避免等同锁回执死锁。
2. 只暂存明确属于本需求且已授权的修改，创建可见的本地 checkpoint commit；无关/归属不清即停。不用 git add -A、隐式 autostash 或自动 push。checkpoint 可保存 TDD red 进度，不冒充质量通过；不绕过项目 hook。
3. fetch 实际目标并固定该次 SHA/必要 Git anchor，不能把其他并发 run 会修改的 origin/staging 引用当作自己的固定结果。以登记旧/新基线 rebase，操作进度复用同一账，不建 sync-state.json。
4. 冲突由 AI 在已批准意图内尝试解决，读取双方有效行为和项目指导；不整边 ours/theirs、不删测试吞验收。语义歧义、关键契约/范围变化或证据不足才问人，且问题先冷读。
5. 只有成功结算才推进当前集成 SHA/revision。中断保留 Git 实际状态与操作记录，不能恢复时重置为未开始；对账后继续或安全处理。
6. 成功同步使旧代码验收和审查失效，重新完成必要验证与独立审查；业务方案实质未变不机械重批。知识批准按当前实际需求 diff/加载范围/列明代码依据重新判断，不让人替上游自己的知识变化背书。

外部手动 pull/rebase/commit 引起未登记漂移时，检查真实历史/内容并明确对账，不改 startSha、不抹用户改动、不凭 HEAD 猜新基线。能证明同一需求增量与新基线才登记；不确定就展示差异请人裁决。

PR 前先主动同步一个明确截面，再冻结、验证和审查；不在证明后偷偷 rebase，不永久追逐移动中的 staging。记录实际测试的 base/head，核对真实 PR diff 和当前合并风险。无自身增量不伪造修改。若需改写已发布需求分支，只在明确授权且使用登记远端 SHA 的精确 force-with-lease 下更新；远端被别人推进就停，不刷新 lease 后覆盖。

## 10. 六项控制机制与一份操作账

| 机制 | 保留的具体失败面与最小形式 |
|---|---|
| signal 文件 | 一个受控持久 outbox；重复、迟到请求不能推进。受控工具填真实 run/actor/role/epoch/revision/requestId/digest，模型不自填身份；只请求检查，不授权 |
| 短文件锁 | 同 run 状态读改写不可丢更新；锁失败拒绝写，不能超时后裸写。复用宿主导出的 OS-backed file-lock，不造 PID/mtime 超时锁 |
| owner 互斥 | 同需求只有一个写 owner；独立持有本 run 排他租约，身份含模块实例与 epoch，不只用 PID/sessionId；不是全项目大锁 |
| 恢复矩阵 | 崩溃后对账真实 Git/PR/Linear、当前授权和在途写，不靠助手摘要恢复或无条件 advance |
| 每工具拦截 | 以真实权限/owner/角色阻断未授权写与未登记 spawn；受控程序动作也复用同一准入/结算条件 |
| stage 提示词 | 当前目标、权限、完成条件、绑定方法和当前必要上下文；不内联整本恢复手册或字符计数读锁 |

权威状态只在 run 中；session entries 仅定位。signal/outbox 不是第二状态机，在同一事务核验和持久消费 requestId。状态原子替换、落盘失败均显式处理；OS lock 的 sidecar 不删除，避免旧/新 inode 分裂成两把锁。

普通本地写只保留活跃 admission：toolCallId、actor/epoch、请求摘要、目标和是否结算；正常结束可压缩，不给每次 edit 永久建完整 WAL。外部或难重放的 Git/GitHub/Linear 动作才保留 prepared/dispatched/settled/unknown 及精确请求/回执；允许执行前先落 dispatched。迟到/脱离 owner 的写不会因 epoch 变了就在物理世界撤销，未知写必须阻塞冻结/接管/finish。

转阶段、冻结验收、接管和 finish 都先停止新写准入，等待在途动作与 helper，再重新持短锁核验；不持锁等待需要它提交结果的工作。不以 wall-clock 超时抢活 owner，不杀未证明归属的 PID。

| 恢复事实 | 动作 |
|---|---|
| owner 租约仍持有或状态未知 | 不接管；报告当前定位 |
| 租约可取得，但旧写未结算 | 进入只读对账；不能先授予新产品写权限 |
| Git 操作中断 | 对照实际 worktree/index/rebase 状态和原操作继续处理，不覆盖进度 |
| 外部创建结果未知 | 按唯一 marker/真实对象/服务端幂等证明对账；一次 not-found 不足以再创建 |
| PR 已有、Linear 回写失败 | 只补尚未完成的回写，不再建 PR |
| 批准对象变化/证据过期 | 回到对应批准或活动；不重置整条流程，也不继承失效授权 |
| 旧 helper/epoch 回执晚到 | 不接纳为当前证据，不误推进 |

扩展不是 OS 沙箱：原始 eval 的进程/网络/文件操作、用户 `!` 命令、外部进程可能不经过工具事件。其他 extension 的后续 input rewrite 也不等于本插件已核验其最终载荷。机械保证针对受控程序动作及合作式 agent 的权限/owner，不宣称防恶意绕过；不写 shell 黑名单冒充安全证明。

### compact／clear 的接续契约：恢复执行依据，不从摘要恢复权限

这是必要能力，不是第四个业务阶段。恢复时保留对齐／实施／交付阶段，另列“核验中／受阻”等等待原因。压缩本身不重置 run、起始 SHA、方案批准或质量证据；真实同步、代码／输入变化才按原规则使相应证明失效。

OMP 18.22.2 的一手源码要求区分四个入口：

| 原生入口 | 实际边界 | 本插件处理 |
|---|---|---|
| 自动 compact | 可在工具循环直接 `agent.continue()`；不保证重发 `before_agent_start` | 成功 compact 事件标记接续；下一次业务请求仍走统一 context 投影，不能只在启动时注入 |
| 主动 compact | 原生 `/compact`／RPC `compact` 后也可能直接 continue | 同上；取消／失败不得声称压缩成功，不以人工压缩冒充自动路径 |
| 原生 `/clear` | 触发 `session_clear`；持久 SessionManager ID／文件保留，provider 会话与内部代次更新 | 立即撤销旧上下文写就绪并推进本控制器的接续代次；持久 ID 未变也重新核验 |
| `/new`／RPC `new_session`／新进程 | 分别经 `session_switch` 或 `session_start`；新会话 `local://` 根改变 | 从真实 cwd/worktree 定位 run，不复制旧闭包、会话入口或写资格 |

每个登记需求 worktree 在其 Git 管理目录保留一个仅含 runId 和仓库定位的非授权定位符，不进产品 PR。它只用于不依赖聊天定位；唯一权限状态仍在 common directory 的 run。交叉核对真实 common directory、worktree、分支、run 与 owner；定位符／材料损坏、状态冲突或多个候选时不猜、不把空聊天当新需求，报告受阻并走受控恢复。

新会话与 clear 都先关闭旧上下文写准入，结算／对账旧写，再建立当前会话的 owner/epoch 绑定；持久业务批准只在对象和语义仍有效时沿用。旧操作晚到可帮助核实原操作完成情况，但不能作为当前批准或质量证明。取消异步任务、清空消息或 PID 仍活着，都不证明物理写已停止。

采用 extension 的 `pi.on("context")`，不是未接入该路径的旧 hooks 文件。每次业务 agent 请求，包括工具结果续跑和压缩后第一次请求，都同步投影最新已核验执行快照，不把动态阶段只写在 turn-scoped `before_agent_start`。快照含 run/仓库与角色、权限阶段和批准范围／修订、当前任务与下一允许动作、未决／未知操作、失效证明及原因，以及必要方案／切片／方法材料的稳定地址和摘要。旧会话 `local://` 须解析为 run 的稳定实体，新会话不能照抄裸别名。

材料加载、摘要与 owner 核验通过受控恢复／状态事务完成；context 只同步投影，不启动 helper、网络或长等待，不反复把整本资料追加到历史。只读准备不授写权；未完成或失败则投影“恢复受阻、禁止写”的已知事实，不编造任务／批准。写就绪须属于当前 root、接续代次及已核验快照；超时、取消或迟到工作不能重新开启它。所有受控工具和程序写仍独立核对 run、owner、有效批准、必要材料与恢复就绪，不能仅凭内存 ready 或模型说“我记得”放行。

宿主会吞掉 context handler 的异常／超时并可能继续模型请求，不能靠 throw 假装已安全阻断。失败时明确投影受阻信息、写 gate 显式拒绝；不承诺一定取消推理。后续 extension 可改写消息，provider 内部 HTTP 重试也不等于新的业务请求；不承诺瞬时注入或保护任意第三方改写。

首次接续给出与当前执行快照一致的程序化可见回执，status 保留可核对事实，不让模型自由编造“高质量继续”。只有核验完成才说“已恢复”；未获批准明确“对齐／未批准”，外部创建结果 unknown 必须说“待对账”，不能说“尚未创建”。材料入口指向本 run 稳定文件，不要求开发者重读旧聊天。

示例只展示格式，不是本次真实状态：

> 已恢复至「实施」，依据已批准方案 v3。当前任务：同步冲突恢复。验收因该次同步失效，下一步重新验证并独立审查。PR 创建结果未知，当前禁止重建，先对账。

原生边界及源码依据见 `omp-feat-flow-native-recovery-evidence.md`。以上是实现与验收契约，不是已实现声明。


## 11. 项目知识：沿用现有体系，不强制 docs

沿用 `omp-feat-flow-knowledge-policy.md`：只看本次相关范围和语义邻居；新增要具体错误场景/证据，先判断不写、合并、修订、删除，再考虑新增。一般最佳实践、临时调试与流程日志不塞进长期 context；已有代码/类型/检查能防错时不再抄一遍。

读取现有项目指导、`.claude/rules` 路径规则、项目 skills 和 ADR，维护原始来源，不生成第二套永久副本或新 glossary。不假装 OMP 自动兼容所有 Claude 语义：严格解析实际 paths、规范 repo 相对路径并匹配受支持语法；范围未知/解析失败时阻断相关写入并说明。新写集先补适用上下文。沿直接生产者/消费者及引用追踪，到改变事实不再传播或已有同语义权威为止，记录停止理由，不造全仓图谱。

长期知识改动与代码同一 PR。确有 diff 才独立审查并额外展示确切 diff、必要性/失效依据、证据和加载范围变化，让人批准；无变更允许短结论，不强制文件/候选/新规则配额，不创建 skill stub。人拒绝可选新增可移除；代码让旧指导变错则必须解决，不能带矛盾指导交付。事故防复发规则不因“能从代码推断”就删，旧 ADR 按原项目方式修订/替代。

知识批准绑定实际 diff、适用范围和列明代码依据。对应输入变更/指导失真才重批，不把无关测试/注释更改一律变成新人工门；也不能同改实现与标准给未批准设计洗白。

## 12. 确定性外部动作与交接

Git/GitHub 由受控程序使用明确 argv；Linear 复用宿主已配置、可核对来源的原生 MCP 连接与公开 client，不另建 token 存储或让模型自由填写目标后自报成功。OMP package 已公开 `/mcp` subpath、MCPManager/getConnection 和 raw callTool；不因为 ExtensionContext 无 invokeTool 就断言无法程序调用，也不新建会覆盖全局 MCP singleton 的 SDK session。

适配器绑定的是当前原生 owner root，而不是“执行时随手取一个全局 manager”。支持的常规形态是每个顶层 OMP 进程一个 MCP-owning root；多个需求以独立 OMP 进程并发，内部只读 SDK helper 全部关闭 MCP。root 初次绑定时捕获具体 MCPManager 对象与 root 身份，并以该 root 的 getAllTools/getActiveTools 来源、实际启用配置、server/tool schema、Linear viewer/workspace/team 核对；仅有远程 MCPManagerApi、无法提供 raw connection 的 worker 不走此路径。
每个 dispatched 写前重新核对捕获对象身份、当前宿主 manager 未被替换、getSource/配置摘要、getConnectionStatus、工具与目标身份。目标/动作从 run/批准对象取得；通过公开 native client 发送登记载荷并读取真实结果核实，不把原始 tool_call 入参当成其他 handler 改写后的认证。发生 root/global-manager 切换、来源不匹配或不可确认时停止，不能改抓新 singleton、另起 SDK root 或另建 manager 来掩盖问题。公开 API 不能证明任意同 PID 多 MCP-root 嵌入器的归属；这类布局不在支持保证内，不能冒称通吃。拿不到可靠启用连接/权限就给原生配置指引，不从私有字段取凭据。

创建/回写先持久登记唯一 opId、请求 digest、repository/issue/branch 和 run marker。API 不支持幂等时不承诺 exactly-once；发出后超时/断线保留 unknown，不盲重发非幂等创建。原生桥接/传输的重试语义必须纳入实现验证，不能用一层外部 WAL 假装消除底层重放。能核实属于本次请求的唯一实际对象才关联/结算。

交付顺序：主动 sync → 当前快照必要验收/独立代码审查与条件知识批准 → 冻结 → 必要提交/push → 核实单 PR → Linear 转 In QA → 提醒对应 desktop 包和 web 环境。提交 hook 若改了内容，旧证明失效，回必要活动；不绕 hook 或继续推送旧证明覆盖不了的树。

PR 正文包含 Summary / Evidence / Merge Danger，记录实际测试 base/head、检查结果及未就绪环境。PR 存在不等于合并/部署/可测；不监听 PR/CI/包，不自动发包或合并。

向原需求单维护可解析的 `Dev Branch`、原需求 `Feature PR`，只有真实存在下游集成 PR 才记录 `Integration PR`。Dev Branch 只是发现线索，不是永远正确的修复基线。

不为本插件再建设 `feature-handoff-v1` 跨产品文件协议、controller→feature→run 交叉锁或强制改造已部署 bug-controller。现有 consumer 已能以真实分支/worktree/cwd 和 UUID 查找需求 group；新插件遵守这条既有路径，不靠标题捕获工作区。通用核心不依赖该个人工具；若将来要增强任意人工改名/特殊跨进程接管，另评真实契约，不假称今天已有。

PR 后保留需求 worktree/workspace；finish 显式查询一次合并及本地交付事实，核对 HEAD、dirty/untracked/ignored 内容、资源和进程归属。只移除自己创建且已证明安全的临时资源，不删除开发者新增数据、不关同组独立 bug workspace；保留最小身份、PR 与恢复定位。没有后台回收器。

## 13. TDD 与真实 E2E 的公开边界

用户已确认下面五类 seam；以下是实施时的可观察契约，不是已跑报告。写测试前把实际公开接口与用例明确到这一层；若新增 seam，先问。逐垂直切片一条失败行为测试→最小实现→下一片，不批量先写假想测试，也不在循环中顺手重构。

| Seam | 能抓什么 | 不证明什么 |
|---|---|---|
| 程序命令 + 真实 OMP rpc-ui | 权限、候选/取消/过期批准、实际 select/input/editor 内容与状态、失败恢复 | 真实 TUI 布局/键盘和第三方客户端像素 |
| 真实 throwaway Git origin/worktrees | 通过控制器本身使用的 Git 模块公开 prepare/sync/inspectCleanup 边界，调用真实 Git 验证原 checkout、checkpoint/rebase/冲突、基线和清理；这是模块集成测试，非测试专用 API | 单独不证明完整命令编排、GitHub/Linear 权限或真实 PR；完整路径由其他 E2E lanes 覆盖 |
| 真实 cmux + OMP TUI | 实际 cwd、workspace/group、读屏/键盘、完整提示和批准 UX、原生 restart | 人的判断正确，或 RPC 能 attach 到 TUI |
| 原生安装/更新 | catalog、user-scope 发现、其他扩展共存、running/installed build、同版本重装及恢复 | 未来所有宿主版本兼容 |
| 专用真实 GitHub/Linear 对象 | 单 PR/issue 关联、真实状态回写、未知结果对账和清理 | merge、发布包、生产业务或全平台 exactly-once |

必要的消费者场景：A/B 均覆盖边界但不重复问已知答案；未批准写被拒；候选 ready 不自动弹批准/推进；问题先真实冷读再按原生 packet 显示；取消/中断不补默认；过期批准无效；无模型只显示静态配置指引；两需求不互改基线/配置；同需求争 owner 不双写；旧 epoch/迟到结果不推进；dirty checkout 不动；中途冲突解决后仍保留双方验收；PR 前 sync 发生在最终证明之前；同版本更新/reload 不假装重载；原生 restart 后对账新实例；PR 后无人工代码亲审 gate；无知识 diff 无知识批准，有 diff 必须批准实际版本；部分交付只补失败动作。

不读取内部 state 文件证明流程通过；用公开 status、实际 Git/PR/Linear 结果、RPC 帧和真实读屏。不能用 echo、源码字符串、私有方法断言、永远成功的模型替身或测试专用绕过。测试夹具可以是临时项目和真实 bare Git；故障注入只作用本测试进程/连接，不伪造远端成功结果。

TUI 与 RPC 是不同进程 lane；cmux 现有 hook 只有生命周期，不是审批总线。真实发送尊重草稿/dialog guard，不全局 --force；read-screen 按明确目标读取。关闭 workspace 是否终止后代进程必须实测，不凭关窗认定清理成功。

### 接续专项 E2E：三类要求，四个不可互相冒充的原生入口

每个入口独立验证首次恢复业务请求上下文、实际可见回执及恢复失败后真实拒写；clear 和新会话是第三类的两个不同子例。沿用已讨论的真实 RPC/TUI/Git seams，不增加测试专用放行入口；写测试前仍随实施计划确认实际 interface 与断言。

| 场景 | 真实触发与不可替代的证明 |
|---|---|
| 自动 compact | 专用隔离配置的公开 thresholdTokens／midTurnEnabled 加受控真实工具输出，触发 `auto_compaction_start(reason=threshold)` 和真实成功 end；必须覆盖工具循环直接 continue。不能调用 manual 再改名。阈值须高于必要固定上下文；限定真实模型／请求／输出／循环次数，超限或无进展即失败，不无限填充 |
| 主动 compact | 独立 fixture 关闭自动压缩，驱动 RPC `compact` 并覆盖 cmux TUI `/compact`；观察真实完成／取消，不拿 prompt 已接收当压缩完成 |
| 原生 clear | 真正 cmux OMP TUI 输入 `/clear`；确认清空与 `session_clear`、持久文件保留，但旧写就绪失效。RPC 字面量 /clear 或 new_session 都不算 |
| 新会话 | 实际 `/new`／RPC new_session；另覆盖同 worktree 新 OMP 进程。旧会话材料别名不能侥幸续用，须由登记 worktree 找回同一 run、重建 owner；旧 owner 未结算时只读对账 |

每例用真实流程达到已知阶段／批准修订和任务，不直接写私有 state 装出“已批准”。独立被动 observer 看首次恢复业务请求的最终 normalized context，并对选定真实 provider 的实际请求关联验证；只记合成 fixture 必要标记／摘要，不记凭据。压缩器推理和 cache warming 不算业务接续，observer 不改写／补种上下文。实际请求不可观察或内容无法核实就不标通过，不能只靠模型复述或 echo。

每例还在专用临时材料／进程内注入失败，例如公开材料入口所指的批准方案不可读，或真实 owner 租约仍被另一测试进程持有；公开 status 应受阻。驱动本来就会写的真实 `/feat-flow-sync`，须明确拒绝且真实 Git／文件不变。native 写工具 gate 的证明必须实际走到 tool_call 并看到拒绝；模型没发写调用，只能证明它未写，不能记作拦截已测。RPC bash／用户 !／原始 eval 不经过同一受控入口，不能冒充 gate 或后门。

回执逐项对照实际阶段、批准、任务、Git 基线及外部结算；无效证明说明原因。不为压缩重批未变业务方案，不因 clear 后持久 ID 相同就复用写资格。代码未实现、真实模型未跑或清理未完成，均不能宣称这些 E2E 已通过。


## 14. 既有测试资源许可、本次执行门与清理失败语义

以下资源类别沿用此前真实许可，不撤销或重复询问 Desktop 归属等既定答案；它们不是“当前实施和真实测试已经开跑”的授权。每次实际执行以已记录的人类开工决定、当时计划／seams 和模型／次数／输出／时间上限共同约束。本次具体边界见[开工审阅包](../plans/2026-11-18-omp-feat-flow-review.md)：A 仅本地实施，A＋B 才包含该次有界真实验收及新增计量接入；未选 B 不推导安装、推理或远端测试开跑许可。产品仓库 commit／push／PR／发布另行明确授权，历史资源许可不能覆盖它们。

允许 throwaway Git、隔离 OMP 配置/安装、自己创建的临时 cmux workspace/必要生命周期元数据和有限真实模型调用。实施时明确模型、请求/输出上限与超时，触顶失败，不自动追加、不偷换模型。隔离真实运行与生产 session；不能声称 cmux 有 per-test App/socket 隔离。

GitHub：允许专门新建私有测试仓库、测试 PR，结束后删除整个该测试仓库；不删除现有仓库。可用该临时仓库验证真正 GitHub marketplace 安装/更新路径，不必先发布未验收插件到正式 catalog。接受平台恢复保留窗口，不承诺物理即时抹除。

Linear：允许在核定团队创建专用测试 issue 并实际删除，接受 Recently deleted 30 天。当前挂载 MCP 无 delete_issue；创建前先找到实际获授权的原生 UI/API 清理通路，权限/通路无法核对就不创建。Cancelled/Archived 不算删除。

创建前用只读事实确认账号、团队、命名空间、权限与测试对象归属；已有明确配置不重复问，多种合理且权限不同才请人决定。不切全局 GitHub 登录、不打印 token、不触碰生产需求。只清本次专用新建对象。

事后删除失败，整条远端 E2E 不能标绿；继续做可达清理，最后列真实对象链接、失败原因和仍需操作。预检不等于保证未来网络/权限永不变化。没跑/没凭据/清理失败均明确报告，不把 skipped 或本地通过叫作整体验证完成。

## 15. 不带走的旧成本与当前证据状态

删：通用 flow DSL、六阶段模板、固定大小分类、固定工件/三轮/agent 人头、人工代码 reset/squash 门、嵌套 implement/implement-spec 编排、强制 docs/glossary、全仓知识巡检/新增配额、skill stub、字符计数读锁、层层 hold/signal 状态、完整旧 kernel 存储/loader、升级 supervisor、第二 native 注册入口、跨产品共享文件协议，以及监听 PR/CI/包和并行写手归并器。

留：独立权限/证据、短锁与 owner、一个请求 outbox、必要操作账、相关知识判断、真实冷读与代码反证。每项分别防一个真实失败，不以“旧版有/没有”决定。

前一版设计及本次 compact／clear 修正案均已完成各自独立反证 ACCEPT；HTML 恢复章节另经新上下文冷读 READY。以上是设计结论，不是运行证明。尚未实施本插件，没有本插件测试通过声明；开发者对本版设计与实际测试 seams 的定稿仍须另记。

主要依据：`private bootstrap chronology (background only; not an implementation prerequisite)`、`omp-feat-flow-skills-audit.md`、`omp-feat-flow-knowledge-policy.md`；`omp://marketplace.md`、`omp://extension-loading.md`、`omp://extensions.md`、`omp://sdk.md`、`omp://rpc.md`、`omp://task-agent-discovery.md`。上游源码：https://github.com/mattpocock/skills/tree/5863806dd4e15c63174bee4e7515a4256792ecfa 。本轮反证模型选择器：`llm-proxy-v2/kimi-k3.1-pro`，不冒称能验证代理供应商的底层实际模型身份。
