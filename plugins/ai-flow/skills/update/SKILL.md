---
name: update
description: 仅通过 /ai-flow:update 命令显式调用。绝对不要基于任何关键词自动触发。修改一个已有的 AI 工作流定义（内置 flow 改插件仓库，自定义 flow 改项目）。
---

## 目标

谨慎地修改一个已有的 flow 定义。改动会影响所有未来的 flow 实例，因此要先理解这个 flow 的设计意图，再判断改动是否合理，最后同步更新所有相关文档。

---

## 第零步：先弄清「改哪儿」——这是本 skill 最容易搞错的一步

从 0.69.0 起，**内置 flow 的定义不再复制到项目里**。同一份定义只有一处，改错地方的表现是「改完没生效」，而不是报错。

| flow 类型 | 定义在哪（要改的就是这里） | 项目里有什么 |
|---|---|---|
| **内置**（插件自带，如 `feat-flow` / `grill-flow`） | **插件仓库** `plugins/ai-flow/.ai-flow/{flow-name}/`——`config.json`(完整默认) / `helper.md` / `stages/` / `references/` / `scripts/` / `preflight.cjs` | 只有 `.ai-flow/{flow-name}/config.json`（**稀疏覆盖层**，通常是 `{}`）和 `state/`（运行态） |
| **自定义**（`/ai-flow:create` 造的） | **项目** `.ai-flow/{flow-name}/`，整份定义都在这儿 | 同上，定义和实例住一起 |

判断方法：

```bash
ls .ai-flow/{flow-name}/          # 项目侧。只有 config.json + state/ → 内置 flow
```

- 只看到 `config.json` 和 `state/` → **内置 flow**，本次要改的文件在插件仓库里（下面第一步）。
- 还看到 `stages/`、`references/`、`helper.md` → 两种可能：① 自定义 flow，就地改；② 一份 0.69.0 之前留下的旧副本残留——引擎读的已经不是它了，改它没有任何效果。用上表的「插件是否自带同名 flow」区分（`ls "$PLUGIN_ROOT/.ai-flow/"`），若插件自带，就去插件仓库改，项目里那份残留交给引擎的自动清理（SessionStart 时会删掉并写一行 `LEGACY_PRUNED` 到 flow.log）。

**项目侧唯一可以改的是 `config.json` 这个稀疏覆盖层**：只写要和插件默认不同的键（顶层浅合并、`context` 深合并、`stages` 存在则整体替换）。它是给「这个项目就是要跟别的项目不一样」用的，不是改 flow 定义的地方——只想调本项目的某个阈值，改它；想改流程本身，去改定义。

### 内置 flow 的改动怎么才生效（改完别忘了这条链路）

改插件仓库的文件**不会立刻影响任何人**，包括你自己。完整链路：

1. 改 `plugins/ai-flow/.ai-flow/{flow-name}/` 下的文件；
2. bump 版本号**两处且必须一致**：`plugins/ai-flow/package.json` 和 `plugins/ai-flow/.claude-plugin/plugin.json`（`marketplace.json` 由 CI 同步，别手改）——不 bump 的话 `/plugin update` 检测不到变化，等于没发布；
3. 跑 `npx vitest run tests/flow-placeholders.test.ts tests/flow-doc-integrity.test.ts tests/stage-prompt-budget.test.ts`（占位符、文档一致性、stage 提示词长度预算的机械检查）；
4. push 到 main，CI 构建并同步 marketplace.json；
5. 使用者 `claude plugin update ai-flow@darian-agent-plugins --scope user`，再 `/reload-plugins`。

本仓库的 git 纪律照旧：**未经开发者明确要求不要自行 commit / push**，改完展示摘要即可。

---

## 第一步：定位并打开定义目录

内置 flow——先拿到插件根，后面统称 `$FLOW_DEF`：

```bash
# 在插件仓库里开发时，直接就是 plugins/ai-flow/.ai-flow/{flow-name}
# 从别的项目改内置 flow，得先找到已安装的插件（只读的缓存副本改了不算数，
# 要改的是插件仓库的 checkout）
ls plugins/ai-flow/.ai-flow/
```

