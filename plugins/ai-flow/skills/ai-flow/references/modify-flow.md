# 修改既有 Flow

修改一个正在使用的 flow 需要谨慎——改动会影响所有未来的 flow 实例。要先理解这个 flow 的原始设计意图，再判断改动是否合理，最后同步更新所有相关文档。

---

## 第一步：发现并定位目标 flow

```bash
ls .ai-flow/
```

如果 $ARGUMENTS 里有 flow 名称，直接定位；否则列出所有 flow 请用户选择。

---

## 第二步：读 helper.md，理解设计意图

```
Read .ai-flow/{flow-name}/helper.md
```

helper.md 是这个 flow 的"活文档"，记录了它的目的、阶段设计、原始决策。先读懂再动手。

如果 helper.md 不存在（老的 flow 可能没有），则读 `config.json` 和各 stage 文件来理解结构。

---

## 第三步：读 config.json，了解当前结构

```
Read .ai-flow/{flow-name}/config.json
```

---

## 第四步：明确改动内容

询问（或从 $ARGUMENTS 中确认）用户想改什么：

- 新增/删除/调整阶段顺序
- 修改某阶段的 write_scope 或 docs_paths
- 给某阶段加/去 Gate
- 加/改 Script Validator 脚本
- 更新某阶段的 AI 提示词
- 修改 preflight 检查

---

## 第五步：分析改动的合理性

在执行之前，主动思考并告知用户：

**改动影响分析：**

1. **流程连贯性**：这个改动会让整个 flow 的逻辑更合理，还是会产生断点？
   - 例：在探索阶段加 Gate，意味着人类要审批 AI 的探索摘要才能继续设计——合理吗？
   - 例：删除最后一个 Gate，意味着最终产出不需要人工确认——可以接受吗？

2. **write_scope 一致性**：如果某阶段需要读取上一阶段的产出来继续工作，但上一阶段的 write_scope 限制了写入路径，这两个阶段是否对齐？

3. **Script Validator 可靠性**：新增的验证脚本在什么条件下会误判（false positive/negative）？脚本的 cwd 是 flow 目录，相对路径要对应。

4. **preflight 同步**：如果新增了某些工具/依赖，preflight.sh 是否需要同步更新？

如果发现潜在问题，告诉用户并一起决定如何处理，不要无声地跳过。

---

## 第六步：执行改动

按用户确认的方案修改文件。改动范围可能包括：

- `config.json`（保持 schema 有效）
- 对应的 `stages/{id}.md`（保持末尾有 signal 指令）
- `scripts/` 下的验证脚本
- `preflight.sh`

---

## 第七步：同步 helper.md

改动之后 helper.md 必须更新，确保它准确反映当前状态：

- 阶段列表（id、名称、Gate 标记）是否有变化？
- 产出文件路径是否有变化？
- 完成条件说明是否需要更新？
- 如果改动改变了 flow 的整体定位，描述部分也要更新

**helper.md 是下一次修改的起点，保持它准确是最重要的事。**

---

## 完成

向用户展示：
- 改动摘要（修改了哪些文件，每个文件改了什么）
- helper.md 的更新内容
- 如果这次改动需要 preflight 更新但还没做，明确提示
