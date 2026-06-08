# feat-flow stage-3 + stage-4 重构设计

> 重构「plan 拆分 + 任务执行」环节。目标:消除执行期低质量与非预期报错造成的时间/token 浪费。
> 状态:**已落地(2026-06-08)**——提示词层 stage-3 / stage-4 / stage-2 / helper.md(走 /ai-flow:update);引擎层 cwd 守卫(§1.3)pretool-handler.ts + 7 测试(TDD,全量 232 测试过)。**第二轮 review 后 writing-plans 由「降级」改为「完全移除」**:self-review checklist 内联进 stage-3,**preflight.sh 移除 writing-plans 依赖**(见 §7)。config.json 不改。均未 commit(待开发者 review)。
> 日期锚定:2026-06-08。

---

## 0. 一句话

把「执行单元怎么切、每个单元需要什么决策」从 **stage-4 运行时即兴判断**,上移到 **stage-3 静态算好、可审、落盘**;粒度从纯语义标准升级为「语义内聚 ∧ 体量可控 ∧ 可单命令验证」;`decisions` 决策切片取代 design.md 路径兜底——其抽取靠「决策↔task 矩阵 + 来源回溯 + files/read_first 一致性门」把**误配变得可检测**,但归属判定保留不可消除的判断内核(由 per-task 规格审查兜底),**不是「纯机械投影」**(见 §4,经对抗审查修正)。stage-4 退化为机械执行器。

---

## 1. 诊断(已验证的失败事实)

证据来源:真实 flow `2026-06-03-9rbh`(fe-nexus,Electron 桌面端安全加固),主执行 session `33d5b912`。**下列事实由该 session 主 session 的实时文字 + 源码 + jsonl 原文交叉验证,非事后复盘臆测。**

### 1.1 验证过的失败

| 失败 | 验证证据 | 根因层 |
|---|---|---|
| 子代理截断(Task 3/7/9/12/13) | 主 session 实时文字:「Task 7 agent 被截断——测试文件已创建但 compatible.ts 未修改。继续 Task 7」「Task 9 agent 被截断」「Task 13 agent 被截断」。`"name":"Agent"` 出现 61 次=确有派发 | **plan 粒度缺体量维度** |
| Task 13 截断雪球(主 session 自评最大根因,约 13–15% token) | 主 session 自评根因表原文:「TDD 大文件 task 的截断雪球(最大):Task 13(rpcApiWrapper…枚举 80+ 方法)」 | plan 粒度 |
| 续跑靠 git 反推 | 截断后「继续 Task 7」= 派续跑代理,无 checkpoint | plan + dispatch |
| cwd 双重前缀 `apps/plaud-desktop/apps/plaud-desktop` | 见 §1.3,**独立的引擎线,不属本次提示词重构** | 引擎(Bash cwd) |

### 1.2 版本注记(诚实边界)

该 flow 跑在**较旧版本**的 feat-flow/ai-flow 上(旧状态布局:`hooks.log`/`violations.log`/`transitions.log`,无 `flow.log`/`active.json`,早于日志合并 commit `2969545`)。因此**不能假设当时 stage-4 = 当前 stage-4**。但核对当前源码确认:**当前 stage-3 粒度标准仍是纯语义**(「一个可独立验证的行为变化」,stage-3.md §粒度标准),**当前 stage-4 的 TDD 减重三条只针对 input,对 output 体量零防护**(stage-4.md 行 93–98)。→ 截断的总开关(粒度无体量维度)在当前版本**仍未修**,重构有效。

### 1.3 cwd 双重前缀 = 独立引擎线(本文档不解决,仅登记)

确定性根因(源码 + jsonl 第 2099 行交叉验证):失败是**主 session 的 Bash `git add`**——模型用 `cd apps/plaud-desktop` 把 cwd 漂进子目录后,仍传 repo-root 锚定的相对路径 `apps/plaud-desktop/src/...`,git 自己拼成双重前缀。引擎 cwd 守卫(`pretool-handler.ts` 第 92 行 WRITE_TOOLS gate + 第 57–67 行 Bash 早退)**只覆盖 Write/Edit/NotebookEdit 相对路径,完全不覆盖 Bash**,从未触发。

