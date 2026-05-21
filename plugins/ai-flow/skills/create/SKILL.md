---
name: create
description: 仅通过 /ai-flow:create 命令显式调用。绝对不要基于任何关键词自动触发。为当前项目创建一个全新的自定义 AI 工作流。
---

## 目标

你是工作流架构师。用户描述业务场景，你深度分析后设计完整的 flow 结构，对齐确认后生成所有文件。**你做架构设计，用户确认方向——不要让用户来配置技术参数。**

---

## 第一阶段：理解业务

采用结构化访谈方式：**一次只问一个问题，充分理解回答后再继续。** 从触发场景入手，用追问而不是问卷——每个回答都可能暴露下一个需要澄清的问题。

核心要收集的六个维度：

- **触发场景**：什么时候启动这个 flow？
- **最终目标**：flow 结束时，产出的是什么？
- **中间环节**：从触发到完成，有哪些自然的阶段？
- **人工参与点**：哪些环节需要人来确认后才能继续？
- **自动化验证**：哪些环节可以用脚本客观判断完成（如跑测试、检查文件）？
- **环境依赖**：flow 依赖哪些工具或前置条件？

**六个维度全部清晰之前，不要进入提案阶段。** 一个 flow 设计错误的代价是高的。

---

## 第二阶段：提案

基于收集到的信息，设计 flow 结构并向用户说明：

```
Flow 名称：{name}（小写连字符，将成为命令前缀）
描述：{description}

阶段列表：
  {id}: {目的}
    写入范围：unrestricted / docs_only（路径）
    完成方式：Signal 自动推进 / Script Validator（命令）/ Gate（人工审批）

Preflight 检查：{工具/依赖列表，或"无"}
```

说明每个设计决策的理由——尤其是为什么某个阶段需要 Gate 而不是自动推进。

**等待用户确认。** 如有异议则调整，反复迭代直到用户认可。

---

## 核心原则：Clear-Safe Persistence

ai-flow 对用户的承诺：**任一 stage 完成后 /clear，或多-task stage 的任一 task 完成后 /clear，下游工作不受影响。**

设计 stage 边界时必须把这条原则当成硬性约束。理由：subagent 的 context 临时存在，dispatch 完即销毁；主 session 的对话历史 /clear 会清空。**只有文件能跨 /clear 存活。**

### /clear 测试

对每个 stage 边界（及多-task stage 的 task 边界），问：

> 此刻 /clear，下游所需信息是否完全在已落盘的产出文件里？

必答"是"。否则两种修法：把缺失信息补到产出文件，或重新设计 stage 边界。

### 常见违反模式

❌ **错误**：Stage A 用 code-explorer subagent 探索代码，返回 200 行详细报告，主 session 综合后只写 30 行摘要到 design.md → /clear 后 Stage B 拿不到细节，要么走样、要么重做探索

✅ **正确**：让 code-explorer 直接产出结构化报告到 `docs/.../exploration-report.md`，design.md 只引用关键路径 → /clear 后 Stage B 可读两份文件

❌ **错误**：多-task stage 的 task N 实施时发现新信息，写在主 session 对话里没进 task 产出 → Task N+1 /clear 后丢失发现

✅ **正确**：task 产出必须含「本 task 期间新发现」section，写入对应产出文件（如 plan.md task 行下挂注）

### Stage 拆分决策三问

判断「某项工作是否值得独立成 stage」时三问：

1. **产出能否完整落盘？** 不能 → 不能拆，必须并入相邻 stage
2. **是否依赖前一 stage 之外的额外探索？** 是 → 倾向拆（独立 stage 有自己干净的探索）；否 → 倾向合（避免重复探索）
3. **Gate 审批对象是否与前一 stage 不同？** 是 → 倾向拆（gate 聚焦）；否 → 倾向合

三问都偏"拆" → 拆；任一偏"合" → 合。

---

## 第二点五阶段：全局连贯性校验

用户确认提案后，**在生成任何文件之前**，先做一次内部推演，发现问题则告知用户共同决定，没有问题则静默通过：

1. **Stage 衔接**：每个 stage 的输出是否就是下一个 stage 的输入？有没有信息断层（stage N 产出 A，但 stage N+1 需要 B，而没有 stage 负责生成 B）？
2. **write_scope 一致性**：`docs_only` 的 stage，它的 stage prompt 要求写入的所有文件路径是否都在 `docs_paths` 范围内？
3. **Gate 合理性**：每个 Gate 的位置——人类审批的是什么内容？基于什么做判断？有没有遗漏关键审批点，或多余的 Gate 拖慢流程？
4. **边界情况**：某 stage 产出为空时，下游 stage 能否优雅处理？用户中途修改上一 stage 产出，当前 flow 设计是否能应对？

---

## 第三阶段：生成文件

