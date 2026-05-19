# 创建自定义 Flow

用户有一个需要 AI 分阶段完成的业务流程。你的工作是深度理解这个流程，设计出合理的 flow 结构，和用户对齐后生成完整配置。

**核心原则**：你做架构设计，用户确认方向。不要问"stage id 叫什么"，而是先问清楚业务，再由你来推导技术结构。

---

## 第一阶段：理解业务流程

请用户描述他们的流程，重点了解：

- **触发场景**：什么时候启动这个 flow？
- **最终目标**：flow 结束时，产出的是什么？
- **中间环节**：从触发到完成，中间有哪些自然的阶段或步骤？
- **人工参与点**：哪些环节需要人来确认/审批才能继续？
- **自动化验证**：哪些环节可以用脚本客观判断"是否完成"？（如跑测试、检查文件存在、调 API）
- **环境依赖**：flow 依赖哪些工具或前置条件？

如果描述不够清晰，继续追问。不要基于假设推进——一个 flow 设计错误的代价是很高的。

**不够清晰的信号**：不知道边界在哪、阶段之间的关系模糊、不清楚哪些需要人工介入。遇到这些信号就继续问，直到你能自信地描述出完整的流程为止。

---

## 第二阶段：设计并提案

基于收集到的信息，设计 flow 结构并向用户说明：

**展示格式：**

```
Flow 名称：{name}
描述：{description}

阶段列表：
  {stage-id}: {目的}
    - 写入范围：{unrestricted / docs_only: 路径}
    - 完成方式：{Script Validator 命令 / Gate（人工审批）/ 自动推进}

Preflight 检查：{列出需要的工具/依赖，或"无"}
```

说明每个设计决策背后的理由，尤其是：
- 为什么这个阶段需要 Gate（而不是自动推进）
- Script Validator 在检查什么
- write_scope 限制的原因

等待用户确认。如果用户有异议，调整设计后再次提案。反复迭代，直到用户明确认可。

---

## 第三阶段：生成文件

用户确认后，生成以下文件：

### config.json

路径：`.ai-flow/{flow-name}/config.json`

schema 约束（必须满足）：
- `schema_version`: `"1.0"`
- stage `id`: 只能包含小写字母、数字、连字符
- `write_scope` 为 `docs_only` 时 `docs_paths` 必填且非空
- `script.command` 不能为空字符串
- `stages` 数组至少有一个元素

### stages/{id}.md

每个 stage prompt 文件必须包含：
1. 清晰描述这个阶段 AI 应该做什么、产出什么
2. 产出规范（文件路径、格式要求、质量标准）
3. **末尾必须是这一行**（替换 `{flow-name}` 为实际名称）：
   ```
   完成本阶段所有产出后，向 `.ai-flow/{flow-name}/state/signal` 写入任意内容。
   ```

### helper.md

路径：`.ai-flow/{flow-name}/helper.md`

内容：
- 这个 flow 是什么、解决什么问题（2-3 句话）
- 命令速查表（start / approve / abort / resume / status）
- 阶段列表：id、名称、Gate/无
- 产出文件路径汇总
- 环境要求

### preflight.sh（如有依赖检测需求）

路径：`.ai-flow/{flow-name}/preflight.sh`（chmod +x）

- 检测缺失项时打印清晰错误信息后 exit 1
- 所有检测通过时 exit 0
- 不安装任何东西，只检测

### scripts/（如有 Script Validator）

为每个用到 Script Validator 的 stage 生成对应脚本。脚本必须：
- exit 0 表示验证通过
- exit 非零并打印失败原因表示验证失败

**重要**：脚本的工作目录（cwd）是 `.ai-flow/{flow-name}/`，而不是项目根目录。如果脚本需要在项目根目录执行命令（如 `npm test`、`npx eslint`），需要先切换目录：
```sh
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT" || exit 1
npm test
```

### .gitignore

确保项目根目录 `.gitignore` 包含 `.ai-flow/*/state/`。

---

## 完成

告诉用户：
- Flow 已创建，文件列表
- 启动方式：`{flow-name} start <触发条件描述>`
- 提示 preflight 会在首次 start 时运行