→ 修复方向是引擎层(守卫扩展到 Bash 的 cwd 漂移,或阻止 `cd` 漂移),**不写 prompt prose**(遵循既定「cwd 靠引擎兜底」原则)。**与 stage-3/4 提示词重构正交,另起一轮处理。**

---

## 2. 子代理粒度模型(证据定案,质量第一)

### 2.1 四方一手来源的实际立场(高度收敛)

| 来源 | 对「写代码」的做法 | 关键证据 |
|---|---|---|
| Claude Code 官方 feature-dev plugin | 实现阶段(Phase 5)**主 agent inline 写,不派子代理**;子代理只做只读扇出(explore/architect/review) | commands/feature-dev.md Phase 5 |
| Anthropic 官方文章 | coding **不适合**多代理(需共享上下文、可并行单元少);subagent 价值=context 隔离/蒸馏 | multi-agent-research-system |
| Cognition《Don't Build Multi-Agents》 | 单线程串行+压缩;多/子代理写码 fragile(隐式决策不同步);连只读子代理都可能制造矛盾 | dont-build-multi-agents |
| superpowers 作者 obra(SDD) | **串行** fresh-subagent-per-task,**绝不并行写**;主 agent 当上下文路由器;**紧耦合 task→不派子代理** | SDD SKILL.md 决策树 + Red Flags |

**共识(可断言)**:① 写码**绝不并行**;② 主 agent 永远是持设计上下文的编排者,不写码、不外包决策;③ 子代理核心价值是 context 隔离。

### 2.2 两种纯模型的失败模式(均有实证)

- 纯单 agent 长上下文:**context rot / 静默漂移**(代码还能编译,逻辑悄悄不一致,约束被淹没,nothing fails loudly)——对「质量第一」最危险,因为不报错。
- 纯每-task-隔离:**跨 task 一致性丢失**(命名漂移、接口冲突、重复实现)。

### 2.3 定案:串行 fresh-subagent-per-执行单元

**执行单元 = 1 个独立 task,或一个耦合簇(coupling cluster)。** 主 session 永远是编排者+上下文路由器,不写码;feature 全部完成后跑跨-task 一致性审查(已是 stage-5 视角① 职责)。

**为什么这个混合而非纯模型**:
1. **你已有 design.md + architecture.md = 堵住「显式决策漂移」**(接口/命名/风格有单一事实源)。**但这只堵显式决策**:执行中临场产生、文档里没有的**隐式决策**(新内部变量命名、错误处理风格、边界条件选择)仍会在 fresh subagent 间漂移——subagent B 看不到 subagent A 临场定了什么。这部分由 `touches_shared` 注入前序 diff(同文件)+ 待沉淀术语(跨文件,尽力而为)**缓解但非根除**,残差由 **stage-5 跨-task 一致性审查**兜底(这才是隐式漂移的真正安全网,不是 per-task 隔离本身)。所以准确说法是:design/architecture 把 model A 从「危险」变「**较安全**」,不是「安全」。(经对抗审查修正过强断言)
2. 质量第一 → 躲 context rot → 排除纯单 agent(对中大型 feature)。
3. **「每个 task 无脑隔离」是过度套用**(正是 9rbh 里 Task 12/13 同改一文件的来源);obra 决策树都说紧耦合别隔离。
4. **耦合驱动合并的质量账(含权衡,经对抗审查补全)**:收益——耦合 task 进同一上下文→共享决策消漂移;独立 task 拆开→隔离防 context rot。**代价——合并牺牲 per-task 的 commit / 两段评审 / 越界检查粒度**(见 §4.7 的缓解:簇内仍逐 task commit、越界检查升到簇 files 并集层 + 子代理回报每 task 实际碰的文件)。所以**不是纯收益**:它用「per-task 检查点粒度」换「耦合决策共享」,只在确有硬耦合时才划算 → 簇必须小(见 §5 簇大小上限)。

