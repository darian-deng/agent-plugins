# grill-flow 设计文档（实现思路与对齐基线）

> 本文档是 grill-flow 的**设计真相源**。给开发者与新会话 AI 看：读完即可透彻理解每个 stage 做什么、为什么这么做、引擎怎么支撑、以及落地时要逐条核对什么。可当**标尺**量实现有没有跑偏。
>
> 记录的是 **grill-flow 这个 flow 本身的设计**（元层面、稳定），不是"用 grill-flow 做某个功能"时 stage-2 产出的 `spec.md`（运行时实例、每次 run 会变）。两者别混。
>
> 状态：设计定稿（5 stage，含 wayfinder 隐式子模式），待落地（`/ai-flow:create`）。落地时逐条核对 §13 必修清单。经两轮对抗性审查（引擎接续 + mattpocock 保真），结论与修正已并入本文。

---

## 1. 定位

**grill-flow = mattpocock/skills v1.1 方法论在 ai-flow 引擎上的完整实现 + feat-flow 里真正有价值的质量把控。**

- **不是"轻量版 feat-flow"，不是"专供中小需求"。** 它和 feat-flow 是**两种方法论的对比**：
  - feat-flow = SDD / superpower 式：接口枚举蓝图 + 细粒度 plan（11+ 字段/task）+ 子代理派发执行。
  - grill-flow = mattpocock 式：纯散文 spec（不锁实现）+ tracer-bullet 切片（窄而完整穿透各层）+ 人在主 session 亲做。
