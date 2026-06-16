# feat-flow 人审对齐层：stage-2 gate 专业技术方案视图

> 设计 spec · 2026-06-15 · 作为 `/ai-flow:update` 落地 stage-2 的依据
> 落地契约：`plugins/ai-flow/.ai-flow/feat-flow/references/tech-design-view.md`（自足：外壳 + openFS 查看器 + 配图质量门全在内，不依赖外部范例文件）

## 1. 问题与目标

**痛点（根因）**：feat-flow 早期 gate 缺一个「为人能否签字对齐」而蒸馏的视图层。design.md/architecture.md 是为 AI 完备性优化的产物——满是 Q*/R* 交叉引用、内联修订史、整张 schema，人读着过载，导致「执行完才发现很多点没对齐」。格式（md vs html）是次要矛盾，**缺蒸馏对齐层**是主要矛盾。

**目标**：开发者在代码动手前几分钟内，能有把握回答——(a) 做什么/不做什么，(b) 几个有后果的岔路各走了哪条，(c) 代码库会被动到哪里，(d) 风险/安全姿态；并相信签字的就是会被建的。

**必须保障**：① 决策集完整性（不漏任何有后果的岔路）；② 保真（视图从 md SoT 生成，非另写会漂移的摘要）；③ 人的低成本（几分钟扫完）。
**可舍弃**：细节完整性（钻取）、视图可编辑（只读/重生成）、早期 gate 视觉精致度。
**不解决（已知边界）**：stage-4 执行漂移（截断/跑偏）属执行保真，是 stage-5 的地盘，本设计不碰。

## 2. 时机：单点放 stage-2 gate（不新增 stage）

- 人相关决策集在 **stage-2 结束时已完整**（stage-3 只把 stage-1/2 决策投影成 AI 可执行排布，不产生新的人决策）。
- config.json gate 分布：stage-1 → stage-2 → stage-3/4 无 gate（开始写码）→ stage-5。**stage-2 gate 本就是代码动手前最后一道人审关**——「决策刚完整」与「最后机会」重合在此。
- 故：**把蒸馏对齐视图挂在 stage-2 gate**，不新增 stage/gate。stage-1 gate 靠杠杆 A 后的干净 md 对齐需求即可。

## 3. 产物模型：md 为 SoT，HTML 为单向生成视图

- **md（design.md + architecture.md）永远是唯一 SoT**，AI 只读写 md、执行器消费 md。
- **`tech-design.html` 是生成的、单向的、重生成而非手改的视图**。后续 stage 经 revision-protocol 改了 md → **重新生成** HTML。
- 「HTML 难同步」是伪命题：我们从不让 AI「编辑」HTML，只**重生成**。同步 = 重生成，单向、零漂移。

## 4. tech-design.html 文档结构（业界优秀技术设计文档骨架）

读者画像：只带清晰需求、**没探索过仓库、没深想过边界**的开发者。读完须清楚：做什么/怎么做/为什么/最终如何实施。

| 章节 | 回答 | 来源 |
|---|---|---|
| 背景 & 现状接地（AI 探索发现了什么） | 让没看过仓库的人懂语境 | stage-1 grounded findings |
| 需求 & **Non-goals** | 做什么 / 显式不做什么 | design 需求+范围 |
| 方案总览 + **架构图** | 怎么做（高层） | architecture 蓝图 |
| 详细设计（组件/接口/数据流，**默认折叠**） | 怎么做（细节，渐进披露） | architecture |
| **★ 决策台账**（表：决策点｜选择｜否决项｜一句话为何｜影响面） | **为什么**——命根子，承载「对齐了吗」 | design 决策 |
| 风险 & 安全姿态 + 未决假设 | 需拍板的 | design 安全节 + ⚠假设 |
| 实施路径（高层阶段/顺序/里程碑，**非**任务清单） | 最终如何实施 | architecture build 顺序 |

**完整 vs 易读 = 渐进披露**：顶层蒸馏对齐面（可扫），细节放可折叠区默认收起。

**文档外壳技术约定**（黄金范例 = `variant-d6.html`，Notion 极简风）：自包含单文件、CSS/JS 全内联、dark mode 切换（CSS 变量 + localStorage + paint 前应用防闪烁）、顶部 sticky 导航、**宽度 breakout 模型**（正文 ~760px + 宽元素 table/图 breakout 到 ~1120px，外层 ~1200px 居中）、每张图配**全屏查看器**（内联静态 fit 宽度、点全屏后才 zoom/pan、ESC 关闭——`openFS` 代码逐字写在契约里，不依赖范例文件）。

## 5. 杠杆 A：md 与 html 都砍掉时间性叙事，只留最终决策

- **决策记录写成当前态**：`选择 / 一句话为何这样 / 否决了什么替代及为何`。
- **砍掉**：时间性/演化叙事（「原本 X 后来反转成 Y」「R4 没扫干净的尾巴」「2026-XX 改成…」）、来源编号体系、后续阶段追加的过程 meta（Stage 6 沉淀表、复评补、gate 修订史）。
- **保留**：「为何否决替代」（alternatives-considered，不是时间性叙事——它让人和 AI 都信服、防 fresh subagent 重新翻案）。
- **审计回溯交给 git**（`git log -p design.md`）——产物里不再维护会腐烂的第二真相源。**不新建修订日志文件。**
- 改 `revision-protocol.md`：修订**当场呈现给开发者**（gate/report 一次性提示）+ **以当前态覆盖产物** + **不留历史**。