自定义 flow：`$FLOW_DEF` 就是项目里的 `.ai-flow/{flow-name}/`。

如果用户已说明 flow 名称则直接定位；否则列出所有 flow 让用户选择。

---

## 第二步：先读 helper.md，理解设计意图

```
Read $FLOW_DEF/helper.md
```

helper.md 记录了这个 flow 的目的、阶段设计、原始决策。**先读懂再动手。**

如果 helper.md 不存在，则读 `config.json` 和各 stage 文件来理解结构。

---

## 第三步：读 config.json，了解当前结构

```
Read $FLOW_DEF/config.json
```

注意：这是**完整默认**。项目侧那份同名文件是稀疏覆盖层，别拿它当结构来源。

---

## 第四步：明确改动内容

询问（或从对话中确认）用户想改什么：
- 新增 / 删除 / 调整阶段顺序
- 修改某阶段的 `write_scope` 或 `docs_paths`
- 给某阶段加 / 去 Gate
- 加 / 改 Script Validator 脚本
- 更新某阶段的 AI 提示词
- 修改 `preflight.cjs` 检查（含新增 / 删除外部依赖：skill / plugin / MCP）

---

## 第五步：分析改动的合理性

执行之前，主动思考并告知用户：

1. **流程连贯性**：这个改动让整个 flow 的逻辑更合理，还是产生了断点？
   - 例：给探索阶段加 Gate，意味着人类要审批 AI 的探索摘要才能继续设计——合理吗？
   - 例：删除最后一个 Gate，意味着最终产出不需要人工确认——可以接受吗？
   - **原则：终端（最后一个）stage 默认必带 Gate。** 终端 stage 误写 signal 会删 active.json、flow 不可逆地结束；中途 stage 误推进还在 flow 内、可恢复，终端不可。删终端 Gate 等于允许 AI 在讨论中自觉「完事了」就结束 flow——除非有充分理由，否则不要删。

2. **write_scope 一致性**：相邻阶段的读写路径是否对齐？

3. **占位符方向**（改 stage / references 里的路径时必查）：
   - `{{flow_root}}` = 项目实例目录，**里面只有 `state/`**。写 signal、读 active.json 走它。
   - `{{flow_def}}` = 定义目录（内置 flow 在插件里）。`references/` `stages/` `scripts/` `helper.md` `preflight.*` 走它。
   - 写反的代价不对称：`{{flow_def}}/state/signal` 会把 signal 写进定义目录，**Write 不报错、引擎永远不推进**（静默）；`{{flow_root}}/references/x.md` 只是 Read 报 ENOENT（响亮）。所以宁可拿不准时用 `{{flow_def}}` 去指定义、绝不用 `{{flow_root}}` 去指定义之外的东西。`tests/flow-placeholders.test.ts` 会机械地兜住这条。

4. **Script Validator 可靠性**：脚本现在**住在插件里**，`join(__dirname, '..')` 推出来的是插件自己的仓库、不是用户项目——⛔ 不许再用它当 flowDir。脚本按四级取 flowDir：`--flow-dir <abs>` 参数 → `AI_FLOW_FLOW_DIR` 环境变量（引擎跑 gate / preflight 时注入）→ 从 cwd 上溯找 `<d>/.ai-flow/<flow>/state/active.json` → 都没有就打印「带正确 `--flow-dir` 的完整命令」并退出非零。提示词里调脚本一律写成 `node {{flow_def}}/scripts/x.cjs --flow-dir {{flow_root}} <子命令>`。

