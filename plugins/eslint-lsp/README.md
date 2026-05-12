[中文](#中文) · [English](#english)

---

## 中文

# eslint-lsp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A52.1.5-blue)](https://claude.ai/code)
[![ESLint](https://img.shields.io/badge/ESLint-v9%2B-4B32C3)](https://eslint.org)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933)](https://nodejs.org)

一个 ~130 行的 Node.js LSP server，让 Claude Code 获得和 IDE 一样的
实时 ESLint 感知能力。不依赖任何第三方语言服务器包，直接使用你项目自己
的 ESLint 安装。

### 为什么存在这个插件

人类在 IDE 里写代码时，ESLint 作为 Language Server 在后台运行。每次
文件内容变更，它通过 LSP 的 `textDocument/publishDiagnostics` 协议把
违规信息推送给编辑器——你的红波浪线就是这样来的，延迟在毫秒级。

Claude Code 虽然有 LSP client 能力，但没有 ESLint 语言服务器——它
依赖的 `vscode-langservers-extracted` 包已于 2024 年 5 月停止维护，
且与 ESLint v10（2026 年 1 月起移除 `FlatESLint` 类）彻底不兼容。

**结果**：AI 写代码时不知道自己违反了 ESLint 规则，只有你手动跑
`lint` 才能发现，AI 再返工修复——每个 session 都在重复这个循环。

这个插件用一个自研的最小化 LSP server 补上这条链路：

```
Claude 编辑文件
  → LSP server 收到 textDocument/didChange
  → 对文件内容调用 ESLint.lintText()（300ms debounce）
  → 把违规通过 textDocument/publishDiagnostics 推送给 Claude
  → Claude 在同一个 turn 里看到错误并立即修复
```

同时捆绑了 **`@eslint/mcp`**（ESLint 官方 MCP server），安装插件后
自动注册。Claude 可以主动调用它来执行 `eslint --fix` 级别的机械修复。

### 前置要求

- Claude Code **≥ 2.1.5**
- Node.js **≥ 18**
- 项目中已安装 ESLint **v9+**，且使用 flat config（`eslint.config.*`）
- `eslint` 包在项目的 `node_modules` 中（server 使用你项目自己的 ESLint）

### 安装

推荐全局安装（`-g`）。这个插件是跨项目的基础设施——在没有 ESLint
配置的项目里会自动静默跳过，不会有任何干扰。

```
/plugin marketplace add darian-deng/agent-plugins
/plugin install eslint-lsp@darian-agent-plugins -g
```

安装完成后，当前及未来所有 Claude Code session 自动获得：

- **ESLint LSP**：写代码时实时推送诊断
- **`@eslint/mcp`**：Claude 可随时主动调用 `eslint --fix`

### 工作原理

#### LSP server（`src/eslint-server.mjs`）

实现了诊断所需的 LSP 最小子集：

| LSP 消息 | 行为 |
|---------|------|
| `textDocument/didOpen` | 调度 lint（300ms debounce） |
| `textDocument/didChange` | 调度 lint（300ms debounce） |
| `textDocument/didClose` | 清除该文件的诊断 |
| `textDocument/publishDiagnostics` | 把 ESLint 结果推送给 Claude |

Server 通过 `createRequire(pkgRoot + '/package.json')` 从**你的项目**
加载 ESLint，而不是捆绑特定版本。这意味着你的 ESLint 版本和所有自定
义规则都会被正确加载。

#### `@eslint/mcp`（MCP server）

通过 `.mcp.json` 自动注册。两者分工明确：

- **LSP server**：被动感知（push-based），每次文件变更自动触发
- **`@eslint/mcp`**：主动修复（pull-based），Claude 按需调用

#### Config 热更新

修改 `eslint.config.*` 后，server 通过 `fs.watch` 检测变更，自动
清除 ESLint 实例缓存。下次 lint 时重新加载最新配置，无需重启。

#### Monorepo 支持

Server 从被编辑文件的位置向上遍历目录树，找到最近的 `eslint.config.*`
作为该包的配置根目录。每个包使用自己的 ESLint 配置，无需额外设置。

### 支持的配置文件

所有 ESLint v9+ flat config 文件名（来自 ESLint 源码硬编码列表）：

```
eslint.config.js    eslint.config.ts
eslint.config.mjs   eslint.config.mts
eslint.config.cjs   eslint.config.cts
```

不支持 `.eslintrc.*` 系列（ESLint v9+ 已移除）。

### Cursor 支持

Cursor 的 plugin 系统不支持 LSP server 注册（Cursor 通过 VS Code 扩展
生态处理 LSP，人类开发者安装 vscode-eslint 扩展即可）。但 Cursor 的
plugin 系统支持 MCP server，因此捆绑的 `@eslint/mcp` 在 Cursor 中
同样生效。

| 能力 | Claude Code | Cursor |
|------|:-----------:|:------:|
| 实时诊断推送（LSP） | ✅ | ❌（由 vscode-eslint 扩展处理） |
| AI 主动调用 ESLint（MCP） | ✅ | ✅ |

### 已知限制

**类型感知规则的冷启动延迟**

如果你的 ESLint 配置启用了需要 TypeScript 类型信息的规则（如
`@typescript-eslint/no-floating-promises`），首次 lint 需要
`@typescript-eslint/parser` 初始化 TypeScript Program，耗时约 1–3
秒。之后的 lint 使用缓存的 Program，耗时降至 100–300ms。

这是 `@typescript-eslint/parser` 的结构性成本，与具体 LSP server 实现
无关。

**多文件重构中的中间态问题**

Claude 在重构多个文件时，编辑顺序会导致某些文件处于中间态，触发
短暂的误报（false positive）。绝大多数规则是单文件确定性的，不受影响；
跨文件规则（如跨模块 import 限制）在中间态时可能误报。

在项目的 `CLAUDE.md` 中加入以下说明，可以帮助 Claude 正确判断：

```markdown
当进行多文件重构时，ESLint 诊断可能在中间态出现误报。
如果你计划在后续步骤中更新触发错误的源文件，继续执行
重构计划——诊断会在所有文件更新完成后自然消除。
```

### 贡献

欢迎提交 issue 和 PR。Server 的核心逻辑在
`src/eslint-server.mjs`，LSP 配置在 `.lsp.json`，MCP 配置在
`.mcp.json`。

---

## English

# eslint-lsp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A52.1.5-blue)](https://claude.ai/code)
[![ESLint](https://img.shields.io/badge/ESLint-v9%2B-4B32C3)](https://eslint.org)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933)](https://nodejs.org)

A ~130-line Node.js LSP server that gives Claude Code the same real-time
ESLint awareness as your IDE. No third-party language server packages — it
uses your project's own ESLint installation.

### Why this exists

When you write code in an IDE, ESLint runs as a Language Server in the
background. Every time file content changes, it pushes violations to your
editor via the LSP `textDocument/publishDiagnostics` protocol — that's where
the red squiggles come from, with millisecond latency.

Claude Code has an LSP client, but no ESLint language server. The commonly
used `vscode-langservers-extracted` package stopped receiving updates in May
2024 and is fundamentally broken with ESLint v10 (which removed the
`FlatESLint` class in January 2026).

**The result**: when Claude writes code, it doesn't know it's violating your
ESLint rules until you manually run `lint`. You report the errors. Claude
fixes them. Every session, every time.

This plugin closes that gap with a minimal, self-contained LSP server:

```
Claude edits a file
  → LSP server receives textDocument/didChange
  → Calls ESLint.lintText() on the new content (300ms debounce)
  → Pushes violations via textDocument/publishDiagnostics
  → Claude sees the error in the same turn and fixes it immediately
```

Also bundled: **`@eslint/mcp`** (ESLint's official MCP server), registered
automatically on install. Claude can call it on demand to apply mechanical
`eslint --fix` transformations.

### Requirements

- Claude Code **≥ 2.1.5**
- Node.js **≥ 18**
- ESLint **v9+** with flat config (`eslint.config.*`) in your project
- The `eslint` package must be in your project's `node_modules` (the server
  loads your project's ESLint, not a bundled copy)

### Installation

Install globally (`-g`). This plugin is cross-project infrastructure — it
silently skips projects without an ESLint config and never interferes.

```
/plugin marketplace add darian-deng/agent-plugins
/plugin install eslint-lsp@darian-agent-plugins -g
```

After installation, every Claude Code session automatically has:

- **ESLint LSP**: real-time diagnostic push while Claude writes code
- **`@eslint/mcp`**: Claude can call `eslint --fix` on demand at any time

### How it works

#### LSP server (`src/eslint-server.mjs`)

Implements the minimal LSP subset needed for diagnostics:

| LSP message | Action |
|-------------|--------|
| `textDocument/didOpen` | Schedule lint (300ms debounce) |
| `textDocument/didChange` | Schedule lint (300ms debounce) |
| `textDocument/didClose` | Clear diagnostics for the file |
| `textDocument/publishDiagnostics` | Push ESLint results to Claude |

The server loads ESLint from **your project's `node_modules`** using
`createRequire(pkgRoot + '/package.json')`, not a pinned bundled version.
Your ESLint version, flat config, and custom rules are all respected.

#### `@eslint/mcp` (MCP server)

Registered automatically via `.mcp.json`. The two components have distinct
responsibilities:

- **LSP server**: passive detection (push-based), fires automatically after
  each file change
- **`@eslint/mcp`**: active remediation (pull-based), Claude calls it when
  it wants to apply a fix

#### Config hot-reload

When you modify `eslint.config.*`, the server detects the change via
`fs.watch` and evicts the cached ESLint instance. The next lint
automatically picks up your updated configuration — no restart needed.

#### Monorepo support

The server walks up the directory tree from each edited file to find the
nearest `eslint.config.*` as that package's config root. Each package uses
its own ESLint configuration with no extra setup.

### Supported config files

All ESLint v9+ flat config filenames (from ESLint's source-level hardcoded
list):

```
eslint.config.js    eslint.config.ts
eslint.config.mjs   eslint.config.mts
eslint.config.cjs   eslint.config.cts
```

Legacy `.eslintrc.*` files are not supported — ESLint v9+ removed them.

### Cursor support

Cursor's plugin system doesn't support LSP server registration (Cursor
handles LSP through the VS Code extension ecosystem; human developers install
the `vscode-eslint` extension). However, Cursor's plugin system does support
MCP servers, so the bundled `@eslint/mcp` works there.

| Capability | Claude Code | Cursor |
|------------|:-----------:|:------:|
| Real-time diagnostics (LSP) | ✅ | ❌ (handled by vscode-eslint extension) |
| AI-callable ESLint fix (MCP) | ✅ | ✅ |

### Known limitations

**Cold-start latency for type-aware rules**

If your ESLint config enables rules that require TypeScript type information
(for example, `@typescript-eslint/no-floating-promises`), the first lint per
session takes 1–3 seconds while `@typescript-eslint/parser` initializes a
TypeScript Program. Subsequent lints use the cached Program and take
100–300ms.

This is a structural cost of `@typescript-eslint/parser`, not specific to
this server.

**Intermediate state during multi-file refactors**

When Claude refactors multiple files in sequence, some files pass through an
intermediate state that can trigger brief false positives. Most rules are
single-file deterministic and aren't affected; cross-file rules (for example,
rules that check cross-module import boundaries) may produce false positives
mid-refactor.

Adding a note to your project's `CLAUDE.md` helps Claude reason about this
correctly:

```markdown
When doing multi-file refactors, ESLint diagnostics may show false positives
on intermediate states. If you plan to update the file that's triggering the
error in a later step, continue the refactor — the diagnostic will clear
when all files are updated.
```

### Contributing

Issues and PRs are welcome. The server's core logic is in
`src/eslint-server.mjs`, LSP registration is in `.lsp.json`, and MCP
registration is in `.mcp.json`.
