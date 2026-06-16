# tech-design.html 生成契约

> Stage 2 Gate 产出。把 design.md + architecture.md 蒸馏成一份**给开发者签字对齐**的专业技术方案 HTML。本契约自足（外壳/查看器/配图规则全在此），无需外部范例。

## 它是什么、为谁

代码动手前（Stage 4）的最后人审面。读者是**只带着清晰需求、没探索过仓库、没深想过边界的开发者**——读完这一份 HTML 就清楚：**做什么 / 怎么做 / 为什么这么做 / 最终如何实施**。

- md（design.md + architecture.md）是唯一 SoT；本 HTML 是**从 md 生成的单向视图**，只读、不手改。上游经 `revision-protocol.md` 改了 md → **重新生成**本文件（同步=重生成，非编辑）。
- 输出：`{{project_root}}/docs/feat-flows/<flow_id>/tech-design.html`

## 生成方式

两步，职责分离：
1. **配图**：dispatch 一个 sonnet 子代理，只画 SVG 并写盘（见下「配图」）。`diagram/` 已有 SVG 则复用、不重画（/clear 重入安全）。
2. **组装**：主 session 读 design.md + architecture.md + 本契约，**增量组装**这份自包含单文件 HTML（见下「HTML 组装」），把写好的 SVG 内联进图位。

## 文档结构（覆盖以下章节）

| 章节 | 回答 | 取自 |
|------|------|------|
| 背景 & 现状接地 | 让没看过仓库的人懂语境（AI 探索发现的现有架构/约束） | design 现状/grounded findings |
| **术语表**（默认折叠，供随时查） | 自造词 / 领域缩写一句话释义 | design 术语表 + architecture 新引入词 |
| 需求 & **Non-goals** | 做什么 / 显式不做什么 | design 需求 + 不在范围内 |
| 方案总览 + **架构图** | 怎么做（高层，一眼看懂落位） | architecture 蓝图 + 配图 |
| 详细设计（组件/接口/数据流，**默认折叠**） | 怎么做（细节，渐进披露） | architecture |
| **★ 决策台账** | 为什么这么做——**命根子，承载「对齐了吗」** | design 决策 + architecture 取舍 |
| 风险 & 安全姿态 + 未决假设 | 需开发者拍板的 | design 安全节 + ⚠ 假设 |
| 实施路径（高层阶段/顺序/里程碑，**非**任务清单） | 最终如何实施 | architecture Build 顺序 |

> **术语表续接**：architecture 引入了 design.md 术语表未收的自造词 / 缩写时，先补进 design.md 术语表，再渲染完整术语表章节。

### 决策台账 schema（固定列，不即兴）

每个有后果的岔路一行：

| 决策点 | 选择 | 否决项 | 一句话为何 | 影响面 |
|--------|------|--------|-----------|--------|

把 design.md 里散落的决策拍平成此表。**穷举每一个有后果的决策**——漏一个，对齐就是假的。

## 只留最终决策，砍掉时间性叙事

正文和图里**只呈现当前态**：`选择 / 一句话为何这样 / 否决了什么替代`。
- **砍**：演化/历史叙事、来源编号体系（Q*/R* 等）、后续阶段追加的过程记录。
- **留**：「为何否决替代」——它是 alternatives-considered，让读者信服，不是时间性叙事。
- design.md/architecture.md 里若混有过程痕迹（修订史、阶段标注），蒸馏时一律剔除，只取实质。

## 完整 vs 易读：渐进披露

顶层是可一眼扫的蒸馏对齐面；细节放可折叠区，默认收起。完整但不是一堵墙。

## 外壳技术要求

- 自包含单文件，CSS/JS 全内联，零外部网络依赖。
- dark mode 切换：`:root` / `html.dark` 上 CSS 变量 + 切换按钮 + localStorage + paint 前应用脚本（防闪烁）。
- 顶部 sticky 横向导航（各 section 锚点），不占横向空间。
- 宽度 **breakout 模型**：正文 ~760px，宽元素（决策台账表 / 图 / 代码）breakout 到 ~1120px，外层 ~1200px 居中。
- **默认折叠区**（术语表 / 详细设计）统一用 `<details>`，收起态。
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

## 配图（baoyu-diagram 原生 + 强制视觉自检）

配图由一个 **sonnet 子代理**用 baoyu-diagram skill 画，**不在本视图里手写 SVG**。子代理职责限定为**画 SVG → 自检 → 写盘 → 回报图清单**：只产 SVG，不组装 HTML，**不再 spawn 下级子代理**（自己画完）。

