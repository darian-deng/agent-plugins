# Stage 7：代码审查

## 目标

以独立视角审查本次 flow 的全部代码改动，确保代码质量和设计合理性。

## 工作步骤

1. 获取完整 diff：`git diff <base_sha> HEAD`（base_sha 来自 `active.json` 的 `base_sha` 字段）
2. dispatch 一个独立的 reviewer subagent，给它：
   - 完整 diff
   - `design.md`（需求背景和决策）
   - **不给** plan.md（审查者不应知道实施过程细节）
3. 处理审查结论：
   - 接受的问题：修复代码，git commit（message: `fix: address review finding`）
   - 反驳的问题：准备充分的反证
4. 最多 3 轮交互（用 SendMessage 继续同一 subagent）

## 产出文件

`docs/feat-flows/{flow_id}/review.md`

```markdown
# 代码审查

## 审查范围

base_sha: <SHA>

## 问题处理

### 已解决

- <问题描述>：<修复方式>

### 已反驳

- <问题描述>：<反证>

## 结论

<总体评估>
```

## 完成条件

review.md 存在，包含审查范围和问题处理两个章节。

产出满足后，向 `.ai-flow/feat-flow/state/signal` 写入任意内容。等待用户确认审查结论后进入 Stage 8。
