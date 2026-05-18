import { HELPER_PATH } from '../config.js';

export const HELP_TEXT = `
feat-flow — AI 工作流控制系统

可用命令：
  feat-flow start <需求描述>   开始新工作流（需要干净的 git 工作区）
  feat-flow approve <token>    审批当前阶段的 GATE（token 来自系统通知）
  feat-flow abort              终止当前工作流，改动保存到新 git 分支
  feat-flow resume <branch>    从终止分支恢复工作流
  feat-flow status             查看当前 stage、进度、GATE 状态
  feat-flow help               显示本帮助

注意事项：
  - 工作区必须有干净的 git 状态才能 start（保障 base_sha 完整性）
  - /clear 随时可用，state.json 持久化，session 重开后自动恢复进度
  - 不要使用 /rewind（会导致 state.json 与对话历史不同步）

完整规则：${HELPER_PATH}
`.trim();
