# feat-flow AI 参考手册

> 此文档供 AI 在用户困惑时查阅。遇到流程问题时，直接读取此文件，不要依赖记忆。

---

## feat-flow 是什么

为中大型需求设计的分阶段 AI 工作流控制系统，确保需求→设计→实施→验证→审查的每一步可追溯、可恢复。

**两套机制，不要混淆：**
- **AI 指令层**：stage 文档告诉 AI 每个阶段要做什么、产出什么格式。
- **Hook 机械层**：Claude Code 引擎在 AI 行动前后自动执行脚本检查，AI 无法感知或绕过。

---

## 命令速查

| 命令 | 触发场景 |
|------|---------|
| `feat-flow start 需求描述` | 开启新工作流。需要干净的 git 工作区（未提交改动会被阻断）。 |
| `feat-flow approve <token>` | 审批当前阶段的 GATE。token 来自系统弹窗，不可伪造。 |
| `feat-flow abort` | 终止当前工作流。所有改动自动保存到 `feat-flow/aborted-<时间戳>` 新分支。 |
| `feat-flow status` | 查看当前 stage、已完成任务数、是否等待 GATE。 |
| `feat-flow help` | 显示使用说明（由系统直接返回，不经过 AI）。 |

---

## 受保护文件（AI 不能修改，hook 会机械拦截）

feat-flow 以 project-scope plugin 形式安装，所有 plugin 文件在 `.claude/plugins/feat-flow/` 下。

| 路径 | 为什么不能动 |
|------|------------|
| `.feat-flow/**` | 控制平面。`state.json` 记录当前 stage 和 GATE 状态，AI 修改会破坏 flow 的状态机。`gate-token` 是 GATE 审批凭证，AI 不可见。 |
| `.claude/plugins/feat-flow/src/hooks/**` | Hook 脚本是流程的机械执行层。AI 修改等于绕过所有阶段控制和 GATE 保护。 |
| `.claude/plugins/feat-flow/skills/**` | Stage 指令文档和本 helper 文件。AI 修改会导致阶段指令失效。 |
| `.claude/plugins/feat-flow/hooks/hooks.json` | Hook 注册配置。修改会导致 hook 不触发，整个控制机制失效。 |

尝试写入以上路径时，PreToolUse hook 会返回 `permissionDecision: deny`，工具调用直接失败。

---

## 阶段流转规则（AI 不能自行推进阶段）

**阶段推进由 PostToolUse hook 自动检测锚点后触发**，AI 写入正确的锚点是推进的唯一方式。

| Stage | 产出文件 | 必须写入的锚点（缺一不推进） |
|-------|---------|--------------------------|
| stage-1 | design.md | `## 需求`、`## 验收标准`、`## STAGE-1-COMPLETE`，总字数 ≥ 200 |
| stage-2 | design.md | `## 探索摘要`、`## 影响范围`、`## STAGE-2-COMPLETE` |
| stage-3 | design.md | `## 方案选型`、`## 决策记录`、`## STAGE-3-COMPLETE`，总字数 ≥ 500 |
| stage-4 | plan.md | `## Tasks`（大写 T）、至少一个 `- [ ]` 任务、`## STAGE-4-COMPLETE` |
| stage-5 | plan.md | 所有任务标记为 `- [x]`、`## STAGE-5-COMPLETE` |
| stage-6 | verification/ | `lint.txt`、`typecheck.txt`、`test.txt` 三个文件存在 |
| stage-7 | review.md | `## reviewer-subagent-id`（含合法 UUID）、`## diff-base-sha`、`## issues`、`## STAGE-7-COMPLETE` |
| stage-8 | design.md | `## STAGE-8-COMPLETE` |

**GATE 等待期间**：AI 必须完全停止工作，明确告知用户执行 `feat-flow approve <token>`。在用户审批前，任何继续实施的行为都会被 UserPromptSubmit hook 拦截。

---

## 流程卡住了怎么办

1. 执行 `feat-flow status`——查看当前 stage 和是否在等待 GATE。
2. 读取 `.feat-flow/state.json`（**只读，绝对不要修改**）——查看精确状态机。
3. 查看 `docs/feat-flows/<flow-id>/` 下的产出文件——了解已完成工作。
4. 如需中止：执行 `feat-flow abort`——改动保存到新 git 分支，不丢失任何工作。
5. **不要使用 `/rewind`**：会导致 `state.json` 与对话历史不同步，hook 会在错误的 stage 做锚点校验，无法推进。

---

## Context Window 管理

- 系统在 context 达到 **35%** 时预警，**55%** 时强制提示。
- 随时可以 `/clear`：产出文件持久化在 git，`state.json` 持久化在磁盘，清空对话**不丢失任何工作进度**。
- 收到 context 警告后的正确流程：完成当前 task → `/clear` → 重开 session。系统会通过 SessionStart hook 自动注入当前 stage 上下文，AI 可无缝接续。