**官方约束已验证不卡**:subagent 不能再 spawn subagent;但 stage-4 主循环跑在主 session,有权派发(9rbh 实跑成功派出 61 次 Agent 为证)。

---

## 3. 新 plan task schema

取代继承自 writing-plans 的格式(writing-plans **完全移除**——self-review checklist 内联进 stage-3,见 §5/§7)。

```
### Task N: <行为导向名>

unit: <execution-unit-id>          # 本 task 属哪个执行单元(独立 task 自成单元;耦合簇共享 id)
TDD: 是 | 否
done: "<行为级断言:操作 → 可观测结果>"
verify: "<可直接运行的验证命令>"     # stage-3 预推导,不留给 stage-4 即兴
read_first:                         # 执行前必读的现有文件/读依赖(门 4 查 files∪read_first)
  - path/to/dep.ts
decisions:                          # ★决策切片,见 §4(取代 design.md 路径默认注入)
  - "<约束断言>  ⟵ <来源:design.md §… / architecture.md §…>"
files:                              # 符号锚点,禁止行号
  - Modify: path/to/file.ts @ <导出名/函数名>
  - Create: path/to/new.ts
  - Test: path/to/test.ts
depends_on: [Task M]                # 线性顺序依赖
touches_shared: [Task M]            # 与哪些前序 task 改同一文件 → stage-4 注入前序 diff
output_size: small | large          # large 强制拆骨架+填充;判据=数 plan 已知量(见 §5),非预测代码体量
contract: "<仅 stub task>"          # 保留现有 stub/contract 协议
```

plan 末尾新增**执行单元清单**(stage-3 静态算出):

```
## 执行单元(串行)
- Unit 1: [Task 1]                       # 独立 → 一个 fresh subagent
- Unit 2: [Task 2, Task 3]               # 耦合簇(共享 createWindowBase.ts)→ 一个 subagent 一次做完
- Unit 3: [Task 4-skeleton, Task 4-fill] # output_size=large 拆骨架+填充
```

---

## 4. ★ `decisions` 决策切片:抽取判据(本文档重点)

**核心风险**(用户点名):stage-3 怎么从 design/architecture 机械地抽出「管某个 task 的决策」,而不是又变成主观即兴写一段?
**解法**:让 decisions 成为「一张 plan 本就需要的矩阵」的**机械投影**,并用 pass/fail 门校验,把「抽得对不对」从主观判断变成可检查。

### 4.1 第一性:为什么需要切片(回答「design.md 给单 task 对吗」)

- 整份 design.md 给单 task 子代理 = **噪音**(一个 task 只碰设计的一个切片;违反 Anthropic「最小高信号集」+ context rot)。
- 相关决策切片 = **必要信号,且必须保证可见**(违反则子代理基于冲突的隐含假设产出不一致 = Cognition 的 fragile 根因)。
- design.md 全文路径 = **合法兜底**,仅供「需要更广 rationale」的罕见情况;**降级为 tail,不再默认注入每个 prompt**。

现状 stage-4 把 design.md 当路径「按需自取」是三者里最差的:子代理不读→漏决策;读全文→噪音;「按需」把决策可见性变成可选。切片把可见性变回**保证**。

### 4.2 抽取机制:决策↔task 矩阵 +「投影机械、填充判断」的诚实划分

stage-3 本就必须做**覆盖性检查**(architecture.md 每个决策/接口/模块都有对应 task)。decisions 切片是**同一张映射反向读**:

1. 先建一张 **决策↔task 矩阵**(行=design.md 决策记录条目 + architecture.md 接口/契约 + design.md 验收标准 AC;列=task)。
2. 某个 task 的 `decisions` = **它在矩阵里命中的那些行**,逐条投影。

**必须诚实区分两步(对抗审查 A1 的核心修正)**:
- **投影**(矩阵某列→该 task 的 decisions)= **机械**。
- **填充**(决定「某条决策该挂到哪个/哪些 task」,即矩阵的格子)= **判断,不可完全机械化**。早先把整体称作「机械投影」是过强,已纠正。

