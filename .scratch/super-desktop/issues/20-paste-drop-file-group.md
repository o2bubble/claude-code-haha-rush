# 20 — 画布粘贴/Drop 创建 FileGroupItem

**What to build:** 用户在 Super Desktop 画布上 Ctrl+V 或拖放文件时，自动创建对应的内容块。复用 InputArea 的粘贴逻辑，抽取共享 clipboardService。新增 `file-group` 块类型用于多文件/目录管理。

**Why:**
- 当前画布只能右键手动创建 Text 块，无法通过粘贴/拖放文件来快速建立引用
- InputArea 已有的 paste/drop 逻辑（图片保存、文件引用）应该被复用而非重复实现
- 多文件场景需要专门的容器类型，方便用户浏览和按需发送

---

## Design Decisions

### 粘贴/Drop 分发逻辑

```
Ctrl+V / Drop 到画布
  ├─ image/* → saveClipboardItem → FileGroupItem(单文件)
  ├─ 剪贴板文件(.files) → saveClipboardItem × N → FileGroupItem
  ├─ Drop 已有文件 → 直接 ref 原路径 → FileGroupItem
  ├─ Drop 目录 → 枚举一层文件 → FileGroupItem(含子文件列表)
  └─ 纯文本
       ├─ isRealFilePath(text) — 1s 超时
       │    ├─ true → FileGroupItem(file ref)
       │    └─ false/超时 → TextItem
```

### 位置
- Paste (Ctrl+V): 画布视口中心
- Drop: drop 位置 (`screenToCanvas(e.clientX, e.clientY)`)

---

## Changes

### 1. `gui/src/services/clipboardService.ts` — 新建，从 InputArea 抽取

```ts
// 从 InputArea.tsx 抽出来
saveClipboardItem(blob, baseName?, workDir) → Promise<string | null>

// 新增：检查文本是否是真实存在的文件路径
isRealFilePath(path: string): Promise<boolean>  // 1s 超时
```

### 2. `gui/src/types/desktop.ts` — 新增 FileGroupContent

```ts
export interface FileGroupContent {
  type: "file-group";
  files: Reference[];  // 每个是 file/dir ref
}

// ItemContent 联合补 "file-group"
// ItemContentType 补 "file-group"
```

### 3. `gui/src/components/desktop/FileGroupItem.tsx` — 新建

UI：
- 文件列表，每行：📄/📁 图标 + 文件路径 + "→ Agent" 按钮
- 点击 "→ Agent" → `CHAT_ADD_REFERENCE` 插单个 `@ref{file:...}` chip
- 右键菜单：全选发送到 Agent / 删除块
- 目录节点可展开到下一层（复用文件面板逻辑）

### 4. `gui/src/components/chat/InputArea.tsx` — 改用 clipboardService

- 移除本地 `saveClipboardItem` 实现
- import 共享的 `saveClipboardItem`

### 5. `gui/src/components/desktop/SuperDesktopCanvas.tsx` — 粘贴/Drop

- `onPaste`: 处理 clipboard data
- `onDrop` + `onDragOver`: 处理文件拖放
- 复用 `saveClipboardItem` + `isRealFilePath`

### 6. `gui/src/components/desktop/DesktopItemView.tsx` — 注册渲染

- `renderContent()` switch 加 `case "file-group": return <FileGroupItem .../>`

---

## Verification

- [ ] Ctrl+V 图片 → FileGroupItem 出现在视口中心，文件保存到 `.claude/pasted/`
- [ ] Ctrl+V 纯文本（非文件路径）→ TextItem
- [ ] Ctrl+V 纯文本（真实文件路径）→ FileGroupItem
- [ ] Ctrl+V 纯文本（假路径）→ 1s 超时后 → TextItem
- [ ] Drop 文件到画布 → FileGroupItem 在 drop 位置
- [ ] Drop 目录到画布 → FileGroupItem 含目录内文件列表
- [ ] FileGroupItem 逐条发送 → 输入框出现对应 `@ref` chip
- [ ] 全选发送 → 多个 chip 插入输入框
- [ ] InputArea 粘贴功能不受影响（复用同一个 service）
- [ ] `saveClipboardItem` 行为与抽取前完全一致
