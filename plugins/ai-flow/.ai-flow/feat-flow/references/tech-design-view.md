# tech-design.html 生成契约

> Stage 2 Gate 产出。把 design.md + architecture.md 蒸馏成一份**给开发者签字对齐**的专业技术方案 HTML。本契约自足（外壳/查看器/配图规则全在此），无需外部范例。

## 它是什么、为谁

代码动手前（Stage 4）的最后人审面。读者是**熟悉需求结果、但没探索过本仓库、没深想过边界的开发者**——读完这一份 HTML 就清楚 **做什么 / 怎么做 / 为什么这么做 / 最终如何实施**，像参加一场技术方案评审：其他参与者从这份文档就能复现「作者打算怎么实现本次需求」。

- md（design.md + architecture.md）是唯一 SoT；本 HTML 是**从 md 生成的单向只读视图**，不手改。上游经 `revision-protocol.md` 改了 md → **重新生成**本文件（同步=重生成，非编辑）。
- 输出：`{{project_root}}/docs/feat-flows/<flow_id>/tech-design.html`

## 生成方式

两步，职责分离：
1. **配图**：dispatch 一个 sonnet 子代理，手写 mermaid（`.mmd`）→ 用 `mmdc` 渲染 SVG 写盘（见下「配图」）。`diagram/` 已有 SVG 则复用、不重画（/clear 重入安全）。
2. **组装**：主 session 读 design.md + architecture.md + 本契约，**增量组装**这份自包含单文件 HTML（见下「HTML 组装」），把写好的 SVG 内联进图位。

## 文档结构（按此顺序，覆盖以下章节）

| 章节 | 回答 | 取自 |
|------|------|------|
| **0 · TL;DR** | 一段话：做什么 + 用什么方案，让人 30 秒决定要不要细读 | design 需求 + 方案总览 |
| **术语表**（**靠前，第 2 节**，默认展开的紧凑表） | 自造词 / 缩写一句话锁定，陌生读者随时查 | design 术语表 + architecture 新引入词 |
| 背景与问题 | 为什么现在做、解决什么（客观事实，不掺方案） | design 现状 / grounded findings |
| 需求 & **目标 / 非目标** | 做什么 / 显式不做什么（非目标=「本可做但明确不做」，尤其重要） | design 需求 + 不在范围内 |
| **现状落位**（含落位图） | 本方案落在现有架构哪、上下游是谁、涉及哪些现有模块——为陌生读者建心智模型 | architecture + 配图 |
| **提议方案**（概览先行 → 机制下钻） | 怎么做：先一段概览 + 一张图，再下钻接口签名 / 数据流 / 核心 pseudo-code；「为什么」就地嵌在每个设计点旁 | architecture |
| 备选方案 | 收口被否决的路 + 为何不选 | design 决策的 alternatives |
| 风险 · 安全 · 未决假设 | 需开发者拍板的 | design 安全节 + ⚠ 假设 |
| 实施路径 | 最终如何实施（高层阶段 / 顺序 / 里程碑，**非**任务清单） | architecture Build 顺序 |
| **附 · 决策台账（速查表）** + ADR 候选 + 暂缓清单 | 对齐速查（**支撑，非正文主体**） | design 决策 + architecture 取舍 |

> **术语表续接**：architecture 引入了 design.md 术语表未收的自造词 / 缩写时，先补进 design.md 术语表，再渲染完整术语表章节。

## 怎么做要「可感知」（命根子）

读者不熟代码库，所以「怎么做」必须**可感知**，而不是停在抽象的「决策与理由清单」：

- **概览先行 → 机制下钻**：每节方案先一段话 + 一张图给地图，再讲机制细节。
- **现状落位图**：让陌生读者最快建立心智模型的入口（本方案在大架构里的位置 / 上下游 / 数据从哪到哪）。
- **写出接口签名**（方法名 / 参数 / 返回 / 异常边界），不泛泛说「提供一个接口」。
- **数据流具体化**（端到端链条 + 错误冒泡 + loading 归属）。
- **核心 pseudo-code**：只贴机制核心那几行，**不整段 copy 接口 / 类型定义**（冗长、含无关细节、易与代码脱节）。
- **「为什么」嵌入式**：讲每个关键设计点时就地说清权衡；被否决的路集中到「备选方案」收口。**决策台账只是附录速查表，不是正文主体**——纯决策表读不出实质。