- **实现规模不限**：切出几十个 ticket、跨多会话执行都覆盖（mattpocock 的 multi-session build）。
- **它保留的"轻"只是 mattpocock 的内核**（散文 spec 不搞接口枚举、tracer-bullet 不搞字段矩阵、人亲做不搞 SDD 派发），**质量把控该有的全在**（per-ticket 双轴 CR + 方案对抗审查 + 收尾双轴+安全 + 假绿检测 + 集中沉淀）。
- **蓝本是 grill-with-docs（不是 grill-me）**：stage 1/2 **读并尊重既有 ADR/glossary**（domain-aware），只是沉淀写侧集中到末 stage（见 §2 偏离表、§5/§6 domain 读侧）。
- **并存，不取代**：feat-flow 一行不动。
- **纯 flow 定义层**：只是 `.ai-flow/grill-flow/`（config.json + stages/*.md + preflight.cjs + references/），**不改引擎 src**。所有能力用引擎既有机制拼。
- **状态载体 = 本地文件**（`alignment.md` / `wayfinder-map.md` / `spec.md` / `tickets.md` / `candidates.md`），不用 GitHub Issues（见 §12）。

### 适用边界（精确表述）

区分两种"大"：

| | 走哪 |
|---|---|
| **实现规模大**（切几十 ticket、多会话执行） | grill-flow 主干覆盖 ✓ |
| **设计迷雾大**（一次 grilling 聊不出 spec，得跨会话逐个 resolve 互相依赖的架构决策） | grill-flow **stage-1 的 wayfinder 子模式**覆盖（见 §5.2），不赶去别的工具 |
| 高风险、想要接口枚举蓝图 + 细 plan 的重型保障 | 仍走 feat-flow |

---

## 2. 与 mattpocock v1.1 的对齐与偏离

mattpocock 主线：`grill-with-docs → to-spec → to-tickets → implement（逐 ticket、之间清 context）→ code-review`；on-ramp：迷雾大用 `wayfinder`（两 mode：chart the map → work through the map；产物转 spec）。

### 忠实对齐
- **grilling**：一次一问、每问给推荐、**Facts 自查·Decisions 问开发者**、达成共识才动手。
- **grill-with-docs 的 domain-awareness（读侧）**：grill/切片时读既有 CONTEXT.md/ADR/glossary，挑战术语冲突、复用已决决策（防重决、术语漂移）。
- **wayfinder 两 mode**：① chart（命名 destination → 广度扇出 grill → 建图含 fog/out-of-scope → 本会话就停）② work（逐会话 resolve 一个决策）；产物转 spec。grill-flow 做成 stage-1 隐式子模式，出口接 stage-2（见 §5.2）。
- **纯散文 spec**（to-spec）：禁文件路径与 typed 代码；**例外**：prototype 产出的、比散文更精确编码某决策的 snippet（状态机/reducer/schema/type shape）可 inline；**接口契约决策**可用散文携带。带编号 **User Stories**；sketch testing seam 并与开发者确认。
- **tracer-bullet 垂直切片**（to-tickets）：每片窄但完整穿透各层、可独立验证、可独立 commit/回退；**prefactor 前置**（先让改动变容易，排第一个 ticket）；wide refactor 用 expand-contract。
- **tdd only at seams**：只在预先约定的 seam 上测。
- **per-ticket 双轴 code-review**：每 ticket 收尾跑 Standards+Spec 双轴（mattpocock 原生就是双轴，不是只 correctness）。
- **context-cleared frontier work**：逐 ticket 在干净 context 里做。
- **research/prototype 按需 detour**：代码库外事实用 research、状态机/UI 用 prototype（throwaway）。
- **每 ticket 独立 commit、不 squash**。

### 刻意偏离（每条带理由）
| 偏离 | mattpocock 原样 | grill-flow 选择 | 理由 |
|---|---|---|---|
| 状态载体 | issue tracker 或本地 tickets.md | **本地文件** | 更轻、离线、随 git 走、契合引擎"本地单一真相"；GitHub 增量（frontier 并行 grab）被"逐 ticket 串行"关掉、不值；GitHub 是引擎盲区，制造外部副作用/脏状态/非原子风险 |
| 确认门控 | 一句提示词祈使（软门、可忽略） | **引擎硬 gate**（signal+approve） | 引擎级不可绕过，弱模型也拦得住；ai-flow 比纯 skill 强的地方 |
| wayfinder | 独立 skill、GitHub issues map+frontier | **stage-1 内隐式子模式、本地决策图、显式 mode marker** | 同批做、体验连续（不用切工具、不新增 stage）；引擎只线性推进 stage，wayfinder 循环塞进 stage-1 内部靠**产物落盘 + mode marker** 续（见 §5.2） |
| 沉淀写侧 | inline domain-modeling（边 grill 边写 CONTEXT.md/ADR） | **读侧照读、写侧集中到末 stage** 走 feat-flow 的 optimize-claude-context | 开发者要沉淀写走 feat-flow 现有机制；读侧（读既有 ADR）不丢。代价：候选 rationale 逐 ticket /clear 前落盘 candidates.md |
| 收尾组装审 | mattpocock 只有 per-ticket review | **per-ticket 双轴 + 收尾组装双轴都保留** | per-ticket review 在各自 clear 窗口做、看不到整体 diff，跨 ticket 的 Duplicated Code/Shotgun Surgery 会逃逸；收尾组装审**补上 mattpocock 这个洞**（不替代 per-ticket 双轴，是叠加） |
| spec/tickets 合一 | 两个 skill | **合并成 stage-2 一个 stage** | mattpocock 明令 grill→spec→tickets 一个 context window、连续思考；本地 flow 合并更省（一次 gate 拍 seam+粒度） |
| ticket 完成标记 | 模板只有 AC 级 `[ ]` | **增设 ticket 级 `- [ ] T<n>`** | 引擎 frontier/门需要 ticket 级完成信号，AC 级不够（见 §6.4） |

---

## 3. 引擎事实基线（设计所依赖的机制，防误判）

> 逐行读 `plugins/ai-flow/src/` 确认，并经对抗性审查逐条对源码核实（见 §13 末）。设计/审查以此为准。

- **纯 hook 驱动**，无守护进程。5 hook：PreToolUse/PostToolUse/SessionStart/UserPromptSubmit/SessionEnd。
- **completion 三类型**（`flow-schema.ts`）：
  - `{}`（none）：写 `done` → 立即自动推进。
  - `{gate:true}`：写 `done` → 暂停等开发者 `approve`。
  - `{script:{command,timeout_ms?}}`：写 `done` 时 **PreToolUse 先跑脚本**（`pretool-handler.ts:178`），exit≠0 就 deny 写 signal、把 stderr 回给 AI 逼修；exit0 才放行。**可与 gate 组合**（先机器门后人工门，顺序已核实正确）。
- **script 门能力边界**（`script-executor.ts`）：只在"写 signal 触发 stage 完成"那一刻跑一次；cwd = flow 目录（`.ai-flow/<flow>/`）；继承父进程 env；**默认 30s 超时、1MB stdout 上限（超限 ENOBUFS→fail-closed）、同步执行（会冻 UI）**。→ **只适合秒级、小输出、可移植的检查**（grep/awk 结构校验），绝不塞耗时命令（全量测试）。
- **preflight 的 cwd = repoRoot**（`start.ts:91`），**不是 flowDir**（与 completion script 的 cwd 不同）——写 preflight.cjs 时别假设 cwd=flowDir。
- **stage 内部无引擎停顿点**：`task_gates` 字段在 schema 里但**全库无消费代码**（死字段）。唯一引擎强制点是 **stage 边界**（完成门 script/gate）。→ per-ticket 层、wayfinder 逐决策层都加不了引擎门，只能靠 AI 纪律 + 人在场 + 产物落盘。
- **session recovery 只到 stage 级**（`session-handler.ts:161-192`）：SessionStart 无条件重注**当前 stage 提示词**，不记 stage 内做到第几步——stage 内进度靠**产物落盘 + marker**，AI 重入自己读文件续。这是 wayfinder 子模式与 stage-3 循环能跨 /clear 存活的唯一依据。
  - **gate-pending 分支例外**（`session-handler.ts:118-140`）：一旦写了 signal，/clear 走的是 gate-pending 恢复，**不重注 stage 提示词**。→ wayfinder 期间**绝不能误写 signal**（见 §5.2 写 signal 前置条件）。
- **context 分级**（per-flow 可配 `warn_at_pct`/`block_at_pct`/`rewarn_delta_pct`）：warn 只提示不中断；block（须显式配，无默认）拒绝写工具、逼 /clear。子代理有独立 context 窗口，主 transcript 只增记 Task 紧凑结果（度量有噪声但不影响正确性；grill-flow 不配 block）。
- **无 reject/rollback**：命令只有 approve（前进）/abort（建快照分支+commit+切回+删 active.json）/resume（纯 rehydration）。gate 不批时只能"继续讨论改产物"或 abort。
- **prompt 注入**：`renderPrompt` **只替换 `{{project_root}}`/`{{flow_root}}`**，不替换 `{{flow_id}}`。→ flow_id 从 `{{flow_root}}/state/active.json` 读（`node -p`，禁 jq/占位符）。gate stage 自动追加 gate 协议说明。
- **base_sha_code**：AI 写 `mark-base` marker → 引擎捕获 git HEAD（幂等 skip-if-exists，git 在 repoRoot），供后续 stage 做 diff 基准。
- **写保护**：非 owner 写拦截、context block 拦截、future-stage prompt 读禁止、cwd drift 相对写拦截、signal 校验、write_scope（docs_only 只能写 docs_paths；**Bash 不受 write_scope 管**）。

---

## 4. Stage 总览（5 stage）

产物落盘 `docs/grill-flows/<flow_id>/`（保证 /clear·/compact 安全；wayfinder-map.md 也在此，确保在 docs_paths 内）。

| stage | 职责 | completion | write_scope |
|---|---|---|---|
| 1 grill | 需求对齐（domain-aware）；research/prototype detour + **wayfinder 子模式**（迷雾大） | **gate** | docs_only |
| 2 spec+tickets | 散文 spec + seam + User Stories + **方案审查** + HTML 方案视图 + tracer-bullet 切片 + **prefactor** | **gate** + script | docs_only |
| 3 implement | 逐 ticket 亲做：实现→**/simplify→Standards+Spec 双轴+correctness**→修→地板→**commit**→qc marker→勾[x]（commit 在质量链后，审查才审得到真实改动）| script | unrestricted |
| 4 code-review | 收尾组装：双轴（Standards/Spec）+ 安全专项 + 全量测试；不 squash | **gate** | unrestricted |
| 5 沉淀 | optimize-claude-context（CLAUDE.md/rules/ADR） | **gate** | unrestricted |