因此覆盖门(§4.5 门 2)只能查「有没有空行(orphan,零命中)」,**查不出「错配」**(决策挂到了错的 task——它仍有 ≥1 命中,门 2 照样 PASS,而真正该拿这条护栏的 task 拿不到 → 重新打开 Cognition fragile 根因)。对错配的防护见 §4.5 门 4(把**符号锚定**的错配变可检测)+ per-task 规格审查(兜行为/风格类的判断残差)。

### 4.3 什么够格进 decisions(客观四类过滤器)

只有命中以下四类的条目能进 `decisions`,其余留在 design.md 路径兜底:

1. **接口契约**:本 task 必须遵守或产出的方法签名 / 返回结构 / 类型形状。来源:architecture.md §接口设计。
2. **命名/类型约定**:本 task 必须沿用以跟兄弟 task / 既有代码保持一致的命名、类型名。来源:architecture.md / 前序 task 的「新术语」。
3. **验收断言**:本 task 闭合的那条 design.md AC(可翻译成测试的行为断言)。来源:design.md §验收标准。
4. **显式决策约束**:design.md §决策记录里**约束本 task「怎么做」**的那条 Q&A,**含「为什么不选 X」**(防子代理重新探索已被否决的路径)。来源:design.md §决策记录。

### 4.4 什么禁止进 decisions(反向门)

- 实现步骤 / 代码 / 伪代码(那是实现,不是约束)。
- **无法回溯到某个 doc section 的条目**(没有 `⟵ 来源` 引用 = 要么 placeholder 要么凭空发明 = plan failure)。
- **适用于所有 task 的条目**(那是全局约束,属 stage-4 dispatch 前言,不该逐 task 重复——否则就是噪音 + 维护漂移)。
- 复述 `done` 字段(decisions 是 guardrail,done 是 what,二者正交,见 §4.6)。

### 4.5 强制可机检的 pass/fail 门(并入现有三轮 review,不另起一套)

**整合说明(对抗审查 B4)**:这些门**并入** stage-3 现有的三轮 review subagent 的检查维度(现有维度 1「覆盖完整性」= 下面门 2「orphan」,合并表述去重),**三轮流程结构不变**,只是扩充检查清单——避免两套 review 并存使 stage-3 负担翻倍。

把「切片抽得对不对」尽量变成机械检查(注意门 4 只能覆盖符号锚定类,行为/风格类有残差):

1. **来源可解析**:每条 decisions 必带 `⟵ 来源` 且该 section 在 design/architecture 里真实存在。无效引用 → FAIL。
2. **无 orphan 决策(覆盖)**:design.md 每条决策记录 + 每条 AC + architecture.md 每个接口,**至少出现在一个 task 的 decisions 里**。遗漏 → FAIL。(= 现有 review 维度 1)
3. **无全局条目伪装成局部**:同一条 decisions 逐字出现在 > N 个 task(建议 N=3)→ 它是全局约束,移到 dispatch 前言 → FAIL until moved。
4. **错配检测(符号锚定类,对抗审查 A1 新增)**:若一条 decisions **引用了具体符号**(接口名/类型名/文件路径/导出名),该符号必须出现在所属 task 的 `files ∪ read_first` 里;否则疑似错配 → FAIL。
   - **边界(诚实声明)**:此门只覆盖「引用了符号」的决策。**行为/风格类约束**(如「抛 RejectedError 而非返回 null」)可能任何 `files` 都不出现该符号——这类**门 4 放行,残差交 per-task 规格审查**(stage-4 的规格审本就核「代码是否符合本 task 的 decisions/契约」,正是错配的最后捕获点)。
   - 注:§4.8 例子里「白名单单一来源=allowedHosts.ts」引用的 `allowedHosts.ts` 在 Task 7 的 `read_first`(读依赖)而非 `files`(改的文件)——所以门 4 必须查 `files ∪ read_first`,只查 `files` 会误杀。

### 4.6 与 done / verify 的正交关系(避免重复)

