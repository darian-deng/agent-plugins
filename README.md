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
| [feat-flow](./plugins/feat-flow) | AI 工作流控制系统：8 阶段结构化开发流程，含人工审批门（GATE）、跨 session 状态持久化、hooks 机械执行保障。适合中大型需求的高质量交付 | ✅ Plugin | ❌ |

### 安装（Claude Code）

**第一步：注册插件来源（每台机器只需一次）**

```
/plugin marketplace add darian-deng/agent-plugins
```

**第二步：安装所需插件**

```
/plugin install eslint-lsp@darian-agent-plugins           # 纯 ESLint
/plugin install ts-eslint-lsp@darian-agent-plugins        # TypeScript + ESLint
/plugin install feat-flow@darian-agent-plugins --scope project  # AI 工作流（必须 project scope）
```

<!-- prettier-ignore -->
> [!NOTE]
> `feat-flow` 必须安装在**项目级别**（`--scope project`），不支持 user
> scope 全局安装，因为它管理的是项目级别的工作流状态。

出现交互菜单后，选择 **Install for you (user scope)** 完成全局安装。
插件在没有 ESLint 配置的项目里会自动跳过。

> ⚠️ 安装 `ts-eslint-lsp` 后，必须先禁用官方的 `typescript-lsp@claude-plugins-official`，否则两者会因扩展名路由冲突导致只有一个生效。详见 [ts-eslint-lsp README](./plugins/ts-eslint-lsp/README.md)。

### 故障排查

**`Plugin "xxx" not found in marketplace "darian-agent-plugins"`**

`/plugin marketplace add` 会把 marketplace 清单克隆到本地，之后 `/plugin install` 只读本地缓存，不自动同步远端更新。遇到这个报错，先刷新一次缓存再重试：

```
/plugin marketplace update darian-agent-plugins
/plugin install <plugin-name>@darian-agent-plugins
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
| [feat-flow](./plugins/feat-flow) | AI workflow control system: 8-stage structured development pipeline with human-approval gates, cross-session state persistence, and mechanically-enforced hooks. Designed for high-quality delivery of medium-to-large requirements | ✅ Plugin | ❌ |

### Installation (Claude Code)

**Step 1: Register the plugin source (once per machine)**

```
/plugin marketplace add darian-deng/agent-plugins
```

**Step 2: Install the plugin you need**

```
/plugin install eslint-lsp@darian-agent-plugins           # ESLint only
/plugin install ts-eslint-lsp@darian-agent-plugins        # TypeScript + ESLint
/plugin install feat-flow@darian-agent-plugins --scope project  # AI workflow (project scope required)
```

For `eslint-lsp` and `ts-eslint-lsp`, when the interactive menu appears,
select **Install for you (user scope)** for a global install. The plugin
silently skips projects without ESLint.

<!-- prettier-ignore -->
> [!NOTE]
> `feat-flow` must be installed at **project scope** (`--scope project`). It
> manages per-project workflow state and is not suitable for global user-scope
> installation.

> ⚠️ After installing `ts-eslint-lsp`, you must disable `typescript-lsp@claude-plugins-official` first — both plugins claim the same file extensions and only one can be active at a time. See the [ts-eslint-lsp README](./plugins/ts-eslint-lsp/README.md) for details.

### Troubleshooting

**`Plugin "xxx" not found in marketplace "darian-agent-plugins"`**

`/plugin marketplace add` clones the marketplace manifest locally. After that, `/plugin install` reads only from the local cache — it does not auto-sync remote updates. If you hit this error, refresh the cache and retry:

```
/plugin marketplace update darian-agent-plugins
/plugin install <plugin-name>@darian-agent-plugins
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
