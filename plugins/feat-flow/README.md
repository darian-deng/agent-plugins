[中文](#中文) · [English](#english)

---

## 中文

# feat-flow

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A52.1.5-blue)](https://claude.ai/code)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6)](https://www.typescriptlang.org)

feat-flow 是一个 Claude Code 插件，为中大型需求实施提供结构化的 8
阶段 AI 工作流。它通过 Claude Code hooks 在机械层面强制执行流程——AI
无法跳过阶段、无法自行通过审批门，每个关键决策点都需要人工确认。

### 为什么需要 feat-flow

直接让 AI 实现需求往往陷入这样的循环：需求没对齐就写代码，代码写
完了才发现方向错，然后大量返工。feat-flow 把这个过程拆解为有序的阶段，
确保 AI 在动手之前已经充分理解需求、探索了代码库、评估了技术方案、
制定了具体计划。

### 快速开始

以下是一个典型工作流。

**安装（每个项目仅需一次）：**

```bash
claude plugin install feat-flow@darian-agent-plugins --scope project
feat-flow-setup
```

**开始一个新需求：**

```
feat-flow start 搭建用户登录系统
```

feat-flow 会检查环境（git 状态、依赖），初始化工作流，然后引导 AI
进入 Stage 1：需求确认。

**在 Stage 1 审批后，继续推进：**

```
feat-flow approve abc123ef
```

**查看当前状态：**

```
feat-flow status
```

**如需中止：**

```
feat-flow abort
```

所有未提交的改动会被自动保存到一个新的 git 分支，方便后续恢复。

### 工作原理

feat-flow 使用 Claude Code 的原生 hooks 机制，在 AI 行动的前后插入
检查点：

- **UserPromptSubmit hook**：拦截 `feat-flow *` 命令，在 AI 看到消息
  之前运行预检、初始化、令牌验证等逻辑。
- **PostToolUse hook**：在 AI 每次写文件后，检查特定锚点字符串，判断
  当前阶段是否完成，自动推进状态机。
- **PreToolUse hook**：阻止 AI 写入控制平面文件（`.feat-flow/` 和插件
  目录），确保工作流状态只能由 hooks 修改。
- **SessionStart hook**：在会话重启后（包括 `/clear`）自动恢复工作流
  上下文，AI 无需重新告知当前进度。
- **PreCompact hook**：在 Stage 5（代码实施）期间阻止上下文压缩，保
  护实施阶段的完整代码上下文。

工作流状态保存在 `.feat-flow/state.json`，随时可以 `/clear` 重开对话，
下一个 session 会自动接续。

### 8 个阶段

feat-flow 把一个需求拆解为 8 个有序阶段，每个阶段有明确的产出文件
和 hooks 自动检测的完成条件。

| 阶段 | 名称 | 产出 | GATE |
|------|------|------|:----:|
| Stage 1 | 需求确认 | `docs/feat-flows/<id>/design.md`（需求 + 验收标准） | ✅ |
| Stage 2 | 代码探索 | `design.md`（探索摘要 + 影响范围） | — |
| Stage 3 | 方案选型 | `design.md`（方案对比 + 决策记录） | ✅ |
| Stage 4 | 实施计划 | `docs/feat-flows/<id>/plan.md`（任务列表 + AC） | ✅ |
| Stage 5 | 代码实施 | 代码提交（每个任务一个 commit） | — |
| Stage 6 | 全量验证 | `verification/lint.txt` 等 | — |
| Stage 7 | 代码审查 | `docs/feat-flows/<id>/review.md` | ✅ |
| Stage 8 | 知识沉淀 | ADR、rule 更新、经验记录 | — |

标有 ✅ 的阶段完成后会触发人工审批门（GATE），必须通过审批才能进入
下一阶段。

### 命令参考

所有命令以纯文本形式输入（不是斜杠命令），由 UserPromptSubmit hook
拦截处理。

| 命令 | 说明 |
|------|------|
| `feat-flow start <需求描述>` | 开始新工作流（需要干净的 git 工作区） |
| `feat-flow approve <token>` | 审批当前 GATE 检查点 |
| `feat-flow abort` | 终止工作流，改动保存到新 git 分支 |
| `feat-flow resume <branch>` | 从中止的分支恢复工作流 |
| `feat-flow status` | 查看当前阶段、进度和 GATE 状态 |
| `feat-flow help` | 显示使用说明 |

### 人工审批门（GATE）

GATE 是 feat-flow 的核心机制，确保 AI 无法自行推进关键决策点。

当 hooks 检测到某个阶段的完成条件满足时：

1. hooks 生成一个随机令牌，写入 `.feat-flow/gate-token`。
2. 令牌通过 `systemMessage` 显示在 Claude Code 界面——这个消息只有
   人类能看到，**不进入 AI 的上下文**。
3. AI 无法读取令牌文件（PreToolUse hook 阻止 Read 工具访问该文件）。
4. 你检查该阶段的产出，满意后执行：

   ```
   feat-flow approve <token>
   ```

5. UserPromptSubmit hook 验证令牌，推进到下一阶段。

GATE 是非阻断的——在你决定是否审批前，可以继续和 AI 对话，让它完善
输出。如果关闭了通知界面，令牌仍保存在磁盘上：

```bash
! cat .feat-flow/gate-token
```

### 安全模型

feat-flow 的安全性依赖两个机械保证，而不是依赖 AI 的自我约束：

- **写保护**：PreToolUse hook 阻止 AI 通过 Edit、Write 或 Bash 工具
  写入 `.feat-flow/` 和插件目录（`.claude/plugins/feat-flow/`）。AI
  无法修改状态文件或 hooks 脚本。
- **令牌不可见**：Gate token 仅通过 `systemMessage` 显示给用户，从不
  出现在 AI 的上下文中。PreToolUse hook 同时阻止 AI 用 Read 工具读取
  令牌文件。

这两个机制确保：**每个阶段只能由人类有意识地审批后才能推进。**

### 环境要求

- Claude Code（版本 ≥ 2.1.5），支持 project-scope plugin
- Node.js ≥ 18（`npx tsx` 运行 TypeScript hooks）
- Git（开始工作流时需要干净的工作区）

<!-- prettier-ignore -->
> [!NOTE]
> feat-flow 必须安装在**项目级别**（project scope），不支持 user
> scope 全局安装。它管理的是项目级别的工作流状态，不同项目之间
> 的状态互相隔离。

### 许可证

[MIT](../../LICENSE)

---

## English

# feat-flow

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A52.1.5-blue)](https://claude.ai/code)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6)](https://www.typescriptlang.org)

feat-flow is a Claude Code plugin that enforces a structured 8-stage AI
workflow for medium-to-large requirements. It uses Claude Code hooks to
mechanically enforce the process — AI can't skip stages, can't self-approve
checkpoints, and every critical decision requires human confirmation.

### Why feat-flow

Asking AI to implement requirements directly often leads to this pattern:
coding starts before requirements are aligned, architecture decisions get made
implicitly, and large amounts of rework follow. feat-flow breaks the process
into ordered stages, ensuring AI fully understands requirements, explores the
codebase, evaluates technical approaches, and creates a concrete plan before
writing a single line of code.

### Quick start

The following steps show a typical workflow.

**Install (once per project):**

```bash
claude plugin install feat-flow@darian-agent-plugins --scope project
feat-flow-setup
```

**Start a new requirement:**

```
feat-flow start Build user authentication system
```

feat-flow checks the environment (git status, dependencies), initializes the
workflow, and guides AI into Stage 1: requirements gathering.

**Approve a gate and continue:**

```
feat-flow approve abc123ef
```

**Check current status:**

```
feat-flow status
```

**Abort if needed:**

```
feat-flow abort
```

All uncommitted changes are automatically saved to a new git branch, making
recovery straightforward.

### How it works

feat-flow uses Claude Code's native hooks mechanism to insert checkpoints
before and after AI actions:

- **UserPromptSubmit hook**: Intercepts `feat-flow *` commands and runs
  preflight checks, initialization, and token validation before AI sees the
  message.
- **PostToolUse hook**: After every file write, checks for specific anchor
  strings to determine whether the current stage is complete and automatically
  advances the state machine.
- **PreToolUse hook**: Blocks AI from writing to control-plane files
  (`.feat-flow/` and the plugin directory), ensuring workflow state can only be
  modified by hooks.
- **SessionStart hook**: Automatically restores workflow context after a
  session restart (including `/clear`) — AI doesn't need to be re-briefed on
  current progress.
- **PreCompact hook**: Blocks context compaction during Stage 5 (implementation)
  to preserve the complete code context for that stage.

Workflow state is persisted in `.feat-flow/state.json`. You can `/clear` and
restart the conversation at any time, and the next session picks up exactly
where you left off.

### The 8 stages

feat-flow breaks a requirement into 8 ordered stages, each with clear output
files and completion conditions that hooks detect automatically.

| Stage | Name | Output | GATE |
|-------|------|--------|:----:|
| Stage 1 | Requirements | `docs/feat-flows/<id>/design.md` (requirements + ACs) | ✅ |
| Stage 2 | Exploration | `design.md` (exploration summary + impact scope) | — |
| Stage 3 | Architecture | `design.md` (architecture comparison + decisions) | ✅ |
| Stage 4 | Planning | `docs/feat-flows/<id>/plan.md` (task list + ACs) | ✅ |
| Stage 5 | Implementation | Code commits (one per task) | — |
| Stage 6 | Verification | `verification/lint.txt` and related files | — |
| Stage 7 | Code review | `docs/feat-flows/<id>/review.md` | ✅ |
| Stage 8 | Governance | ADRs, rule updates, lessons learned | — |

Stages marked ✅ trigger a human approval gate (GATE) on completion. You must
approve before the workflow advances to the next stage.

### Command reference

All commands are plain text (not slash commands). The UserPromptSubmit hook
intercepts and processes them before they reach AI.

| Command | Description |
|---------|-------------|
| `feat-flow start <requirement>` | Start a new workflow (requires clean git working tree) |
| `feat-flow approve <token>` | Approve the current GATE checkpoint |
| `feat-flow abort` | Terminate the workflow; saves changes to a new git branch |
| `feat-flow resume <branch>` | Resume a workflow from an aborted branch |
| `feat-flow status` | Show current stage, progress, and GATE status |
| `feat-flow help` | Show usage guide |

### Human approval gates (GATE)

GATE is feat-flow's core mechanism for ensuring AI can't advance past critical
decision points on its own.

When hooks detect that a stage's completion conditions are met:

1. Hooks generate a random token and write it to `.feat-flow/gate-token`.
2. The token appears via `systemMessage` in the Claude Code interface — this
   message is visible only to you; **it never enters AI's context**.
3. AI can't read the token file (the PreToolUse hook blocks Read tool access
   to that file).
