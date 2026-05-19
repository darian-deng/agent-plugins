---
name: feat-flow-stage-6
description: feat-flow Stage 6 全量验证 — hook 驱动，AI 是响应方
disable-model-invocation: true
---

# Stage 6：全量验证

> **前置**：stage-5 已完成，所有代码实施完毕。

## 你的角色

控制系统正在后台运行全量 lint/typecheck/test。**你是响应方，不是执行方。**

## 可能的情况

**验证通过（hook 自动推进）：**
控制系统通知"全量验证通过"，自动推进到 stage-7。无需操作。

**验证失败（hook 通知你修复）：**
控制系统把失败详情（具体 errors）告知你。处理步骤：
1. 读取 `docs/feat-flows/<flow-id>/verification/` 目录下的输出文件
2. 诊断根因（可 dispatch debug subagent 辅助）
3. 修复代码
4. git commit（message：`feat-flow: fix verification errors`）
5. 控制系统自动重跑验证（最多 3 次）
6. 3 次仍未通过 → 控制系统触发人工审批门

## 重要

- **不要自己跑 lint/test 命令**——控制系统会跑，AI 自跑不被计入验证
- 验证结果文件在 `docs/feat-flows/<flow-id>/verification/`：
  - `lint.txt`：lint 输出
  - `typecheck.txt`：类型检查输出
  - `test.txt`：测试结果

## 完成条件

控制系统检测 `verification/lint.txt`、`typecheck.txt`、`test.txt` 均存在时，自动推进到 stage-7。
