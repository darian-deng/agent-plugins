# Stage 5：质量门

> feat-flow 第 5/6 步 · [流程总览](../helper.md)
> 当前 stage 目的：全量自动化回归 + **组装级双视角审查**（集成与需求闭环 + 强制安全），抓只有改动全部组装后才显现的缺陷。**验证与审查合并在一个 stage**，避免传统拆分时的"修了一个又破另一个"套娃

## 目标

**stage-5 只审「全部改动组装后才显现」的缺陷**——这是 Stage 1/2/4 任何单点都看不到的视角。逐函数局部 bug / 语法 / 边界已由 **Stage 4 每 task 的两段评审（规格 + 质量）覆盖，这里不重做**；架构与方案已由 Stage 2 + 其 Gate 定稿，这里不重判（发现真问题走 `{{flow_root}}/references/revision-protocol.md`，不当常规审查项）。

确保 base_sha_code 之后的所有改动通过：
- **自动化回归**（lint / typecheck / 单元测试 / 集成测试）
- **组装级双视角审查**：① 集成 & 需求闭环 ② 安全专项（**强制，不可跳过**）
- 阻塞项经 **3 轮验证**确认修复到位（模型会幻觉，修复也会——独立审查者复核是核心防线）

本 stage 只产生**修复类 commit**——验证修复（`fix: resolve verification errors`）或审查修复（`fix: address review finding`），不新增功能。

## 前置读取

- `{{project_root}}/docs/feat-flows/<flow_id>/design.md` — 项目命令、决策记录、AC
- `{{project_root}}/docs/feat-flows/<flow_id>/architecture.md` — 架构基线 + 集成点清单
- `{{project_root}}/docs/feat-flows/<flow_id>/task-reports.md` — 跨 task 元信息（新术语 / 前置修订）
- 引擎注入的 `[ai-flow:paths]` 块里的 `base_sha_code` — Stage 4 起点 SHA（下文 `<base>` 即此值；不要去读 active.json，那是控制面）

## 入场动作

**ADR 查阅**：执行 `{{flow_root}}/references/adr-scan.md`，筛出与本次改动相关的 ADR，产出**相关 ADR 路径列表**——下文环节 B 两个视角的审查者都按需引用它（视角① 查"是否违反既有 ADR"、视角② 取安全相关 ADR）。无 `docs/adr/` 则列表为空，跳过。

## 环节 A：自动化回归

按 design.md 项目命令运行：
- 单元测试：`<design.md 项目命令.单元测试>`
- 集成测试（若有）：`<design.md 项目命令.集成测试>`
- Lint：`<design.md 项目命令.Lint>`
- Typecheck：`<design.md 项目命令.Typecheck>`

**失败处理**：
- 修代码（默认）
- 若是既有测试被打破 + 怀疑测试在测**实现细节** → 应用「既有测试破坏纪律」（见下）
- 修复后 `git add -A && git commit -m "fix: resolve verification errors"`（`-A` 全树暂存,不受当前目录影响）
- 重跑直到全过

### 既有测试破坏纪律

**默认假设**：本次改动是回归，要修代码。

**例外**：若主 session 认为既有测试在测**实现细节**而非**行为**（违反可测试性原则），可提议改测试：
- 必须在 review.md「测试调整记录」节明确列出：哪条测试、为什么是测了实现细节、新测试如何覆盖原意图
- 改完测试可继续环节 A，但该调整**留待环节 B 的视角① 复核**（派发视角① 时明确要求验证「测试调整记录」每条是否成立）
- 若视角① 判定调整不成立 → 当作阻塞项回退

**绝对禁止**：通过修改测试断言让测试"通过"而不解释为什么。

## 环节 B：组装级双视角审查

两个视角**并行派发**，各自聚焦组装后才显现的缺陷，互不重叠。两个审查者都用内置 `general-purpose` 子代理（**能跑 git**）——主 session 只给 base SHA，让审查者自己 `git diff <base>..HEAD` / `git log` / 按需 Read 文件（业界实证：审查者自己沿调用链查，远胜被动接收一坨 diff 文本）。

