# 子能力详细操作步骤

## new — 创建新 ADR

### 输入
- 用户描述（自然语言：包含决策的 what + why + alternatives 等信息）

### 步骤

1. **分配编号**
   ```bash
   # 扫 docs/adr/ 找最大编号
   ls docs/adr/*.md 2>/dev/null | grep -oE '[0-9]{4}' | sort -n | tail -1
   ```
   - 没有现有 ADR（仅 README）→ 编号 0001（meta ADR 0000 已被占用）
   - 有现有 ADR → 最大编号 +1，仍四位数零填充

2. **从用户描述提取字段**
   - **Title**：5-8 个词，名词性短语，描述决策对象（不是过程）
     - 好：「Use IndexedDB for local cache storage」
     - 不好：「Decided to use IndexedDB」（过程化）
   - **Context**：背景 + 问题 + 约束（为什么需要做这个决策）
   - **Decision**：选择是什么（具体到方案 / pattern / 接口形状）
   - **Consequences**：分 positive / negative / neutral 三栏
     - **Negative 栏不允许为空**——没想到 negative consequence 说明分析不充分，要求用户补充
   - **Alternatives Considered**：至少 1 个，说明为什么没选

3. **生成 slug**
   ```
   slug = title.lower()
            .replace(/[^a-z0-9\s-]+/g, '')   # 删除非字母数字
            .replace(/\s+/g, '-')             # 空格转 dash
            .replace(/^-+|-+$/g, '')          # 删首尾 dash
            .replace(/-+/g, '-')              # 多个 dash 合一个
            .slice(0, 50)                     # 上限 50 字符
   ```
   - title 含中文 → slug 主体用英文翻译；翻译不出来时降级为 `adr-NNNN-untitled`

4. **填模板**
   - 读 `templates/adr-nygard.md`
   - 替换占位符：`{NUMBER}`、`{TITLE}`、`{DATE}` (YYYY-MM-DD)、`{CONTEXT}`、`{DECISION}`、`{CONSEQUENCES_POSITIVE}`、`{CONSEQUENCES_NEGATIVE}`、`{CONSEQUENCES_NEUTRAL}`、`{ALTERNATIVES}`
   - `{SUPERSEDES_LINE}`：new 流程下为空字符串（不写这行）；supersede 流程下为 `- **Supersedes**: ADR-NNNN — <reason>`

5. **写文件**
   - 路径：`docs/adr/NNNN-<slug>.md`
   - 不允许覆盖既有文件（写之前 `test -f` 检查；冲突时报错并要求人工确认）

6. **触发 index 子能力**重建 `docs/adr/README.md`

7. **报告**
   ```
   ✅ 创建 ADR-NNNN: <Title>
      文件：docs/adr/NNNN-<slug>.md
      索引已更新
   ```

---

## supersede — 用新 ADR 替代旧 ADR

### 输入
- 旧 ADR 标识（编号 / 描述 / 模糊指代）
- 新决策描述（同 new 流程）

### 步骤

1. **定位旧 ADR**
   - 编号 → 直接 `docs/adr/NNNN-*.md`
   - 描述 → 调用 grep 子能力辅助定位；若多个候选 → 列出让用户选
   - 模糊 → 反问要求明确，不允许猜

2. **验证旧 ADR 当前状态**
   - 读旧 ADR header
   - 若已是 `Status: Superseded by ADR-X` → 提示用户：「ADR-N 已被 ADR-X 替代。是否再做一次替代（链式 supersede）？」需要用户明确
   - 若已是 `Status: Deprecated` → 提示并要求确认

3. **走 new 流程创建新 ADR**
   - 唯一差异：`{SUPERSEDES_LINE}` 填 `- **Supersedes**: ADR-NNNN(old) — <one-line-reason>`

4. **修改旧 ADR header**
   - 找到 `- **Status**: <current>` 行
   - 替换为 `- **Status**: Superseded by ADR-NNNN(new) — {DATE}`
   - 不修改其他内容（Context / Decision / Consequences 保留作历史依据）

5. **触发 index 重建**

