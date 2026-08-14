# 收尾：组装审 + 开发者 IDE 人审 + squash（stage-4）

> 全部 ticket 完成后，把整轮改动过 AI 组装审 + 开发者 IDE 亲审，最终 squash 成一笔 feat commit。三环节：**A 全量测试 → B AI 双轴组装审 → C 开发者 IDE 人审闭环 + squash**。环节 C 走完前**绝不写 signal**。

`<base>` = 引擎注入 `[ai-flow:paths]` 块里的 `base_sha_code`（stage-3 的 mark-base 捕获）。不读 active.json（控制面）。若注入块无该行（极罕见跨版本续跑）→ 回 stage-3 重写 `{{flow_root}}/state/mark-base` 重新捕获。

## 环节 A：全量测试（AI 跑）

- AI 亲自跑全量测试（异步、不冻 UI）；**假绿检测**=执行测试数 > 0。
- 失败 → 修代码（既有测试挂了默认当回归、**禁改断言糊弄**）→ commit `fix: resolve test failures` → 重跑直到全绿。
- 原始输出（通过/失败计数 + 当前 commit SHA）落 `review.md`——gate 时贴给开发者亲验。测试真绿无法机器证明，真防线=假绿检测+开发者看原始输出。

## 环节 B：AI 双轴组装审（一次，不套娃）

补 per-ticket 各自 /clear 窗口看不到整体 diff 的洞。diff 基准 `git diff <base>..HEAD -- . ':(exclude)docs/grill-flows/*'`（pathspec 排除 doc churn）。两个 `general-purpose` 子代理并行（能跑 git、自己 diff、**都不开 worktree**——本 stage 审的就是主树上归并后的整体，stage-3 的并行票到这里已全部回合、worktree 已拆，机器门⑤ 保证了这点）：

- **① Standards 轴**：携 `references/fowler-smells.md` 全文，审整体 diff 的跨 ticket smell——Duplicated Code（多 ticket 各写一份类似逻辑）、Shotgun Surgery、错 altitude、过度工程。
- **② Spec 轴**：携 `spec.md`，对 **User Stories 逐条**查需求闭环——每条 US 是否被兑现、有无缺失/偏离。
- **安全专项**（强制）：立场是**默认 diff 里可能有可利用漏洞、外部输入不可信，直到证明无害**（不是「读一遍看有没有」——这个心态转变零成本、抓真漏洞最值）。据此扫本 diff 的注入 / 鉴权与访问控制（越权、缺校验）/ 密钥凭据 / 敏感数据外泄（日志·错误·响应）/ 不安全反序列化，**不强制逐类打勾、不外扩到 diff 之外、不引入多级 severity**（定级沿用下方阻塞 / 建议二元）。

findings 分**阻塞 / 建议**落 review.md。阻塞项修复 → commit `fix: address review finding`。**不做 feat-flow 的 3 轮验证套娃**（grill-flow 刻意保持轻，一次审+修即可；判断型缺陷的最终兜底在环节 C 开发者亲审）。**唯一例外：安全类阻塞项修复后加一次独立复核**——另派 `opus` 子代理、report-only（不写文件、不 apply），只核这几行 fix 是否真堵住、有没有开新洞，**不重审全 diff**（「不做 3 轮套娃」禁的是重审整份 diff，这里只窄验几行 fix，粒度一致、不冲突）。**复核判仍不到位 → 直接停下 `AskUserQuestion` 问开发者**（安全红线五类的定义见 `per-ticket-review.md` 的「安全红线五类」节，不在此复述——复述必漂）；**不得因此再补第二轮修复——即便只补一次也不行**。**此例外只给安全（可被外部利用、后果不可逆的一类），不外推到 Standards / Spec。**

## 环节 C：开发者 IDE 人审闭环 + squash（写 signal 前最后一关）

环节 A/B 是 AI 自查，这一环是**开发者**把关；开发者的修改同样过回归。**本环节走完前绝不写 signal。**

