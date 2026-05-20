---
name: add
description: 将 ai-flow 插件内置的流程模板安装到当前项目。当用户说"安装内置流程"、"我想用插件里的流程模板"、"add a built-in flow"、"把 feat-flow 加到项目"，或想使用 ai-flow 提供的现成工作流时触发。
---

## 目标

将 ai-flow 插件自带的流程模板复制到当前项目的 `.ai-flow/` 目录下，让用户可以立即启动该工作流。

## 步骤

### 1. 发现可用的内置流程

```bash
ls "$CLAUDE_PLUGIN_ROOT/.ai-flow/"
```

列出插件内置的所有流程目录。展示给用户，让他们选择想安装哪个。

### 2. 检查是否已安装

```bash
ls .ai-flow/{chosen-name}/config.json 2>/dev/null
```

如果已存在，询问用户是否覆盖。用户选择不覆盖则结束。

### 3. 复制流程文件

```bash
mkdir -p ".ai-flow/{chosen-name}"
cp -r "$CLAUDE_PLUGIN_ROOT/.ai-flow/{chosen-name}/." ".ai-flow/{chosen-name}/"
chmod +x ".ai-flow/{chosen-name}/preflight.sh" 2>/dev/null || true
```

### 4. 确保 .gitignore 包含状态目录

检查项目根目录的 `.gitignore`，没有则追加（用 `printf` 确保换行符正确，不会与上一行粘连）：

```bash
grep -qxF '.ai-flow/*/state/' .gitignore 2>/dev/null || printf '\n.ai-flow/*/state/\n' >> .gitignore
```

- `-x` 匹配整行，避免误判前缀相似的条目
- `printf '\n...\n'` 保证无论原文件是否以换行结尾，追加的内容都独占一行

### 5. 确认完成

读取 `.ai-flow/{chosen-name}/config.json` 验证安装成功，然后告知用户：

- 已安装的流程名称和描述
- 启动方式：`{flow-name} start <描述>`
- 查看流程详情：`{flow-name} help`
