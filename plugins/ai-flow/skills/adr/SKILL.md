---
name: adr
description: 仅通过 /ai-flow:adr 命令显式调用。绝对不要基于任何关键词自动触发。管理项目的 Architecture Decision Records (ADR)：新建、supersede、索引、列出、搜索、bootstrap 初始化。
---

## 目标

管理项目 ADR 体系，确保结构一致 + 编号正确 + 双向链接完整 + 索引可信。AI 只负责**内容**（决策的 why / what / consequences），skill 流程负责**结构和元数据**（编号、模板、索引、supersede 链接）。

---

## 第一步：识别用户意图（路由）

用户调用 `/ai-flow:adr` 后通常会用自然语言描述意图。先识别意图属于哪一类，再走对应流程：

| 用户说 | 路由到 |
|--------|-------|
| "新加 ADR" / "记一下这个决策" / "我刚做了 X 决策" | **new** |
| "ADR-N 已经过时了" / "用新决策替代旧的" / "supersede" | **supersede** |
| "项目还没 ADR" / "初始化" / "bootstrap" | **bootstrap** |
| "重建索引" / "ADR 列表乱了" / "更新 README" | **index** |
| "查一下提过 X 的 ADR" / "搜索" / "grep" | **grep** |
| "列出 ADR" / "ADR 列表" / "有哪些 ADR" | **list** |
| 意图模糊 / 多义 | **clarify**（反问） |

详细路由规则见 `references/routing.md`，包含边界情况和优先级。

**关键纪律**：意图不清就反问，不要猜。多猜一次错一次的代价高于多问一次。

---

## 第二步：检查前置条件

| 路由 | 必须先检查 |
|------|-----------|
| new / supersede / index / list / grep | `docs/adr/` 目录存在？不存在 → 提示用户先调 bootstrap |
| bootstrap | `docs/adr/` 已存在？已存在 → 提示用户改用 index 重建 |

`docs/adr/` 路径**默认是仓库根目录下**。如项目是 monorepo 且改动只涉及某子目录，应使用该子目录的 `docs/adr/`（与改动所在目录的最深公共祖先一致）。

---

## 第三步：执行对应子能力

每个子能力的详细步骤见 `references/operations.md`。下面是简要工作流：

### new（创建新 ADR）

1. 扫 `docs/adr/` 找最大编号 → 分配 `NNNN+1`（四位数零填充，如 `0007`）
2. 从用户描述中提炼：
   - **Title**（简短，5-8 个英文词或对应中文）
   - **Context**（为什么需要这个决策——背景、问题、约束）
   - **Decision**（选择是什么，具体到方案 / pattern / 库 / 接口形状）
   - **Consequences**（带来的后果，含 positive + negative + neutral）
   - **Alternatives Considered**（考虑过的其他方案 + 为什么没选）
3. 读 `templates/adr-nygard.md` 模板 → 填入上面字段
4. 写文件到 `docs/adr/NNNN-<title-slug>.md`（slug = title 转 kebab-case，仅 a-z/0-9/dash）
5. **自动执行 index 子能力重建索引**

### supersede（用新 ADR 替代旧 ADR）

1. 识别旧 ADR 编号（用户说"ADR-12"或"上次的 IndexedDB 决策"——若是后者，调用 grep 子能力定位）
2. 读旧 ADR 文件确认存在 + 当前 status
3. 走 new 流程创建新 ADR，但模板中：
   - 在 title 下方加 `**Supersedes**: ADR-NNNN(old) — <one-line-reason>`
4. 修改旧 ADR header：把 `Status: Accepted`（或当前状态）改为 `Status: Superseded by ADR-NNNN(new)`
5. **自动执行 index 子能力重建索引**

### index（重建索引）

1. 扫描 `docs/adr/*.md` 所有 ADR 文件
2. 解析每个文件 header 提取：编号 / Title / Status / Date / Supersedes / Superseded by
3. 读 `references/index-format.md` 拿到表格格式规范
4. 重写 `docs/adr/README.md` 的索引表（按编号升序）
5. 保留 README.md 头部说明文字（不要覆盖整个文件）

### list（按状态列出）

1. 解析 `docs/adr/README.md` 索引表（最快）或扫 `docs/adr/*.md`
2. 按 status 过滤（默认全部；用户说"已弃用的"等过滤）
3. 返回简短列表：`ADR-NNNN <Title> [Status]`

### grep（搜索 ADR）

1. 用 `grep -l "<term>" docs/adr/*.md` 找命中文件
2. 对每个命中文件，用 `grep -B 1 -A 2 "<term>"` 取上下文片段
3. 返回：命中条目 + 编号 + Title + 片段

### bootstrap（项目从零初始化）

1. 创建 `docs/adr/` 目录
2. 读 `templates/readme-template.md` → 写入 `docs/adr/README.md`（含使用说明 + 空索引表）
3. 读 `templates/meta-adr.md` → 写入 `docs/adr/0000-record-architecture-decisions.md`（meta ADR：why we use ADRs）
4. 提示用户：「ADR 体系已初始化。后续新决策可用 `/ai-flow:adr` 添加。」

### clarify（意图反问）

当用户描述意图含糊（如 "ADR 那个事"、"刚才那个决策"、单纯说 "/ai-flow:adr"）：

明确反问，给具体选项：

```
请明确意图：
1. 新加 ADR 记录一个决策
2. 用新决策替代旧 ADR（supersede）
3. 列出现有 ADR
4. 搜索 ADR 内容
5. 重建 ADR 索引
6. 项目首次初始化 ADR 体系（bootstrap）
```

---

## 第四步：写文件前的硬性纪律

- **编号唯一**：分配新编号前必须扫描现有文件，不允许编号冲突
- **slug 规范**：title 转 kebab-case 时仅保留 `a-z0-9-`，其他字符全删
- **不覆盖既有 ADR 内容**：除非是 supersede 流程修改 Status 行
- **README.md 索引保留头部说明**：只重写「索引表」段落，不覆盖整个文件
- **跨调用一致性**：每个写操作后立即执行 index 子能力同步索引——不要积累批量操作

---

## 第五步：完成后的报告

每次完成操作必须告诉用户：

- 做了什么操作（new/supersede/index/list/grep/bootstrap）
- 涉及哪些文件（具体路径）
- 是否更新了索引

不要长篇汇报，简洁告知即可。

---

## 关于本 skill 的边界

**本 skill 做的事**：
- ADR 文件的创建、修改、索引、查询
- 结构正确性（编号、模板、链接、表格）

**本 skill 不做的事**：
- **判断「应不应该写 ADR」**——那是 feat-flow2 Stage 6 的职责（三闸门 + comment vs ADR placement）。本 skill 假设调用方已经决定要写
- **判断「这个决策有没有 trade-off」**——同上
- **跨 ADR 的语义冲突检测**——本 skill 只检查 supersede 显式声明，不主动 grep 找隐性矛盾（那个 cost-benefit 失衡）

**当被作为 feat-flow2 Stage 6 子组件调用时**：调用方已经过过滤，传给本 skill 的请求是「确定要做的操作」，本 skill 只负责机械执行 + 保结构正确。
