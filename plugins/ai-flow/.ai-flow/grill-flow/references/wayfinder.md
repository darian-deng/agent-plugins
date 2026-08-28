# wayfinder 子模式（stage-1 内，处理设计迷雾大的需求）

> ⚠️ **本文件里的 `{{flow_root}}` / `{{project_root}}` 是没展开的字面量**：引擎只替换 stage 提示词里的占位符，references 是你自己 Read 进来的，拿到的就是原文。用之前换成 stage 提示词 `[ai-flow:paths]` 块里的真实绝对路径——⛔ sh 里代入失败会报错，**Write 不会**（会建出字面名的目录，落盘等于没写，且不报错）。
>
> 何时用：需求**设计迷雾大**——一次 grilling 根本聊不出完整 spec，因为背后是一串**互相依赖、现在答不出、要调研/原型才能定的架构级决策**（例：协作编辑先定 OT 还是 CRDT，落盘/离线/权限全悬在它下面）。实现规模大（切几十 ticket）**不算**迷雾大，走普通 grill 即可。

## 触发（不自评，让迷雾浮现后向开发者提议）

普通 grill 广度推进时，若冒出一串互相 `blocked-by`、答不出、要调研/原型才能定的架构决策（经验信号：**≥3 个互相阻塞的决策**），**停下，向开发者提议**："这个需求设计迷雾较大，建议升级 wayfinder 逐个 resolve 决策。" **开发者同意才进入**——触发权在开发者，不是你闷头自评。

## 状态载体：`wayfinder-map.md`

落 `{{project_root}}/docs/grill-flows/<flow_id>/wayfinder-map.md`（docs_paths 内）。顶部一行 **mode marker** 是判断模式的唯一依据（不靠"map 是否存在"）。**格式钉死：文件首行严格写 `mode: <charting|working|clear>`（冒号后一个空格）；四态探测时对读到的值 `trim()` 后比较，容忍前后空白，但值只认这三个之一，其余按"marker 无法识别"处理**：

```
mode: charting | working | clear

# Destination
<一句话终点，固定 scope，每次会话都朝它对齐>

# Decisions
## D1 冲突解决模型
- status: resolved
- blocked-by: -
- 结论: 用 CRDT(Yjs)。依据: research 子代理 + throwaway 原型验证延迟可接受。被否: OT（手动 transform 复杂度高）。
## D2 落盘与转录 pipeline 对接
- status: open
- blocked-by: D1

# Not yet specified (fog)
<还没想清、待 charting 展开的区域>

# Out of scope
<明确不做>
```

每个决策条目 resolve 后必须落 **结论 + 关键依据 + 被否方案一句话**——这是摘要下限，保证雾散后综合 spec 不贫血（别只写一句结论）。

## 两个 mode

**① charting（建图，本会话就停）**：命名 Destination → 广度扇出 grill → 填 Decisions（标 open + blocked-by）/ fog / out-of-scope → 写 `mode: working` 收尾。
- **硬约束（最尖锐的踩坑点，钉死）：charting 模式下绝对禁止 resolve 任何决策。** 只命名、只建图、只标依赖。charting 的唯一出口是把 marker 改成 `working`。（mattpocock：charting the map is one session's work, do not also resolve tickets。）

**② working（逐决策 resolve，每会话一个）**：
1. 读 map，取 frontier = `status:open` 且 `blocked-by` 全部 `resolved` 的决策，挑一个。
2. 用 grilling / research（外部事实起后台子代理）/ prototype（状态机·UI，throwaway、走 Bash 写 repo 外、不 commit，怎么选分支、怎么建见 `prototype.md`）/ **task**（为解锁决策的手动前置：开账号、供权限、搬数据看形状）去 resolve 它。
3. 写回 结论+依据+被否，标 `resolved`；冒出下游决策 append（带 blocked-by）；新迷雾进 fog 段。
4. 一个决策告一段落即可 `/clear`（图在盘上，不必背着整段调查史）。

## 完成判据（相对 Destination，不是"所有决策 resolved"）

**the way is clear**——到 Destination 之前没有还需要决定的事（fog 段清空、frontier 为空）→ 写 `mode: clear`。不必穷尽枚举每个想得到的决策，够走到终点即可。

## 四态重入（/clear 后 stage-1 提示词开头必做的探测）

引擎只把你恢复到"stage-1"，不记你在 wayfinder 里走到哪——全靠读 map 的 marker：

| 探测 | 动作 |
|---|---|
| `wayfinder-map.md` 不存在 | 普通 grill（读 alignment.md 若存在则续） |
| marker `charting` | 继续建图 |
| marker `working` | 读 frontier 续 resolve 下一个决策 |
| marker `clear` | 用整张图综合出 `alignment.md` → 与开发者确认共识 → 过 gate |
| marker 缺失/无法识别 | **停下问开发者，不擅自选模式** |
| 已 clear 后开发者又提新迷雾（gate 前） | 把 marker 翻回 `working`、append 新决策 |

## 出口与写 signal

- 出口：雾散 → 综合 `alignment.md` → gate → **stage-2**（不回头重新 grill；resolve 决策的过程本身就是 grilling）。
- **写 signal 前置（钉死）**：仅当 `mode: clear` 且 alignment.md 已综合、开发者已确认，才允许写 `done`。
- **诚实边界**：若真误写了 signal，引擎会走 gate-pending 分支、**不再重注 stage-1 提示词**，"提示词开头探测"根本跑不到——那时恢复靠：① 开发者拒绝 approve；② 你主动重读盘上的 wayfinder-map.md + 当前 stage-1 提示词续 wayfinder。所以前置条件才是主防线，别指望误写后自动探测兜底。