## 渐进披露：实质默认展开，只折附录

- **默认展开（绝不折叠）**：问题、所选方案、数据流、接口主干、关键权衡与理由——这些是读者来读文档的目的。
- **才折叠（`<details>` 收起）**：完整枚举（如全部错误码 / 成员清单）、守护栏不变量、附录、术语表细节。
- **禁止把核心方案折叠到读不出实质**（折叠核心 = 把正文藏起来）。需并排比较的内容（方案 A/B、字段映射）不折叠。

## 配图（mermaid + mmdc，图优先）

配图由一个 **sonnet 子代理**手写 mermaid（`.mmd`）→ 用 `mmdc` 渲染 SVG 写盘。子代理职责限定为**写 .mmd → 渲染 → 自检 → 写盘 → 回报图清单**：只产 SVG，不组装 HTML，**不再 spawn 下级子代理**。

- **图优先（但有预算，不是堆图）**：图是最好的阅读工具——纯文字讲不清的**结构 / 流程 / 时序 / 状态**都配图，每张必须 **准确 + 贴合本次需求 + 图文同主题**。**优先保证现状落位图 + 1–2 张核心数据流 / 时序图**；其余仅当「纯文字确实讲不清该结构 / 流程」才追加，**同一信息已有图覆盖不重复画**，不为画而画、不画与本需求无关的通用图。
  - 常配的图：**现状落位图**（结构：模块是什么 / 含什么 / 落在哪层）、**关键数据流或时序图**（行为：时序 / 条件分支 / 循环 / 重试回滚 / 跨进程往返 / 状态迁移）、**状态机图**。两类都画时各守车道：结构图管模块、数据流图只画流转。
- **怎么画**：子代理读真实 design.md + architecture.md，**手写 mermaid 语法**（`flowchart` / `sequenceDiagram` / `stateDiagram-v2` 等，按图义选），用浅色 `neutral` 主题（跟随浅色文档=图文同主题）。渲染：
  ```
  mmdc -i <图>.mmd -o <图>.svg -t neutral -b transparent
  ```
- **为什么 mermaid 而非手写 SVG**：mermaid 是声明式确定渲染，拓扑 / 箭头 / 不穿盒由引擎保证，从根上避免「箭头穿盒 / 压线」这类错误。代价是自由布局美学略弱——但落位 / 流程 / 时序 / 状态四类图够用且更可靠。**结构由你手写决定**（不要套固定模板填槽，那会把真实拓扑/顺序拍歪）。
- **标签纪律（避免渲染失败）**：mermaid 节点标签里裸写 `( ) [ ] { } : / | # < > ;` 及**全角符号（（）：；【】）**都可能被解析器当语法 token 而崩。**统一规则：节点标签一律用 `"..."` 双引号包裹**（消解绝大多数 token 冲突）；标签内仍需 `"` 时改写措辞。中文文字正常支持。**换行必须用 `<br/>`，禁用 `\n`**——mermaid 不解析 `\n`，会把它当字面量原样渲染，导致标签超长且出现可见的 `\n` 字符。
- **★ 配图质量门（强制——不许交没看过的图）**：每张图写盘前，子代理**渲染 PNG → 读图 → 逐条核对 → 修**。失败 checklist（命中即不合格）：
  0. **渲染失败（语法错，置顶先查）**：`mmdc` 退出码非 0 / 无 SVG 产出 = 语法错——先修语法再谈视觉，语法修复轮次**单独算、不占下面视觉自检的 2 轮预算**。语法连续修仍失败 → 该图位降级（如 `sequenceDiagram` 带 alt/loop 块降为 `flowchart`）或放弃此图改纯文字承载，回报里标注，**绝不内联损坏 / 空 SVG**。
  1. **箭头穿盒**：连线绝不穿过盒子内部。
  2. **标签压线 / 断线**：连线标签放线的上方或旁边，不骑线。
  3. **文字溢出 / 截断**：盒内文字放不下就换行或缩短（**中文字宽 ≈ font-size**）；换行只用 `<br/>`。
  4. **重叠**：盒子不重叠；泳道分隔不穿盒。
  5. **顺序错**：时序 / 分支顺序须与 design 真实逻辑一致（手写语法时按真实逻辑写，别让结构走样）。
  6. **可见 `\n` 字面量**：读图时若标签里出现可见的 `\n`（未被解析为换行）= 渲染失败必修——改成 `<br/>` 重渲。

  自检命令（渲 PNG 后 Read 图核对上面 5 条）：
  ```
  mmdc -i <图>.mmd -o /tmp/diagcheck.png -t neutral -b white --scale 2
  ```
  **render→check→fix 最多 2 轮**：2 轮后仍有命中项，接受当前最佳版本，不无限重画。
