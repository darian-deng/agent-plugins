# 环节 C：人工 review 闭环 + 最终 CR + squash

> **触发**：stage-5 环节 B 全部结束、改动都已 commit，要交给开发者亲审。**本环节走完前绝不写 signal。**
> `<base>` = 引擎注入 `[ai-flow:paths]` 块里的 `base_sha_code` 值。`<flow_root>` = 本文件所在目录的上一级。

环节 A/B 是 AI 自查，这一环是**开发者**把关；开发者的修改同样要过回归与最终 CR（与 AI 代码同等把关）。

本环节把 base 之后的全部改动摊成 **unstaged 全量**（工作区），全程不 stage、不 commit，直到最终 squash。开发者据此在 IDE 源码管理面板看「相对 base 的一整坨改动」，而非被一串 fix commit 切碎。**保持 unstaged 的收益**：diff 右侧是工作树真文件，IDE 语言服务（跳转定义 / 查引用）在 review 全程可用——staged 或 commit-vs-commit 的 diff 两侧都是 git 虚拟文档，语言服务不可用。

## 入场：把改动摊平到工作区

```bash
BASE_SHA="<注入的 base_sha_code 值>"   # = 引擎 [ai-flow:paths] 块里的 base_sha_code
[ -z "$BASE_SHA" ] || [ "$BASE_SHA" = "<注入的 base_sha_code 值>" ] && { echo "ERROR: base_sha_code 缺失，回 Stage 4 重写 mark-base 重新捕获"; exit 1; }
# ⚠️ 顺序不能反：先算范围、**写进 review.md**，才 reset —— reset 后 HEAD==base，这个 diff 变空
git diff --name-only "$BASE_SHA"..HEAD    # ← 输出先写进 review.md「本 flow 改动范围」节
# （写完再执行下一行）
git reset "$BASE_SHA"
```

`git reset`（mixed）撤回 base 之后所有提交、HEAD 退回 base，改动内容原样留在工作区且**全部 unstaged**（base 之后新建的文件呈 untracked）；散落的未提交工件（review.md / context-delta.md / task-reports.md 等）本就在工作区，一并以 unstaged/untracked 出现。此刻工作区相对 base 就是全部改动。

**告知开发者**：去 IDE 源码管理面板看 **Changes（未暂存）** 组，这就是组装后的完整 diff；⛔ **请勿手动 stage**——保持 unstaged 才有语言服务跳转。

⛔ 上面那条 `git diff --name-only` 的输出**必须在 reset 之前就写进 review.md**（「本 flow 改动范围」节）：它是收尾 `git add -A` 前 scope 核对的唯一依据（判据见 helper.md 铁律「`git add -A` 前先核范围」），而 reset 之后 `<base>..HEAD` 是空的、算不出来了。

**万一 /clear 恰好落在「reset 已跑、这一节还没写」的窗口里**（重入判据是 `HEAD == base_sha_code` 且 review.md 无该节）：不要凭工作区现状硬猜范围——那正好把 stray 也算进去。用 task-reports.md 里各 task 记的 `**Commit**` sha 反推：`git diff --name-only <base>..<最后一个 task 的 commit sha>`。那些 commit 被 reset 撤的只是 HEAD 指向，对象还在（`git reflog` 也能找回），所以这条随时算得出来。

reset 完成后**立即在 review.md 建「人工 review（环节 C）」节**（哪怕暂无内容）——作为 `/clear` 落在「reset 已跑、开发者还没提第一个问题」窗口时的恢复标记。

## 注释清理（显式调用 comment skill，reset 后 + squash 前各一次）

stage-4 每 task 评审只顺带标记注释、不专职清理（历史上因此漏网——某次 feat-flow 源码留了 54 处 `Task N` / `plan.md` / `design.md` 进程指代）；本步是**专职、会真删的兜底**。

**显式调用 `comment` skill**（`/ai-flow:comment`，范围 = 相对 `<base>` 的**已追踪改动 ∪ 未追踪新文件**，两半边的取法与理由见 skill，此处不复述）。⛔ **「调用」= 用 Skill 工具调（`skill: "ai-flow:comment"`），不是去把 `SKILL.md` 读出来自己照着办**——插件缓存目录并存十几个历史版本，`find` 的返回顺序与版本新旧无关；实测有一次读到五天前的旧版，照它已废弃的「一文件一子代理」编排派发，回合数是当前版批处理的 8 倍（30 vs 3.7 个回合/文件）。

