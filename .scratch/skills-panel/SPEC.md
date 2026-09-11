# Skills Panel — Spec

## Problem Statement

斜杠命令系统已完整支持，但浏览和发现技能（prompt 型命令）仍不方便。用户需要在聊天中记忆命令名、手动输入 `/cmd`，无法可视化浏览可用技能。此外，文件引用（@ref）无法直接添加到技能参数中——必须先打开技能对话框，再回到文件树右键发送，但文件引用只会插入到聊天输入框，无法路由到技能对话框。

## Solution

新增 **Skills Panel**——可搜索的技能列表，点击弹出浮动对话框，支持 contenteditable 输入（含 @ref chip），直接发送格式化命令到 agent。收藏功能置顶常用技能。

## User Stories

1. 作为 GUI 用户，我希望在侧边栏看到 "Skills" 面板，列出所有可用的 prompt/skill 型命令
2. 作为 GUI 用户，我可以通过搜索框过滤技能列表
3. 作为 GUI 用户，点击技能后弹出浮动对话框，显示技能名和描述
4. 作为 GUI 用户，对话框中的输入区支持多行文本编辑（Enter 换行，Shift+Enter 发送）
5. 作为 GUI 用户，对话框打开时，文件树右键"发送到聊天"的 @ref 应插入到对话框中，而非聊天输入框
6. 作为 GUI 用户，点击发送后，格式化的 `/cmd args` 消息直接发送给 agent
7. 作为 GUI 用户，点击星标可收藏技能，收藏后置顶显示
8. 作为 GUI 用户，收藏列表在重启 GUI 后仍然保持
9. 作为 GUI 用户，对话框可以拖动、调整大小，跨 panel 显示
10. 作为 GUI 用户，关闭对话框通过 FloatingRenderer 的 × 按钮或 Escape 键

## Implementation Decisions

### 浮动窗口模式（与 AskQuestion 同款）
- `addFloatingPanel` + `panelId: "skill-dialog"`
- `SkillDialogFloating` — 模块级回调 + chatStore 读数据
- 关闭检测：drag 时 `getFloatingPanels().some(fp => fp.id === _floatId)` → true → 不触发 skip
- 真关闭：panel 已从 store 移除 → `!stillExists` → 触发 skip + 清回调

### 输入区（contentEditable 替代 textarea）
- 复用 `extractContent()` 逻辑（含 `\u00A0` 归一化）
- 监听 `CHAT_ADD_REFERENCE` 事件插入 @ref chip
- **路由机制**：InputArea 的 `CHAT_ADD_REFERENCE` handler 检查 `getChatState().activeSkillDialog`——非 null 时跳过，让 SkillDialog 接管

### 发送机制
- `commands.execute("SEND_MESSAGE", content)` — 复用已注册的命令
- 消息格式：`/cmd args`（如有参数）或 `/cmd`（无参数）

### 收藏持久化
- `settingsStore.favoriteSkills?: string[]` — 可选字段，默认 undefined
- 读取：`getSettings().favoriteSkills ?? []`
- 保存：`updateSettings({ favoriteSkills: [...] })` → 自动持久化到 settings.json

### 命令类型区分（后端）
- `broadcastSlashCommands` 透传 command.type（`prompt` | `local` | `local-jsx`），不再硬编码 `'local'`
- SkillsPanel 过滤 `c.type === "prompt" || c.type === "skill"`

## Testing Decisions

- 测试技能列表是否正确过滤（prompt + skill 类型）
- 测试对话框打开/关闭/发送完整流程
- 测试 @ref chip 在对话框中的插入和提取
- 测试对话框打开时，聊天输入框不再接收 @ref
- 测试收藏持久化（重启后保持）
- 测试对话框中 Enter 换行和 Shift+Enter 发送

## Out of Scope

- 对话框中的 `/` 命令补全
- 技能图标/分类
- 技能详情页（更多介绍）
- 对话历史中展示技能调用参数

## Further Notes

### 架构复用
- 浮动窗口生命周期：完全参考 `AskQuestionFloating`（close/cleanup 回调模式）
- @ref 插入逻辑：复用 `InputArea` 的 `insertChipAtCursor`（本地副本）
- 发送路径：复用 `useChatBridge` 的 `SEND_MESSAGE` 命令

### 关键文件
| 文件 | 类型 |
|------|------|
| `gui/src/components/chat/SkillsPanel.tsx` | 新建 — 面板组件 |
| `gui/src/components/chat/SkillDialog.tsx` | 新建 — 对话框内容 |
| `gui/src/components/chat/SkillDialogFloating.tsx` | 新建 — 浮动窗口包装 |
| `gui/src/stores/chatStore.ts` | 修改 — `activeSkillDialog` 字段 |
| `gui/src/stores/settingsStore.ts` | 修改 — `favoriteSkills` 字段 |
| `gui/src/components/chat/InputArea.tsx` | 修改 — CHAT_ADD_REFERENCE guard |
| `gui/src/components/chat/useChatBridge.ts` | 修改 — SEND_MESSAGE 命令 |
| `gui/src/App.tsx` | 修改 — 面板注册 |
| `src/entrypoints/ideMode.ts` | 修改 — type 透传 |