> 为什么不用专用安全/审查插件 agent：官方生态里没有"有文档、可验证调用、且是安全专项"的 subagent——`code-review` 插件是 PR 导向且把安全列为忽略项，`security-guidance` 是被动 hooks，`code-modernization:security-auditor` 是无文档的插件内部 agent（无法可靠调用）。故用 general-purpose **执行公认的 OWASP/CWE 标准**：被背书的是标准本身，不是 agent 外壳。

> base SHA = 引擎注入 `[ai-flow:paths]` 块里的 `base_sha_code` 值。下文 `<base>` 均指此值。若注入块里没有该行（极罕见：flow 跨版本续跑），回 Stage 4 重写 `{{flow_root}}/state/mark-base` 让引擎重新捕获。

### 视角①：集成 & 需求闭环审查（必跑）

派一个 `general-purpose` 子代理作审查者，让它**以资深工程师的视角**审查。它的职责**不是**逐函数找 bug（那是 Stage 4 每 task 两段评审已做的，重做既浪费又可能给出打架结论），而是审"全部改动组装后才显现"的问题。

传入：
- `<base>` 值（让它自己跑 `git diff <base>..HEAD`、`git log`、按需 Read 改动文件全文）
- design.md 全量（需求 + 决策记录 + AC——已对齐决策不得再质疑）
- architecture.md（架构基线 + 集成点清单）
- 相关 ADR 路径列表
- task-reports.md（跨 task 元信息：新术语 / 前置修订）
- **不传 plan.md**（避免审查被实施过程带偏）

审查维度（**全是组装级**）：
1. **需求闭环**：组装后的系统端到端满足 design.md 每条 AC 吗？有没有 AC 没被任何 task 覆盖、或被实现成另一个意思？
2. **跨 task 一致性**：术语 / 命名跨文件一致？数据结构跨模块对齐？task 之间的接口契约吻合？
3. **集成接驳**：与既有代码的接驳点（路由 / i18n / 错误处理 / 日志 / 鉴权）真的接上了？architecture.md 列的集成点有无遗漏？
4. **跨 task 资源 / 时序**：多 task 路径汇合后才显现的问题——新的竞态 / 死锁、N+1 查询、重复请求、性能退化。**只看多 task 汇合处**，不做通用性能审查（那是过早优化）。
5. **注释 / context 漂移**：改动函数相邻 ±20 行注释是否仍准确？
6. **ADR 合规**：本次改动是否违反既有 ADR？问题必须引 ADR ID 作证据。
7. **测试调整复核（若 review.md 有「测试调整记录」）**：逐条验证——被改的测试是否真在测实现细节而非行为？新测试是否仍覆盖原意图？不成立则列为阻塞项。
8. **实现深度（altitude）**：改动是在正确深度实现，还是把特例堆在共享基础设施上当创可贴？多个 task 都在加特例 = 底层机制该泛化的信号——作为**建议项**提（非阻塞，呈开发者裁决，可能 YAGNI，不进 3 轮循环）。
9. 局部 bug 只在上述视角下**顺手撞见**才报，不主动地毯式扫。

输出**分两级**（每条 ≤5 行片段证据）：
- 🔴 **阻塞项**：需求未闭环 / 跨 task 不一致 / 集成断裂 / 违反 ADR / 高置信度真 bug。必须修。
- 🟡 **建议项**：架构优化、更好的复用、惯用法改进等——**允许激进提**（不设高置信度门槛），但**非阻塞**，呈开发者裁决，不进修复循环。

### 视角②：安全专项审查（强制，不可跳过）

派一个 `general-purpose` 子代理作**对抗式安全审查者**，**按公认的 OWASP Top 10 + CWE 标准**逐项核（不是自创方法论——OWASP/CWE 就是业界安全审计通用标准，这里只是让 general-purpose 执行它）。立场：**假设代码恶意，直到证明无害**。无论改动类型，**每次都跑**——安全是最高代价缺陷类，跨模块可利用性只有组装后才看得全。

传入：`<base>` 值 + design.md（技术栈 / 项目命令）+ architecture.md（集成点 / 鉴权架构，判 IDOR / 越权要靠它）+ 安全相关 ADR 路径列表。让它自己 `git diff <base>..HEAD` 圈定改动范围 + grep 代码追 source→sink。审查范围 = `base..HEAD` 的改动及其可达路径，不审历史遗留代码。

