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
| [eslint-lsp](./plugins/eslint-lsp) | 通过 LSP 实时推送 ESLint 诊断，并捆绑 `@eslint/mcp` 支持 AI 主动调用 autofix | ✅ LSP + MCP | ✅ MCP |

### 安装（Claude Code）

所有插件均推荐全局安装（`-g`）——它们设计上就是跨项目通用的工具，
在没有 ESLint 的项目里会自动静默跳过。

```
/plugin marketplace add darian-deng/agent-plugins
/plugin install eslint-lsp@darian-agent-plugins -g
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
| [eslint-lsp](./plugins/eslint-lsp) | Real-time ESLint diagnostics via LSP, bundled with `@eslint/mcp` for AI-callable autofix | ✅ LSP + MCP | ✅ MCP |

### Installation (Claude Code)

Install plugins globally (`-g`) — they're designed to work across all projects
and silently skip projects that don't have ESLint configured.

```
/plugin marketplace add darian-deng/agent-plugins
/plugin install eslint-lsp@darian-agent-plugins -g
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