5. **preflight 同步**：若本次改动涉及外部依赖变化，必须同步更新 `$FLOW_DEF/preflight.cjs`（Node 脚本，纯 builtin、跨平台；完整范例见插件自带的 `feat-flow/preflight.cjs`）：

   **新增依赖**：
   - Skill → `npx skills find <name>`，顶部若无清晰 `owner/repo@skill` 格式 = 未找到，停下来问用户
   - Plugin → 搜索 marketplace 或 GitHub；MCP → 查官方文档；系统工具 → 直接确认命令名
   - 找到后，在 preflight.cjs 对应节（Skills / Plugins / MCP / 系统工具）添加独立 check 块（用 `missing = true` 标记缺失，文件末尾 `process.exit(missing ? 1 : 0)`）：
     ```js
     // Skill 块（每个 skill 独立，安装命令对应解析结果）
     if (checkSkill('{name}')) ok('skill: {name}');
     else { err('Missing skill: {name}'); cmd('npx skills add {owner/repo}@{name} -g -y'); missing = true; }

     // Plugin 块
     // if (checkPlugin('{name}')) ok('plugin: {name}');
     // else { err('Missing plugin: {name}'); cmd('claude plugin install {name}@{registry} --scope user'); missing = true; }

     // MCP 块
     // if (checkMcp('{name}')) ok('mcp: {name}');
     // else { err('{name} MCP not configured.'); err('Install: {官方命令}'); missing = true; }
     ```

   **删除依赖**：移除 preflight.cjs 中该依赖的完整 check 块，同步更新 helper.md 的「环境要求」节。

   **重命名依赖**：等价于先删除旧名称 check 块，再新增新名称 check 块（走新增流程解析安装命令）。

   **preflight.cjs 不存在时**：若首次新增依赖，从零创建——直接照抄插件自带的 `feat-flow/preflight.cjs` 作骨架（CommonJS + node builtin），保留其 helper（`cmdExists` / `checkSkill` / `checkPlugin` / `checkMcp`、基于 `CLAUDE_CONFIG_DIR`/home 的路径、`let missing = false`、末尾 `process.exit(missing ? 1 : 0)`），把检查块换成本 flow 的依赖。**不要新建 `.sh`**——引擎优先跑 `.cjs`/`.mjs`，preflight 运行时 cwd = 项目根。

6. **stage prompt 规范合规**：改动涉及 stage 文件时，改完后该 stage 是否仍符合 `optimize-stage-prompt` 规范？检查：section 顺序（目标→前置读取→步骤→输出规格→完成条件→Signal）、Signal 是否为独立末尾 section、输出规格是否明确、完成条件是否可客观验证。

7. **Clear-Safe 检查**：改动是否破坏「任一 stage / task 后 /clear，后续仍可执行」的承诺？

   测试方法：
   - 模拟在改动涉及的 stage 末尾 /clear
   - 检查下一 stage 所需信息是否全部在落盘的产出文件里
   - 不在 → 改动必须包含「补落盘」机制，或调整边界

   常见违反场景：
   - 新加 stage 依赖前 stage 的 subagent 探索细节（subagent context 已销毁，不可恢复）
   - 调整 stage 顺序后，新位置的前置依赖产出还没生成
   - 合并 stage 后，原来分两次 gate 审的内容压成一次 gate，但产出未对应合并 → 用户审批面失焦

8. **对已在跑的 flow 实例的影响**：定义随插件版本走，使用者一次 `/plugin update` 就会换掉**所有**正在跑的实例后续要用的提示词。**改 stage id 或删 stage 尤其危险**——`getStageConfig` 遇到 active.json 里那个已不存在的 stage id 会抛异常，而它在 PreTool/PostTool 路径上，实例会在下一次工具调用时卡死（`state/` 不在 git 里，救不回来）。要改 id / 删 stage，先说清楚这件事，并给出迁移办法（手工把 `state/active.json` 的 `current_stage` 改成新 id）。

发现潜在问题时，告诉用户并一起决定如何处理。

---

## 第六步：执行改动

按确认的方案修改文件（内置 flow 一律改插件仓库的 `plugins/ai-flow/.ai-flow/{flow-name}/`）。改动范围可能包括：
- `config.json`（保持 schema 有效）
- `stages/{id}.md`（遵循 `optimize-stage-prompt` 规范：Signal 必须是独立末尾 section，输出规格必须明确，完成条件必须可客观验证）
- `references/` 下的参考文档
- `scripts/` 下的验证脚本
- `preflight.cjs`

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
- **内置 flow**：还差哪几步才生效（版本号是否已 bump、是否需要 push / CI / `/plugin update`），以及机械检查（`flow-placeholders` / `flow-doc-integrity` / `stage-prompt-budget`）的结果
