# 18 — "Send to Agent" 改为插入 @ref chip 到输入框

**What to build:** 右键菜单 "Send to Agent" 不再直接发送消息，而是将当前内容块以 `@ref{desktop-item:<type>/<uuid>|<label>}` 格式插入到聊天输入框。AI 看到 ref 后自行决定读取/操作数据。

**Why:**
- 当前直接 `SEND_MESSAGE` 剥夺了 AI 的决策权——AI 应该自己决定怎么处理这个块的数据
- @ref 格式已经在 `CHAT_ADD_REFERENCE` → `InputArea.insertChipAtCursor` 链条中支持
- path 中包含 type（text/chart/graphic/ref），AI 无需额外查询就能知道内容类型

**Ref 格式规范:**
```
@ref{desktop-item:text/<uuid>|<label>}     → TextItem
@ref{desktop-item:chart/<uuid>|<label>}    → ChartItem
@ref{desktop-item:graphic/<uuid>|<label>}  → GraphicItem
@ref{desktop-item:ref/<uuid>|<label>}      → RefItem
```

---

## Changes

### 1. SuperDesktopCanvas.tsx — 重写 "Send to Agent" 回调

- 移除 `commands.execute("SEND_MESSAGE", text)` 及上面的 content→text 格式化代码（217-223 行）
- 改为 `eventBus.emit(Events.CHAT_ADD_REFERENCE, { type: "desktop-item", path: "<type>/<uuid>", label: item.label })`
- `path` = `${item.content.type}/${item.id}`
- 需要确保已 import `eventBus` 和 `Events`（当前可能已 import Events，需确认 eventBus）

### 2. referenceActions.ts — `desktop-item` handler 解析 type/uuid 路径

- 当前 L65: `eventBus.emit(Events.DESKTOP_ITEM_SELECTED, { itemId: ref.path })`
- `ref.path` 现在是 `chart/uuid` 格式，需提取 UUID：`ref.path.includes("/") ? ref.path.split("/").slice(1).join("/") : ref.path`
- 用 `join("/")` 而非 `[1]` 防御 UUID 中偶尔出现的额外 `/`

### 3. InputArea.tsx L17 — `CHIP_ICONS` 补 desktop-item

```ts
// 当前缺少 desktop 和 desktop-item
const CHIP_ICONS: Record<string, string> = {
  file: "📄", dir: "📁", line: "📄", panel: "📋",
  session: "💬", paste: "📋",
  // 补：
  desktop: "🖥️", "desktop-item": "📌",
};
```

### 4. ReferenceLink.tsx L5 — `TYPE_ICONS` 补 desktop-item

```ts
const TYPE_ICONS: Record<string, string> = {
  file: "📄", dir: "📁", line: "📄", panel: "📋",
  session: "💬", paste: "📋",
  // 补：
  desktop: "🖥️", "desktop-item": "📌",
};
```

### 5. ReferenceLink.tsx — `displayLabel` 适配 path 格式

当前 `displayLabel` 用 `ref.path.split(/[/\\]/).pop()` 取 basename。对于 `desktop-item`，path 是 `chart/uuid`，`pop()` 会拿到 UUID，但已有 `ref.label` 时会优先用 label。**不需要改**——label 已包含可读名称，fallback 显示 UUID 也不影响功能。

---

## 不需要改的文件

| 文件 | 原因 |
|------|------|
| `referenceParser.ts` | `formatReference` 直接拼接 `type:path`，`parseReferences` 正确解析 `type:chart/uuid` 格式 |
| `SkillDialog.tsx` | 复用 `formatReference`，没有硬编码 path 格式 |
| `DesktopItemView.tsx` | `data-desktop-item` 属性用 `item.id`(UUID)，不涉及 ref path |

---

## Verification

- [ ] 右键 Text → "Send to Agent" → 输入框出现 `📌 label` chip，hover 显示 `@ref{desktop-item:text/...}`
- [ ] 右键 Chart → "Send to Agent" → 同上，path 含 `chart/`
- [ ] 右键 Graphic → "Send to Agent" → 同上，path 含 `graphic/`
- [ ] 右键 Ref → "Send to Agent" → 同上，path 含 `ref/`
- [ ] chip 追加到光标位置，不替换已有内容，不自动发送
- [ ] 消息渲染中的 `@ref{desktop-item:...}` 正确显示为可点击的 ReferenceLink
- [ ] 点击消息中的 ReferenceLink → 激活 Super Desktop 面板 + emit DESKTOP_ITEM_SELECTED(UUID)
- [ ] `formatReference` → `parseReferences` 往返后 path 不变
- [ ] `parseReferences("@ref{desktop-item:chart/uuid|Label}")` → `{ type: "desktop-item", path: "chart/uuid", label: "Label" }`
