# 环节 B：组装级双视角审查

> **触发**：stage-5 环节 A 自动化回归全绿，要开始组装级审查。
> `<base>` = 引擎注入 `[ai-flow:paths]` 块里的 `base_sha_code` 值（**不读 active.json**，那是控制面）。若注入块里没有该行（极罕见：flow 跨版本续跑），回 Stage 4 重写 `<flow_root>/state/mark-base` 让引擎重新捕获。

两个视角**并行派发**，各自聚焦组装后才显现的缺陷，互不重叠。两个审查者都用内置 `general-purpose` 子代理（**能跑 git**）——主 session 只给 `<base>`，让审查者自己 `git diff <base>..HEAD` / `git log` / 按需 Read 文件（业界实证：审查者自己沿调用链查，远胜被动接收一坨 diff 文本）。

> 为什么不用专用安全 / 审查插件 agent：官方生态里没有「有文档、可验证调用、且是安全专项」的 subagent——`code-review` 插件是 PR 导向且把安全列为忽略项，`security-guidance` 是被动 hooks，`code-modernization:security-auditor` 是无文档的插件内部 agent（无法可靠调用）。故用 general-purpose **执行公认的 OWASP/CWE 标准**：被背书的是标准本身，不是 agent 外壳。

## 视角①：集成 & 需求闭环审查（必跑）

派一个 `general-purpose` 子代理作审查者，让它**以资深工程师的视角**审查。它的职责**不是**逐函数找 bug（那是 Stage 4 每 task 评审已做的，重做既浪费又可能给出打架结论），而是审「全部改动组装后才显现」的问题。

**传入**：

- `<base>` 值（让它自己跑 `git diff <base>..HEAD`、`git log`、按需 Read 改动文件全文）
- design.md 全量（需求 + 决策记录 + AC——已对齐决策不得再质疑）
- architecture.md（架构基线 + 集成点清单）
- 相关 ADR 路径列表（入场 ADR 查阅的产出）
- task-reports.md（跨 task 元信息：新术语 / 前置修订）
- ⛔ **不传 plan.md**（避免审查被实施过程带偏）

**审查维度（全是组装级）**：

1. **需求闭环**：组装后的系统端到端满足 design.md 每条 AC 吗？有没有 AC 没被任何 task 覆盖、或被实现成另一个意思？
2. **跨 task 一致性**：术语 / 命名跨文件一致？数据结构跨模块对齐？task 之间的接口契约吻合？
3. **集成接驳**：与既有代码的接驳点（路由 / i18n / 错误处理 / 日志 / 鉴权）真的接上了？architecture.md 列的集成点有无遗漏？
4. **跨 task 资源 / 时序**：多 task 路径汇合后才显现的问题——新的竞态 / 死锁、N+1 查询、重复请求、性能退化。**只看多 task 汇合处**，不做通用性能审查（那是过早优化）。
5. **ADR 合规**：本次改动是否违反既有 ADR？问题必须引 ADR ID 作证据。
6. **测试调整复核**（若 review.md 有「测试调整记录」）：逐条验证——被改的测试是否真在测实现细节而非行为？新测试是否仍覆盖原意图？不成立则列为阻塞项。
7. **实现深度（altitude）**：改动是在正确深度实现，还是把特例堆在共享基础设施上当创可贴？多个 task 都在加特例 = 底层机制该泛化的信号——作为**建议项**提（非阻塞，呈开发者裁决，可能 YAGNI，不进 3 轮循环）。
8. 局部 bug 只在上述视角下**顺手撞见**才报，不主动地毯式扫。

**输出分两级**（每条 ≤5 行片段证据）：

- 🔴 **阻塞项**：需求未闭环 / 跨 task 不一致 / 集成断裂 / 违反 ADR / 高置信度真 bug。必须修。
- 🟡 **建议项**：架构优化、更好的复用、惯用法改进等——**允许激进提**（不设高置信度门槛），但**非阻塞**，呈开发者裁决，不进修复循环。

## 视角②：安全专项审查（强制，不可跳过）

派一个 `general-purpose` 子代理作**对抗式安全审查者**，**按公认的 OWASP Top 10 + CWE 标准**逐项核（不是自创方法论——OWASP/CWE 就是业界安全审计通用标准，这里只是让 general-purpose 执行它）。立场：**假设代码恶意，直到证明无害**。无论改动类型，**每次都跑**——安全是最高代价缺陷类，跨模块可利用性只有组装后才看得全。

