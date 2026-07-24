# tech-design.html 生成契约（grill-flow 轻契约）

> stage-2 gate 产出。把**散文 spec.md** 蒸馏成一份给开发者签字对齐的方案 HTML。本契约自足（外壳/查看器/配图规则全在此）。
>
> **与 feat-flow 契约的关键差异**：grill-flow 的 spec 是**散文、不锁实现**，所以本视图**去掉 feat-flow 的 typed 接口签名与 pseudo-code 两节**；但**保留接口契约决策**（用散文描述"这个模块对外承诺什么行为/输入输出契约"，不是 typed 签名）——否则 gate 沦为盖章。

## 它是什么、为谁

代码动手前（stage-3）的最后人审面。读者是**熟悉需求结果、但没探索过本仓库**的开发者——读完就清楚 **做什么 / 怎么做 / 为什么 / 大致如何实施**。

- spec.md 是唯一 SoT；本 HTML 是从它生成的**单向只读视图**，不手改。spec 改了 → **重新生成**（同步=重生成）。
- 输出：`{{project_root}}/docs/grill-flows/<flow_id>/tech-design.html`

## 生成方式

两步，职责分离：
1. **配图**：dispatch 一个 sonnet 子代理，手写 mermaid（`.mmd`）→ `mmdc` 渲染 SVG 写盘（见下「配图」）。`diagram/` 已有 SVG 则复用、不重画（/clear 重入安全）。
2. **组装**：主 session 读 spec.md + 本契约，**增量组装**自包含单文件 HTML，把 SVG 内联进图位。

## 文档结构（按此顺序）

| 章节 | 回答 | 取自 spec.md |
|------|------|------|
| **0 · TL;DR** | 一段话：做什么 + 用什么方案，30 秒决定要不要细读 | problem + solution |
| **术语表**（第 2 节，默认展开紧凑表） | 自造词/缩写一句话锁定 | 术语 + spec 新引入词 |
| 背景与问题 | 为什么做、解决什么（客观，不掺方案） | problem |
| 需求 & **目标/非目标** + **User Stories** | 做什么 / 显式不做什么 + 编号 US 列表 | solution + User Stories + out-of-scope |
| **现状落位**（含落位图） | 方案落在现有架构哪、上下游是谁——给陌生读者建心智模型 | solution + 配图 |
| **提议方案**（概览先行 → 机制下钻，散文） | 怎么做：先概览+一张图，再讲**概念机制 + 端到端数据流叙事**；「为什么」就地嵌在旁 | solution + decisions |
| **接口契约决策**（散文，非 typed 签名） | 涉及的模块对外**承诺什么行为/输入输出契约**——散文描述，不写方法签名/类型 | decisions |
| 备选方案 | 被否决的路 + 为何不选 | decisions 的 alternatives |
| 风险 · 安全 · 未决假设 | 需开发者拍板的 | 风险 + ⚠ 假设 |
| **方案审查结论** | stage-2 对抗审查的 findings + resolved 状态 | spec 的 `## 方案审查` 段 |
| **附 · 决策台账（速查表）** | 对齐速查（支撑，非正文主体） | decisions |

## 怎么做要「可感知」（命根子，但守散文内核）

读者不熟代码库，「怎么做」必须**可感知**——但 grill-flow 是散文 spec，所以用**概念机制 + 数据流叙事**承载，**不下钻到 typed 签名 / pseudo-code**：

- **概览先行 → 机制下钻**：每节先一段话 + 一张图给地图，再讲概念机制。
- **现状落位图**：陌生读者建心智模型的入口（方案在大架构里的位置 / 上下游 / 数据从哪到哪）。
- **数据流具体化（散文叙事）**：端到端链条 + 错误冒泡 + 状态归属，用文字讲清，不贴代码。
- **接口契约用散文**：「X 模块对外承诺：给它 A 会得到 B，失败时 C」——描述契约行为，不写方法签名。
- **「为什么」嵌入式**：讲每个关键设计点就地说清权衡；被否决的路集中到「备选方案」。决策台账只是附录速查表。

## 渐进披露

