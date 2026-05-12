[中文](#中文) · [English](#english)

---

## 中文

# ts-eslint-lsp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A52.1.5-blue)](https://claude.ai/code)
[![ESLint](https://img.shields.io/badge/ESLint-v9%2B-4B32C3)](https://eslint.org)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933)](https://nodejs.org)

将 TypeScript 语言服务与实时 ESLint 诊断合并在同一个 LSP server 里，彻底解决两者无法共存的根本矛盾。

### 为什么需要这个插件

**AI 写代码时最隐蔽的质量盲区**：Claude 不知道自己违反了 ESLint 规则。

每一次 AI coding session 都在重复同一个循环：

```
Claude 写代码 → 你跑 pnpm lint → 你把错误粘回去 → Claude 修复 → 重复
```

Claude Code 有 LSP client 能力。如果 ESLint 作为 LSP server 运行，每次 AI
修改文件后，ESLint 会通过 `textDocument/publishDiagnostics` 协议主动推送违规
信息——Claude 在同一个 turn 就能看到错误并当场修复，无需任何人工干预。

#### 为什么不直接安装 `eslint-lsp` + `typescript-lsp`？

因为 Claude Code 的 LSP 路由存在一个根本性限制，已从 2.1.139 二进制反编译确认：

```javascript
function getServerForFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  const servers = extensionMap.get(ext);
  return servers[0]; // 永远只取第一个，其余静默忽略
}
```

两个插件都声明 `.ts` 扩展名时，只有第一个注册的 server 能收到消息。
无论如何配置，另一个始终被跳过，没有任何报错提示。

#### 这个插件的解法

既然只能有一个 server，就让这一个 server 同时做两件事：

```
Claude Code（stdin/stdout）
    ↕ JSON-RPC
[ts-eslint-proxy.mjs]
    ├── 子进程：typescript-language-server --stdio
    │   转发：所有 TypeScript LSP 请求（go-to-def、hover、references...）
    │   拦截：publishDiagnostics → 存入 diagMap.ts
    └── 直接运行：ESLint（使用项目自己的安装）
         didOpen/didChange 触发（300ms debounce）
         结果 → diagMap.eslint
         任意一方更新 → 合并发出统一 publishDiagnostics → Claude 看到
```

TypeScript 能力完整保留，ESLint 诊断实时推送，Claude 从此同时感知两类问题。

### 前置要求

- Claude Code **≥ 2.1.5**
- Node.js **≥ 18**
- `typescript-language-server` 已安装（在项目 `node_modules/.bin/` 或系统 PATH）
- ESLint **v9+** flat config（`eslint.config.*`）已配置

### 安装

```
/plugin marketplace add darian-deng/agent-plugins
/plugin install ts-eslint-lsp@darian-agent-plugins
```

出现交互菜单后，选择 **Install for you (user scope)** 完成全局安装。

### ⚠️ 必须先禁用 `typescript-lsp@claude-plugins-official`

由于扩展名路由限制，`typescript-lsp@claude-plugins-official` 与 `ts-eslint-lsp`
不能共存——两者都声明了 `.ts`、`.tsx` 等扩展名，只有一个能生效。

**安装后请立即执行：**

```
/plugin disable typescript-lsp
/reload-plugins
```

或在 `.claude/settings.json` 中设置：

```json
{
  "enabledPlugins": {
    "typescript-lsp@claude-plugins-official": false
  }
}
```

同样，如果已安装 `eslint-lsp`，也请禁用它——`ts-eslint-lsp` 已经包含了
ESLint 功能，两者同时开启会导致 ESLint 诊断重复上报。

### 与 `eslint-lsp` 的关系

| 插件 | 提供的能力 | 适用场景 |
|---|---|---|
| `eslint-lsp` | 仅 ESLint 诊断推送 | 不需要 TypeScript 语言功能时 |
| `ts-eslint-lsp` | TypeScript 语言智能 + ESLint 诊断 | TypeScript 项目的标准选择 |

两者都使用项目自己的 ESLint 安装，版本和配置始终与项目保持一致。

### 工作原理

- **Monorepo 支持**：从被编辑文件向上遍历目录，找到最近的 `eslint.config.*`，每个子包使用各自的 ESLint 配置
- **ESLint v9+ flat config**：完整支持
- **降级处理**：`typescript-language-server` 崩溃时，代理继续运行，ESLint 诊断不受影响
- **诊断合并**：TypeScript 类型错误与 ESLint 规则违规合并为一条 `publishDiagnostics`，避免相互覆盖

### 支持的文件类型

`.ts`、`.tsx`、`.js`、`.jsx`、`.mts`、`.cts`、`.mjs`、`.cjs`

### 已知限制

**类型感知规则的冷启动延迟**：如果 ESLint 配置启用了需要 TypeScript 类型信息的规则（如 `@typescript-eslint/no-floating-promises`），首次 lint 需要初始化 TypeScript Program，耗时约 1–3 秒。之后的 lint 使用缓存，速度恢复正常。

---

## English

# ts-eslint-lsp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A52.1.5-blue)](https://claude.ai/code)
[![ESLint](https://img.shields.io/badge/ESLint-v9%2B-4B32C3)](https://eslint.org)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933)](https://nodejs.org)

A single LSP server that proxies `typescript-language-server` for full TypeScript intelligence while simultaneously running ESLint and merging both diagnostic streams into Claude's context.

### Why this exists

**The hidden quality blind spot in AI coding**: Claude doesn't know it's violating ESLint rules.

Every AI coding session repeats the same loop:

```
Claude writes code → you run pnpm lint → you paste errors back → Claude fixes → repeat
```

Claude Code has a built-in LSP client. If ESLint runs as an LSP server, it can push violations via `textDocument/publishDiagnostics` immediately after every file edit — Claude sees the errors in the same turn and fixes them without any manual step.

#### Why not just install `eslint-lsp` + `typescript-lsp`?

Because Claude Code has a fundamental routing constraint, confirmed from the 2.1.139 binary:

```javascript
function getServerForFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  const servers = extensionMap.get(ext);
  return servers[0]; // only the first registered server ever receives messages
}
```

When two plugins declare the same extension (`.ts`), only the first one is active. The second is silently ignored — no error, no warning, just silence.

#### How this plugin solves it

Since only one server can handle an extension, make that one server do both jobs:

```
Claude Code (stdin/stdout)
    ↕ JSON-RPC
[ts-eslint-proxy.mjs]
    ├── child process: typescript-language-server --stdio
    │   forwards: all TypeScript LSP requests (go-to-def, hover, references...)
    │   intercepts: publishDiagnostics → stored in diagMap.ts
    └── runs directly: ESLint (project's own installation)
         triggered on: didOpen / didChange (300ms debounce)
         result → diagMap.eslint
         either side updates → merged publishDiagnostics sent to Claude
```

Full TypeScript intelligence is preserved. ESLint diagnostics are pushed in real time. Claude sees both.

### Prerequisites

- Claude Code **≥ 2.1.5**
- Node.js **≥ 18**
- `typescript-language-server` available in the project's `node_modules/.bin/` or on `$PATH`
- ESLint **v9+** with flat config (`eslint.config.*`) in your project

### Installation

```
/plugin marketplace add darian-deng/agent-plugins
/plugin install ts-eslint-lsp@darian-agent-plugins
```

When the interactive menu appears, select **Install for you (user scope)** for a global install.

### ⚠️ Disable `typescript-lsp@claude-plugins-official` first

Due to the single-server-per-extension routing constraint, `typescript-lsp@claude-plugins-official` and `ts-eslint-lsp` cannot coexist — both declare `.ts`, `.tsx`, and the other JS/TS extensions.

**After installation, run:**

```
/plugin disable typescript-lsp
/reload-plugins
```

Or set it in `.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "typescript-lsp@claude-plugins-official": false
  }
}
```

If you have `eslint-lsp` enabled, disable it too — `ts-eslint-lsp` already includes ESLint, and running both will cause duplicate diagnostics.

### Relationship to `eslint-lsp`

| Plugin | What it provides | When to use |
|---|---|---|
| `eslint-lsp` | ESLint diagnostics only | When you don't need TypeScript language features |
| `ts-eslint-lsp` | TypeScript language intelligence + ESLint diagnostics | The standard choice for TypeScript projects |

Both use the project's own ESLint installation, so your version and config are always respected.

### How it works

- **Monorepo-aware**: walks up from each edited file to find the nearest `eslint.config.*`, so each package uses its own config
- **ESLint v9+ flat config**: fully supported
- **Graceful degradation**: if `typescript-language-server` crashes, the proxy continues running and ESLint diagnostics keep flowing
- **Merged diagnostics**: TypeScript type errors and ESLint rule violations are combined into a single `publishDiagnostics` notification to prevent one from overwriting the other

### Supported file types

`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`

### Known limitations

**Cold-start latency for type-aware rules**: if your ESLint config enables rules that require TypeScript type information (e.g. `@typescript-eslint/no-floating-promises`), the first lint per session takes 1–3 seconds while `@typescript-eslint/parser` initializes a TypeScript Program. Subsequent lints use the cached Program and are fast.