- **reset 后跑一次**（开发者亲审的是已清理 diff）
- 人审-修复循环若动过代码，**squash 前再跑一次**（兜住修复时新灌的噪声）

清理结果记 review.md。**执行方式与机制——谁跑、怎么并行、是否会动老注释、判据——全在 skill 里、每次调用取最新，本文不复述**（这里只定「何时调用 + 范围」）。

## 真机验证清单（注释清理之后、人审-修复循环之前建立）

环节 A/B 全是机器地板 + 读 diff，都验不了「跑起来对不对」。**这里是全流程唯一的真机验证落点**，而此刻工作区是相对 base 的 unstaged 全量、代码可直接跑，正是唯一能验的时机。

1. **汇总清单，写进 review.md「真机验证」节**，来源两处（都要，别只取一处）：
   - design.md「验收标准」节里标 `[manual]` 的每条 AC（stage-1 定的，自上而下）
   - task-reports.md 各 task 的 `### 待人工验证`（stage-4 实施时发现的，自下而上）
   - 两处都空 → 在该节写明「无 `[manual]` 项」。⛔ **必须显式写**：空清单天然满足完成条件，不写就分不清「真的没有」和「忘了汇总」。
   - **两处指同一个行为时合并成一条、注明两个来源**：一条 `[manual]` 验收标准往往正是某个 task 的 `done` 所闭合的那条，那个 task 的子代理会把同一件事再上报一次进「待人工验证」。不合并就是请开发者把同一件事验两遍。
2. **逐条交开发者真机验**：给「验什么 + 怎么验（design.md 的验证步骤，或一句话操作路径）+ 期望结果」，一次给全清单，别一条条挤牙膏。
3. **验过** → 该条标 `已验证`，记 review.md。
4. **验出问题** → 并入下面的人审-修复循环（AI 改工作树 → 重跑环节 A 回归 → 请开发者复验），修好再标 `已验证`。
5. **开发者对某条明确豁免** → 标 `已豁免` + 注明原因（谁豁免的、为什么）。
6. ⛔ **全部条目 `已验证` 或 `已豁免`，才允许进最终 CR + squash**（stage-5 常驻红线第一条）。squash 之后再发现这些行为是坏的，就只能另开一次修复——stage-6 那行「🧪 建议人工测试」出现时代码已经提交完、flow 即将结束。

## 人审-修复循环（开发者每提一个问题）

全程保持 unstaged，不 add、不 commit：

1. **AI 直接改 working tree**（不 stage、不 commit）——改动并入 unstaged 全量（本轮新灌的注释噪声由 squash 前的复清兜底）
2. **重跑环节 A 自动化回归，必须全绿**——在 working tree 当前状态直接跑；人改 / AI 改同等过回归，不放行未验证改动
3. 把「开发者问题 + AI 改动的文件清单 + 回归结果」记入 review.md「人工 review」节——这份**文件清单是最终 CR 圈范围的依据**（0-commit、不分层，靠这份清单圈定人审阶段动过哪些文件）
4. 回开发者：「本轮改动见工作区 diff + 回归通过，确认无误吗？还有其他问题吗？」
5. ⛔ **持续判断开发者是否审完**；开发者明确表示无更多问题前，不进下一步、不写 signal（**即便讨论中说「可以了」，也要先跑完最终 CR**）

> 不做「本轮 vs 上轮」的增量切分：工作区 diff 始终是相对 base 的全量。开发者若想单独核对某一轮 AI 改了什么，可自行 `git add -A` 把已确认部分暂存、只留本轮为未暂存——这是开发者的可选本地操作，不是流程强制，AI 不依赖也不维护 index 状态（要回退某改动，口头说，让 AI 改回）。

## 最终 CR（条件式）→ squash

开发者确认无更多问题后：

1. ⛔ **先 scope 核对，再 `git add`**：逐条对 `git status --porcelain`，只把落在本 flow 范围内的改动纳入（范围 = review.md「本 flow 改动范围」节 ∪ `docs/feat-flows/**` ∪ `.ai-flow/**`——最后一项是 flow 定义，flow 运行中升级过插件或跑过 `/ai-flow:update` 就会有它，**必须纳入、不是 stray**；判据见 helper.md 铁律「`git add -A` 前先核范围」）。全部落在范围内 → `git add -A` 收尾，index = 全部累积改动；**有范围外的改动 → 不要 `-A`**，停下问开发者怎么处理。