- **何时配**：自适应，默认画最少的图。有架构足迹（新建模块 / 跨模块接线 / 落在哪层）才出**架构落位图**；纯局部改动不硬凑。图的规模随足迹缩放。
  - **何时再加数据流图**：仅当行为承载了结构图给不出的信息——时序 / 条件分支 / 循环（分页）/ 重试回滚 / 并发 / 跨进程往返 / 状态迁移。若「流程」只是同一批盒子按结构图画出的顺序走一遍，**不画第二张**，改在架构图上标 ①②③ 步号。两张都画时各守车道：结构图管「模块是什么 / 含什么」，数据流图只画流转、不重列模块内部成员。
- **怎么画**：子代理读真实 design.md + architecture.md，用 **baoyu-diagram 原样**画——Read 其 `~/.claude/skills/baoyu-diagram/SKILL.md`（及 `references/` 若有，含架构图布局算法），遵循它的设计系统、**原生深色主题**、自带流程。
- **风格不干预**：不覆盖主题（接受深色图嵌入浅色文档的明暗对比）、不改字体、不加新建/既有配色语义。但**结构正确性必须自检**（见下）——风格归 baoyu，正确性归质量门。
- **★ 配图质量门（强制——baoyu 也会画错，不许交没看过的图）**：每张图写盘前，子代理**渲染 → 读图 → 逐条核对 → 修**。失败模式 checklist（命中即不合格）：
  1. **箭头穿盒**：连线**绝不**穿过任何盒子内部——只走盒子之间空白；穿不过就改连接点 / 绕行。
  2. **标签压线/断线**：连线标签放线的**上方或旁边**，不得骑在线上把线截断。
  3. **文字溢出/截断**：盒内文字放不下就换行或缩短（**中文字宽 ≈ font-size，别按拉丁估**）。
  4. **重叠**：盒子之间不重叠；**泳道分隔线不得穿过盒子**。
  5. **挤**：内容多就**放大 viewBox**（绝不挤）；展示时等比缩小、全屏看 1:1。

  自检命令（headless Chrome 截图后 Read 图核对上面 5 条）：
  ```
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --screenshot=/tmp/diagcheck.png --window-size=1600,1300 --force-device-scale-factor=2 "file://<SVG 绝对路径>"
  ```
  **render→check→fix 最多 2 轮**：2 轮后仍有命中项，接受当前最佳版本，不得无限重画。（是否出某张图由上「何时配」决定，与质量门无关。）
- **写盘 + 回报**：自检后 SVG 落在 `{{project_root}}/docs/feat-flows/<flow_id>/diagram/`（stage-2 为 `docs_only` write_scope，落此目录外会被引擎拒写）。子代理终态回报图清单（出了哪几张、各对应哪个图位），供主 session 内联与核对；内联在「HTML 组装」时做。

> baoyu-diagram 经 plugin marketplace（`JimLiu/baoyu-skills`）安装、materialize 进 ~/.claude/skills/；preflight 已检查 SKILL.md。

## HTML 组装（主 session 增量构建）

主 session 亲自拼，**不 dispatch 子代理写 HTML**；**禁止把整份 HTML 放进单次 Write**，按序增量落盘：

1. **写骨架**：一次 Write 落出固定外壳——HTML 头、CSS 变量与 dark mode 脚本、sticky 导航、breakout 布局、「外壳技术要求」里那段 `openFS` JS **逐字照搬**；各章节、各图位留**唯一占位锚点**（如 `<!--SEC:决策台账-->`、`<!--FIG:架构落位-->`）。
2. **逐节填充**：每章节单独一次 Edit 替换其占位锚点，决策台账按固定列填表——一节一改，不堆在一起。
3. **内联图**：按子代理回报的图清单，从 `diagram/` 读出 SVG，逐张 Edit 替换对应图位锚点，每张套 `<figure class="diagram">…</figure>` 全屏查看器外壳（见「外壳技术要求」）。

## 完成判据

- `tech-design.html` 存在、自包含、可在浏览器打开。
- 各章节齐全（含术语表，收录正文出现的自造词 / 缩写）；决策台账穷举有后果的决策；正文无时间性叙事。
- 若有架构足迹：配图子代理回报的每张图已内联并套全屏查看器（质量门由子代理把关、终态回报为准：无箭头穿盒 / 压线断线 / 文字溢出 / 盒子重叠 / 泳道穿盒）。
- Gate 呈现以本文件为开发者主审面。