- **gate（人工 approve）：1 / 2 / 4 / 5（4 个）**。
- **script（秒级 grep/awk 机器门）：2 / 3**。
- **stage-3（implement）无 gate**，frontier 空自动进 4。

**gate 数不是"重"的来源**（gate 就敲一次 approve）。真正让 feat-flow 重的是 stage 内部的仪式（字段矩阵、多轮 review、结构门、独立重推导）。grill-flow 的"轻"落在**每个 stage 内部提示词薄、流程短**，不在砍人工控制点。

---

## 5. Stage 1 — grill（domain-aware，含 wayfinder 子模式）

completion: `{gate:true}`，write_scope: docs_only。最不能省的对齐点——mattpocock 三个修复的灵魂在这，引擎硬 gate 让"grill 完直接跳实现"对我们免费不可绕过。

**入场先读 domain**：扫既有 `CONTEXT.md`/`docs/adr/`/glossary（指定读），grill 时复用已决决策、挑战术语冲突、**sharpen 模糊词到 canonical 术语、用 concrete scenario 压测边界**（grill-with-docs 内核）。

### 5.1 普通 grill 模式（迷雾小：一次会话能聊出 spec）
- 照 grilling：一次一问、每问给推荐、Facts 自查·Decisions 问开发者、达成共识才动手。
- **research/prototype 按需 detour**（约 4 行、钉死"非必经"）：卡在代码库外的外部事实 → 起后台 research 子代理查一手来源；卡在"状态模型/UI 对不对" → 建一次性 throwaway prototype。**prototype 的每次增改都走 Bash（heredoc/echo），禁 Edit/Write**（docs_only 会 deny 非 docs 的 Edit/Write，但 Bash 不受 write_scope 管）；**写到 repo 之外**（`$(mktemp -d)`，否则 stage-3 脏树预检会看到未追踪原型文件而恒脏）、标 throwaway、绝不 commit。会话能定的别用；拿到答案回 grill。
- **产出**：`alignment.md`（需求/范围/不做什么/关键决策/暂缓）+ 沉淀候选区（candidates.md）。
- **出口**：达成共识 → gate → stage-2。

### 5.2 wayfinder 子模式（迷雾大：一次 grilling 聊不出 spec）

**触发（不 AI 闷头自评，照 mattpocock）**：普通 grill 广度推进中，若**迷雾浮现**——冒出一串互相依赖、现在答不出、需调研/原型才能定的架构级决策（经验信号：≥3 个互相 `blocked-by` 的决策）——AI **停下向开发者提议**"这需求迷雾大，建议升级 wayfinder"。开发者同意才进入。这样触发判据由**开发者 gate 式确认**，不是 AI 主观自评。

**状态载体：`wayfinder-map.md`**（docs 内，落 docs_paths）。顶部一行**显式 mode marker**（这是消除 bootstrap 死循环的关键——模式由 marker 判定，不由"map 是否存在"判定）：
```
mode: charting | working | clear
# Destination
<一句话终点，固定 scope，每会话朝它对齐>
# Decisions
## D1 冲突解决模型
- status: resolved
- blocked-by: -
- 结论: 用 CRDT(Yjs)。依据: research+throwaway 原型验证延迟可接受。被否: OT(手动 transform 复杂度高)。
## D2 落盘与转录 pipeline 对接
- status: open
- blocked-by: D1
# Not yet specified (fog)
<还没想清、待展开的区域>
# Out of scope
<明确不做>
```
每个决策条目落**结论 + 关键依据 + 被否方案一句话**（摘要下限，保证雾散后综合 spec 不贫血——解"只存摘要"与"末态综合"的张力）。

**mode ① charting（建图，本会话就停）**：命名 Destination → 广度扇出 grill → 填 Decisions/fog/out-of-scope → 写 `mode: working` 就停。**硬约束（最尖锐的 mode-confusion 点，提示词里钉死成祈使句）：charting 模式下绝对禁止 resolve 任何决策——只命名、只建图、只标 open/blocked-by；charting 的唯一出口是写 `mode: working`。**（mattpocock：charting the map is one session's work, do not also resolve tickets。）

