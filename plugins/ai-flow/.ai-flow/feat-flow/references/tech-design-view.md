# tech-design.html 生成契约

> Stage 2 Gate 产出。把 design.md + architecture.md 蒸馏成一份**给开发者签字对齐**的专业技术方案 HTML。本契约自足（外壳/查看器/配图规则全在此），无需外部范例。

## 它是什么、为谁

代码动手前（Stage 4）的最后人审面。读者是**只带着清晰需求、没探索过仓库、没深想过边界的开发者**——读完这一份 HTML 就清楚：**做什么 / 怎么做 / 为什么这么做 / 最终如何实施**。

- md（design.md + architecture.md）是唯一 SoT；本 HTML 是**从 md 生成的单向视图**，只读、不手改。上游经 `revision-protocol.md` 改了 md → **重新生成**本文件（同步=重生成，非编辑）。
- 输出：`{{project_root}}/docs/feat-flows/<flow_id>/tech-design.html`

## 生成方式

dispatch 一个 **sonnet 子代理**（画图密集，用 sonnet 不用 opus）：读 design.md + architecture.md + 本契约，产出自包含单文件 HTML。配图另由 baoyu 子代理画后内联（见下「配图」）。主 session 保持上下文干净。

## 文档结构（覆盖以下章节）

| 章节 | 回答 | 取自 |
|------|------|------|
| 背景 & 现状接地 | 让没看过仓库的人懂语境（AI 探索发现的现有架构/约束） | design 现状/grounded findings |
| 需求 & **Non-goals** | 做什么 / 显式不做什么 | design 需求 + 不在范围内 |
| 方案总览 + **架构图** | 怎么做（高层，一眼看懂落位） | architecture 蓝图 + 配图 |
| 详细设计（组件/接口/数据流，**默认折叠**） | 怎么做（细节，渐进披露） | architecture |
| **★ 决策台账** | 为什么这么做——**命根子，承载「对齐了吗」** | design 决策 + architecture 取舍 |
| 风险 & 安全姿态 + 未决假设 | 需开发者拍板的 | design 安全节 + ⚠ 假设 |
| 实施路径（高层阶段/顺序/里程碑，**非**任务清单） | 最终如何实施 | architecture Build 顺序 |

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
- 每张图配**全屏查看器**：内联静态 fit 宽度（**不绑滚轮缩放**），点「全屏」后才 zoom/pan，ESC 关闭。**逐字使用下面这套已验证的 `openFS`**（勿即兴重写——即兴版屡次出全屏 bug）。

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

配图由 baoyu-diagram skill 画，**不在本视图里手写 SVG**。

- **何时配**：自适应。有架构足迹（新建模块 / 跨模块接线 / 落在哪层）才出**架构落位图**；有清晰端到端链条才出**数据流图**；纯局部改动不硬凑。图的规模随足迹缩放。
- **怎么画**：dispatch 一个 sonnet 子代理，**读真实 design.md + architecture.md**（像本视图生成器那样消化内容），用 **baoyu-diagram 原样**画——Read 其 `~/.claude/skills/baoyu-diagram/SKILL.md`（及 `references/` 若有，含架构图布局算法），遵循它的设计系统、**原生深色主题**、自带流程。
- **风格不干预**：不覆盖主题（接受深色图嵌入浅色文档的明暗对比）、不改字体、不加新建/既有配色语义。但**结构正确性必须自检**（见下）——风格归 baoyu，正确性归质量门。
- **★ 配图质量门（强制——baoyu 也会画错，不许交没看过的图）**：每张图内联前，子代理必须**渲染 → 读图 → 逐条核对 → 修到干净**。失败模式 checklist（命中即不合格，改/重画后重渲）：
  1. **箭头穿盒**：连线**绝不**穿过任何盒子内部——只走盒子之间空白；穿不过就改连接点 / 绕行。
  2. **标签压线/断线**：连线标签放线的**上方或旁边**，不得骑在线上把线截断。
  3. **文字溢出/截断**：盒内文字放不下就换行或缩短（**中文字宽 ≈ font-size，别按拉丁估**）。
  4. **重叠**：盒子之间不重叠；**泳道分隔线不得穿过盒子**。
  5. **挤**：内容多就**放大 viewBox**（绝不挤）；内联等比缩小展示、全屏看 1:1。

  自检命令（headless Chrome 截图后 Read 图核对上面 5 条）：
  ```
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --screenshot=/tmp/diagcheck.png --window-size=1600,1300 --force-device-scale-factor=2 "file://<图或临时HTML的绝对路径>"
  ```
  有问题 → 改 / 重画 → 重渲，直到干净，才内联。
- **内联**：自检干净后，SVG 直接内联进 HTML 的图位，套上全屏查看器。
- **落盘约束**：baoyu 子代理若写中间 SVG 文件，必须落在 `{{project_root}}/docs/feat-flows/<flow_id>/`（如 `diagram/` 子目录）内——stage-2 为 `docs_only` write_scope，落此目录外会被引擎拒写（此为 IO 约束，不与「零干预」冲突）。

> baoyu-diagram 经 plugin marketplace（`JimLiu/baoyu-skills`）安装、materialize 进 ~/.claude/skills/；preflight 已检查 SKILL.md。

## 完成判据

- `tech-design.html` 存在、自包含、可在浏览器打开。
- 七个章节齐全；决策台账穷举有后果的决策；正文无时间性叙事。
- 若有架构足迹：架构落位图已内联且套全屏查看器；有端到端链条则数据流图同。**每张图已过配图质量门**（截图自检通过：无箭头穿盒 / 压线断线 / 文字溢出 / 盒子重叠 / 泳道穿盒）。
- Gate 呈现以本文件为开发者主审面。