## 6. 配图：baoyu-diagram 原生（深色），忠实生产式调用

**踩坑结论（保留为决策依据，勿重走）**：
- 「LLM 靠提示词手写自定义 SVG」**6 轮失败、已证伪**——LLM 修得了拓扑（重叠/遮挡）却修不了**比例量感**（盒子多大/线多长），在挤与肿之间反复横跳。
- Mermaid 否（颜值/表达力）；D2 否（太大 + 家族风格）；AI 生成位图否（技术标签糊）。
- **baoyu-diagram 成立**：它的设计系统 + 分类型布局算法（references/architecture.md）+ **大盒内嵌套子盒**天然解决比例与空旷巨块。

**最终方案（已锁）**：
- **引擎 = baoyu-diagram skill，用其原生深色主题**。baoyu 自我定义即 "dark-themed"、`#0f172a` 硬编码、无 light 选项——**接受深色图**（浅色文档中两块深色图，开发者已接受此明暗对比；**不做浅色覆盖**，不逆着 skill 改）。
- **调用方式 = 忠实生产式**：一个 **sonnet 子代理**（遵「画图走 subagent + sonnet」）**读真实 design.md + architecture.md**（像真实文档生成器那样消化），用 baoyu-diagram **原样**（follow 其 SKILL.md + references + 自带流程）画图——**风格不干预**：不覆盖主题、不改字体、不加配色语义。但**结构正确性强制自检**（见下）。
- **图类型自适应**：有架构足迹才出架构落位图（规模随足迹缩放）；有端到端链条才出数据流图；纯局部改动不硬凑。
- 产出 SVG **内联**进 tech-design.html，套全屏查看器。
- **强制配图质量门（截图自检）**：baoyu 也会画错（实测 d6 数据流出现箭头穿盒），故每张图内联前子代理必须 **headless Chrome 截图 → 读图 → 逐条核对 → 修到干净**。checklist：① 箭头不穿盒 ② 标签不压线/断线 ③ 文字不溢出/截断（中文字宽≈font-size）④ 盒子不重叠/泳道不穿盒 ⑤ 内容多放大 viewBox 不挤。人在 gate 是第二道兜底。

**baoyu 安装（团队/preflight）**：经 **plugin marketplace** 安装——`claude plugin marketplace add JimLiu/baoyu-skills` → `claude plugin install baoyu-skills@baoyu-skills --scope user`；本机实测会 **materialize 进 `~/.claude/skills/`**（非 plugins/cache），故 preflight 按 **skill 检测**（checkSkill）。
> 实测排除的方案：`npx skills add jimliu/baoyu-skills@baoyu-diagram -g` **失败**（PromptScript 不支持全局安装）；baoyu-skills 仓库**无 license**，**不能 vendor**。
> preflight **硬依赖 SKILL.md**（单独足以产出可用图）；`references/`（架构图布局算法）为**增强、缺失不阻塞**（marketplace 不保证交付子目录）。

## 7. effective-html / fireworks 的处置

都**不引入为依赖**。effective-html 借鉴自包含 HTML 的审美/dark mode 规范；fireworks 借鉴「约束化 + 视觉自检」的纪律思想。配图引擎最终用 baoyu，不用它们。

## 8. 落地改动清单（走 `/ai-flow:update`）

- `stages/stage-2.md`：加「生成 tech-design.html」步骤（dispatch sonnet 子代理读 design.md+architecture.md，写文档外壳 + 内联 baoyu 子代理画的两图 + 全屏查看器）；gate 主审面从「对着 md 审 7 点」改为「以 tech-design.html 为主审面」。
- `stages/stage-1.md`：决策记录骨架改「当前态」格式（杠杆 A）。
- `references/revision-protocol.md`：修订当场呈现 + 当前态覆盖 + 不留历史（删 L3 inline 进正文）。
- 新增 `references/tech-design-view.md`（**自足，不配范例文件**）：文档结构契约 + 决策台账 schema + openFS 全屏查看器**代码逐字** + 渐进披露 + 配图约定（baoyu 原生 + 忠实调用 + 自适应 + **强制截图自检质量门**）。
- `helper.md`：流程总览同步。
- `preflight.cjs`：增加 baoyu-diagram 检查（checkSkill SKILL.md 硬依赖；references/ 缺失仅提示；安装提示 = plugin marketplace）。
- `config.json`：**不改**（stage-2 已有 gate）。
- 版本 bump（package.json + plugin.json）+ push（CI build dist）。

## 9. 不在本次范围

- 执行漂移（stage-4 截断/跑偏）——stage-5 执行保真，另议。
- stage-1 gate 不生成 HTML（靠杠杆 A 干净 md 对齐需求即可）。
- 视图不含 stage-3 任务切分（信任其为 AI 内部）。
