# 安装内置 feat-flow 模板

feat-flow 是随 ai-flow 插件一起分发的内置示例——8 阶段软件功能开发工作流。安装就是把插件自带的完整配置复制到当前项目里。

## 步骤

### 1. 确认插件根目录

```bash
echo $CLAUDE_PLUGIN_ROOT
```

内置模板在 `$CLAUDE_PLUGIN_ROOT/.ai-flow/feat-flow/`。

### 2. 检查是否已安装

```bash
ls .ai-flow/feat-flow/config.json 2>/dev/null && echo "already installed"
```

如果已存在，询问用户是否覆盖。如果用户选择不覆盖，结束并告知已安装。

### 3. 复制模板文件

```bash
mkdir -p .ai-flow/feat-flow
cp -r "$CLAUDE_PLUGIN_ROOT/.ai-flow/feat-flow/." .ai-flow/feat-flow/
chmod +x .ai-flow/feat-flow/preflight.sh
```

### 4. 更新 .gitignore

检查项目根目录的 `.gitignore`，如果没有 `.ai-flow/*/state/` 条目，追加：

```
.ai-flow/*/state/
```

### 5. 确认结果

读取 `.ai-flow/feat-flow/config.json` 验证安装成功，然后告诉用户：

- 已安装 feat-flow（8 阶段软件开发工作流）
- preflight 会检查必要的 skills 和插件是否已安装
- 启动方式：`feat-flow start <需求描述>`
- 查看帮助：`feat-flow help`
