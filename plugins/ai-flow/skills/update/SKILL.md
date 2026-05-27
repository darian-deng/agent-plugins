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
- 修改 `preflight.sh` 检查（含新增 / 删除外部依赖：skill / plugin / MCP）

---

## 第五步：分析改动的合理性

执行之前，主动思考并告知用户：

1. **流程连贯性**：这个改动让整个 flow 的逻辑更合理，还是产生了断点？
   - 例：给探索阶段加 Gate，意味着人类要审批 AI 的探索摘要才能继续设计——合理吗？
   - 例：删除最后一个 Gate，意味着最终产出不需要人工确认——可以接受吗？

2. **write_scope 一致性**：相邻阶段的读写路径是否对齐？

3. **Script Validator 可靠性**：新脚本的 cwd 是 flow 目录，不是项目根目录。相对路径是否正确？

4. **preflight 同步**：若本次改动涉及外部依赖变化，必须同步更新 `preflight.sh`：

   **新增依赖**：
   - Skill → `npx skills find <name>`，顶部若无清晰 `owner/repo@skill` 格式 = 未找到，停下来问用户
   - Plugin → 搜索 marketplace 或 GitHub；MCP → 查官方文档；系统工具 → 直接确认命令名
   - 找到后，在 preflight.sh 对应节（Skills / Plugins / MCP / 系统工具）按以下规则添加独立 check 块：
     ```sh
     # Skill 块（每个 skill 独立，安装命令对应解析结果）
     if check_skill "{name}"; then ok "skill: {name}"
     else err "Missing skill: {name}"; cmd "npx skills add {owner/repo}@{name} -g -y"; MISSING=1; fi

     # Plugin 块
     # if check_plugin "{name}"; then ok "plugin: {name}"
     # else err "Missing plugin: {name}"; cmd "claude plugin install {name}@{registry} --scope user"; MISSING=1; fi

     # MCP 块
     # if check_mcp "{name}"; then ok "mcp: {name}"
     # else err "{name} MCP not configured."; err "Install: {官方命令}"; MISSING=1; fi
     ```

   **删除依赖**：移除 preflight.sh 中该依赖的完整 check 块，同步更新 helper.md 的「环境要求」节。

   **重命名依赖**：等价于先删除旧名称 check 块，再新增新名称 check 块（走新增流程解析安装命令）。

   **preflight.sh 不存在时**：若首次新增依赖，从零创建。文件头部固定为：
   ```sh
   #!/bin/sh
   # {flow-name} preflight — runs once when '{flow-name} start' is called.
   PASS=0; FAIL=1; MISSING=0
   SKILLS_DIR="$HOME/.claude/skills"
   PLUGINS_CACHE="$HOME/.claude/plugins/cache"  # 实现细节，跨版本不保证稳定
   err()          { printf "❌  %s\n" "$1" >&2; }
   cmd()          { printf "    %s\n" "$1" >&2; }
   ok()           { printf "✅  %s\n" "$1"; }
   check_cmd()    { command -v "$1" >/dev/null 2>&1; }
   check_skill()  { [ -f "$SKILLS_DIR/$1/SKILL.md" ]; }
   check_plugin() { find "$PLUGINS_CACHE" -maxdepth 4 -type d -name "$1" 2>/dev/null | grep -q .; }
   check_mcp()    { claude mcp list 2>/dev/null | grep -qE "(^|[[:space:]])$1([[:space:]]|$)"; }
   ```
   文件末尾固定为 `[ "$MISSING" = "1" ] && exit $FAIL; exit $PASS`

5. **stage prompt 规范合规**：改动涉及 stage 文件时，改完后该 stage 是否仍符合 `optimize-stage-prompt` 规范？检查：section 顺序（目标→前置读取→步骤→输出规格→完成条件→Signal）、Signal 是否为独立末尾 section、输出规格是否明确、完成条件是否可客观验证。

6. **Clear-Safe 检查**：改动是否破坏「任一 stage / task 后 /clear，后续仍可执行」的承诺？

   测试方法：
   - 模拟在改动涉及的 stage 末尾 /clear
   - 检查下一 stage 所需信息是否全部在落盘的产出文件里
   - 不在 → 改动必须包含「补落盘」机制，或调整边界

   常见违反场景：
   - 新加 stage 依赖前 stage 的 subagent 探索细节（subagent context 已销毁，不可恢复）
   - 调整 stage 顺序后，新位置的前置依赖产出还没生成
   - 合并 stage 后，原来分两次 gate 审的内容压成一次 gate，但产出未对应合并 → 用户审批面失焦

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
