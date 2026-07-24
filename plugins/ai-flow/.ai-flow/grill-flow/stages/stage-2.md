# Stage 2：spec + tickets（散文规格 + 切片）

> grill-flow 第 2/5 步 · [流程总览](../helper.md)
> 当前 stage 目的：从 alignment.md 综合散文 spec + 对抗审查 + HTML 方案视图 + tracer-bullet 切片。一段连续思考（grill→spec→tickets 一个 context window）。
>
> **元规则**：禁止 git commit（stage-3 起点统一提交）。

## 前置读取

- `{{project_root}}/docs/grill-flows/<flow_id>/alignment.md` — 综合 spec 的唯一来源
- `{{flow_root}}/references/adr-scan.md`（用项目术语、尊重既有 ADR）
- `{{flow_root}}/references/spec-view.md` — HTML 方案视图契约
- `{{flow_root}}/references/revision-protocol.md`

## 步骤

**重入子产物级探测**（stage-2 密度高，逐产物续跑防重跑/覆盖）：spec.md 无 / `## Testing Decisions` 空 → 从 alignment 综合 spec；spec 全但 `## 方案审查` 空 → 派方案审查；spec+审查全但 HTML 缺 → 生成 HTML；前三者全但 tickets 缺 → 切 tickets；全在 → 去 gate。

1. **散文 spec**（照 to-spec，从 alignment 综合）→ `spec.md`，段标题**建议用这些字面量**（机器门按 `## <标题>` 前缀匹配、容忍后缀，但用纯字面量最稳）：`## Problem` / `## Solution` / `## User Stories` / `## Decisions` / `## Testing Decisions` / `## Out of scope` / `## 方案审查`（User Stories 用编号列表；Testing Decisions 写 seam）。**禁文件路径与 typed 代码**；例外：prototype 产出的、比散文更精确的 snippet（状态机/reducer/schema/type shape）可 inline；**接口契约用散文**（描述行为契约，非签名）。
2. **seam 与开发者确认**：在探索代码库、选最高现有 seam 之后提，写进 `## Testing Decisions`。
3. **对抗性方案审查**（gate 前必跑）：派独立子代理在方案层挑**新引入决策**的复用缺失/过度工程/方案漏洞——**只审本次新增，不重议 grilling 已定方案**。findings 写进 `## 方案审查` 段带 resolved 状态；**即使无阻塞项也必须写该段**（记「已审查，无阻塞项」）——机器门要求此段非空。
4. **HTML 方案视图**：照 `spec-view.md`（sonnet 子代理手写 .mmd→mmdc 渲 SVG→主 session 增量组装）→ `tech-design.html`。
5. **切 tickets**（照 to-tickets）→ `tickets.md`：tracer-bullet 垂直切片，每片穿透各层、可独立验证/commit。**prefactor 前置**（要改处先重构才好改 → 排第一个 ticket）；wide-refactor 用 expand→分批迁移→contract。每条 **ticket 级** `- [ ] T<n> <标题>` + `delivers:` + `Blocked by:`（ticket 内 acceptance criteria 用 `AC:` 前缀子项，不参与 frontier/门）。
6. **quiz 粒度**：切完 quiz 开发者、粒度/blocking 确认。

## 输出规格

文件 → `docs/grill-flows/<flow_id>/` 下 `spec.md` + `tickets.md` + `tech-design.html`（+ `diagram/*.svg`）。`<flow_id>` 一律用 context 顶部注入的实际值，勿自拼日期或加后缀（机器门读 active.json 的真实 flow_id 定位文件，路径不符会失配）。
验证：机器门 `scripts/gate-stage-2.cjs` 校验三文件存在 + spec 三段非空 + ticket 格式。

## 完成条件

- spec.md 含非空 `## Testing Decisions` / `## User Stories` / `## 方案审查`；seam 已与开发者确认。
- tech-design.html 生成、可打开。
- tickets.md 每条 ticket 级项有 `Blocked by`；粒度已 quiz 确认。

## Signal

**触发条件**：完成条件全满足，**或**开发者明确表示本阶段完成。
**动作**：用 Write 工具向 `{{flow_root}}/state/signal` 写入 `done`。引擎先跑机器门（`gate-stage-2.cjs`），通过后进人工 gate 等 approve。
