# agent-plugins — Claude Code 开发说明

## 仓库结构

```
plugins/
  eslint-lsp/       # 纯 ESLint LSP server（无编译步骤）
  ts-eslint-lsp/    # TypeScript LSP 代理（无编译步骤）
  feat-flow/        # AI 工作流控制系统（TypeScript，需编译）
```

## feat-flow 开发规范

### 修改 TypeScript 源码后必须重新构建

feat-flow 的 hooks 运行时依赖 `dist/` 下的预编译 JS 文件（`node dist/hooks/xxx.js`）。
**每次修改 `src/` 下的任何文件后，必须运行 build 并把 `dist/` 一起提交。**

```bash
cd plugins/feat-flow
npm run build          # 编译 src/ → dist/
cd ../..
git add plugins/feat-flow/dist/
git commit -m "..."
```

### 为什么要提交 dist/

Claude Code 执行插件 hooks 时 PATH 受限，`npx tsx` 不可靠。
hooks.json 使用 `node dist/hooks/xxx.js`，`node` 在任何 Node.js 环境都在 PATH 里。
`dist/` 通过 GitHub Actions 自动构建并 force-commit 到 main branch。

### 发布流程

1. 修改 `src/` 代码
2. `npm run build` 验证无编译错误
3. 提交 `src/` + `dist/` 变更
4. push 到 main — CI 会重新验证 build 并更新 dist/

### plugin.json 字段说明

`minClaudeCodeVersion` 不是合法字段（`claude plugin validate` 会报错），不要加。

## marketplace 更新说明

`/plugin marketplace add` 会把 manifest 克隆到本地缓存。
修改 `.claude-plugin/marketplace.json` 并 push 后，用户需要执行：

```
/plugin marketplace update darian-agent-plugins
```

才能拉取最新 manifest。