把 base 之后的全部改动摊成 **unstaged 全量**（工作区），全程不 stage、不 commit，直到最终 squash。开发者据此在 IDE 源码管理面板看「相对 base 一整坨改动」，而非被一串 commit 切碎。**保持 unstaged 的收益**：diff 右侧是工作树真文件，IDE 语言服务（跳转定义 / 查引用）全程可用——staged 或 commit-vs-commit 两侧都是 git 虚拟文档、语言服务不可用。

### 入场：reset 摊平到工作区
环节 B 全部改动已 commit 后：
```bash
BASE_SHA="<注入的 base_sha_code 值>"   # 只替换本行占位为真 SHA；下一行比较里的占位串保持原样（否则守卫恒 exit 1）
[ -z "$BASE_SHA" ] || [ "$BASE_SHA" = "<注入的 base_sha_code 值>" ] && { echo "ERROR: base_sha_code 缺失，回 stage-3 重写 mark-base 重新捕获"; exit 1; }
git reset "$BASE_SHA"
```
`git reset`（mixed）撤回 base 之后所有 commit、HEAD 退回 base，改动原样留工作区且**全部 unstaged**（新文件呈 untracked）。**告知开发者**：去 IDE 源码管理面板看 **Changes（未暂存）** 组 = 整轮完整 diff；**请勿手动 stage**——保持 unstaged 才有语言服务跳转。
reset 后**立即在 review.md 建「人工 review（环节 C）」节**（哪怕空）——作为 /clear 落在「reset 已跑、开发者还没提问」窗口的恢复标记。

### 注释清理（显式调用 comment skill，reset 后 + squash 前各一次）
**编排器显式调用 `comment` skill**（`/ai-flow:comment`，范围=相对 base 的**已追踪改动 ∪ 未追踪新文件**——两半边的取法与理由见 skill，此处不复述）：**reset 后跑一次**（让开发者亲审的是已清理 diff）；人审-修复循环若动过代码，**squash 前再跑一次**（兜住修复时新灌的噪声——即"CR 时改动又乱加注释"）。清理结果记 review.md。**执行方式与机制——谁跑、怎么并行、是否会动老注释、判据——全在 skill 里、每次调用取最新，本 stage 不复述（本 stage 只定「何时调用 + 范围」）。**

### 真机验证清单（tickets.md 有 `## 待真机验证` 段时）
grill-flow 全流程只有这一处能做真机 / 鉴权 / 运行时验证——stage-3 机器地板验不了的票都攒在这。逐条走：
1. 读 tickets.md `## 待真机验证` 段（每条 `- T<n> — 验什么`）+ 该 ticket 在 tickets.md 的 AC。
2. 请**开发者**真机验该票（跑起来验鉴权流转 / 设备 I/O / 跨端行为等，AI 代不了）。
3. 验过 → 把该票行的 `rm:pending` 改 `rm:done`，在 review.md 人工 review 节记「T<n> 真机验证：通过」。
4. 验出问题 → 并入下面「人审-修复循环」（AI 改工作树 → 重跑全量测试 → 复验），修好再 `rm:done`。
5. **全部 `rm:pending` → `rm:done`（或开发者对某票明确豁免、并在 review.md 注明原因）才进最终 CR + squash。** 这是真机验证的 gate 兜底（stage-4 是 gate stage，靠人审 approve 强制）。

### 人审-修复循环（全程 unstaged，不 add/不 commit）
开发者每提一个问题：
1. **AI 直接改 working tree**（不 stage、不 commit）——改动并入 unstaged 全量。（本轮新灌的注释噪声由 squash 前的复清兜底——见上「注释清理」。）
2. **重跑全量测试，必须全绿**（人改 / AI 改同等过回归，不放行未验证改动）。
3. 「开发者问题 + AI 改动文件清单 + 回归结果」记入 review.md 人工 review 节（**文件清单是最终 CR 圈范围依据**）。
4. 回开发者：「本轮改动见工作区 diff + 回归通过，还有其他问题吗？」
5. **开发者明确表示无更多问题前，不进下一步、不写 signal**（即便讨论中说「可以了」，也要先跑完最终 CR + squash）。

