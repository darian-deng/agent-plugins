# feat-flow 参考手册

> 供 AI 在 flow 执行期间查阅。遇到流程问题时直接读取此文件，不要依赖记忆。

---

## feat-flow 是什么

8 阶段软件功能开发工作流。确保需求→设计→实施→验证→审查的每一步可追溯、可恢复。

运行在 ai-flow 引擎上：阶段定义在 `.ai-flow/feat-flow/config.json`，状态存储在 `.ai-flow/feat-flow/state/`。

---

## 命令速查

| 命令 | 说明 |
|------|------|
| `feat-flow start <需求描述>` | 开启新工作流实例（需要干净的 git 工作区） |
| `feat-flow approve <token>` | 审批当前 Gate 检查点 |
| `feat-flow abort` | 终止工作流，改动保存到 `feat-flow/aborted-<时间戳>` 分支 |
| `feat-flow resume <branch>` | 从中止的分支恢复 |
| `feat-flow status` | 查看当前阶段和 Gate 状态 |

---

## 阶段流转

| 阶段 | 名称 | Gate | 完成条件 |
|------|------|:----:|---------|
| stage-1 | 需求确认 | ✅ | design.md 含需求/约束/验收标准，≥200字 |
| stage-2 | 代码探索 | — | design.md 含探索摘要/影响范围 |
| stage-3 | 方案选型 | ✅ | design.md 含方案选型，≥500字 |
| stage-4 | 实施计划 | ✅ | plan.md 含 Tasks，有至少一个任务 |
| stage-5 | 代码实施 | — | plan.md 所有任务标为 [x] |
| stage-6 | 全量验证 | ✅ | 三个验证文件存在且无错误 |
| stage-7 | 代码审查 | ✅ | review.md 存在，含审查范围和问题处理 |
| stage-8 | 知识沉淀 | — | design.md 含 Stage 8 评估章节 |

**阶段推进的唯一方式**：向 `.ai-flow/feat-flow/state/signal` 写入任意内容。

---

## Gate 机制

Gate 触发后：
1. 引擎生成随机 token，仅通过系统弹窗显示给用户（不进入 AI 上下文）
2. AI 必须停止，等待用户执行 `feat-flow approve <token>`
3. 用户审批前，非审批命令会清除 Gate（让 AI 继续工作精化产出）

AI 不能读取 token（引擎阻止对 `state/gate-token` 的所有访问）。

---

## 受保护路径（PreToolUse hook 机械拦截）

| 路径 | 为什么 |
|------|--------|
| `.ai-flow/feat-flow/config.json` | 流程定义，运行时只读 |
| `.ai-flow/feat-flow/stages/` | 阶段提示词，运行时只读 |
| `.ai-flow/feat-flow/scripts/` | 验证脚本，只能由用户手动替换 |
| `.ai-flow/feat-flow/state/active.json` | 引擎状态，只能由引擎写入 |
| `.ai-flow/feat-flow/state/gate-token` | Gate 凭证，AI 不可见不可写 |

`state/signal` 是唯一允许 AI 写入的 state 文件（完成信号）。

---

## 产出文件路径

所有产出在 `docs/feat-flows/<flow_id>/`（`<flow_id>` 由 `feat-flow start` 时自动生成）：

| 文件 | 阶段 |
|------|------|
| `design.md` | stage-1 创建，stage-2/3/8 追加 |
| `plan.md` | stage-4 创建，stage-5 更新 |
| `verification/lint.txt` | stage-6 |
| `verification/typecheck.txt` | stage-6 |
| `verification/test.txt` | stage-6 |
| `review.md` | stage-7 |

---

## 流程卡住了怎么办

1. `feat-flow status` — 查看当前阶段和是否有挂起的 Gate
2. 查看 `docs/feat-flows/<flow_id>/` 下的产出文件 — 了解已完成工作
3. 如需中止：`feat-flow abort` — 所有改动保存到新 git 分支，不丢失工作
4. **不要使用 `/rewind`** — 会导致 state 与对话历史不同步

---

## Context Window 管理

随时可以 `/clear`：产出文件持久化在 git，flow 状态持久化在 `.ai-flow/feat-flow/state/active.json`，清空对话不丢失任何进度。

SessionStart hook 会在新 session 开始时自动注入当前阶段上下文。