**传入**：`<base>` 值 + design.md（技术栈 / 项目命令）+ architecture.md（集成点 / 鉴权架构，判 IDOR / 越权要靠它）+ 安全相关 ADR 路径列表。让它自己 `git diff <base>..HEAD` 圈定改动范围 + grep 代码追 source→sink。审查范围 = `<base>..HEAD` 的改动及其可达路径，**不审历史遗留代码**。

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

**按 OWASP Web Top 10 + 隐私逐项核**（注意**不是** OWASP-for-LLM 那套）：

- 注入（SQL / 命令 / NoSQL / LDAP / 模板）——每个用户可控输入追到 sink
- 认证 / 授权 / IDOR / 越权（敏感路由 / 操作的鉴权检查、所有权校验）
- 密钥 / 凭证硬编码、敏感配置泄露
- **用户隐私 / PII 泄露**（日志、响应体、第三方传输）
- SSRF / 不安全反序列化 / XSS / CSRF（Web 场景）
- 弱加密 / 不安全随机
- 依赖 CVE（**仅当本次 diff 新增了包依赖时**跑审计工具；否则跳过并写明）

每条问题：严重度（Critical / High / Medium）+ CWE 编号 + **可利用场景（source→sink 论证，不空喊风险）** + 修复建议。

- **Critical / High = 阻塞**，合并前必须修。
- Medium → 建议项，由开发者裁决。

## 综合处理（主 session，按 receiving-code-review 纪律）

两个视角都返回后，主 session 调用 `receiving-code-review` skill 逐条处理：

- ⛔ **严禁** "You're absolutely right!" / "Great point!" / 任何致谢类表演性同意
- 每条先**对照代码实际核验**，再决定接受还是反驳
- **去重**：两个视角指向同一处时合并为一条
- 三种特殊处置：
  - **YAGNI 检查**：审查者提「应该实现 X / 完善 Y」类 → 先 grep 该功能是否真有调用方，无调用 → 以「YAGNI」反驳
  - **架构级冲突**：若问题挑战 design.md 已记录的决策（非实现细节）→ **直接列入 review.md「待开发者决策（架构级）」，不进 3 轮循环**
  - **既有测试质疑**：建议改测试 → 应用 stage-5 的「既有测试破坏纪律」
- **处理顺序**：先澄清不清楚的 → 阻断项（安全 Critical/High + 视角① 阻塞）→ 简单修复（拼写 / import）→ 复杂修复（重构 / 逻辑），每条修完单独跑测试
- 接受 → 修代码，commit `fix: address review finding`，记 review.md「已解决」
- 反驳 → review.md「已反驳」记反证（≤5 行片段）
- 🟡 **建议项 + Medium 安全项** → review.md「建议（非阻塞）」，呈开发者，不强制修

## 阻塞项的验证（3 轮硬上限）

阻塞项修完后，让**对应视角的审查者**验证修复真的到位（模型会幻觉，修复也会）。**「视角派发 + 综合处理」记为轮 1**，本节是轮 2、轮 3，合计硬上限 3 轮：

- **轮 1 的阻塞项格式**：finding 蕴含多个命中点（跨 task 一致性、集成接驳、跨 task 资源 / 时序等）时，必须给出**可复跑判据 + 轮 1 当时的命中数**（形如 `grep -rn '<pattern>' <dir>` → N）；给不出就要说明为什么这是单点问题。
- **轮 2**：把「已接受项的处理结果 + 反驳项的反证」发给对应视角的审查者核验 → 返回：验证通过 / 撤回意见 / 仍坚持。核验范围 = 修复 commit 的 diff **∪** 重跑该 finding 的那条判据；命中数没降到 0（或没降到 finding 声明的预期残留）= 覆盖不全。
- **安全类阻塞项（仅 Critical / High）**：修复后另派一个子代理（`model='opus'`）做 report-only 独立复核，只核这几行 fix 是否真堵住 / 有没有开新洞，不重审全 diff。
- **轮 3（仅剩余分歧）**：发分歧项 + 双方完整立场，审查者给最终理由。主 session 仍不认同 → review.md 标「需开发者决策 + 双方立场」。
- **3 轮后任何剩余分歧 → 停下来等开发者，不再循环。**