**依赖审计（条件执行，不跳过 OWASP 其他项）**：先判断本次改动是否新增了包依赖，再决定是否跑审计工具：

```bash
# 找依赖清单文件（排除 lock 文件）中是否有新增行
# 覆盖主流生态：JS/TS、Python、Rust、Go、Ruby、Java/Kotlin、PHP、.NET
# BASE_SHA = 引擎注入的 base_sha_code（把下面的占位替换成 [ai-flow:paths] 里那个值）
BASE_SHA="<注入的 base_sha_code 值>"
[ -z "$BASE_SHA" ] || [ "$BASE_SHA" = "<注入的 base_sha_code 值>" ] && { echo "ERROR: base_sha_code 缺失，回 Stage 4 重写 mark-base 重新捕获"; exit 1; }
MANIFEST_RE="package\.json$|requirements[^/]*\.txt$|Pipfile$|pyproject\.toml$|Cargo\.toml$|go\.mod$|Gemfile$|pom\.xml$|build\.gradle(\.kts)?$|\.csproj$|composer\.json$"
ADDED_DEPS=$(git diff "$BASE_SHA"..HEAD --name-only \
  | grep -E "$MANIFEST_RE" \
  | while IFS= read -r f; do
      git diff "$BASE_SHA"..HEAD -- "$f" | grep '^+' | grep -v '^+++'
    done \
  | head -5)
echo "${ADDED_DEPS:-NONE}"
```

- **`ADDED_DEPS` 非 `NONE`（有新增行）** → 按项目技术栈跑审计（`npm audit --audit-level=high` / `pip-audit` / `cargo audit` / 等）
- **`ADDED_DEPS` 为 `NONE`**（只删除 / 版本降级 / 无依赖文件变动）→ **跳过依赖审计**，明确写「依赖审计：本次改动未新增包依赖，跳过」

按 **OWASP Web Top 10 + 隐私**逐项核（注意**不是** OWASP-for-LLM 那套）：
- 注入（SQL / 命令 / NoSQL / LDAP / 模板）——每个用户可控输入追到 sink
- 认证 / 授权 / IDOR / 越权（敏感路由 / 操作的鉴权检查、所有权校验）
- 密钥 / 凭证硬编码、敏感配置泄露
- **用户隐私 / PII 泄露**（日志、响应体、第三方传输）
- SSRF / 不安全反序列化 / XSS / CSRF（Web 场景）
- 弱加密 / 不安全随机
- 依赖 CVE（**仅当本次 diff 新增了包依赖时**跑审计工具；否则跳过并写「依赖审计：本次改动未新增包依赖，跳过」）

每条问题：严重度（Critical / High / Medium）+ CWE 编号 + **可利用场景（source→sink 论证，不空喊风险）** + 修复建议。

- **Critical / High = 阻塞**，合并前必须修。
- Medium → 建议项，由开发者裁决。

### 综合处理（主 session，按 receiving-code-review 纪律）

两个视角都返回后，主 session 调用 `receiving-code-review` skill 逐条处理：

- **严禁** "You're absolutely right!" / "Great point!" / 任何致谢类表演性同意
- 每条先**对照代码实际核验**，再决定接受还是反驳
- **去重**：两个视角指向同一处时合并为一条
- 三种特殊处置：
  - **YAGNI 检查**：审查者提"应该实现 X / 完善 Y" 类 → 先 grep 该功能是否真有调用方，无调用 → 以「YAGNI」反驳
  - **架构级冲突**：若问题挑战 design.md 已记录的决策（非实现细节）→ **直接列入 review.md「待开发者决策（架构级）」，不进 3 轮循环**
  - **既有测试质疑**：建议改测试 → 应用既有测试破坏纪律
- **处理顺序**：先澄清不清楚的 → 阻断项（安全 Critical/High + 视角① 阻塞）→ 简单修复（拼写 / import）→ 复杂修复（重构 / 逻辑），每条修完单独跑测试
- 接受 → 修代码，commit `fix: address review finding`，记 review.md「已解决」
- 反驳 → review.md「已反驳」记反证（≤5 行片段）
- 🟡 **建议项 + Medium 安全项** → review.md「建议（非阻塞）」，呈开发者，不强制修

### 阻塞项的验证（3 轮硬上限）