| 字段 | 回答 | 例 |
|---|---|---|
| `done` | 完成长什么样(what) | "openExternalUrl 对非白名单域名抛 RejectedError" |
| `verify` | 怎么验(how to check) | `npx vitest run -t "openExternalUrl rejects"` |
| `decisions` | 实现时不得违反的护栏(constraints) | "URL 白名单复用 `config/allowedHosts.ts` 单一来源,禁止本 task 内联硬编码 ⟵ architecture.md §集成点" |

三者不重叠:done 说目标,verify 给检查命令,decisions 给「过程中不能踩的线 + 已定的接口/命名/为何不选 X」。

### 4.7 耦合簇的 decisions = 成员切片的并集(去重)+ 簇内仍保 per-task 检查点

一个耦合簇交给一个子代理时,其 decisions = 簇内各 task 切片的并集去重。**这正是耦合 task 该共享上下文的形式化**:它们共享一个决策切片,所以放进同一子代理上下文里消漂移。

**但合并不得牺牲质量基建(对抗审查 B1)**——簇子代理虽在一个上下文里连续做,仍须:
- **逐 task commit**(不是一坨):保留回滚/审查粒度,簇内 task A 错了不必连累 task B。
- **越界检查升到「簇 `files` 并集」层**:簇内 task 间互相写对方文件属正常协作,机械越界检查(对比单 task `Files`)在簇内失效;改为对比簇 files 并集,**并要求子代理回报「每个 task 实际碰了哪些文件」**供细粒度核对。
- **簇内 verify 时点**:簇内每个 task 各跑自己的 `verify`(不是簇做完只跑一次),保留 per-task 行为闭环。
- **定义「硬耦合」(够格合并簇的判据)**:仅当 ① `touches_shared` 文件交集非空(改同一文件),或 ② 一个 task 的 `done` 验证依赖另一 task 在**同一上下文内**的未提交中间状态(硬 contract 依赖,跨子代理传不过去)。仅逻辑顺序依赖(`depends_on` 但不共享文件/状态)**不够格合并**,保持独立单元。

### 4.8 一个具体例子(取自 9rbh 域,示意)

```
### Task 7: openExternalUrl 域名白名单校验

unit: U5
TDD: 是
done: "openExternalUrl(url) 对不在白名单的域名抛 RejectedError 并不发起跳转"
verify: "npx vitest run -t 'openExternalUrl'"
read_first:
  - apps/plaud-desktop/src/config/allowedHosts.ts   # 读依赖(决策引用它,门 4 查 files∪read_first)
decisions:
  - "白名单单一来源 = config/allowedHosts.ts,禁止本 task 内联硬编码域名  ⟵ architecture.md §集成点"   # 符号锚定→门 4 校验 allowedHosts.ts ∈ read_first ✓
  - "校验失败抛 RejectedError(不是返回 null),与 setWindowOpenHandler 的错误类型统一  ⟵ design.md §决策记录 Q4"   # 行为/风格类→门 4 放行,规格审兜底
  - "AC: 非白名单域名必须被拦截且记审计日志  ⟵ design.md §验收标准 AC6"
files:
  - Modify: apps/plaud-desktop/src/main/window/openExternal.ts @ openExternalUrl
  - Test: apps/plaud-desktop/src/main/window/openExternal.test.ts
depends_on: [Task 6]
output_size: small
```

注意:design.md 关于「为什么做安全加固」的整段需求叙事**没有**进 decisions(噪音,留路径兜底);只有约束本 task 实现的三条护栏进来了,且各带可解析来源。

---

## 5. stage-3 / stage-4 职责重排

### stage-3(plan 生成)新增职责

1. **粒度三硬门**(任一不满足必拆):语义内聚 ∧ `files` 可枚举且 ≤3–4 ∧ `output_size` 装得进单上下文。
   - **`output_size` 判据(对抗审查 A2 修正——别预测代码体量,数 plan 已知量)**:以 `files.Create` 数量 + architecture.md 中该文件**已列明**需实现的方法/导出/枚举条目数为硬阈值(如「单文件需实现 ≥ X 个已列明成员」即 `large`,强制拆骨架+填充)。
   - **前置门(把不确定性推回可静态检查处)**:若 architecture.md **没列全**某文件要实现的成员(如「包装全部 rpc 方法」却没枚举是哪些)→ 不在 stage-3 猜,**退回要求 stage-2 补全枚举**,作为 stage-3 的前置条件。9rbh 的 Task 13 正是「architecture 没枚举 80+ 方法 → stage-3 估不出 large」。
   - 非枚举型的体量(纯逻辑复杂度大)无法静态估 → 落到 stage-4 截断自保护协议兜底(§6 第 5 行)。