- **默认展开**：问题、所选方案、数据流叙事、接口契约决策、关键权衡——读者来读文档的目的。
- **才折叠（`<details>`）**：完整枚举（全部错误码/成员）、术语表细节、附录。
- 禁止把核心方案折叠到读不出实质。

## 配图（mermaid + mmdc，图优先）

一个 **sonnet 子代理**手写 mermaid（`.mmd`）→ `mmdc` 渲染 SVG 写盘。子代理只产 SVG，不组装 HTML，不再 spawn 下级子代理。

- **图优先（有预算）**：优先现状落位图 + 1–2 张核心数据流/时序图；其余仅当纯文字讲不清才追加，同信息不重复画。
- **怎么画**：读真实 spec.md，手写 mermaid（`flowchart`/`sequenceDiagram`/`stateDiagram-v2` 按图义选），浅色 `neutral` 主题。渲染：
  ```
  mmdc -i <图>.mmd -o <图>.svg -t neutral -b transparent
  ```
- **标签纪律（避免渲染失败）**：节点标签一律用 `"..."` 双引号包裹；换行必须用 `<br/>`，禁 `\n`（会渲成字面量）。裸写 `( ) [ ] { } : / | # < > ;` 及全角符号易崩。
- **★ 配图质量门（强制）**：每张图写盘前渲 PNG → 读图 → 逐条核对 → 修。失败项：渲染失败（语法错，置顶先修）/ 箭头穿盒 / 标签压线 / 文字溢出截断 / 重叠 / 顺序错 / 可见 `\n`。自检：
  ```
  mmdc -i <图>.mmd -o /tmp/diagcheck.png -t neutral -b white --scale 2
  ```
  **render→check→fix 最多 2 轮**（语法修复轮次单独算）。仍不合格 → 降级为纯文字承载，标注，绝不内联损坏 SVG。
- **写盘**：SVG 落 `{{project_root}}/docs/grill-flows/<flow_id>/diagram/`（stage-2 docs_only，落此目录外被拒写）。子代理回报图清单供主 session 内联。

## HTML 组装（主 session 增量构建）

主 session 亲拼，**不 dispatch 子代理写 HTML**；**禁止整份 HTML 单次 Write**，按序增量：

1. **写骨架**：一次 Write 落外壳——HTML 头、CSS 变量与 dark mode 脚本、sticky 导航 + scrollspy、统一内容宽度（~100ch）、下面 `openFS` JS **逐字照搬**；各章节/图位留唯一占位锚点（如 `<!--SEC:现状落位-->`、`<!--FIG:落位-->`）。
2. **逐节填充**：每章节单独 Edit 替换占位锚点。
3. **内联图**：按图清单从 `diagram/` 读 SVG，逐张 Edit 替换图位，每张套 `<figure class="diagram">…</figure>` 全屏查看器外壳。

### 外壳技术要求

- 自包含单文件，CSS/JS 全内联，零外部网络依赖。
- **自适应宽度**（~1600px 或流式，宽屏不挤窄列）；**统一内容宽度**（约 100ch，正文/表格/图/代码同限对齐）；**绝不出横向滚动条**（代码块 `white-space:pre-wrap`）。
- **dark/light 切换**：`:root`/`html.dark` CSS 变量 + 按钮 + localStorage + paint 前应用脚本（防闪烁）。mermaid 浅色主题、图文同主题。
- **sticky 导航 + scrollspy**（锚点配 `scroll-margin-top`）。
- **默认折叠区**用 `<details>` 收起态；实质内容默认展开。
- 每张图配全屏查看器：内联静态 fit 宽度（不绑滚轮缩放），点「全屏」后才 zoom/pan，ESC 关闭。**逐字照搬下面 `openFS`。**

每张图包成 `<figure class="diagram"><div class="diagram-bar"><button data-fs>全屏</button></div><div class="diagram-stage"><svg viewBox="...">…</svg></div></figure>`，配套：

