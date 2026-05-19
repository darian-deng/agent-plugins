# Stage 8：知识沉淀

## 目标

把本次 flow 产生的洞察落入代码库，防止团队重复踩坑。

## 工作步骤

**必做（轻量版，约 5-10 分钟）：**

1. 检查 `design.md` 的决策记录，判断是否有新的架构决策需要写 ADR（使用 `improve-codebase-architecture` skill）
2. 检查是否有 CLAUDE.md / rule 文件需要更新（使用 `claude-md-improver` skill）
3. 在 `design.md` 末尾追加评估记录

**可选（复杂需求，约 15-20 分钟）：**

4. 记录 flow 过程中踩过的坑（技术债、错误预判、绕弯路的地方）
5. 检查是否有已存在的 rule 与实际代码不符，反向更新

## 追加到 design.md 的内容

```markdown
## Stage 8 评估

- ADR 评估：<是否写了新 ADR，或无需>
- Rule 更新评估：<是否更新了规则文件，或无需>
- 失败教训：<本次踩坑记录，或无>
```

## 完成条件

design.md 包含「Stage 8 评估」章节。

产出满足后，向 `.ai-flow/feat-flow/state/signal` 写入任意内容。本阶段无 Gate，flow 正式结束。