2. **建决策↔task 矩阵 → 投影出每个 task 的 `decisions`**(§4);四道门**并入现有三轮 review**(§4.5,不另起一套)。
3. **静态算执行单元**:按 §4.7 的「硬耦合」判据把耦合 task 合并成簇 → 输出执行单元清单。**这是职责上移的核心:簇划分从 stage-4 运行时即兴 → stage-3 可审静态。**
   - **簇大小上限(对抗审查 B1)**:簇内 `files` 并集必须仍满足 §5.1 体量门(≤3–4 文件、不触发 `large`),否则簇过大 → 退回 model B 的 context rot。宁可不合并,保独立单元串行。
4. 符号锚点替行号;`verify` 预推导(并校验,见 §6 verify 假绿行)。
5. **self-review checklist 内联进 stage-3,完全移除 writing-plans 依赖**:spec coverage / placeholder 扫描 / type consistency / file-structure mapping 四条通用纪律直接写进 stage-3 步骤,不再调用任何外部 plan skill。(第二轮 review:为 4 条通用纪律保留硬依赖性价比差,内联是行为等价且砍掉一个 `feat-flow start` 阻塞依赖)

### stage-4(执行)退化为机械执行器

1. **读执行单元清单,串行派发**:单元是 1 task→一个 fresh subagent;是耦合簇→一个 subagent 带全簇 decisions 并集一次做完。
2. **dispatch = 机械拼装**(plan 已自带 decisions/verify/files/锚点)→ 消灭「即兴构造、信息密度无下限」。
3. **去并行**(SDD 本就禁,9rbh 实跑违规并行 Task 1+2 触发 lint-staged race)。
4. **截断自保护协议**:子代理近上限/超预期大 → 先 commit 已完成部分 + 在 task-reports.md 写「剩余工作」清单 → 报 DONE_WITH_CONCERNS/BLOCKED;续跑读清单**不做 git 考古**。
5. `touches_shared` → 注入前序 task diff(防覆盖前序成果)。
6. design.md/architecture.md **不再默认注入每个 prompt**;仅当 task decisions 切片不足时作兜底路径出现。
7. cwd 不在此解决(§1.3 引擎线)。

---

## 6. 执行决策矩阵 v2(裸奔项补齐)

| # | 执行期情形 | 重构后决策 | 现状 |
|---|---|---|---|
| 1 | 干净成功 | verify→规格审→质量审→下一个 | ✅ |
| 2 | DONE_WITH_CONCERNS | 涉正确性/范围先处理;仅观察记录后推进 | ✅ |
| 3 | NEEDS_CONTEXT | 查 docs/ADR;在→补指针重派一次;不在→问开发者,禁凭空补 | ✅ |
| 4 | BLOCKED | 补 context/换强模型/拆 task/plan 错上报;2 次→开发者 | ✅ |
| 5 | **截断** | plan 体量门预防 + 子代理 checkpoint + 清单续跑 | ❌→补 |
| 6 | verify 失败 | 子代理自修,修不动才 escalate | ✅ |
| 7 | 既有测试挂 | 默认修代码;确信测实现细节→DONE_WITH_CONCERNS | ✅ |
| 8 | **改共享文件** | `touches_shared` 注入前序 diff | 🟡→补 |
| 9 | 行为越界 | 规格审越界检查→revert;**簇内升到 files 并集层 + 子代理回报每 task 实际碰的文件**(§4.7) | ✅/簇补 |
| 10 | cwd 错 | 引擎线(§1.3),非本重构 | ↗引擎 |
| 11 | 运行中发现 plan 错 | revision-protocol 入口 B,L1/L2/L3 | ✅ |
| 12 | **并行 race** | 钉死串行,耦合簇同 subagent | ❌→补 |
| 13 | **verify 假绿/假红(对抗审查 B3)**:verify 上移 stage-3 后被固化,机械执行不质疑 | 子代理跑 verify 后须确认**实际匹配到 ≥1 测试**;0 匹配视为命令错→escalate(不当通过) | ❌→补 |
| 14 | **verify 基建未就位(对抗审查 B3)**:TDD task 的 verify 依赖的测试基建在更靠后 task 才建 | stage-3 门:每个 TDD task 的 `verify` 所依赖的基建 task 必须在其 `depends_on` 闭包内 | ❌→补 |
| 15 | **耦合簇内某 task 错** | 簇内逐 task commit(§4.7),可单 task 回滚不连累同簇其余 | ❌→补 |

