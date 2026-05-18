export const HELP_TEXT = `
## feat-flow 命令参考

| 命令 | 说明 |
|------|------|
| \`feat-flow init\` | 初始化项目（幂等，首次使用自动执行） |
| \`feat-flow start <需求>\` | 开始新工作流（需要干净的 git 工作区） |
| \`feat-flow approve <token>\` | 通过 GATE 审批，进入下一阶段 |
| \`feat-flow abort\` | 终止工作流，变更保存到新分支 |
| \`feat-flow resume <branch>\` | 从中止的分支恢复 |
| \`feat-flow status\` | 查看当前阶段和进度 |

> \`/clear\` 随时可用 — 状态持久化，重开 session 后自动恢复进度。
> 不要使用 \`/rewind\`（会导致 state 与对话历史不同步）。
`.trim();
//# sourceMappingURL=help.js.map