4. You review the stage output, then when you're satisfied, run:

   ```
   feat-flow approve <token>
   ```

5. The UserPromptSubmit hook validates the token and advances to the next stage.

GATE is non-blocking — you can keep chatting with AI to refine the output
before deciding whether to approve. If the notification dismissed, the token
is still on disk:

```bash
! cat .feat-flow/gate-token
```

### Security model

feat-flow's security relies on two mechanical guarantees rather than AI
self-restraint:

- **Write protection**: The PreToolUse hook blocks AI from writing to
  `.feat-flow/` and the plugin directory (`.claude/plugins/feat-flow/`) via
  Edit, Write, or Bash. AI can't modify state files or hook scripts.
- **Token invisibility**: The gate token only appears via `systemMessage` and
  never enters AI's context. The PreToolUse hook also blocks AI from reading
  the token file with the Read tool.

Together, these guarantees mean: **stages can only advance when a human
consciously approves.**

### Requirements

- Claude Code (version ≥ 2.1.5) with project-scope plugin support
- Node.js ≥ 18 (for running TypeScript hooks via `npx tsx`)
- Git (clean working tree required to start a flow)

<!-- prettier-ignore -->
> [!NOTE]
> feat-flow must be installed at **project scope** — it is not suitable for
> global user-scope installation. It manages per-project workflow state,
> keeping different projects isolated from each other.

### License

[MIT](../../LICENSE)