阻塞项修完后，让**对应视角的审查者**验证修复真的到位（模型会幻觉，修复也会）。**「视角派发 + 综合处理」记为轮 1**，本节是轮 2、轮 3，合计硬上限 3 轮：

- **轮 2**：把"已接受项的处理结果 + 反驳项的反证"发给对应视角的审查者，让它重跑 `git diff <base>..HEAD`（已含修复 commit）核验 → 返回：验证通过 / 撤回意见 / 仍坚持。
- **轮 3（仅剩余分歧）**：发分歧项 + 双方完整立场，审查者给最终理由。主 session 仍不认同 → review.md 标「需开发者决策 + 双方立场」。
- **3 轮后任何剩余分歧 → 停下来等开发者，不再循环。**

### 自查前置 stage 问题（Stage 5 期间随时可能触发）

任一视角的审查者或主 session 自查发现前置 stage 漏写 / 错了 → 走 `{{flow_root}}/references/revision-protocol.md`（入口 B）：
- L1（推翻决策）→ 停下问开发者，建议 abort
- L2（漏写补全）→ 暂停 Stage 5，回更新前置文档，让开发者确认，再回 Stage 5 继续
- L3（小修）→ inline 修文档，review.md 加注记

注：问题挑战 design.md 已记录决策的「架构级冲突」处理（见综合处理）是本协议的特例。

### /clear 后的恢复

新 session 重启前先判定停在哪个环节：读 review.md——**有「人工 review（环节 C）」节且记有「本环节起点 SHA」→ 处于环节 C**，不重派双视角，直接续环节 C（重呈 `git diff base_sha_code..HEAD` + review.md 结论，从「还有其他问题吗」继续人审-修复循环，delta 起点用记录的 SHA）；**否则处于环节 A/B**，按下面重派双视角。

审查中途 /clear（审查者子代理 agent ID session-scoped 会丢失）→ 新 session 重启环节 B：

1. 已 commit 的修复 → 新审查者跑 `git diff <base>..HEAD` 看到的是当前 HEAD，不会再报已修项
2. review.md 累积的「已解决 / 已反驳 / 待开发者决策 / 建议」段保留——重派审查者时把现有 review.md 作为「上次审查的状态」一并传入
3. 用 fresh 审查者接力（**不是同一个子代理**），两个视角都重派，依靠 review.md 累积上下文避免重复劳动
4. 已记录的反驳反证 → 新审查者直接评估反证是否成立，不重新提相同问题；review.md 已记录的「建议（非阻塞）」项也**不重复提出**（建议项不改代码，fresh 审查者跑 diff 看不到，靠 review.md 去重）

**前提**：每轮处理后必须**立即**写 review.md（各类都即时落盘），不允许积累在主 session 内存。

### review.md 结构

```markdown
# 代码审查

## 审查范围
BASE_SHA_CODE: <SHA>

## 集成 & 需求闭环（视角①）

### 已解决
- <问题描述>：<修复方式> — 证据：`<≤5 行片段>`

### 已反驳
- <问题描述>：<反证：≤5 行片段>

## 安全（视角②）

### 已解决（Critical / High）
- <问题描述> [CWE-xxx]：<修复方式> — 证据：`<≤5 行片段>`

### 已反驳
- <问题描述>：<反证：≤5 行片段>

## 待开发者决策（架构级）
- <问题描述>：审查者立场 + 主 session 立场

## 建议（非阻塞）
- <视角① 建议项 / Medium 安全项> — 来源视角 + 一句话理由

## 测试调整记录
- <如有> 改测试的位置 + 理由 + 复核者意见

## 人工 review（环节 C）
本环节起点 SHA: <SHA>
- <开发者指出的问题>：<修复 commit> — 回归：通过
- 最终 CR：<跳过（零改动）| delta 聚焦 CR 结论 | 全量安全重跑结论>

## 结论
<总体评估>
```

## 环节 C：人工 review 闭环 + 最终 CR（写 signal 前的最后一关）

环节 A/B 是 AI 自查，这一环是**开发者**把关；开发者的修改同样要过回归与最终 CR（与 AI 代码同等把关）。**本环节走完前绝不写 signal。**