2. **依改动量选择性 CR**：
   - 本环节**零代码改动**（只 review、没让改）**且环节 B 没修过阻塞项** → **跳过 CR**（环节 B 双视角审的就是当前这份内容，`git reset` 只撤提交不改工作区内容）
   - 本环节零代码改动、**但环节 B 修过阻塞项** → 仍跑 CR，范围 = 那些 `fix:` commit 触及的文件
   - **有改动** → 按 review.md 记录的「人审动过的文件清单」**取各轮并集**圈范围。⛔ 此时已 `git add -A` 收尾、`HEAD==base`，派出的视角子代理**须用 `git diff --staged <base>` 看改动，勿用 `<base>..HEAD`**——那是空 diff，子代理会对着空 diff 写出一份「没发现问题」：
     - 实质改动 → 派**视角①**聚焦审这些文件的最终形态 + 与既有改动的集成（质量看 reuse / simplification / altitude，正确性看是否引入回归或与既有改动冲突）
     - 清单含安全敏感改动（鉴权 / 输入处理 / 密钥 / 序列化 等）→ 加派**视角②**（安全）
     - 纯拼写 / import 级小修 → 主 session 自核即可
   - CR 发现问题 → 回人审-修复循环

3. **CR 干净（或零改动跳过 CR）→ 先做 Context 变化捕获**（见下节，写 `context-delta.md` 的 `## Stage 5` 节），再 squash。把 context-delta 一并纳入 squash，保证 squash 后 working tree 干净。**两个分支都汇流到此收尾，零改动也必须写 `## Stage 5` 节 + squash**（否则 Stage 6 A2 会因缺节 abort）。

4. **squash 成单个 feat commit**（改动已全 staged，直接 commit）。**撞 pre-commit hook 时不要默认 `--no-verify`**：squash 是环节 A/B/人审都过完的**最终态、本该干净**——失败落在上面 scope 核对判定的本 flow 范围内 → 修代码、不跳过（stage-4 那条「中间态可跳过」只适用于 task 间的 build 顺序中间态，收尾这里没有中间态可言）；只有失败明确落在范围外的其他子项目 stray 上（依据即 scope 核对结论）→ 才用 `--no-verify`，并在 message 里注明跳过了哪个 hook 及原因：

```bash
git add -A && git commit -m "feat: <一句话功能概述>

<2-4 行 what / why>

详细需求设计与架构见 docs/feat-flows/<flow_id>/（design.md · architecture.md · plan.md）

flow-squash: <flow_id>"
```

commit message **自包含**：概述与 what/why 不引用 `Task N` / `U<k>` / `Phase X` 等 flow 内部临时指代。body 末行 `flow-squash: <flow_id>` 是校验锚点——Stage 6 A0 据此只读校验代码已 squash。**commit 成功后方可写 signal。**

## Context 变化捕获

**时机**：最终 CR 干净后 / 零改动跳过 CR 后、squash commit 前。产出满足 stage-5 完成条件里的 `## Stage 5` 节那一项。

派一个 `general-purpose` 子代理做知识沉淀——它 `git diff --staged <base>` 看本次全部最终改动（此时环节 C 已 `git add -A` 收尾、HEAD 仍在 base、改动全在 index，故用 `--staged` 比 index 与 base，⛔ **不要用 `<base>..HEAD`**——那是空 diff），**在代码里、满足 `assess-candidate` 契约**（主 session 不读代码、跑不了 litmus / comment-check / lint 毕业，故不在主 session 做）。

子代理职责：

- 从 review.md 已解决项 + diff 识别命中 helper「注释与 context 归置」4 类之一（缘由 / 否定 / 约定 / 边界）、且属代码行为模式（非一次性局部 bug）的候选
- 对每条调用 `optimize-claude-context` 的 `assess-candidate`，只回它保留的**幸存候选 + 路由（目标层 + 理由 + file:line）**（其余由 skill 自理）

> 跨源冲突检测与权威路由仍归 Stage 6 `handle-one-directive`。

主 session 把子代理回报的幸存候选写入 `docs/feat-flows/<flow_id>/context-delta.md`。⛔ **不论是否有候选，都必须追加 `## Stage 5` 节**（无幸存时写「（无）」）——此节是 Stage 6 验证本 stage 已执行的唯一标记。

```markdown
## Stage 5 — <flow_id>

- <一句话描述> — 目标层 hint: <CLAUDE.md | rules/<domain>.md | skill | ADR> — 来源: review.md §<已解决项描述>
```