### 最终 CR（条件式）→ squash
开发者确认无更多问题、且 `## 待真机验证` 无 `rm:pending` 残留（或已明确豁免）后：
1. **先做 stage-4.md 的「squash 前工作树 scope 核对」**（`git add -A` 前逐条核 `git status --porcelain`：只有本 flow 代码范围 ∪ `docs/grill-flows/**` 记账 tracking 才纳入；跨子项目 stray 改动别吞、停下问开发者）→ 再 `git add -A` 收尾（index = 本 flow 范围内的全部累积改动）。
2. **依改动量选择性 CR**（子代理用 `git diff --staged <base>` 看，**勿用 `<base>..HEAD`**——已 reset、HEAD==base，那是空 diff）：
   - 环节 C 零代码改动（只 review 没让改）→ **跳过 CR**（环节 B 已覆盖）。
   - 有实质改动 → 派 **Spec/Standards 子代理**聚焦审人审动过的文件；清单含安全敏感改动（鉴权 / 输入 / 密钥 / 序列化）→ 加派**安全**。
   - 纯拼写 / import 级小修 → 主 session 自核。
   - CR 发现问题 → 回人审-修复循环。
3. CR 干净（或零改动跳过）→ **squash 成单个 feat commit**（下面 `git add -A` 仍限步骤 1 核过的 scope，跨子项目 stray 不纳入；若 commit 撞 pre-commit hook，按 `per-ticket-review.md` 的「领域事实：预期的中间不可编译态」处理，别默认 `--no-verify`）：
```bash
git add -A && git commit -m "feat: <一句话功能概述>

<2-4 行 what / why>

详细规格见 docs/grill-flows/<flow_id>/spec.md

flow-squash: <flow_id>"
```
commit message **自包含**（不引用 `T<n>` / flow 内部临时指代）。body 末行 `flow-squash: <flow_id>` 是校验锚点。

4. **清理本 flow 的票分支**（squash 之后、写 signal 之前）：stage-3 的并行票留下 `wt/<flow_id>-T<n>`（车道模式是 `-R<n>`）分支（它们被刻意保留，供 stage-3 的重入相位表区分「已交付未回合」）。squash 已经把全部改动收进一笔 feat commit，这些分支再没有用途，不删会跨 flow 永久累积：
```sh
git branch --list "wt/<flow_id>-*" | xargs -r git branch -D
```
删之前确认 squash commit 已在（上一步），否则这是唯一还持有那些 per-ticket commit 的引用。

**commit 成功 + 分支已清理后方可写 signal。**

## /clear 重入判据（照 git 状态判在哪个环节）

reset 到 base 是环节 C 的强标志——环节 A/B 期间 HEAD 恒领先 base：
- **HEAD 提交 body 含 `flow-squash: <flow_id>` 且 signal 未写** → 已 squash 只差 signal：校验完成条件后补写 signal，不重做审查。
- **`HEAD == base_sha_code` 且工作区非空**（`git status --porcelain` 有输出）→ 环节 C 人审中：不重派双轴，重呈相对 base 全量改动（IDE Changes 组 / `git diff <base>` + `git status` 覆盖 untracked）+ review.md，从「还有其他问题吗」续人审循环；**并重读 tickets.md `## 待真机验证`：仍有 `rm:pending` 的票续做真机验证再收口**。
- **否则**（HEAD 领先 base）→ 环节 A/B，重跑。

## review.md 结构
```markdown
# 代码审查
## 审查范围
BASE_SHA_CODE: <SHA>
## Standards（跨 ticket smell）
### 已解决 / ### 已反驳
## Spec（User Stories 闭环）
### 已解决 / ### 已反驳
## 安全
### 已解决 / ### 已反驳
## 建议（非阻塞）
## 人工 review（环节 C）
- 真机验证：T<n> 通过 / T<n> 豁免（原因）
- <开发者问题>：AI 改动 <file…> — 回归：通过
- 最终 CR：<跳过（零改动）| 聚焦 CR 结论>
- squash：<feat commit 概要>
## 结论
## 原始测试输出
<通过/失败计数 + commit SHA>
```
