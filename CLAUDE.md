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

### 三层内容，别搞混

ai-flow 的内容分三层，改之前先认清：
- `src/**` — TS 引擎源码（**改引擎逻辑只动这里**，需 build）
- `dist/**` — 编译产物（CI 生成，**永不手动读写**；要理解引擎逻辑读 `src/`，不要读 `dist/` 或 marketplace 缓存等任何非 source-of-truth 副本——它们可能滞后，照着推理会得出过时的错误结论）
- `.ai-flow/<flow>/**` — flow 定义（stage 提示词 / config.json / references，纯内容、不编译；改提示词只动这里，走 `/ai-flow:update`）

src 访问受阻时，解决访问或询问，**不要退而读 dist/缓存**。

### 两套 build，用途不同

| 命令 | 输出目录 | 用途 | gitignore |
|------|----------|------|-----------|
| `npm run build:local` | `dist-local/` | 本地开发、测试 hook 行为 | ✅ 已忽略 |
| `npm run build` | `dist/` | **仅 CI 使用**，本地执行直接报错 | ✅ 已忽略 |

**本地验证编译**：
```bash
cd plugins/ai-flow
npm run typecheck      # 最快：只做类型检查，不产生文件
npm run build:local    # 需要实际运行 hook 时用，产物在 dist-local/
```

**绝不要在本地跑 `npm run build`**——检测到非 CI 环境会直接报错退出。

`dist/` 只由 CI 生成并 force-commit 到仓库，开发者不需要也不应该管它。

### 发布流程

1. 修改 `src/` 代码
2. 更新版本号（**必须**，否则 `/plugin update` 不会触发更新）：
   - `plugins/ai-flow/package.json` → `"version"`
   - `plugins/ai-flow/.claude-plugin/plugin.json` → `"version"`
   - **不需要手动改** `.claude-plugin/marketplace.json`：CI 从 plugin.json 读版本并自动同步
   - **提交前用 `git diff` 确认两个文件都已改**：版本号必须在 `git add` 之前写入磁盘，否则 staging 拿到的仍是旧版本，CI 也会同步错误版本到 marketplace.json
3. `npm run typecheck` 验证无类型错误（无需 build）
4. 提交 `src/` + 版本号变更（**不提交 dist/ 或 dist-local/**）
5. push 到 main — CI 自动 build、同步 marketplace.json 版本、commit dist/

### CI 行为说明

- `build-ai-flow.yml` 在以下路径变更时触发（其他 plugin 不会触发）：
  `plugins/ai-flow/src/**`、`.ai-flow/**`（stage 文档/flow 配置）、`.claude-plugin/**`、`package.json`、`tsconfig*.json`、`package-lock.json`
- CI **不自动 bump 版本**：版本号由开发者在 package.json + plugin.json 两处设定，CI 照单全收，只同步到 marketplace.json
- `marketplace.json` 中 ai-flow 的版本字段由 CI 维护；eslint-lsp / ts-eslint-lsp 没有 CI 构建，它们的版本字段仍由开发者手动维护
- `marketplace.json` 其余字段（`description`、`tags`、`category`、`homepage`）全部由开发者手动维护，不要让 CI 覆盖

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
