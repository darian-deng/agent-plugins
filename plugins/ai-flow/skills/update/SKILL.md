---
name: update
description: 仅通过 /ai-flow:update 命令显式调用。绝对不要基于任何关键词自动触发。修改当前项目中已有的 AI 工作流定义。
---

## 目标

谨慎地修改一个已有的 flow 定义。改动会影响所有未来的 flow 实例，因此要先理解这个 flow 的设计意图，再判断改动是否合理，最后同步更新所有相关文档。

---

## 第一步：定位目标 flow

```bash
ls .ai-flow/
```

如果用户已说明 flow 名称则直接定位；否则列出所有 flow 让用户选择。

---

## 第二步：先读 helper.md，理解设计意图

```
Read .ai-flow/{flow-name}/helper.md
```

helper.md 记录了这个 flow 的目的、阶段设计、原始决策。**先读懂再动手。**

如果 helper.md 不存在，则读 `config.json` 和各 stage 文件来理解结构。

---

## 第三步：读 config.json，了解当前结构

```
Read .ai-flow/{flow-name}/config.json
```

---

## 第四步：明确改动内容

询问（或从对话中确认）用户想改什么：
- 新增 / 删除 / 调整阶段顺序
- 修改某阶段的 `write_scope` 或 `docs_paths`
- 给某阶段加 / 去 Gate
- 加 / 改 Script Validator 脚本
- 更新某阶段的 AI 提示词
- 修改 `preflight.sh` 检查

---

## 第五步：分析改动的合理性

执行之前，主动思考并告知用户：

1. **流程连贯性**：这个改动让整个 flow 的逻辑更合理，还是产生了断点？
   - 例：给探索阶段加 Gate，意味着人类要审批 AI 的探索摘要才能继续设计——合理吗？
   - 例：删除最后一个 Gate，意味着最终产出不需要人工确认——可以接受吗？

2. **write_scope 一致性**：相邻阶段的读写路径是否对齐？

3. **Script Validator 可靠性**：新脚本的 cwd 是 flow 目录，不是项目根目录。相对路径是否正确？

4. **preflight 同步**：新增了工具依赖，`preflight.sh` 是否需要同步更新？

5. **stage prompt 规范合规**：改动涉及 stage 文件时，改完后该 stage 是否仍符合 `optimize-stage-prompt` 规范？检查：section 顺序（目标→前置读取→步骤→输出规格→完成条件→Signal）、Signal 是否为独立末尾 section、输出规格是否明确、完成条件是否可客观验证。

发现潜在问题时，告诉用户并一起决定如何处理。

---

## 第六步：执行改动

按确认的方案修改文件。改动范围可能包括：
- `config.json`（保持 schema 有效）
- `stages/{id}.md`（遵循 `optimize-stage-prompt` 规范：Signal 必须是独立末尾 section，输出规格必须明确，完成条件必须可客观验证）
- `scripts/` 下的验证脚本
- `preflight.sh`

---

## 第七步：同步 helper.md

**改动后 helper.md 必须更新**，确保它准确反映当前状态：
- 阶段列表（id、名称、Gate 标记）
- 产出文件路径
- 完成条件说明
- 如果改动改变了 flow 的整体定位，描述部分也要更新

**helper.md 是下一次修改的起点，保持它准确是最重要的事。**

---

## 完成

向用户展示：
- 改动摘要（修改了哪些文件，改了什么）
- helper.md 的更新内容
- 如果需要更新 preflight 但还没做，明确提示
