[中文](#中文) · [English](#english)

---

## 中文

# agent-plugins

一套为 Claude Code（及 Cursor）设计的 AI 编程插件集合，致力于把人类
开发者在 IDE 里习以为常的实时反馈环，带给 AI 编程 session。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A52.1.5-blue)](https://claude.ai/code)
[![ESLint](https://img.shields.io/badge/ESLint-v9%2B-4B32C3)](https://eslint.org)

### 可用插件

| 插件 | 功能描述 | Claude Code | Cursor |
|------|---------|:-----------:|:------:|
| [eslint-lsp](./plugins/eslint-lsp) | 纯 ESLint LSP server：实时推送诊断，捆绑 `@eslint/mcp` 支持 AI 主动 autofix。适合不需要 TypeScript 语言智能的场景 | ✅ LSP + MCP | ✅ MCP |
| [ts-eslint-lsp](./plugins/ts-eslint-lsp) | TypeScript LSP 代理 + ESLint 诊断二合一：完整保留 go-to-def / hover / references 等 TypeScript 能力，同时实时推送 ESLint 违规。TypeScript 项目的首选 | ✅ LSP | ✅ — |
| [ai-flow](./plugins/ai-flow) | 通用数据驱动 AI 工作流引擎：用 `config.json` 定义任意阶段流程，含人工审批门（GATE）、Script Validator、跨 session 状态持久化、hooks 机械执行保障。适合需要结构化 AI 工作流的场景 | ✅ Plugin | ❌ |

### 安装（Claude Code）

以下所有命令在终端直接运行，或在 Claude Code 里加 `!` 前缀执行（如 `! claude plugin install ...`）。

**第一步：注册插件来源（每台机器只需一次）**

```bash
claude plugin marketplace add darian-deng/agent-plugins
```

**第二步：安装所需插件**

```bash
# eslint-lsp / ts-eslint-lsp：全局安装（user scope），在所有项目生效
claude plugin install eslint-lsp@darian-agent-plugins --scope user
claude plugin install ts-eslint-lsp@darian-agent-plugins --scope user

# ai-flow：必须指定 project 或 local scope（见下方说明）
claude plugin install ai-flow@darian-agent-plugins --scope project  # 团队共用
claude plugin install ai-flow@darian-agent-plugins --scope local    # 个人使用
```

> ⚠️ 安装 `ts-eslint-lsp` 后，必须先禁用官方的 `typescript-lsp@claude-plugins-official`，否则两者会因扩展名路由冲突导致只有一个生效。详见 [ts-eslint-lsp README](./plugins/ts-eslint-lsp/README.md)。

**更新 / 卸载**

```bash
# 更新（需指定安装时的 scope）
claude plugin update ai-flow@darian-agent-plugins --scope project
claude plugin update ai-flow@darian-agent-plugins --scope local

# 卸载（需指定安装时的 scope）
claude plugin uninstall ai-flow@darian-agent-plugins --scope project
claude plugin uninstall ai-flow@darian-agent-plugins --scope local
```

**安装完成后重载**

```
/reload-plugins
```

---

### ai-flow 的 scope 选择

ai-flow 管理的是**项目级工作流状态**（阶段进度、审批记录、分支快照），因此它的很多行为需要针对不同项目分别配置，**不支持 user scope（全局安装）**。

| Scope | 适用场景 | 配置文件 |
|-------|---------|---------|
| `project` | 团队协作，所有成员共用同一套工作流配置 | `.claude/settings.json`（提交到 git） |
| `local` | 个人使用，不影响其他协作者 | `.claude/settings.local.json`（gitignore） |

### 故障排查

**`Plugin "xxx" not found in marketplace "darian-agent-plugins"`**

`marketplace add` 会把 manifest 克隆到本地缓存，之后 install 只读缓存，不自动同步远端更新。遇到此报错，先刷新缓存：

```bash
claude plugin marketplace update darian-agent-plugins
claude plugin install <plugin-name>@darian-agent-plugins --scope <scope>
```

### 设计理念

人类用 IDE 写代码时，ESLint 的错误在毫秒内出现——不是等你手动跑
`lint`，也不是等 pre-commit hook 触发。这个反馈环让开发者在写代码的
同时就能修正错误，而不是事后返工。

Claude Code 等 AI 编程工具缺少这条链路：AI 写完代码，你才能运行
lint，才能发现问题，才能让 AI 修复——每一次 AI coding session 都在
重复这个循环。

这个仓库里的插件，目的只有一个：把这条反馈环还给 AI。

### 贡献

欢迎 PR。每个插件在 `plugins/<name>/` 下有独立的 README，包含详细的
设计文档和技术说明。

### 许可证

[MIT](LICENSE)

---

## English

# agent-plugins

A collection of plugins for Claude Code (and Cursor) that bring real-time
feedback loops to AI coding sessions — the same loops human developers rely
on in their IDEs.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A52.1.5-blue)](https://claude.ai/code)
[![ESLint](https://img.shields.io/badge/ESLint-v9%2B-4B32C3)](https://eslint.org)

### Available plugins

| Plugin | Description | Claude Code | Cursor |
|--------|-------------|:-----------:|:------:|
| [eslint-lsp](./plugins/eslint-lsp) | Standalone ESLint LSP server: real-time push diagnostics, bundled with `@eslint/mcp` for AI-callable autofix. Use when you don't need TypeScript language intelligence | ✅ LSP + MCP | ✅ MCP |
| [ts-eslint-lsp](./plugins/ts-eslint-lsp) | TypeScript LSP proxy + ESLint diagnostics in one server: preserves full TypeScript intelligence (go-to-def, hover, references) while simultaneously pushing ESLint violations. The standard choice for TypeScript projects | ✅ LSP | ✅ — |
| [ai-flow](./plugins/ai-flow) | Generic data-driven AI workflow engine: define any stage pipeline via `config.json`, with human-approval gates, Script Validators, cross-session state persistence, and mechanically-enforced hooks | ✅ Plugin | ❌ |

### Installation (Claude Code)

Run the following commands in your terminal, or prefix them with `!` inside Claude Code (e.g. `! claude plugin install ...`).

**Step 1: Register the plugin source (once per machine)**

```bash
claude plugin marketplace add darian-deng/agent-plugins
```

**Step 2: Install the plugin you need**

```bash
# eslint-lsp / ts-eslint-lsp: global install (user scope), active across all projects
claude plugin install eslint-lsp@darian-agent-plugins --scope user
claude plugin install ts-eslint-lsp@darian-agent-plugins --scope user

# ai-flow: must use project or local scope (see below)
claude plugin install ai-flow@darian-agent-plugins --scope project  # team use
claude plugin install ai-flow@darian-agent-plugins --scope local    # personal use
```

> ⚠️ After installing `ts-eslint-lsp`, you must disable `typescript-lsp@claude-plugins-official` — both claim the same file extensions and only one can be active at a time. See the [ts-eslint-lsp README](./plugins/ts-eslint-lsp/README.md) for details.

**Update / Uninstall**

```bash
# Update (specify the scope used at install time)
claude plugin update ai-flow@darian-agent-plugins --scope project
claude plugin update ai-flow@darian-agent-plugins --scope local

# Uninstall (specify the scope used at install time)
claude plugin uninstall ai-flow@darian-agent-plugins --scope project
claude plugin uninstall ai-flow@darian-agent-plugins --scope local
```

**Reload after install**

```
/reload-plugins
```

---

### ai-flow scope selection

ai-flow manages **per-project workflow state** — stage progress, approval records, branch snapshots. Because its behavior is intentionally project-specific, **user scope (global install) is not supported**.

| Scope | When to use | Config file |
|-------|------------|-------------|
| `project` | Team use — all collaborators share the same workflow config | `.claude/settings.json` (committed to git) |
| `local` | Personal use — does not affect other collaborators | `.claude/settings.local.json` (gitignored) |

### Troubleshooting

**`Plugin "xxx" not found in marketplace "darian-agent-plugins"`**

`marketplace add` clones the manifest locally. After that, `install` reads only from the local cache and does not auto-sync remote updates. If you hit this error, refresh the cache first:

```bash
claude plugin marketplace update darian-agent-plugins
claude plugin install <plugin-name>@darian-agent-plugins --scope <scope>
```

### Design philosophy

When humans write code in an IDE, ESLint errors appear in milliseconds — not
after a manual `lint` run, not after a pre-commit hook. That tight feedback
loop means you correct mistakes as you write, not in a separate cleanup pass.

AI coding tools like Claude Code don't have this loop: you wait for the AI
to finish writing, then run lint, then ask the AI to fix the violations —
every session, every time.

The plugins in this repository exist to close that gap.

### Contributing

PRs are welcome. Each plugin lives in `plugins/<name>/` with its own README
covering design rationale and technical details.

### License

[MIT](LICENSE)