用户确认后，生成以下文件：

### `.ai-flow/{flow-name}/config.json`

Schema 约束：
- `schema_version`: `"1.0"`
- stage `id`: 只能包含小写字母、数字、连字符
- `write_scope` 为 `docs_only` 时 `docs_paths` 必填且非空
- `stages` 数组至少有一个元素

### `.ai-flow/{flow-name}/stages/{id}.md`

每个 stage prompt 必须符合 `optimize-stage-prompt` 规范（本插件同名 skill）。使用以下固定结构：

```markdown
# Stage N：{阶段名}

> {flow-name} 第 N/M 步 · [流程总览](../helper.md)
> 后续：Stage N+1（{名} · Gate / 无 Gate）— 末步时改为「本 stage 是流程末步」
> 当前 stage 目的：{一句话}
>
> **元规则**：{commit 政策——如「禁止 git commit。改动用 git add 暂存」或「本 stage 允许 commit，message 格式: <prefix>: <subject>」}

## 目标
{1-3 句话，说明此阶段产出什么、为什么}

## 前置读取
{仅当此 stage 依赖前序阶段产物时添加}
- `路径` — 用途说明

## 步骤
{bullet list，不用散文段落}

## 输出规格
{三选一：}
{文件 → `路径` — 格式说明}
{      验证：`cat 路径` 应返回非空内容}
{git commits → Git commits，格式: `feat: <task>`}
{无输出 → 无文件产出}

## 完成条件
{可客观检验的状态——不能是「AI 认为完成时」}

## Signal
**触发条件**：本阶段「完成条件」全部满足，**或**用户明确表达本阶段已完成。
**动作**：用 Write 工具向 `.ai-flow/{flow-name}/state/signal` 写入任意内容（Bash 写入会被引擎拒绝，必须用 Write）。
```

单个 stage 文件 token 目标 ≤ 800（约 600 字）。

#### 多 Task Stage 的拆解指南

若 stage 含多个独立 task（如「逐 task 实施代码」），stage prompt 必须要求 AI **维护一个 task 列表文件**（约定俗成是 `plan.md`），每个 task 含 AC（可验收条件），完成一个就把 `[ ]` 改为 `[x]`。

这样设计的目的是让 task 进度跨 /clear 存活——AI 重新进入 stage 时通过读文件恢复进度，不依赖主 session 对话历史。

Task 粒度建议 **2-5 分钟 AI 工作量**——太粗 → subagent 出错风险高且归因困难；太细 → 协调成本爆炸。

#### 用户反对意见处理协议（含 Gate 的 stage 通用）

stage prompt 中应包含此协议，避免 AI 在用户提异议时反射性接受。可复用模板：

```
用户对 AI 产出有异议时不允许反射性接受。按下列流程：

步骤 1：识别异议类型
- A. 用户指出 AI 没考虑到的事实约束
- B. 用户给不同偏好但没说理由
- C. 用户的反对与 design.md 已有决策冲突
- D. 用户的反对推翻了前置 stage 已对齐的结论

步骤 2：严谨评估
- A → 接受，并检查 design.md 是否需要同步更新
- B → 不接受。要求用户给真实考量（如时间约束 / 历史经验 / 已知风险）。「感觉更好」类无信息量回应不接受
- C → 与用户逐项过现有决策。改前置决策必须先更新 design.md 含新理由
- D → 同 C

步骤 3：上游影响检查
任何被驳回的 AI 结论 → 完成本 stage 修订前必须检查 design.md 是否需更新
不允许出现「本 stage 产物反映新决策，design.md 还停留旧决策」的分裂状态
```

根据 stage 性质裁剪文案，但 4 步框架保留。

### `.ai-flow/{flow-name}/helper.md`

内容：
- 这个 flow 是什么、解决什么问题（2-3 句话）
- 命令速查（start / approve / abort / resume / status / help）
- 阶段列表：id、名称、完成方式
- 产出文件路径汇总
- 环境要求

### `.ai-flow/{flow-name}/preflight.sh`（如有依赖检测需求）

- chmod +x
- 检测失败时打印清晰错误信息后 exit 1
- 全部通过时 exit 0
- 只检测，不安装

脚本的工作目录（cwd）是 `.ai-flow/{flow-name}/`。如需在项目根目录执行命令，要先切换：
```sh
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT" || exit 1
```

### `.ai-flow/{flow-name}/scripts/`（如有 Script Validator）

为每个用到 Script Validator 的 stage 生成对应脚本。exit 0 = 验证通过，exit 非零并打印失败原因 = 失败。

### `.gitignore`

确保项目根目录包含 `.ai-flow/*/state/`。

---

## 完成

告知用户：
- Flow 已创建，列出生成的文件
- 启动方式：`{flow-name} start <描述>`
- 查看详情：`{flow-name} help`