```css
.diagram-stage svg{width:100%;height:auto;display:block}
.fs-overlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.88);display:flex;flex-direction:column}
.fs-top{display:flex;justify-content:flex-end;gap:8px;padding:12px}
.fs-canvas{flex:1;overflow:hidden;cursor:grab}.fs-canvas.grabbing{cursor:grabbing}
.fs-inner{transform-origin:0 0;position:absolute;top:0;left:0;background:#fff;border-radius:8px}.fs-inner svg{display:block}
```

> **`.fs-inner` 背景不可省**：配图用 `-b transparent` 渲染（SVG 透明），全屏遮罩近黑，不给浅色背景则深色文字/线条不可见。`.fs-inner` 尺寸由内部 SVG 显式 width/height 撑开，加背景色不影响 fit() 计算。

```js
(function(){function openFS(svg){var ov=document.createElement('div');ov.className='fs-overlay';ov.innerHTML='<div class="fs-top"><button data-z="out">－</button><button data-z="in">＋</button><button data-z="reset">重置</button><button data-z="close">关闭 ✕</button></div><div class="fs-canvas"><div class="fs-inner"></div></div>';var canvas=ov.querySelector('.fs-canvas'),inner=ov.querySelector('.fs-inner'),clone=svg.cloneNode(true);clone.removeAttribute('width');clone.removeAttribute('height');inner.appendChild(clone);document.body.appendChild(ov);document.body.style.overflow='hidden';var s=1,tx=0,ty=0,vb=clone.viewBox.baseVal,W=vb.width,H=vb.height;clone.setAttribute('width',W);clone.setAttribute('height',H);function ap(){inner.style.transform='translate('+tx+'px,'+ty+'px) scale('+s+')';}function fit(){var cw=canvas.clientWidth,ch=canvas.clientHeight;s=Math.min(cw/W,ch/H)*0.92;tx=(cw-W*s)/2;ty=(ch-H*s)/2;ap();}requestAnimationFrame(fit);canvas.addEventListener('wheel',function(e){e.preventDefault();var f=e.deltaY<0?1.1:0.9,r=canvas.getBoundingClientRect();tx=(e.clientX-r.left)-((e.clientX-r.left)-tx)*f;ty=(e.clientY-r.top)-((e.clientY-r.top)-ty)*f;s*=f;ap();},{passive:false});var drag=false,sx=0,sy=0;canvas.addEventListener('mousedown',function(e){drag=true;sx=e.clientX-tx;sy=e.clientY-ty;canvas.classList.add('grabbing');});window.addEventListener('mousemove',function(e){if(drag){tx=e.clientX-sx;ty=e.clientY-sy;ap();}});window.addEventListener('mouseup',function(){drag=false;canvas.classList.remove('grabbing');});ov.querySelector('.fs-top').addEventListener('click',function(e){var z=e.target.dataset.z;if(!z)return;if(z==='in')s*=1.2;else if(z==='out')s/=1.2;else if(z==='reset')return fit();else if(z==='close')return cl();ap();});function cl(){document.body.removeChild(ov);document.body.style.overflow='';document.removeEventListener('keydown',ok);}function ok(e){if(e.key==='Escape')cl();}document.addEventListener('keydown',ok);}document.querySelectorAll('.diagram').forEach(function(d){var b=d.querySelector('[data-fs]'),sv=d.querySelector('svg');if(b&&sv)b.addEventListener('click',function(){openFS(sv);});});})();
```

### 决策台账 schema（附录速查，固定列）

每个有后果的岔路一行，把 spec 散落的决策拍平，**穷举**：

| 决策点 | 选择 | 否决项 | 一句话为何 |
|--------|------|--------|-----------|

只呈现当前态，砍演化历史。它是附录支撑，正文「为什么」走嵌入式叙述。

## 完成判据

- `tech-design.html` 存在、自包含、可浏览器打开。
- 章节齐全按序（术语表靠前；TL;DR / 背景 / 目标·非目标+US / 现状落位 / 提议方案 / 接口契约决策 / 备选 / 风险 / 方案审查 / 附录台账）。
- **无 typed 签名 / pseudo-code**；接口契约以散文承载。
- 实质默认展开、只折附录/枚举；图优先且质量门自检通过；统一宽度、无横向滚动条。
- Gate 呈现以本文件为开发者主审面。