- **写盘 + 回报**：自检后 SVG 落在 `{{project_root}}/docs/feat-flows/<flow_id>/diagram/`（stage-2 为 `docs_only` write_scope，落此目录外会被引擎拒写）。子代理终态回报图清单（出了哪几张、各对应哪个图位），供主 session 内联与核对。

> mmdc（`@mermaid-js/mermaid-cli`）由 preflight 检查；缺失时 `npm install -g @mermaid-js/mermaid-cli`。

## 外壳技术要求

- 自包含单文件，CSS/JS 全内联，零外部网络依赖。
- **自适应宽度**：外层容器宽度放宽（~1600px 或流式），**宽屏下不得把内容挤在窄列、两侧留大片空白**。
- **统一内容宽度**：正文 / 表格 / 图 / 代码块**同限一个内容宽度（约 100ch）**、左右边对齐——不做「正文窄、表格图全宽」的错位排布。
- **绝不出横向滚动条**：代码块用 `white-space:pre-wrap`（长行换行不横滚）；表格在统一宽度内自适应，禁止横向撑破或溢出内容宽度。
- **dark / light 切换**：`:root` / `html.dark` 上 CSS 变量 + 切换按钮 + localStorage + paint 前应用脚本（防闪烁）。mermaid 图用浅色主题，浅色文档下图文同主题。
- **sticky 导航 + scrollspy**：侧边或顶部 sticky 导航（各 section 锚点）+ 滚动高亮当前节；锚点配 `scroll-margin-top` 避开 sticky 头遮挡。
- **默认折叠区**（完整枚举 / 守护栏 / 术语表细节）统一用 `<details>`，收起态；**实质内容默认展开**。
- 每张图配**全屏查看器**：内联静态 fit 宽度（**不绑滚轮缩放**），点「全屏」后才 zoom/pan，ESC 关闭。**逐字照搬下面这套 `openFS`，勿改写**。

每张图包成：`<figure class="diagram"><div class="diagram-bar"><button data-fs>全屏</button></div><div class="diagram-stage"><svg viewBox="...">…</svg></div></figure>`，配套：

