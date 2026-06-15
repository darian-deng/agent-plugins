---
name: add
description: 仅通过 /ai-flow:add 命令显式调用。绝对不要基于任何关键词自动触发。把 ai-flow 插件内置的流程模板安装到当前项目，或 monorepo 的某个子项目。
---

## 目标

把插件自带的某个 flow 模板装到项目里，让用户能立即启动它。

**分工**：确定性的机械动作（探测项目根、复制模板、改 .gitignore、跑 preflight、打印用法）全部交给随插件附带的 node CLI；你只负责**交互**——展示选项、用 AskUserQuestion 收集用户的选择，再把 CLI 的结构化结果转达给用户。这样安装过程可复现、出错面收敛，不靠你手搓一串 bash。

> 为什么不让脚本自己弹菜单：Claude Code 的 Bash 工具是非交互的（只捕获 stdout，没有 TTY），交互式 TUI 渲染不出来。所以「选哪个 flow / 装到哪个目录」必须走你的 AskUserQuestion，CLI 始终非交互。

## 步骤

### 1. 前置：确认 Node.js ≥ 18

ai-flow 的全部引擎与本 CLI 都跑在 Node 上——这是它唯一的普适前置依赖。先确认：

```bash
node --version
```

解析主版本号。**缺失或 < 18** → 停下，告诉用户「ai-flow 依赖 Node.js ≥ 18，请先安装（如 `brew install node` 或 nvm）再重试 /ai-flow:add」，不要继续后面的步骤。

### 2. 定位 CLI

`$CLAUDE_PLUGIN_ROOT` 只在 hook 运行时有值，你的 Bash 工具里它是空的。从已安装记录里取插件实际路径（用 node 读，避免 python 依赖）：

```bash
PLUGIN_ROOT=$(node -e "const fs=require('fs'),os=require('os');try{const d=JSON.parse(fs.readFileSync(os.homedir()+'/.claude/plugins/installed_plugins.json','utf8'));const p=((d.plugins||{})['ai-flow@darian-agent-plugins']||[{}])[0].installPath;if(p)process.stdout.write(p);else process.exit(1)}catch(e){process.exit(1)}" 2>/dev/null) || \
PLUGIN_ROOT=$(ls -d ~/.claude/plugins/cache/darian-agent-plugins/ai-flow/*/ 2>/dev/null | sort -V -r | head -1 | sed 's:/$::')
CLI="$PLUGIN_ROOT/dist/cli/add.js"
node "$CLI" list >/dev/null 2>&1 || { echo "找不到 ai-flow CLI（$CLI）。插件可能未正确安装或版本过旧，建议 /plugin update 后重试。"; }
```

后续都用 `node "$CLI" <子命令>`。CLI 自己知道插件内置 flow 的位置，不用你再传路径。

### 3. 选要安装哪个 flow

```bash
node "$CLI" list
```

输出是 `[{name, description}]` 的 JSON。**用 AskUserQuestion 把这些 flow 作为选项让用户选**（可多选——一次装多个）。每个选项的说明用 CLI 给的 description。

### 4. 选锚点目录（.ai-flow 装在哪）

```bash
node "$CLI" detect
```

输出 JSON：`cwd` / `gitRoot` / `recommended` / `candidates[]`。每个 candidate 含 `dir`、`reason`（如「最近的项目根(package.json)」「git 根」）、`outerAiFlow`、`existingFlows`。

`.ai-flow` 装在哪，就决定了这个 flow 的**锚点**——引擎按锚点定位状态与产物，monorepo 里因此可以「一个子项目一套 flow」。据此决定：

- **只有一个候选，或 `recommended` 就是用户显然想要的** → 直接用 `recommended`，不必多问。
- **有多个候选**（典型：子项目根 vs git 根）→ 用 AskUserQuestion 让用户选，默认项放 `recommended`。把每个候选的 `reason` 讲清楚，帮用户判断装在子项目还是仓库根。
- **某候选的 `outerAiFlow` 非 null** → 明确告诉用户：装在这里后，在该子树工作时引擎会**就近锚定到这里、完全屏蔽外层 `outerAiFlow` 的 flow**。这是 monorepo 项目隔离的预期行为，但要让用户知情确认。
- 候选的 `existingFlows` 里已含目标 flow → 提示用户这里已装过（见下一步的 `--force`）。

### 5. 安装

对每个「选中的 flow × 选定的锚点目录」执行：

```bash
node "$CLI" install --flow <flow-name> --dir <chosen-dir>
```

CLI 会复制模板、`chmod` preflight、把 `.ai-flow/*/state/` 写进该目录的 `.gitignore`、跑该 flow 的 preflight 做依赖自检，最后打印启动用法。**把 CLI 的输出原样转达给用户**——它已经包含 preflight 结果（缺依赖会列出补齐命令）和「如何启动」。

- 该 flow 已装在目标目录 → CLI 会拒绝并提示加 `--force`。征得用户同意覆盖后，重跑并加 `--force`。
- preflight 未通过 → flow 文件已装好，但要先按 CLI 列出的缺失项补齐依赖才能 start；把这些转达给用户。