6. **报告**
   ```
   ✅ ADR-NNNN(old) → Superseded by ADR-NNNN(new)
      旧 ADR：docs/adr/NNNN-<old-slug>.md（header 已更新）
      新 ADR：docs/adr/NNNN-<new-slug>.md
      索引已更新
   ```

---

## index — 重建索引

### 步骤

1. **扫描所有 ADR 文件**
   ```bash
   ls docs/adr/*.md | grep -v README
   ```

2. **解析每个文件的 metadata**
   - **只解析 header 块**：从文件开头读到第一个 `## ` 标题前。这避免误把 body 里描述性的 `- **Status**: ...` 当成真 metadata
   - 提取：
     - 编号：从文件名 `NNNN-*.md` 提取
     - Title：第一行 `# ADR-NNNN: <Title>` 的 Title 部分
     - Status：header 块中 `- **Status**: <value>`（取**首次出现**）
     - Date：header 块中 `- **Date**: <YYYY-MM-DD>`（取首次出现）
     - Supersedes：header 块中 `- **Supersedes**: ADR-NNNN`（无则为 `—`）
     - Superseded by：从 Status 行解析（`Superseded by ADR-NNNN` → 提取 NNNN）

3. **生成索引表**
   按编号升序排列。格式见 `references/index-format.md`。

4. **写回 README.md**
   - 读现有 README.md
   - 替换 `<!-- AUTO-GENERATED INDEX BEGIN -->` 和 `<!-- AUTO-GENERATED INDEX END -->` 之间的内容
   - 标记不存在 → 报错并提示用户：「README.md 缺少索引标记。是否走 bootstrap 重建？」

5. **报告**
   ```
   ✅ 索引已重建（N 条 ADR）
      文件：docs/adr/README.md
   ```

---

## list — 按状态列出

### 输入
- 可选过滤：`--status accepted|superseded|deprecated|all`（默认 all）

### 步骤

1. **优先解析 README.md 索引**（最快）
   - 失败（README 不存在 / 表格损坏） → 退回扫文件

2. **过滤 + 排序**
   - 按编号升序
   - status 过滤

3. **输出**
   ```
   ADR-0000 Record Architecture Decisions [Accepted]
   ADR-0001 Use IndexedDB for local cache  [Accepted]
   ADR-0002 Use atom-RPC pattern           [Superseded by ADR-0007]
   ...
   ```

---

## grep — 搜索 ADR 内容

### 输入
- 搜索词

### 步骤

1. **执行 grep**
   ```bash
   grep -l "<term>" docs/adr/*.md
   ```

2. **对每个命中文件取上下文片段**
   ```bash
   grep -n -B 1 -A 2 "<term>" docs/adr/NNNN-*.md
   ```

3. **输出格式**
   ```
   ADR-0001: Use IndexedDB for local cache
      Line 8: ...IndexedDB...
      Line 23: ...IndexedDB 异步 API...

   ADR-0007: Switch from SQLite to IndexedDB
      Line 12: ...IndexedDB...
   ```

---

## bootstrap — 项目从零初始化

### 步骤

1. **检查不存在**
   ```bash
   test ! -d docs/adr
   ```
   存在 → 提示「目录已存在，请改用 index」

2. **创建目录**
   ```bash
   mkdir -p docs/adr
   ```

3. **写 README.md**
   - 读 `templates/readme-template.md`
   - 替换 `{DATE}` 占位符
   - 写入 `docs/adr/README.md`

4. **写 meta ADR (0000)**
   - 读 `templates/meta-adr.md`
   - 替换 `{DATE}` 占位符
   - 写入 `docs/adr/0000-record-architecture-decisions.md`

5. **报告**
   ```
   ✅ ADR 体系已初始化
      docs/adr/README.md（索引 + 使用说明）
      docs/adr/0000-record-architecture-decisions.md（meta ADR）

   后续新决策可用 /ai-flow:adr 添加。
   ```

---

## clarify — 反问

### 步骤

1. 明确说明本 skill 能做的事
2. 列出具体选项让用户选
3. 等用户回应后重新路由

参见 SKILL.md「clarify」段。