---

## 7. 迁移路径(全部确定,无「可能」)

**A. 提示词层(走 `/ai-flow:update`)——确定改 4 个文件:**

1. **stage-3.md(改)**:粒度三门(含 output_size 数已知量 + stage-2 枚举前置门)+ 决策矩阵/decisions + **四道门并入现有三轮 review(不另起一套,§4.5/B4)** + 执行单元清单(含簇大小上限)+ 符号锚点 + verify 预推导校验 + self-review checklist 内联(移除 writing-plans 依赖)。
2. **stage-4.md(改)**:机械派发 + 去并行 + 截断自保护协议 + touches_shared 注入 + **簇内逐 task commit/越界并集层/per-task verify** + **verify 假绿检测** + verify 基建闭包门;删 design.md 默认注入。
3. **stage-2.md(确定改,非「可能」)**:`output_size` 前置门要确定成立,必须让 architecture.md 在「接口设计/模块定位」枚举**单文件将获得/包装的批量成员清单或数量**(现骨架「每个 service/hook 的方法签名」只覆盖新建服务,不覆盖「包装既有 N 个成员」如 Task 13 的 80+ rpc 方法)。改动:architecture.md 骨架 + 完成条件 + 开发者审批清单加「批量成员是否已枚举」一项。
4. **helper.md(确定改)**:第 114–121 行「已知偏离 upstream」明文描述旧 plan 格式与旧 SDD 精选来源模式,重构后变事实错误,**必须更新**;连带 stage 表 stage-3 工具列(去掉 writing-plans)、stage-4 工具列注明执行单元/机械派发、**必需 skills 列表移除 writing-plans 条目**。

**B. preflight.sh(改——第二轮 review 修正)**:REQUIRED_SKILLS **移除 `writing-plans`**(连同其安装命令 case 与来源注释),剩 grounded-design / subagent-driven-development / receiving-code-review / optimize-claude-context 四个。原判「不改」基于「writing-plans 仅降级仍是依赖」;第二轮认定「为 4 条通用 checklist 留硬依赖性价比差 → 内联移除」,故 preflight 同步移除。其余 skill 不变。

**C. 引擎层(独立轨,走 TDD 不走 /ai-flow:update)**:cwd 守卫扩展。**唯一改 `plugins/ai-flow/src/lib/pretool-handler.ts`**:Bash 分支第 66 行 `return null` 之前加 cwd 漂移守卫——`resolve(cwd)!==resolve(repoRoot)` 时 DENY(此信号 100% 可靠:repoRoot 必为 cwd 祖先;Bash 命令自由文本无法可靠抽路径,故只用此结构化信号,与 Write 守卫同构)。控制平面三检查(signal/active.json/scripts)保持在此守卫之前。tests/pretool.test.ts 加 7 例(含「控制平面检查优先级」回归锁)。版本 bump 两处。**与 A/B 正交,可并行或先后,不阻塞提示词重构。**

**D. 发布**:A 改完 → 版本 bump(package.json + plugin.json)→ push,CI build dist。C 可同批或单独发。**commit/push 均等开发者明确授权(CLAUDE.md)。**

---

## 8. 已知风险 / 待验证(经对抗审查更新)

