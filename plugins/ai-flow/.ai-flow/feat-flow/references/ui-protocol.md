# UI 设计来源对齐子协议

适用于 Stage 1 当需求涉及任何 UI 改动（新页面、新组件、视觉调整）时。

## 步骤 1：识别 UI 来源

询问用户：
- A. Figma 链接（请提供 URL）
- B. 文字描述
- C. 允许 AI 提议（用户后续签字确认）

## 步骤 2：列出 UI 涉及的视图与状态维度

对每个识别到的视图，按下列**六类维度**列出需对齐的状态：

- **数据状态**：空 / 单 / 多 / 边界
- **加载状态**：初始 / 刷新 / 分页
- **错误状态**：网络 / 权限 / 业务 / 校验
- **交互状态**：hover / focus / disabled / loading
- **流程分支**：成功 / 失败 / 取消 / 撤销 / 确认对话
- **响应式**：桌面 / 移动 / 小窗（若产品需要）

## 步骤 3：来源 A 处理（Figma）

1. dispatch figma MCP subagent 读取设计稿（get_design_context / get_screenshot / get_metadata）
2. 列出 Figma 已**明确画出**的状态/视图
3. **不假设 Figma URL 覆盖了所有状态**——用户提供的 Figma 常只是一个 frame，其他状态需逐项 gap closure

## 步骤 4：对每一项「未明确覆盖」进行独立代码探索（关键）

**不依赖 Stage 1 入场时的代码探索**——那次的范围可能不覆盖 UI 组件层。

对每一项（视图 × 维度）未明确覆盖的：
1. dispatch 专门的 UI 探索 subagent，或主 session Grep + Read 项目里的：
   - 公共组件库（src/components/、design-system/）
   - 已实现的相似页面的 fallback
   - 全局错误处理 / loading / 空态组件
2. 探索目标：找出该状态是否已被项目里现有组件 / 模式处理

## 步骤 5：每一项必须显式对齐（不允许默认沿用）

**如果**找到现有复用组件已处理该状态：
- 向用户呈现：「发现 `<ComponentName>`（path:line）已处理此状态，表现为 X。**是否沿用？**」
- 用户必须显式回答（yes / no / 需变种）
- 沿用 → design.md 记 `[复用 <ComponentName>，路径，已与用户确认]`
- 不沿用 → 走步骤 6

**如果**未找到现有处理 → 直接进步骤 6

## 步骤 6：让用户三选一

对每一项真正需要新做的状态：
- 用户补 Figma URL → 回步骤 3
- 用户给文字描述 → design.md 记 `[用户文字]<描述>`
- 用户允许 AI 提议 → AI 写描述，design.md 记 `[AI 提议，待确认]<描述>`

## 步骤 7：gap closure 硬性要求

**不允许 Signal 直到**：
- 每个视图、每类维度都在 design.md 中有归属
- 每项归属都标注来源（`[Figma]` / `[复用 <Component>]` / `[用户文字]` / `[AI 提议]`）
- 复用项必须含「已与用户确认」标记
- 用户给的 Figma URL **不被默认视为「全覆盖」**——每个未在 Figma 明确出现的状态都要走步骤 4-6

## 写入 design.md 的格式

```markdown
## UI 设计与状态清单

### 视图：缓存列表页（CacheListPage）

**来源**：[Figma frame 1](url-A)

**状态覆盖**：
| 维度 | 表现 | 来源 |
|------|------|------|
| 正常列表（≥1 项） | 按时间倒序卡片 | [Figma](url-A) frame 1 |
| 空态（零项） | 居中插画 + "暂无缓存" + 刷新按钮 | [用户文字] |
| 加载中 | 复用 LoadingSkeleton | [复用 src/components/LoadingSkeleton.tsx:8] 已确认沿用 |
| 错误态 | Toast + 重试 CTA | [Figma](url-B) frame 3 |
| 网络错 | 同错误态变文案 | [用户文字] |
| Hover/Focus | 卡片阴影抬升 4px | [Figma](url-A) interactive |

**响应式**：仅桌面（用户已确认无需移动适配）
```