**mode ② working（逐决策 resolve，每会话一个）**：
1. 读 map，取 frontier（`status:open` 且 `blocked-by` 全 resolved 的决策）。
2. 用 grilling/research/prototype/**task**（为解锁决策的手动前置：开账号/供权限/搬数据看形状——mattpocock ticket 四类之一）resolve 它，写回结论+依据+被否，标 resolved；冒出下游决策则 append（带 blocked-by）；新迷雾进 fog 段。
3. 一个决策告一段落即可 /clear。
4. **完成判据（相对 Destination，不是"所有决策 resolved"）**：the way is clear——到 Destination 前没有还需要决定的事（fog 段清空、frontier 空）→ 写 `mode: clear`。

**四态重入**（/clear 后 stage-1 提示词开头必做的探测——引擎只到 stage 级，全靠这四态 + marker 续）：
- `wayfinder-map.md` **不存在** → 普通 grill（5.1）；读 alignment.md 若存在续。
- marker `charting` → 继续建图。
- marker `working` → 读 frontier 续 resolve。
- marker `clear` → 用整张图**综合 alignment.md** → 与开发者确认共识 → gate。
- marker **缺失/无法识别** → **停下问开发者，不擅自选模式**（防非法 marker 落进未定义行为）。
- clear 后开发者又提新迷雾（gate 前）→ 把 marker **翻回 working**、append 新决策（clear→working 回退路径）。

**写 signal 前置条件（钉死）**：仅当 `mode: clear` 且 alignment.md 已综合、开发者已确认，才允许写 `done`。**诚实边界**：若真误写了 signal，引擎会走 gate-pending 分支、**不再重注 stage-1 提示词**（§3），"提示词开头探测"根本跑不到——恢复不靠探测，而靠：① 开发者拒绝 approve；② wayfinder-map.md 在盘上，AI 主动重读 map + 当前 stage-1 提示词（当前 stage 提示词可读）续 wayfinder。所以前置条件是**主防线**，别指望事后自动探测兜底。

**出口**：雾散 → 综合 alignment.md → gate → **stage-2**（不回头重新 grill；resolve 决策的过程本身就是 grilling）。wayfinder 全程在 stage-1 内部，雾散后 stage-1 正常达成对齐、过 gate、自然进 stage-2。

**已知代价（隐式子模式的固有张力，开发者已知情选择）**：普通 grill + charting + working + 四态 dispatcher + domain 读侧全挤一份 stage-1 提示词，提示词偏长、AI 有选错模式的风险。缓解：mode marker 让重入判定确定化、触发靠开发者确认。若落地证明太脆，确定性 fallback 是把 wayfinder 显式化成独立 stage（见 §12 决策记录），但当前按开发者定的隐式形态实现。

---

## 6. Stage 2 — spec + tickets（completion: gate + script）

一段连续思考（mattpocock: grill→spec→tickets 一个 context window），产出可供开发者 gate 时"看懂整体方案"的规格 + 切片。**入场沿用 stage-1 已读的 domain（ADR/glossary），spec 用项目术语、尊重既有 ADR。**

### 6.1 散文 spec（照 to-spec，从 alignment.md 综合）
- 结构：problem / solution / **编号 User Stories** / decisions / **Testing Decisions（seam）** / out-of-scope / **方案审查**。
- **禁文件路径与 typed 代码**（内核：不锁实现）；**例外**：prototype 产出的、比散文更精确的 snippet（状态机/reducer/schema/type shape）可 inline；**接口契约决策**用散文携带（不是 typed 签名）。
- **seam 作会话步骤跟开发者确认**（要在探索代码库、选最高现有 seam 之后提，所以归这里、不前移 stage-1）。

### 6.2 对抗性方案审查（feat-flow 抢救 + 对 mattpocock 的增强，收窄范围）
- gate 前必跑。派独立子代理在**方案层**（代码还没写）挑**新引入的**复用缺失 / 过度工程 / 方案漏洞——**只审本次方案新增的决策，不重新审议 grilling 已定的方案**（避免与 stage-4 Standards 轴重叠、避免推翻已对齐决策）。findings 落 spec.md `## 方案审查` 段带 resolved 状态（耐久锚点）。

### 6.3 HTML 方案视图（复用 feat-flow 的 mermaid+mmdc 契约外壳，派生轻契约）
- 只渲染散文 spec 真有的东西：TL;DR / 术语表 / 现状落位概念图 / 提议方案概念机制 + 端到端数据流叙事 / **接口契约决策（散文）** / 备选 / 风险 / 决策台账。
- **去掉** feat-flow tech-design-view 的 **typed 签名 / pseudo-code** 两节（那是实现级）；**保留接口契约决策**（散文形式，否则 gate 沦为盖章）。
- sonnet 子代理手写 `.mmd`（落 docs 内）→ mmdc 渲染 SVG → 主 session 增量组装 HTML，深浅色切换。

### 6.4 切 tickets（照 to-tickets）
- tracer-bullet 垂直切片 → `tickets.md`。**prefactor 前置**（要改的地方得先重构才好改 → 排第一个 ticket）；wide-refactor 用 expand→分批迁移→contract。
- **ticket 级完成标记与 AC checkbox 区分**（mattpocock ticket 内 `[ ]` 是 acceptance criteria；本 flow frontier/门要一个 ticket 级标记）：每条 ticket 用 `- [ ] T<n> <标题>` 作**ticket 级**勾选，`delivers:` + `Blocked by:`；ticket 内的 AC 用无勾选的子列表或 `AC:` 前缀，**不参与** frontier/门判定。
- quiz 粒度、blocking 与开发者确认。

### 6.5 script 门 + gate
- **script（秒级 grep/awk，fail-closed）**：**三个被检文件各自先 `[ -f ]||exit 1`**（spec.md、tickets.md、HTML）；spec.md 含**非空** `## Testing Decisions` + `## User Stories` + `## 方案审查` 段（awk 判非空）；tickets.md 每条 ticket 级项有 `Blocked by`；HTML 产物存在。命令 cwd=flowDir：`node -p "require('./state/active.json').flow_id" || exit 1` 取 id、`$(cd ../.. && pwd)` 拼 project_root。**段标题字符串与提示词写死一致**（§13 必修 1）。
- **gate**：开发者一次拍板 seam + 整体方案（看 HTML + 方案审查 findings）+ 切片粒度。
- **mid-stage 子产物级重入阶梯**（stage-2 密度高，比照 stage-3 qc marker 的详度，逐子产物探测续跑，防 /clear 落中途重跑/覆盖）：
  1. spec.md 无 / `## Testing Decisions` 空 → 从 alignment.md 综合 spec。
  2. spec.md 全但 `## 方案审查` 空 → 跳到派方案审查子代理。
  3. spec+方案审查全但 HTML 缺 → 跳到生成 HTML。
  4. 前三者全但 tickets.md 缺 / 无 ticket 级项 → 跳到切 tickets。
  5. 全在 → 去 gate。

---

## 7. Stage 3 — implement（completion: script，无 gate）

- **入场**：全部 flow docs（alignment+wayfinder-map+spec+tickets）先 commit → 再写 `mark-base` 捕获 base_sha_code（顺序钉死）；**分支预检**（不在 main/master）；脏树预检豁免 `docs/grill-flows/`。
- **循环**：读 frontier（第一个未勾 ticket 级项 + 所有 blocker 已勾）→ 主 session 亲做。**commit 在质量链之后**——审查/simplify 必须审到真实改动，commit-first 会让它们审空树、per-ticket 双轴+correctness 集体失效（这是全新独立审查抓到的核心缺陷）：
  1. **脏树预检**（`git status --porcelain`）；重入时用 `git log --oneline <base>..HEAD` 目测 frontier ticket 是否已有 commit（有 commit = 质量已过的锚）。
  2. **实现**：tdd 只在 stage-2 约定的 seam 测；改动留工作树、**先不 commit**。
  3. **per-ticket 收尾质量**（跑在未提交工作树上；mattpocock 原生 per-ticket 就是 Standards+Spec 双轴，**不是内置 `/code-review` 能给的**——内置版审 current diff、不吃 spec.md）：
     - **`/simplify`**（自动 apply 机械型质量修——复用/简化/效率）。
     - **Standards 轴子代理**：携 Fowler baseline + 未提交 diff，report-only 判断型 smell（不 apply，与 simplify 分工；不砍 smell 退化成 correctness）。
     - **Spec 轴子代理**：携 spec.md + 未提交 diff，自定义 prompt 查一致性（早期抓 spec-drift）。内置 skill 给不了。
     - **correctness**：Claude Code 内置 `/code-review`（默认审当前未提交 diff——ticket 改动全在工作树、正好被它看到；无需 PR、勿加 `--comment`）。
     - **子代理都不开 worktree**（看未提交 diff）——引擎只算主 session context，子代理不计入；~30 ticket 约 4-6 次 /clear。
     - 按 findings 修复（仍未提交）；关键修复独立复核兜底。
  4. **per-ticket 客观地板**（AI 自觉纪律，非引擎强制）：typecheck + 该 ticket 相关测试绿；**假绿检测**=测试选择器实际匹配 ≥1 个测试；**枚举负空间检查**=ticket 蕴含 N 个错误码/状态/分支时逐项核 diff 都实现+断言；**回归纪律**=既有测试挂了当回归、改代码不改测试。
  5. **commit**：实现+simplify+修复**一次性提交为一个独立 commit**（引用 ticket 号）、**钉死不 squash**、**无需 --amend**（一次到位）。commit = 本 ticket 质量完成锚。
  6. 落沉淀候选（**带 ticket ID 前缀，append 前 grep 去重**）到 candidates.md。
  7. **写 qc marker**（tickets.md 该条 `qc:done`）**再标 ticket 级 `[x]`**。顺序铁律：实现→simplify→双轴→correctness→修复→地板→commit→候选→qc marker→勾[x]。
  8. **重入判据（防质量步骤被静默跳过 / 防丢进度）**，以"有无该 ticket commit"为质量完成锚：
     - **无 commit 但工作树有该 ticket 未提交改动** → 质量没走完 → 重跑质量链（simplify/双轴/correctness 幂等）→ 地板 → commit → 候选 → qc → [x]。
     - **有 commit 但无 `qc:done`** → 已提交、收尾没做完 → 补候选+qc+勾（不是"见 commit 就补勾"跳过收尾）。
     - **有 `qc:done` 无 [x]** → 直接补勾。
     - **有 commit+qc:done+[x]** → 完成，进下一个。
- **context**：提示词只一句"进度在 tickets.md 勾选 + qc marker + candidates.md；/clear 后重读 tickets.md 从 frontier 续"。阈值叙述不写进提示词（引擎+config 管；grill-flow 配宽松 warn、不配 block）。
- **切片撑爆窗口** = 上游切片错 → **就地在 tickets.md 重切该 ticket 并知会开发者**（引擎无反向 stage 转移）。
- **script 门（秒级，fail-closed）**：先 `[ -f "$TICKETS" ] || exit 1`；再用 awk **同时断言"≥1 个已勾 ticket 级项 AND 无未勾"**（`awk 'BEGIN{c=0}/^- \[x\] T/{c++}/^- \[ \] T/{bad=1}END{exit (bad||c==0)}'`）——**不能依赖"空文件自然非零"**（裸 awk 对空文件走 END、未置标志会 exit 0 = 误 PASS；stage-3 无 gate，误放行直接把空 tickets 冲进 stage-4）。**禁 `grep&&exit1||exit0` 反相 idiom**。**诚实定位**：防"忘做"（漏勾）+ 防编译破；**拦不住** AI 谎标[x]/空实现——真正反谎报靠 stage-4 全量测试 + 人工 gate。
- **出口**：frontier 空 → 写 `done` → script 校验全 `[x]` → 自动进 stage-4。
- **诚实边界**：per-ticket 的 simplify+双轴CR+客观地板都是**纪律，不是引擎强制门**（stage 内无挂载点）；强制兜底在 stage-4 gate。

---

## 8. Stage 4 — code-review（completion: gate）

- **职责**：全部 ticket 完成后跑一次组装级审查（补 per-ticket 看不到整体 diff 的洞——跨 ticket 的 Duplicated Code/Shotgun Surgery）。
- **AI 跑全量测试**（异步可见、不冻 UI，假绿检测：执行测试数 > 0），原始输出（通过/失败计数 + commit SHA）落报告文件。
- **双轴并行子代理**组装审：① **Standards**（Fowler smell baseline **全文粘进子代理 prompt**）② **Spec**（对 spec.md 查 User Stories 逐条闭环/缺失/偏离）。
- **安全专项**（feat-flow 抢救；"mattpocock code-review 忽略安全"**标为假设**、未从源文件证实）：**一行有界清单**——只看本 diff 的注入/鉴权/密钥处理，钉死不外扩。
- **diff 基准**：`git diff <base_sha_code>..HEAD -- . ':(exclude)docs/grill-flows/*'`（pathspec 排除 doc churn，§13 必修 4）。
- **不 squash**：保留每 ticket 独立 commit（tracer-bullet landability）。
- **gate**：呈现 findings + **AI 贴出的原始测试输出** → 开发者交付签收 approve。

> v4 审查砍掉了 feat-flow 的"3 轮独立复核 + 修复复核者"套娃（纯搬运、过度）。stage-4 收敛为：全量测试 + 一次组装双轴 + 安全专项 + gate。

---

## 9. Stage 5 — 沉淀（completion: gate）

- **职责**：复用 feat-flow 的 optimize-claude-context（handle-one-directive, manual）。
- 从 alignment.md/wayfinder-map.md/spec.md/tickets.md/candidates.md 收 ADR/术语/规则候选，去重 → 逐条写 CLAUDE.md/rules/ADR，含跨源冲突检测 + supersede。
- **gate**：沉淀汇总拍板（写项目长期记忆不可逆）。

---

## 10. 核心设计原则（落地判断准绳）

1. **script 门只做秒级、可移植、grep/awk 型结构检查**，**一律 fail-closed**（每个被检文件先 `[ -f ]||exit 1`，非空段用裸 awk，禁反相 idiom）。绝不把耗时命令塞进同步 hook。
2. **耗时验证（测试/typecheck）由 AI 跑**（异步可见），结果落报告；假绿检测/枚举负空间/回归纪律是纪律；**人在 gate 看原始输出**把关。
3. **判断型 review = 独立子代理**（context 隔离），绝不让主 session 自评刚写的 diff。
4. **人在场**（主 session 亲做、每个 ticket 看得见）替代 feat-flow 的 AFK 补偿重门。
5. **wayfinder / per-ticket 循环跨 /clear 存活，全靠产物落盘 + marker + 提示词自读**（引擎只到 stage 级）。marker = wayfinder mode、qc、tickets [x]。
6. **flow_id 一律从 `{{flow_root}}/state/active.json` 读**（`node -p`，`||exit 1`），禁 `{{flow_id}}` 占位符和 jq。
7. **script 路径**：cwd=flowDir → `./state/active.json` 读 id、`$(cd ../.. && pwd)` 拼 project_root；preflight 的 cwd=repoRoot 另算。

---

## 11. 固有取舍与诚实边界（不是 bug，是"mattpocock 式 + 人在场"的本质代价）

1. **测试真绿无法机器证明**：不让引擎自己跑测试就没有不可伪造的方式证明测试真绿（报告 AI 写、`echo "PASSED"` 骗过 grep）；让引擎跑就回到 30s/1MB/冻 UI。死结。→ 真防线 = 假绿检测（测试数>0）+ 开发者在 stage-4 gate 看 AI 贴的原始测试输出。script 验报告只防"忘写报告"，**不是反伪造门**。
2. **per-ticket / wayfinder 逐决策层零引擎强制**：stage 内部无引擎挂载点。per-ticket 双轴+客观地板、wayfinder 逐决策 resolve 都是 AI 自觉纪律，唯一强制兜底在 stage 边界（stage-4 gate、stage-1 gate）。AFK 跑就裸奔——违反 flow 前提（人在场）。
3. **判断型缺陷推迟到收尾（已大幅缓解）**：per-ticket 双轴的 Spec 轴现在当场抓 spec-drift（不再拖到收尾）；stage-2 方案审查提前拦方案层错误。剩下的跨 ticket 集成级 smell 才到 stage-4 暴露——这是"逐 ticket 亲做"的自觉代价，可接受。
4. **wayfinder 隐式子模式是本设计最新、引擎最不 native 的一块**（两套逻辑挤一份 stage-1 提示词）。用 mode marker + 开发者确认触发把风险压到提示词工程层；确定性 fallback（显式独立 stage）保留在 §12。落地后重点观察 AI 会不会选错模式。

---

## 12. 关键决策记录（对齐历程与 rationale）

- **定位：从"轻量/中小需求" → "mattpocock 完整实现 + feat-flow 质量把控、规模不限"**：早期误把"轻"等同"砍质量门/专供中小"。mattpocock 原文（multi-session build、wayfinder for huge foggy effort）证明它覆盖大需求，质量把控加回。
- **状态载体 GitHub Issues → 本地文件（翻案）**：三份审查推翻 GitHub——增量被"逐 ticket 串行"关掉、GitHub 是引擎盲区（外部副作用不可回滚、非原子、不随 git 走）。
- **context 隔离：主 session 逐 ticket /clear 串行（放弃并行）**：忠实 mattpocock 手感、人亲做；并行需 subagent 与"人亲做"矛盾。
- **gate 数量：6→试图砍到 3→审查推翻→v4 一度 5→回收敛到 4（1/2/4/5）**：认清引擎只有边界 gate 一种强制原语、gate 不是重的来源；spec+tickets 合并回一个 stage（更保真"一个 context window"），stage 数回 5。
- **script 门引入与降级**：引入机器门把"靠 AI 自觉"变客观拦截；随即认清测试门是"安全剧场"+性能坑，降级为"只做秒级结构检查、fail-closed"。
- **wayfinder：划边界赶去别的工具 → stage-1 内隐式子模式（同批做、出口 stage-2）**：开发者要体验连续、不新增 stage。澄清：① wayfinder 跨会话是它的定义（单会话搞得定就不叫 wayfinder）；② 决策图子系统不是为对付 /clear，而是处理决策依赖图本身就需要它。**审查修正**：补齐 mattpocock 的 charting 半场 + Destination/fog/out-of-scope 结构；用**显式 mode marker** 消除"map 不存在→普通 grill"的 bootstrap 死循环；触发改为"grill 中迷雾浮现→向开发者提议"（不 AI 自评）；完成判据相对 Destination（不是"所有决策 resolved"）。**确定性 fallback**（若隐式太脆）：显式化成独立 wayfinder stage（gate、docs_only、chart+work 两态各自被 SessionStart 精确重注），当前不采用。
- **per-ticket review 形态**：mattpocock per-ticket 原生就是 **Standards+Spec 双轴**；早期误把双轴移到收尾（净损失、放大 spec-drift）→ 审查修正：per-ticket 恢复双轴（Spec 轴当场抓 drift）+ 收尾组装审叠加（抓跨 ticket）。
- **domain-awareness 读侧找回**：早期把 grill-with-docs 写成了无状态 grill-me；审查指出 to-spec/to-tickets 都要求读既有 domain 文档 → stage 1/2 读 ADR/glossary（读侧），写侧维持集中沉淀（开发者定，像 feat-flow）。
- **stage-5→4 砍套娃**：v4 审查砍"3 轮复核+修复复核者"（feat-flow 防幻觉套娃、过度）。

---

## 13. 落地必修清单（两轮对抗性审查收敛，`/ai-flow:create` 时逐条核对）

### 架构必修（不改会真崩/卡死/丢数据/丢质量）
1. **script 段字符串对死**：spec 段标题（AI 要写的）与 script grep 的串同一 literal（`## Testing Decisions`、`## User Stories`、`## 方案审查`）。不一致 → 门永远失败 → 卡死。
2. **所有 script 门 fail-closed**：stage-2/3 每条 script 对每个被检文件先 `[ -f "$F" ]||exit 1`，非空段用裸 awk，**禁 `grep&&exit1||exit0` 反相 idiom**。**stage-3 尤其**（无 gate，误放行直接冲 stage-4）：用 awk **显式断言"≥1 已勾 ticket 级项 AND 无未勾"**，**别信"空文件自然非零"**（空文件走 awk END、未置标志会 exit 0=误 PASS）。
3. **wayfinder 四态重入 + mode marker 写进 stage-1 提示词开头**：map 不存在→grill / charting→建图 / working→读 frontier / clear→综合 alignment 去 gate；marker 缺失/非法→停下问开发者；clear 后又提迷雾→翻回 working。**用 marker 判模式，不用"map 是否存在"**（否则 bootstrap 死循环）。写 signal 前置=`mode:clear`+已确认。**Y2 兜底诚实写**：误写 signal 后走 gate-pending 分支、不重注 stage-1 提示词，"探测"跑不到——靠用户拒批 + AI 主动重读 map/当前 stage 提示词续，前置条件才是主防线。
4. **charting 禁 resolve 设成硬约束祈使句**（charting 与 working 是互斥指令挤一份提示词、最尖锐的 mode-confusion 点）：charting 只建图、唯一出口写 `mode:working`。
5. **per-ticket 双轴的实现机制写死**：**Spec 轴 = 子代理携 spec.md + 该 ticket 自定义 prompt**（内置 `/code-review` 审 current diff、不吃 spec.md，给不了 Spec 轴——照字面接会把双轴又丢回上一版净损失）；**Standards 轴 = 子代理携 Fowler baseline、report-only 判断型 smell**（不 apply，与 simplify 的 apply 分工，别把 smell 砍掉退化成 correctness）；correctness 子项用 **Claude Code 内置 `/code-review`**（默认审当前未提交 diff，无需 PR）。注：双轴与收尾组装审是自定义子代理 prompt、不调 `/code-review` 命令，故不涉及此项。
6. **per-ticket commit 时序 + 防跳过**：**commit 在质量链之后**（实现→simplify→双轴→correctness→修复→地板→commit），让审查/simplify 审到真实未提交改动——commit-first 会让它们审空树、核心审查失效（全新独立审查抓到的 🔴）。每 ticket 一个独立 commit、不 squash、**无需 --amend**；qc marker 用 tickets.md `qc:done`；重入以"有无该 ticket commit"为质量完成锚（无 commit+有工作树改动→重跑质量链；有 commit 无 qc→补收尾；有 qc 无 [x]→补勾）。
7. **ticket 级完成标记与 AC checkbox 区分**：frontier/门只认 ticket 级 `- [ ] T<n>`，ticket 内 AC 子项不参与判定。
8. **stage-1 prototype 每次增改走 Bash（禁 Edit/Write）**（docs_only 会 deny 非 docs 的 Edit/Write，Bash 不受管）、**写 repo 之外 `$(mktemp -d)`**（否则 stage-3 脏树恒脏）、标 throwaway、不 commit。
9. **wayfinder-map.md 落 docs_paths 内**（否则 write_scope 拒）；preflight cwd=repoRoot（写 mmdc 检查时别假设 flowDir）。
10. **HTML 派生轻契约**：去 typed 签名/pseudo-code，**保留接口契约决策（散文）**；preflight 加 mmdc 检查；`.mmd` 落 docs 内。
11. **stage-2 子产物级重入阶梯**（stage-2 密度高，比照 stage-3 qc marker 详度）：逐个探测 spec/方案审查段/HTML/tickets 是否已在，精确续跑，防 /clear 落中途重跑或覆盖。

### 诚实定位（把话说对）
11. **测试验证**：script 验报告不是反伪造门；真防线是假绿检测（测试数>0）+ stage-4 gate 时 AI 贴原始 stdout 尾部/通过失败计数/commit SHA。
12. **per-ticket / wayfinder 逐决策无引擎门**：是 AI 自觉纪律、人在场是可选抓漏、强制兜底在 stage 边界。
13. **gate 无 reject 语义** → stage-2/4/5 提示词写明"不批=就地改产物再重呈"。
14. **安全专项标为假设**（"mattpocock 忽略安全"未从源证实）；给一行有界清单（注入/鉴权/密钥）。

### 局部收口
15. stage-2 提示词点名"从 alignment.md 综合 spec" + mid-stage 重入指引 + to-spec 的 prototype-snippet 例外。
16. stage-3 入场 commit 纳入 alignment.md + wayfinder-map.md；脏树预检豁免 `docs/grill-flows/`。
17. candidates append 前 grep 去重；不做"显式补"bootstrap（冗余不可靠）。
18. stage-2 方案审查**收窄**：只审新引入决策、不重议 grilling 已定方案（防与 stage-4 Standards 轴重叠）。

### 已实测/源码确认（放心）
- §3 引擎事实基线**逐条经源码核实属实**（completion 组合、script cwd/超时/上限、session recovery 只到 stage 级、task_gates 死字段、renderPrompt 两占位符、无 reject、write_scope、mark-base 幂等、context 分级）。
- script 路径拼接（flowDir 的 `../..`=project_root、`node -p` 读 active.json，monorepo 子项目安装也成立）。
- wayfinder 引擎机制可行（stage-1 不写 signal→永久停留→每次 /clear 重注提示词→marker+产物续）；风险在提示词纪律，非引擎能力。

---

## 附：与 feat-flow 的差异对照

| 维度 | feat-flow（SDD/superpower 式） | grill-flow（mattpocock 式） |
|---|---|---|
| 方法论 | 接口枚举蓝图 + 细 plan + 子代理派发 | 散文 spec + tracer-bullet + 人亲做 |
| stage 数 | 6 | 5 |
| 规划产物 | design.md + architecture.md（接口枚举）+ plan.md（11+字段/task） | alignment.md（+wayfinder-map.md）+ 散文 spec.md + HTML 视图 + tracer-bullet tickets.md |
| 迷雾大 | — | stage-1 wayfinder 隐式子模式（chart+work） |
| domain | 读+inline 写 | 读（ADR/glossary）+ 集中写（stage-5） |
| 执行 | 串行 subagent 派发、每 task opus 评审 + 全量测试 | 主 session 逐 ticket 亲做、per-ticket 双轴CR+simplify+客观地板 |
| review | stage-4 每 task + stage-5 质量门（环节 A/B/C） | per-ticket 双轴 + 收尾组装双轴 + 安全专项 |
| 质量兜底 | 重机器门（越界/枚举/假绿/注释审查） | 秒级 fail-closed script + 假绿检测 + 枚举负空间 + 人在场 + gate |
| commit | 收尾 squash 成一笔 | 每 ticket 独立 commit、不 squash |
| gate 数 | 4-5 | 4（1/2/4/5） |
| 沉淀 | stage-6 optimize-claude-context | stage-5 复用同机制 |
| 适用 | 高风险、要重型蓝图保障 | mattpocock 方法论、规模不限、迷雾大有 wayfinder |
</content>
