---
name: feat-flow-stage-0
description: feat-flow Stage 0 环境预检 — feat-flow start 触发时由 UserPromptSubmit hook 自动执行
disable-model-invocation: true
---

# Stage 0：环境预检

> **触发时机**：用户输入 `feat-flow start <requirement>` 后，**UserPromptSubmit hook 自动执行预检**，不需要 AI 手动调用脚本。

## hook 执行的预检项目

| 检查项 | 通过条件 | 失败处理 |
|--------|---------|---------|
| git 仓库 | 当前目录是 git repo | hook deny，提示用户 cd 到正确目录 |
| feat-flow-setup 已完成 | `.feat-flow/.initialized` 存在 | hook deny，提示运行 `feat-flow-setup` |
| 无活跃 flow | `.claude/.feat-flow-active` 不存在 | hook deny，提示先 `feat-flow abort` |
| git 工作区干净 | 无未提交改动 | hook deny（硬性阻断，保障 base_sha 完整性） |
| 需求描述非空 | `feat-flow start` 后有文字 | hook deny，提示需要描述 |

## 预检通过后

UserPromptSubmit hook 自动：
1. 初始化 `.feat-flow/` 目录和 `state.json`
2. 记录 `base_sha`（当前 HEAD commit）
3. 注入 stage-1 指令到 AI context

AI 无需执行任何脚本，直接开始 stage-1 需求确认工作。

## 如果需要手动初始化（仅限首次项目接入）

```bash
feat-flow-setup
```

此脚本检查 git 仓库、更新 .gitignore、创建 `.feat-flow/` 目录。
脚本位置：`.claude/plugins/feat-flow/bin/feat-flow-setup`