**最大单点风险(对抗审查总评)**:**`decisions` 的「归属判定」有不可消除的判断内核**。投影机械、填充判断;门 4 只能把**符号锚定**的错配变可检测,行为/风格类约束的错配只能靠 per-task 规格审查兜底。落地时若过度相信「机械」而弱化 per-task 规格审查,错配会重新打开 Cognition fragile 根因。→ **缓解已写入 §4.2/§4.5;但需实测错配率,若偏高则需强化规格审查对 decisions 的逐条核验。**

- **output_size 仍部分依赖 architecture 颗粒度**:§5 已把判据改成「数已知量 + stage-2 枚举前置门」,把不确定性推到可静态检查处。残余风险:stage-2 是否真会枚举全(需 §7 第 4 条回改 stage-2 兜)。非枚举型大 task 仍只能靠截断自保护协议。
- **决策矩阵 + 四门的 stage-3 成本**:stage-3 变重。缓解:门并入现有三轮 review(不翻倍)、矩阵是一次性投影。需实测中大型 feature 下 stage-3 时长可接受。
- **耦合簇过大反成 context rot**:已加簇大小上限(§5.3:簇 files 并集 ≤ 体量门)。
- **per-task 规格审查成为关键防线**:本设计把 decisions 错配、隐式决策漂移、簇内越界三类残差都压到 stage-4 的 per-task 规格审查 + stage-5 跨-task 审查。这两道审查的质量是整套设计的**真实底座**,不能因「plan 更结构化了」而削弱。

---

## 9. 对抗审查与处置(2026-06-08)

独立对抗审查(默认怀疑立场)+ 主 session 逐条独立裁定。**全部 7 条成立并已修;A1 的修复方案被主 session 独立修正(审查者原方案会误杀)。**

| 项 | 严重度 | 审查发现 | 主 session 裁定 | 处置位置 |
|---|---|---|---|---|
| A1 | 🔴 | decisions「机械投影」过强;归属填充是判断,门只查 orphan 查不出错配,重开 fragile 根因 | **成立**。投影机械、填充判断。审查者修复(符号不在 `files` 即 FAIL)**会误杀**(read_first 依赖、行为类无符号)→ 修正为查 `files ∪ read_first` + 行为类交规格审兜底 | §0、§4.2、§4.5 门 4、§8 |
| A2 | 🔴 | output_size 写 plan 时无法静态估,却是截断防护唯一总开关 | **成立**。改「数 plan 已知量(Create 数 + architecture 已列明成员)」+ stage-2 枚举前置门,把不确定性推到可静态检查处 | §3、§5.1、§7.4、§8 |
| B1 | 🟡 | 耦合簇吞掉 per-task commit/评审/越界粒度;被说成纯收益违反「暴露权衡」 | **成立**。簇内逐 task commit + 越界升并集层 + per-task verify + 硬耦合判据 + 簇大小上限;§2.3 补全权衡账 | §2.3.4、§4.7、§5.3、§6 行 9/15 |
| B2 | 🟡 | 「已有文档拆掉 fragile 根因」过强——隐式决策仍漂移 | **成立**。降为「堵显式漂移,隐式靠 touches_shared+待沉淀术语缓解,残差 stage-5 兜」 | §2.3.1 |
| B3 | 🟡 | §6 漏 verify 命令自身错(假绿)+ 测试基建时序;且假绿是本重构**引入**的 | **成立**。补矩阵行 13/14 | §6 |
| B4 | 🟡 | 新门与现有三轮 review 关系未交代,易两套并存 | **成立**。明确门并入现有三轮 review,维度 1=门 2 去重 | §4.5、§7.1 |

**审查者校验属实项(不构成问题)**:§1.3 cwd 守卫断言、§1.2 版本边界注记——均经源码/jsonl 核对准确。

**经此轮,整套设计的诚实定性**:不是「用结构化 plan 消除了主观性」,而是「把可符号锚定的错误变可机检,把不可机检的残差(归属判断、隐式决策、簇内协作)显式压到 per-task 规格审查 + stage-5 跨-task 审查这两道底座上」。底座质量 = 设计上限。