入场记下当前 HEAD 为**本环节起点 SHA**，写进 review.md「人工 review」节标题（`/clear` 后从那里读，用于算 delta）。

1. **请开发者 review**：呈现组装后改动（`git diff base_sha_code..HEAD`）+ review.md 结论摘要，明确告知：「你指出的每个问题都会修 + 重跑回归，全部满意后我做一次整体 CR 才推进」。
2. **人审-修复循环**（开发者每提一个问题）：
   - 修代码 → `git commit -m "fix: address human review"`（每问题一笔，/clear 安全）
   - **重跑环节 A 的自动化回归，必须全绿**——人改的代码同样过回归，不放行未验证改动
   - 把问题 + 处理记入 review.md「人工 review」节
   - 回开发者：「已修复 + 回归通过，还有其他问题吗？」
   - **持续判断开发者是否审完**；开发者明确表示无更多问题前，不进下一步、不写 signal（即便讨论中说「可以了」，也要先跑完步骤 3 的最终 CR）
3. **最终 CR（条件式）**——开发者确认无更多问题后：
   - 循环**零代码改动**（只 review、没让改）→ **跳过**（环节 B 双视角已覆盖当前 HEAD）
   - 循环**有改动** → 对本环节 delta（`git diff <本环节起点 SHA>..HEAD`）做聚焦 CR：质量看 reuse / simplification / altitude，正确性看 delta 是否引入回归或与既有改动冲突
   - delta **含安全敏感改动**（鉴权 / 输入处理 / 密钥 / 序列化 等）→ 升级为对 `base_sha_code..HEAD` 全量重跑视角②（安全）
   - CR 发现问题 → 回步骤 2 修复循环；**CR 干净 → 方可进入完成条件、写 signal**

## 完成条件

- 自动化回归全过（最后一个 commit 后跑一次确认）
- **视角① 与视角② 都已跑**（安全视角强制，不可跳过）
- **环节 C 已走完**：开发者确认无更多问题，人审 fix 全部过回归，最终 CR 已跑（或按条件跳过）且干净
- review.md 存在且完整（**含安全节**）
- 所有阻塞项（视角① 阻塞 + 安全 Critical/High）已修复 + commit
- 「待开发者决策」类问题由开发者拍板后已应用
- 建议项已呈开发者（非阻塞，无需全部修）
- `context-delta.md` 已追加 `## Stage 5` 节（无候选时写 `（无）`）

## Context 变化捕获（写 signal 前、判定完成条件时执行——其产出满足上面完成条件的 `## Stage 5` 节项）

派一个 `general-purpose` 子代理做知识沉淀——它 `git diff <base_sha_code>..HEAD` 看本次全部最终改动，**在代码里、满足 `assess-candidate` 契约**（主 session 不读代码、跑不了 litmus / comment-check / lint 毕业，故不在主 session 做）。子代理职责：

- 从 review.md 已解决项 + diff 识别命中 helper「注释与 context 归置」4 类之一（缘由 / 否定 / 约定 / 边界）、且属代码行为模式（非一次性局部 bug）的候选
- 对每条调用 `optimize-claude-context` 的 `assess-candidate`，只回它保留的**幸存候选 + 路由（目标层 + 理由 + file:line）**（其余由 skill 自理）

> `base_sha_code` 取自引擎注入的 `[ai-flow:paths]` 块。跨源冲突检测与权威路由仍归 Stage 6 `handle-one-directive`。

主 session 把子代理回报的幸存候选写入 `{{project_root}}/docs/feat-flows/<flow_id>/context-delta.md`。**不论是否有候选，都必须追加 `## Stage 5` 节**（无幸存时写「（无）」）——此节是 Stage 6 验证本 stage 已执行的唯一标记。

```markdown
## Stage 5 — <flow_id>

- <一句话描述> — 目标层 hint: <CLAUDE.md | rules/<domain>.md | skill | ADR> — 来源: review.md §<已解决项描述>
```

## Signal

**触发条件**：本阶段「完成条件」全部满足——**含环节 C 走完（开发者确认无更多问题 + 最终 CR 干净）**。在此之前不写 signal；即便讨论中开发者说「可以了」，也要先跑完最终 CR。
**动作**：用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`。写入后引擎进入 gate-pending，开发者 `feat-flow approve` 方才推进。
