[中文](#中文) · [English](#english)

---

## 中文

# ai-flow

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A52.1.5-blue)](https://claude.ai/code)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6)](https://www.typescriptlang.org)

ai-flow 是一个 Claude Code 插件，提供**通用的、数据驱动的 AI 工作流引擎**。你用 `config.json` 定义自己的工作流（阶段数量、完成条件、审批门、写入限制），引擎通过 Claude Code hooks 在机械层面强制执行——AI 无法跳过阶段、无法自行通过审批门。

### 与 feat-flow 的区别

旧的 feat-flow 是**硬编码 8 阶段**的特定开发流程。ai-flow 是**数据驱动引擎**：阶段数量、名称、完成方式、审批逻辑全部来自你的 `config.json`，引擎本身对具体业务流程一无所知。

### 核心概念

**Flow Definition（流程定义）**
存放在项目的 `.ai-flow/{flow-name}/` 目录下。包含：
- `config.json` — 阶段配置（Zod 验证的 schema）
- `stages/` — 每个阶段的 AI 提示词（Markdown）
- `scripts/` — 可选的 Script Validator 脚本
- `preflight.sh` — 可选的启动前环境检查脚本

**Signal（完成信号）**
每个阶段的 AI 提示词中包含一条指令：当该阶段完成时，向 `.ai-flow/{flow-name}/state/signal` 写入任意内容。PreToolUse hook 拦截这次写入，按照该阶段的 Completion Config 处理推进逻辑。

**Completion Config（完成配置）**
每个阶段可选配：
- **Script Validator**：Signal 触发后先运行验证脚本（bash/node/python3）。Exit 0 = 通过，非零 = 失败，AI 被告知原因并需修复后重试。
- **Gate**：Script Validator 通过后（如有）触发人工审批门。AI 停止，等待用户执行 `{flow-name} approve <token>`。

**Gate Token**
Gate 触发时，引擎生成随机 token，仅通过 Claude Code 的 `systemMessage` 显示给用户（不进入 AI 上下文，AI 无法读取）。

### 快速开始

**安装：**

```bash
# 注册插件来源（每台机器一次）
claude plugin marketplace add darian-deng/agent-plugins

# 在项目目录下安装（project 或 local scope）
claude plugin install ai-flow@darian-agent-plugins --scope project
/reload-plugins
```

**在项目中添加 Flow Definition：**

使用内置的 `/ai-flow` slash command 创建或管理流程定义（详见下方 `/ai-flow` 说明）。或者手动创建 `.ai-flow/my-flow/config.json`。

**开始一个工作流实例：**

```
my-flow start 搭建用户登录系统
```

**查看状态：**

```
my-flow status
```

**审批 Gate：**

```
my-flow approve <token>
```

**中止：**

```
my-flow abort
```

中止后所有改动自动保存到 `my-flow/aborted-{timestamp}` 分支。

**从中止分支恢复：**

```
my-flow resume my-flow/aborted-2024-01-15T10-30-00
```

### config.json 格式

```json
{
  "schema_version": "1.0",
  "name": "my-flow",
  "description": "我的自定义工作流",
  "stages": [
    {
      "id": "design",
      "prompt": "stages/design.md",
      "write_scope": "docs_only",
      "docs_paths": ["docs/my-flow/{flow_id}/"],
      "completion": {}
    },
    {
      "id": "implement",
      "prompt": "stages/implement.md",
      "write_scope": "unrestricted",
      "completion": {
        "script": {
          "command": "bash scripts/check-tests.sh",
          "timeout_ms": 30000
        },
        "gate": true
      }
    }
  ]
}
```

**字段说明：**

| 字段 | 说明 |
|------|------|
| `write_scope` | `unrestricted`（任意路径）或 `docs_only`（限制在 `docs_paths`） |
| `docs_paths` | `write_scope` 为 `docs_only` 时必填，支持 `{flow_id}` 模板 |
| `completion.script` | Signal 后运行的验证脚本，exit 0 = 通过 |
| `completion.gate` | 是否需要人工审批后才能推进 |

### 命令参考

所有命令以纯文本形式输入（不是斜杠命令），由 UserPromptSubmit hook 拦截处理。`{flow-name}` 是你的流程目录名。

| 命令 | 说明 |
|------|------|
| `{flow-name} start <需求描述>` | 开始新工作流实例（需要干净的 git 工作区） |
| `{flow-name} approve <token>` | 审批当前 Gate 检查点 |
| `{flow-name} abort` | 终止工作流，改动保存到新 git 分支 |
| `{flow-name} resume <branch>` | 从中止的分支恢复工作流 |
| `{flow-name} status` | 查看当前阶段和 Gate 状态 |
| `{flow-name} help` | 列出项目中所有可用流程及其阶段 |

### /ai-flow slash command

安装插件后，`/ai-flow` slash command 用于管理 Flow Definition：

- 在项目中添加内置的 `feat-flow` 模板（8 阶段软件开发工作流）
- 创建新的自定义 Flow Definition
- 修改现有 Flow Definition 的阶段配置

### 工作原理

ai-flow 使用 Claude Code 的原生 hooks 机制：

- **UserPromptSubmit hook**：识别并路由 `{flow-name} *` 命令。非命令消息会清除挂起的 Gate（让 AI 继续工作）。
- **PreToolUse hook**：拦截对 `.ai-flow/{flow-name}/state/signal` 的写入（Signal），执行 Completion Config。同时保护控制平面文件（config.json、stages/、scripts/、state/active.json、gate-token）不被 AI 修改。对 `docs_only` 阶段强制执行写入路径限制。
- **SessionStart hook**：会话启动时（`source=startup`）从模型名解析 context window 大小并保存到状态，并自动向 AI 注入当前流程状态和阶段提示词。
- **PostToolUse hook**：每次写文件后从 transcript 读取 token 使用量，在 context 超过阈值时向 AI 注入警告。

工作流状态保存在 `.ai-flow/{flow-name}/state/active.json`（已加入 `.gitignore`），随时可以 `/clear` 重开对话，下一个 session 自动接续。

### 安全模型

- **Signal 拦截**：AI 完成一个阶段的唯一方式是向 signal 文件写入内容。写入前，引擎运行 Script Validator（如配置），通过后才推进。
- **Gate 不可绕过**：Gate Token 仅通过 `systemMessage` 传给用户，不进入 AI 上下文。AI 被设计为无法读取 token（PreToolUse hook 拦截对 gate-token 文件的所有 Read 和 Bash 访问）。Token 也不写入任何 AI 可读的日志文件。
- **控制平面只读**：AI 无法通过任何工具修改 config.json、stages/、scripts/、active.json。
- **写入范围限制**：`docs_only` 阶段的 AI 只能向指定路径写文件，防止在文档审查阶段意外修改代码。

### 环境要求

- Claude Code（版本 ≥ 2.1.5），支持 project-scope plugin
- Node.js ≥ 18
- Git（开始工作流时需要干净的工作区）

<!-- prettier-ignore -->
> [!NOTE]
> ai-flow 必须安装在**项目级别**（project scope 或 local scope），不支持
> user scope 全局安装。它管理的是项目级别的工作流状态，不同项目之间
> 的状态互相隔离。

### 许可证

[MIT](../../LICENSE)

---

## English

# ai-flow

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A52.1.5-blue)](https://claude.ai/code)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6)](https://www.typescriptlang.org)

ai-flow is a Claude Code plugin providing a **generic, data-driven AI workflow engine**. You define your own pipeline in `config.json` — number of stages, completion conditions, approval gates, and write restrictions — and the engine enforces it mechanically via Claude Code hooks. AI can't skip stages or self-approve checkpoints.

### Difference from feat-flow

The old feat-flow was a **hardcoded 8-stage** software development workflow. ai-flow is a **data-driven engine**: stage count, names, completion logic, and approval rules all come from your `config.json`. The engine itself knows nothing about your specific domain.

### Core concepts

**Flow Definition**
Lives in `.ai-flow/{flow-name}/` in your project. Contains:
- `config.json` — stage configuration (Zod-validated schema)
- `stages/` — AI prompt files for each stage (Markdown)
- `scripts/` — optional Script Validator scripts
- `preflight.sh` — optional environment preflight script

**Signal**
Each stage prompt includes one instruction: when the stage is done, write anything to `.ai-flow/{flow-name}/state/signal`. The PreToolUse hook intercepts this write and processes the stage's Completion Config.

**Completion Config**
Each stage can optionally configure:
- **Script Validator**: runs a validation script (bash/node/python3) when Signal fires. Exit 0 = pass, non-zero = fail (AI is told why and must fix before retrying).
- **Gate**: after Script Validator passes (if any), triggers a human approval checkpoint. AI halts and waits for `{flow-name} approve <token>`.

**Gate Token**
When a Gate fires, the engine generates a random token delivered only via Claude Code's `systemMessage` — visible to the user, never entering AI's context. AI cannot read it.

### Quick start

**Install:**

```bash
# Register the plugin source (once per machine)
claude plugin marketplace add darian-deng/agent-plugins

# Install in your project (project or local scope)
claude plugin install ai-flow@darian-agent-plugins --scope project
/reload-plugins
```

**Add a Flow Definition to your project:**

Use the built-in `/ai-flow` slash command to create or manage flow definitions. Or manually create `.ai-flow/my-flow/config.json`.

**Start a flow instance:**

```
my-flow start Build user authentication system
```

**Check status:**

```
my-flow status
```

**Approve a gate:**

```
my-flow approve <token>
```

**Abort:**

```
my-flow abort
```

Changes are saved to `my-flow/aborted-{timestamp}` branch automatically.

**Resume from an aborted branch:**

```
my-flow resume my-flow/aborted-2024-01-15T10-30-00
```

### config.json format

```json
{
  "schema_version": "1.0",
  "name": "my-flow",
  "description": "My custom workflow",
  "stages": [
    {
      "id": "design",
      "prompt": "stages/design.md",
      "write_scope": "docs_only",
      "docs_paths": ["docs/my-flow/{flow_id}/"],
      "completion": {}
    },
    {
      "id": "implement",
      "prompt": "stages/implement.md",
      "write_scope": "unrestricted",
      "completion": {
        "script": {
          "command": "bash scripts/check-tests.sh",
          "timeout_ms": 30000
        },
        "gate": true
      }
    }
  ]
}
```

**Field reference:**

| Field | Description |
|-------|-------------|
| `write_scope` | `unrestricted` (any path) or `docs_only` (restricted to `docs_paths`) |
| `docs_paths` | Required when `write_scope` is `docs_only`. Supports `{flow_id}` template |
| `completion.script` | Validation script run after Signal. Exit 0 = pass |
| `completion.gate` | Whether human approval is required before advancing |

### Command reference

All commands are plain text (not slash commands). The UserPromptSubmit hook intercepts and processes them. `{flow-name}` is your flow directory name.

| Command | Description |
|---------|-------------|
| `{flow-name} start <requirement>` | Start a new flow instance (requires clean git working tree) |
| `{flow-name} approve <token>` | Approve the current Gate checkpoint |
| `{flow-name} abort` | Terminate the flow; saves changes to a new git branch |
| `{flow-name} resume <branch>` | Resume a flow from an aborted branch |
| `{flow-name} status` | Show current stage and Gate status |
| `{flow-name} help` | List all available flows in the project and their stages |

### /ai-flow slash command

After installing the plugin, the `/ai-flow` slash command manages Flow Definitions:

- Add the bundled `feat-flow` template (an 8-stage software development workflow)
- Create new custom Flow Definitions
- Modify existing Flow Definitions

### How it works

ai-flow uses Claude Code's native hooks mechanism:

- **UserPromptSubmit hook**: Recognises and routes `{flow-name} *` commands. Non-command messages clear any pending Gate (letting AI continue work).
- **PreToolUse hook**: Intercepts writes to `.ai-flow/{flow-name}/state/signal` (the Signal), executes the Completion Config. Also protects control-plane files (config.json, stages/, scripts/, active.json, gate-token) from AI modification. Enforces `docs_only` write restrictions per stage.
- **SessionStart hook**: On startup (`source=startup`), parses the model name to determine context window size and saves it to state. Injects current flow status and stage prompt into AI context.
- **PostToolUse hook**: After each file write, reads token usage from the session transcript. Injects a context warning into AI context when usage exceeds the configured threshold.

State is stored in `.ai-flow/{flow-name}/state/active.json` (gitignored). You can `/clear` and restart the conversation at any time; the next session picks up where you left off.

### Security model

- **Signal interception**: The only way AI completes a stage is by writing to the signal file. The engine runs the Script Validator (if configured) before advancing.
- **Gate cannot be bypassed**: The gate token is delivered only via `systemMessage` and never enters AI's context. AI is designed to be unable to read the token — the PreToolUse hook blocks all Read and Bash access to the gate-token file. The token is also never written to any AI-readable log.
- **Control plane is read-only**: AI cannot modify config.json, stages/, scripts/, or active.json through any tool.
- **Write scope enforcement**: In `docs_only` stages, AI can only write to designated paths, preventing accidental code changes during documentation or review stages.

### Requirements

- Claude Code (version ≥ 2.1.5) with project-scope plugin support
- Node.js ≥ 18
- Git (clean working tree required to start a flow)

<!-- prettier-ignore -->
> [!NOTE]
> ai-flow must be installed at **project scope** (project or local) — global
> user-scope installation is not supported. It manages per-project workflow
> state, keeping different projects isolated from each other.

### License

[MIT](../../LICENSE)
