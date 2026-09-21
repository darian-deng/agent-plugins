[中文](#中文) · [English](#english)

---

## 中文

# ai-flow

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A52.1.5-blue)](https://claude.ai/code)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933)](https://nodejs.org)

ai-flow 是一个 Claude Code 插件，让你为任何项目定义结构化的 AI 工作流。你描述业务流程，AI 帮你设计并生成完整的 flow 定义；安装后，engine 通过 hooks 机械执行流程控制，确保 AI 按阶段推进、无法跳过审批门。

### 快速安装

在终端运行，或在 Claude Code 里加 `!` 前缀执行：

```bash
# 注册插件来源（每台机器一次）
claude plugin marketplace add darian-deng/agent-plugins

# 全局安装（一次安装，所有项目可用）
claude plugin install ai-flow@darian-agent-plugins --scope user
/reload-plugins
```

### 创建工作流

安装后，在 Claude Code 中运行 `/ai-flow:create`，描述你需要什么样的工作流，AI 会帮你设计阶段结构、推荐完成条件和审批门，对齐确认后自动生成所有配置文件。

对于软件功能开发，ai-flow 内置了一套 6 阶段工作流模板（需求确认 → 实施蓝图 → 实施计划 → 代码实施 → 质量门 → 知识沉淀）。运行 `/ai-flow:add` 安装内置模板即可立即使用。

### 运行工作流

Flow 定义生成后，用以下命令操作（将 `{flow-name}` 替换为你的 flow 目录名）：

| 命令 | 说明 |
|------|------|
| `{flow-name} start <需求描述>` | 启动新工作流（需要干净的 git 工作区） |
| `{flow-name} approve <token>` | 审批当前 Gate 检查点 |
| `{flow-name} abort` | 终止工作流，改动保存到新 git 分支 |
| `{flow-name} resume <branch>` | 从中止分支恢复 |
| `{flow-name} status` | 查看当前阶段和 Gate 状态 |
| `{flow-name} help` | 列出项目中所有 flow 及其阶段 |

这些命令以纯文本输入，UserPromptSubmit hook 自动拦截处理。

### 工作原理

flow 的**定义**（`config.json` 的默认值、每个阶段的 AI 提示词 `stages/`、参考资料 `references/`、验证脚本 `scripts/`）随插件版本走，住在插件里。项目里只有两样：`.ai-flow/{flow-name}/config.json`——一个**稀疏覆盖层**，只写要改的键，留空就是全用插件默认；以及 `.ai-flow/{flow-name}/state/` 运行态。

（0.69.0 之前定义会整份复制进项目。实测 7 份安装无一与模板一致、差异 2–25 条，且没有一条是有意定制——全是版本滞后，所以改成了单一来源。旧项目的残留副本由引擎在第一次 SessionStart 自动删除。）

**阶段推进**：每个阶段的提示词末尾都有一条指令——完成后向 `.ai-flow/{flow-name}/state/signal` 写入内容。PreToolUse hook 拦截这次写入，按该阶段的配置决定是否推进。

**Script Validator**：signal 触发后，engine 先运行可选的验证脚本（bash/node/python3）。脚本 exit 0 = 通过，非零 = 失败，AI 收到失败原因后修复再重试。

**Gate**：验证通过后可触发人工审批门。engine 生成随机 token，仅通过系统通知显示给用户——token 不进入 AI 上下文，AI 无法读取。用户用 `{flow-name} approve <token>` 审批后，工作流进入下一阶段。

**状态持久化**：运行状态存储在 `.ai-flow/{flow-name}/state/`（已 gitignore），随时可以 `/clear` 重开对话，下一个 session 自动接续。

**停滞自检（watchdog）**：执行 flow 的 session 停下来之后，如果五分钟内没人来、也没有任何东西会把它叫醒，engine 会让它自己判断一次「这次停下来合不合理」。

- **判定发生在唤醒之前**。模型起一个后台进程，它盯着 flow 状态，**确认停滞才退出**——宿主在它退出时用它的输出唤醒 session。没停滞就一直睡着：不唤醒、不出声、不花 token，开发者什么都看不到。反过来的做法（定时触发再由引擎拦下来）做不到这一点：拦一次就必然在终端留一条警告，而定时器只在会话空闲时触发、错过的那次在回合刚结束时补发，于是绝大多数触发恰好落在「刚停下 0 秒」这个必须拦的时刻。
- **起没起由 engine 核验**，不靠提示词纪律：Stop hook 的输入里带着本 session 每个后台任务的命令行原文，没起就当场让模型补起（一个 session 最多要 3 次）。
- **被唤醒时开发者看得见**：那条唤醒消息就是提醒——它会说明是 watchdog 让 AI 继续的、已静置多久、本 stage 用掉了第几次。
- **每个 stage 最多催 3 次**，开发者一说话或阶段推进就清零。无人值守时这是唯一的上界。
- **只作用于真正在执行的那个 session**：非 owner session、同仓库另一检出的 session、子代理，一律不参与。等 approve、有别的后台任务在跑、回合还没结束，都不算停滞。
- **关掉**：`config.json` 里 `"watchdog": { "enabled": false }`，或环境变量 `AI_FLOW_WATCHDOG=0`；`"idle_minutes"` 改阈值（默认 5）。
- **有没有生效是看得见的**：`{flow-name} status` 会报「已武装 / 未武装」以及本 stage 已催几次。沉默既可能是「一切正常」也可能是「它死了」，这一行是唯一能分辨的地方。

### 安全保障

ai-flow 通过两项机械保证确保 AI 无法绕过流程控制：

- **Signal 是唯一出口**：AI 完成阶段的唯一方式是写入 signal 文件。写入前 engine 运行 Script Validator，通过后才推进；若配置了 Gate，token 只通过系统通知传给用户，AI 不可见、无法自行通过。
- **控制平面只读**：PreToolUse hook 阻止 AI 修改 `config.json`、`stages/`、`scripts/` 以及运行时状态文件，确保流程定义和引擎状态只能由 engine 自身变更。

### 环境要求

- **Node.js ≥ 18 — 唯一的普适前置**：引擎（hooks / 安装 CLI / preflight）全部基于 Node，跨平台（含 Windows），不依赖 shell 或 Python。缺失时 `/ai-flow:add` 会在入口给出明确提示。
- Claude Code（版本 ≥ 2.1.5）
- **按 flow 声明的依赖**：具体 flow 可能需要额外工具——例如 feat-flow 需要 Git（开始工作流时需要干净的工作区）。这类依赖由各 flow 的 preflight 在启动时检查并给出安装指引，不是插件级的普适要求。

### 安装位置（含 monorepo）

可装在 git 仓库根，也可装在 monorepo 的某个子项目根——`.ai-flow` 装在哪，该 flow 的锚点就在哪。引擎按 session 绑定定位 flow，运行中可自由 `cd` 到任意目录。`/ai-flow:add` 会探测项目根候选让你选；若子项目装在已有外层 `.ai-flow` 之下，会提示「就近锚定、屏蔽外层 flow」（项目隔离的预期行为）。

### 许可证

[MIT](../../LICENSE)

---

## English

# ai-flow

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A52.1.5-blue)](https://claude.ai/code)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933)](https://nodejs.org)

ai-flow is a Claude Code plugin that lets you define structured AI workflows
for any project. Describe your process, and AI designs and generates a
complete flow definition. Once installed, the engine enforces the workflow
mechanically via hooks — AI can't skip stages or self-approve checkpoints.

### Quick install

Run in your terminal, or prefix with `!` inside Claude Code:

```bash
# Register the plugin source (once per machine)
claude plugin marketplace add darian-deng/agent-plugins

# Global install — works across all your projects
claude plugin install ai-flow@darian-agent-plugins --scope user
/reload-plugins
```

### Creating a workflow

After installing, run `/ai-flow:create` in Claude Code and describe the
workflow you need. AI will think through the stage structure, recommend
completion conditions and approval gates, and generate all configuration files
once you confirm the design.

For software feature development, ai-flow ships with a built-in 6-stage
workflow template: requirements → blueprint → planning → implementation →
quality gate → governance. Run `/ai-flow:add` and choose to install the
built-in template to get started immediately.

### Running a workflow

Once a flow is defined, use the following commands (replace `{flow-name}` with
your flow directory name):

| Command | Description |
|---------|-------------|
| `{flow-name} start <requirement>` | Start a new workflow (requires clean git working tree) |
| `{flow-name} approve <token>` | Approve the current Gate checkpoint |
| `{flow-name} abort` | Terminate the workflow; saves changes to a new git branch |
| `{flow-name} resume <branch>` | Resume from an aborted branch |
| `{flow-name} status` | Show current stage and Gate status |
| `{flow-name} help` | List all flows in the project and their stages |

Type these commands as plain text in Claude Code — the UserPromptSubmit hook
intercepts and processes them automatically.

### How it works

A flow's DEFINITION — default `config.json`, per-stage AI prompts (`stages/`),
references and validation scripts — ships with the plugin and travels with its
version. Your project keeps only `.ai-flow/{flow-name}/config.json`, a SPARSE
override layer that may be empty, and `.ai-flow/{flow-name}/state/` for runtime
state. (Before 0.69.0 the definition was copied into each project; across seven
measured installs not one matched the template and none of the differences were
intentional, so it became a single source. Leftover copies are removed
automatically on the first SessionStart.)

**Stage advancement**: Every stage prompt ends with one instruction — when
the stage is done, write anything to `.ai-flow/{flow-name}/state/signal`. The
PreToolUse hook intercepts this write and decides whether to advance based on
that stage's configuration.

**Script Validator**: After a signal fires, the engine runs an optional
validation script (bash, Node.js, or Python). Exit 0 means the stage passes;
any other exit code fails, and AI receives the reason and must fix it before
retrying.

**Gate**: After validation passes, an optional human approval checkpoint fires.
The engine generates a random token delivered only via system notification —
the token never enters AI's context and AI can't read it. Once you run
`{flow-name} approve <token>`, the workflow advances.

**State persistence**: Runtime state lives in `.ai-flow/{flow-name}/state/`
(gitignored). You can `/clear` and restart at any time; the next session picks
up exactly where you left off.

**Stall watchdog**: When the session driving a flow stops, and five minutes pass
with nobody returning and nothing scheduled to wake it, the engine has it check
once whether stopping was the right move.

- **The decision happens before the wake.** The model starts a background process
  that watches the flow state and **exits only once a stall is confirmed**; the host
  wakes the session with that process's output. While nothing is wrong it just keeps
  sleeping: no wake, no output, no tokens, nothing for you to read. The inverse
  design — fire on a timer, then have the engine discard the ones that were
  pointless — cannot do this: discarding a prompt always renders a warning, and a
  scheduled task fires only while the session is idle, with a missed fire delivered
  the instant a turn ends, so almost every fire lands exactly where it has to be
  discarded.
- **The engine verifies it is running**, rather than trusting a prompt: `Stop` hook
  input carries each background task's command line, so a missing watcher is asked
  for again (at most three times per session).
- **You see it when it fires.** The wake-up message says the watchdog is why work
  resumed, how long the session sat idle, and which of the stage's nudges this was.
- **At most three nudges per stage**, reset by any developer prompt and by every
  stage advance. Unattended, that cap is the only bound there is.
- **Only the session actually executing the flow** takes part — never a non-owner
  session, a session in another checkout, or a subagent. A pending gate, other
  background work in flight, and a turn still running all count as "not stalled".
- **Turning it off**: `"watchdog": { "enabled": false }` in `config.json`, or
  `AI_FLOW_WATCHDOG=0`. `"idle_minutes"` changes the threshold (default 5).
- **Whether it is armed is visible**: `{flow-name} status` reports armed / not armed
  and how much of the stage's budget is spent. Silence means either "nothing wrong"
  or "it died", and that line is the only place the two are distinguishable.

### Security

ai-flow provides two mechanical guarantees that prevent AI from bypassing
workflow controls:

- **Signal is the only exit**: The only way AI completes a stage is by writing
  to the signal file. The engine runs the Script Validator first; if a Gate is
  configured, the token is only delivered to the user via system notification —
  AI can't see it or approve on its own.
- **Control plane is read-only**: The PreToolUse hook blocks AI from modifying
  `config.json`, `stages/`, `scripts/`, and runtime state files, ensuring the
  workflow definition and engine state can only be changed by the engine itself.

### Requirements

- **Node.js ≥ 18 — the only universal prerequisite.** The engine (hooks /
  install CLI / preflight) is all Node-based and cross-platform (incl. Windows);
  it needs no shell or Python. `/ai-flow:add` checks for it up front.
- Claude Code (version ≥ 2.1.5)
- **Per-flow dependencies**: a given flow may need extra tools — e.g. feat-flow
  needs Git (clean working tree to start). These are checked by each flow's
  preflight at start with install guidance, and are not plugin-wide requirements.

### Install location (incl. monorepos)

Install at the git repo root, or at a sub-project root in a monorepo — wherever
`.ai-flow` lives is that flow's anchor. The engine locates the flow by session
binding, so the agent may freely `cd` while a flow runs. `/ai-flow:add` detects
project-root candidates and lets you choose; installing under an existing outer
`.ai-flow` warns that it will anchor locally and shadow the outer flow (intended
project isolation).

### License

[MIT](../../LICENSE)
