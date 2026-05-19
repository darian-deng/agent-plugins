# agent-plugins — Claude Code 开发说明

## 仓库结构

```
plugins/
  eslint-lsp/       # 纯 ESLint LSP server（无编译步骤）
  ts-eslint-lsp/    # TypeScript LSP 代理（无编译步骤）
  ai-flow/          # AI 工作流控制系统（TypeScript，需编译）
```

## ai-flow 开发规范

### dist/ 由 CI 生成，不提交到仓库

`plugins/ai-flow/dist/` 已加入 `.gitignore`。本地开发时 build 仅用于验证，不需要提交 `dist/`。
Push 到 main 后，GitHub Actions (`build-ai-flow.yml`) 自动编译并 force-commit `dist/` 到 main。

```bash
cd plugins/ai-flow
npm run build   # 本地验证编译无误即可，不用 git add dist/
```

### 发布流程

1. 修改 `src/` 代码
2. 更新版本号（**必须**，否则 `/plugin update` 不会触发更新）：
   - `plugins/ai-flow/package.json` → `"version"`
   - `plugins/ai-flow/.claude-plugin/plugin.json` → `"version"`
   - `.claude-plugin/marketplace.json` → ai-flow 条目的 `"version"`
3. `npm run build` 验证无编译错误
4. 提交 `src/` + 版本号变更（**不提交 dist/**）
5. push 到 main — CI 自动 build 并 commit dist/

### plugin.json 字段说明

`minClaudeCodeVersion` 不是合法字段（`claude plugin validate` 会报错），不要加。

## plugin 生命周期命令（完整）

所有命令在 Claude Code 里加 `!` 前缀直接跑 CLI，或用 `/plugin` 交互菜单：

```bash
# 安装（--scope 缺省为 user，ai-flow 必须指定 project 或 local）
claude plugin install ai-flow@darian-agent-plugins --scope project
claude plugin install ai-flow@darian-agent-plugins --scope local

# 卸载（需和安装时的 scope 一致）
claude plugin uninstall ai-flow@darian-agent-plugins --scope project
claude plugin uninstall ai-flow@darian-agent-plugins --scope local

# 更新
claude plugin update ai-flow@darian-agent-plugins --scope project
claude plugin update ai-flow@darian-agent-plugins --scope local

# 重载（修改 hooks/settings 后）
/reload-plugins
```

在 Claude Code 内执行时加 `!` 前缀：`! claude plugin install ...`

scope 说明：
- `user`   → `~/.claude/settings.json`，全局生效，**ai-flow 不支持**
- `project` → `.claude/settings.json`，随 git 共享给团队
- `local`  → `.claude/settings.local.json`，gitignored，仅本人在此 repo 生效

## marketplace 更新说明

`/plugin marketplace add` 会把 manifest 克隆到本地缓存。
修改 `.claude-plugin/marketplace.json` 并 push 后，用户需要执行：

```
/plugin marketplace update darian-agent-plugins
```

才能拉取最新 manifest。
