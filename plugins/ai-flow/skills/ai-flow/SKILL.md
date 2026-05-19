---
name: ai-flow
description: 管理 ai-flow Flow Definition。安装内置 feat-flow 模板到当前项目、引导创建全新自定义 flow、或修改既有 flow 的阶段/配置/脚本。当用户说"安装 feat-flow"、"添加一个 flow"、"创建工作流"、"我想要一个 AI 工作流"、"修改我的 flow"、"给 flow 加阶段"、"我想用 ai-flow"、或描述一个需要 AI 分阶段执行的流程时，使用此 skill。
---

## 场景识别

根据 `$ARGUMENTS` 或对话上下文判断用户意图，落入三个场景之一：

| 场景 | 信号 | Reference |
|------|------|-----------|
| **install** | "安装 feat-flow"、"我想用那个 8 阶段开发流程" | `references/install-feat-flow.md` |
| **create** | 描述一个工作流程、"帮我设计一个 flow"、"我想要一个自定义 flow" | `references/create-flow.md` |
| **modify** | "修改 flow"、"给 stage 加 gate"、"调整阶段配置" | `references/modify-flow.md` |

如果意图不清晰，直接问："你是想安装内置的 feat-flow 模板、创建一个新的自定义 flow，还是修改已有的 flow？"

## 执行

判断场景后，Read 对应的 reference 文件，完整按其步骤执行，不要跳步。

## 约束（任何场景都适用）

- Flow 文件写入 `{cwd}/.ai-flow/{flow-name}/`，不要写到其他路径
- `.ai-flow/*/state/` 必须加入项目 `.gitignore`（state 是运行时状态，不进 git）
- 每个 stage prompt 文件末尾必须包含 signal 指令，这是 AI 完成阶段的唯一触发器
- Gate token 只通过 systemMessage 传给用户，不要在 stage prompt 里写 token 查看指令
