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
修改文件后，ESLint 会通过 `textDocument/publishDiagnostics` 协议推送违规信息——
Claude 在下一个 turn 就能看到并修复，减少人工干预。

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

#### 为什么 ESLint 错误无法像原生 TypeScript LSP 那样"同轮注入"？

调研了 Claude Code 二进制内部机制后，存在一条**原生 IDE 诊断注入路径**（通过
`~/.claude/ide/*.lock` 锁文件 + MCP SSE server），理论上可在 AI 写完文件后
立即将诊断注入当前 turn。然而这条路有两个无法回避的硬限制：

1. **触发条件苛刻**：必须配置 `autoConnectIde: true`（写入 `~/.claude/settings.json`）
   或设置 `CLAUDE_CODE_SSE_PORT` 环境变量。普通终端会话默认不启用。
2. **注入时机是下一轮**：即使 IDE MCP server 成功连接，`getDiagnostics` 也是在
   **下一个 query 开始时**调用，而非在当前 turn 的 Write/Edit 工具执行后立即注入。

换句话说，原生路径能让诊断出现在 Turn N+1 的上下文里，但无法真正做到 Turn N 内修复。

#### 这个插件的解法

**双轨机制**——LSP 代理负责 TypeScript 能力，PostToolUse hook 负责同轮 ESLint 修复：

```
Claude Code（stdin/stdout）
    ↕ JSON-RPC
[ts-eslint-proxy.mjs]                     PostToolUse hook（Write/Edit 后触发）
    ├── 子进程：typescript-language-server    └── 调用 eslint-aggregator /lint
    │   转发：go-to-def、hover、references        ↓
    │   拦截：publishDiagnostics             有错误 → 返回 {"decision":"block"}
    └── 直接运行：ESLint（debounce）         Claude 被阻止完成当前 turn
         结果合并发出 publishDiagnostics     必须 Edit 修复后才能继续
         → 下一 turn 的上下文              → 同一 turn 内完成修复 ✓
```

- **TypeScript 能力**：`ts-eslint-proxy.mjs` 代理完整保留
- **ESLint 下一轮上下文**：`publishDiagnostics` 路径，Turn N+1 可见
- **ESLint 同轮修复**：`PostToolUse hook` + `decision: "block"`，Turn N 内强制修复

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

**首次诊断延迟（每次 aggregator 重启后）**：ESLint 规则在第一次 `lintText` 调用时
才完成加载，约耗时 **4–5 秒**。这只发生一次（aggregator 启动后的第一个 Write/Edit
hook 触发时），之后所有调用约 **90ms**。开发者在每次 session 开始后的第一次写文件操作
会感到轻微停顿，这是正常现象。

aggregator 会随 session 启动保持常驻，因此多数情况下启动早已完成、规则已热身，
实际使用中鲜少感知到冷启动。

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

Claude Code has a built-in LSP client. If ESLint runs as an LSP server, it pushes violations via `textDocument/publishDiagnostics` after every file edit — Claude sees the errors in the next turn and can fix them without manual copy-paste.

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

#### Why can't ESLint errors be injected in the same turn like native TypeScript LSP?

We investigated the internal binary mechanism (v2.1.140). There is a native IDE diagnostic injection path — Claude Code can connect to an IDE MCP server via `~/.claude/ide/*.lock` and call `getDiagnostics` after each file edit. However, this path has two hard constraints:

1. **Requires explicit opt-in**: either `"autoConnectIde": true` in `~/.claude/settings.json` or the `CLAUDE_CODE_SSE_PORT` environment variable. Not enabled by default in terminal sessions.
2. **Injection is still next-query, not same-turn**: even when the IDE connection is active, `getDiagnostics` is called at the *start of the next query* — not inside the current write/edit action. So diagnostics appear in Turn N+1 context, not Turn N.

In short: the native path reduces the delay to the next turn but cannot reliably achieve within-turn repair.

#### How this plugin solves it

**Two-track approach** — the LSP proxy handles TypeScript intelligence; a PostToolUse hook handles same-turn ESLint enforcement:

```
Claude Code (stdin/stdout)
    ↕ JSON-RPC
[ts-eslint-proxy.mjs]                     PostToolUse hook (fires after Write/Edit)
    ├── child process: typescript-language-server    └── calls eslint-aggregator /lint
    │   forwards: go-to-def, hover, references            ↓
    │   intercepts: publishDiagnostics            errors found → {"decision":"block"}
    └── runs directly: ESLint (debounced)         Claude cannot finish the turn
         merged publishDiagnostics sent           must Edit to fix before continuing
         → available in next turn context        → repair happens within same turn ✓
```

- **TypeScript intelligence**: fully preserved via `ts-eslint-proxy.mjs`
- **ESLint in next-turn context**: via `publishDiagnostics`, visible in Turn N+1
- **ESLint same-turn enforcement**: via `PostToolUse hook` + `decision: "block"`, forces repair in Turn N

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

**First-diagnostic delay (once per aggregator restart)**: ESLint rule implementations are loaded lazily on the first `lintText` call, taking roughly **4–5 seconds**. This happens once after the aggregator starts. Subsequent hook calls take roughly **90 ms**. You'll notice a brief pause on your first Write or Edit in a fresh session — this is expected and only occurs once.

The aggregator persists across turns within a session, so the warmup cost is paid at most once per session start, and typically once per machine reboot (the `SessionStart` hook keeps the aggregator running).
