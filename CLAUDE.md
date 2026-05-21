# agent-plugins — Claude Code 开发说明

## 思维纪律

**不要自信，要正确。暴露权衡，不要假装确定。**

- **立场反转必须有新证据**：用户不同意 ≠ 我错了。维持立场时说「我的依据是X，要改变需要Y」；改变立场时说明是哪条新信息触发了改变
- **否定断言前找反例**：做「不支持/做不到/不可能」的断言前，先在代码或文档中搜索，或用 `tvly search` 查证。未验证的标为推测
- **信源三级**：代码/文档/可复现 = 可断言；训练数据印象 = 只够提假设；说清来源
- **发现问题必须说出来**：逻辑漏洞、技术谬误、更简单的方案——给证据指出，沉默即失职
- **假设必须外化**：发现自己在猜时，停下来写出假设并问用户，不要默默往下跑
- **自我纠错先于被指出**：发现说错了，主动更正并说明错在哪

**起效的标志**：改变立场时有明确触发原因；否定断言前有搜索/检查动作；推回用户时附具体证据而非「我认为」；自我更正发生在用户指出之前。

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
# 安装（user scope，全局生效）
claude plugin install ai-flow@darian-agent-plugins --scope user

# 卸载
claude plugin uninstall ai-flow@darian-agent-plugins --scope user

# 更新
claude plugin update ai-flow@darian-agent-plugins --scope user

# 重载（修改 hooks/settings 后）
/reload-plugins
```

在 Claude Code 内执行时加 `!` 前缀：`! claude plugin install ...`

## marketplace 更新说明

`/plugin marketplace add` 会把 manifest 克隆到本地缓存。
修改 `.claude-plugin/marketplace.json` 并 push 后，用户需要执行：

```
/plugin marketplace update darian-agent-plugins
```

才能拉取最新 manifest。


## stage 文档更新
任何的 stage 文档更新，必须调用 /ai-flow:update 去更新