```css
.diagram-stage svg{width:100%;height:auto;display:block}
.fs-overlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.88);display:flex;flex-direction:column}
.fs-top{display:flex;justify-content:flex-end;gap:8px;padding:12px}
.fs-canvas{flex:1;overflow:hidden;cursor:grab}.fs-canvas.grabbing{cursor:grabbing}
.fs-inner{transform-origin:0 0;position:absolute;top:0;left:0}.fs-inner svg{display:block}
```
```js
(function(){function openFS(svg){var ov=document.createElement('div');ov.className='fs-overlay';ov.innerHTML='<div class="fs-top"><button data-z="out">－</button><button data-z="in">＋</button><button data-z="reset">重置</button><button data-z="close">关闭 ✕</button></div><div class="fs-canvas"><div class="fs-inner"></div></div>';var canvas=ov.querySelector('.fs-canvas'),inner=ov.querySelector('.fs-inner'),clone=svg.cloneNode(true);clone.removeAttribute('width');clone.removeAttribute('height');inner.appendChild(clone);document.body.appendChild(ov);document.body.style.overflow='hidden';var s=1,tx=0,ty=0,vb=clone.viewBox.baseVal,W=vb.width,H=vb.height;clone.setAttribute('width',W);clone.setAttribute('height',H);function ap(){inner.style.transform='translate('+tx+'px,'+ty+'px) scale('+s+')';}function fit(){var cw=canvas.clientWidth,ch=canvas.clientHeight;s=Math.min(cw/W,ch/H)*0.92;tx=(cw-W*s)/2;ty=(ch-H*s)/2;ap();}requestAnimationFrame(fit);canvas.addEventListener('wheel',function(e){e.preventDefault();var f=e.deltaY<0?1.1:0.9,r=canvas.getBoundingClientRect();tx=(e.clientX-r.left)-((e.clientX-r.left)-tx)*f;ty=(e.clientY-r.top)-((e.clientY-r.top)-ty)*f;s*=f;ap();},{passive:false});var drag=false,sx=0,sy=0;canvas.addEventListener('mousedown',function(e){drag=true;sx=e.clientX-tx;sy=e.clientY-ty;canvas.classList.add('grabbing');});window.addEventListener('mousemove',function(e){if(drag){tx=e.clientX-sx;ty=e.clientY-sy;ap();}});window.addEventListener('mouseup',function(){drag=false;canvas.classList.remove('grabbing');});ov.querySelector('.fs-top').addEventListener('click',function(e){var z=e.target.dataset.z;if(!z)return;if(z==='in')s*=1.2;else if(z==='out')s/=1.2;else if(z==='reset')return fit();else if(z==='close')return cl();ap();});function cl(){document.body.removeChild(ov);document.body.style.overflow='';document.removeEventListener('keydown',ok);}function ok(e){if(e.key==='Escape')cl();}document.addEventListener('keydown',ok);}document.querySelectorAll('.diagram').forEach(function(d){var b=d.querySelector('[data-fs]'),sv=d.querySelector('svg');if(b&&sv)b.addEventListener('click',function(){openFS(sv);});});})();
```

## HTML 组装（主 session 增量构建）

主 session 亲自拼，**不 dispatch 子代理写 HTML**；**禁止把整份 HTML 放进单次 Write**，按序增量落盘：

1. **写骨架**：一次 Write 落固定外壳——HTML 头、CSS 变量与 dark mode 脚本、sticky 导航 + scrollspy、统一内容宽度（~100ch）布局、那段 `openFS` JS **逐字照搬**；各章节、各图位留**唯一占位锚点**（如 `<!--SEC:现状落位-->`、`<!--FIG:落位-->`）。
2. **逐节填充**：每章节单独一次 Edit 替换其占位锚点；附录决策台账按固定列填速查表——一节一改，不堆在一起。
3. **内联图**：按子代理回报的图清单，从 `diagram/` 读出 SVG，逐张 Edit 替换对应图位锚点，每张套 `<figure class="diagram">…</figure>` 全屏查看器外壳。

### 决策台账 schema（附录速查，固定列）

每个有后果的岔路一行，把 design.md 散落的决策拍平成此表，**穷举**（漏一个对齐就是假的）：

| 决策点 | 选择 | 否决项 | 一句话为何 | 影响面 |
|--------|------|--------|-----------|--------|

但它是**附录支撑**——正文的「为什么」走嵌入式叙述，不靠这张表承载。**只呈现当前态**（选择 / 一句话为何 / 否决了什么），砍掉演化历史、来源编号体系（Q*/R*）、过程记录；蒸馏时剔除 md 里混入的修订史 / 阶段标注。

## 完成判据

- `tech-design.html` 存在、自包含、可在浏览器打开。
- 章节齐全且按规定顺序（**术语表靠前**；TL;DR / 背景 / 目标·非目标 / 现状落位 / 提议方案 / 备选 / 风险 / 实施路径 / 附录决策台账）；术语表收录正文出现的自造词 / 缩写。
- **实质内容默认展开**，只折附录 / 完整枚举 / 守护栏；正文无时间性叙事；决策台账穷举有后果的决策且仅作附录。
- **图优先**：凡能用图讲清的结构 / 流程 / 时序 / 状态已配图，每张准确贴合本需求、图文同主题、质量门自检通过（无穿盒 / 压线 / 溢出 / 重叠 / 乱序）。
- **布局**：统一内容宽度、宽屏不挤窄列、无横向滚动条。
- Gate 呈现以本文件为开发者主审面。
