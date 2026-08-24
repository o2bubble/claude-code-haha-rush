# UI 字体缩放系统

**Status:** implemented (2026-07-28)

---

## Problem Statement

用户视力情况不同，需要在 GUI 中调整文字大小。之前的尝试（CSS `zoom`、`transform: scale()`、`-webkit-text-size-adjust`）都有副作用——要么布局错乱、要么鼠标坐标偏移、要么完全不生效。

## Solution

CSS 变量 `--font-scale` + `calc()` 模式。只缩放文字渲染，不影响布局、坐标、交互。

```
用户拖滑块选择缩放比例
  → updateSettings({ uiFontSize: 120 })
    → App.tsx 设 document.documentElement.style.setProperty("--font-scale", "1.2")
      → 所有 "calc(var(--font-scale, 1) * 14px)" 自动放大
```

## Lessons Learned

### 为什么 `zoom` 不行

CSS `zoom` 是非标准属性，它的工作方式是先按原始尺寸布局，再整体缩放渲染。但浏览器事件系统（鼠标坐标、点击检测、`getBoundingClientRect`）基于原始坐标系：

- 视觉上元素在某处，但浏览器认为元素在另一个位置
- 拖拽时 `movementX/Y` 可能是屏幕像素而非 CSS 像素
- 比例不一致导致"元素跟不上鼠标"
- 不同 WebView 内核表现不一致

### 为什么 `transform: scale()` 不行

- 视觉缩放但不影响布局盒子 → 需要逆尺寸补偿
- 即便补偿了尺寸，`getBoundingClientRect` 依然返回原始坐标
- 浮层、context menu 的绝对定位在 scale 后的坐标系中错位

### 为什么 `-webkit-text-size-adjust` 不行

- 这是**移动端**专用属性，桌面 Chromium/WebView2 完全忽略

## Implementation

### CSS Variable

```tsx
// App.tsx
useEffect(() => {
  document.documentElement.style.setProperty("--font-scale", (uiFontSize / 100).toFixed(2));
}, [uiFontSize]);
```

### Inline Style Pattern

```tsx
// ✅ 会缩放
fontSize: "calc(var(--font-scale, 1) * 14px)"

// ❌ 不会缩放
fontSize: 14
```

### Slider (SettingsPanel → General)

```
70% – 150%，步长 10%
松手后应用，拖动期间不触发全局缩放（避免抽搐）
```

### Settings

- **TS**: `AppSettings.uiFontSize?: number`，默认 100
- **Rust**: `AppSettings { ui_font_size: f64, #[serde(default = "default_ui_font_size")] }`，默认 100.0
- **i18n**: `settings.uiFontSize: "字体缩放"` / `"Font Scale"`

## Coverage (70+ 处，11+ 文件)

| 文件 | 缩放内容 |
|------|---------|
| SettingsPanel.tsx | 标签、输入框、下拉、关于页 |
| SkillsPanel.tsx | 技能名、描述、按钮、标签 |
| SessionPanel.tsx | 会话标题、操作按钮 |
| Toolbar.tsx | 下拉菜单、按钮、会话/git 标签 |
| StatusBar.tsx | 消息日志 |
| ChatInputPanel.tsx | 权限提示、状态栏 |
| PlanPanel.tsx | 任务内容、历史标题 |
| ContextMenu.tsx | 菜单项 |
| MessageItem.tsx | 消息气泡、引用栏 |
| InputArea.tsx | 输入文本、@ref 标签 |
| FileTree.tsx | 文件/文件夹名、空状态、重命名输入 |

## Design Rule

**写 UI 代码时必须判断 fontSize 是否需要纳入缩放：**
- **应纳入**：用户阅读的文字（标签、消息、描述、标题、按钮文字、输入区、Tab名、菜单项）
- **不应纳入**：≤10px 的辅助标记（badge、箭头、计数器）、图标字符（● ✓ ▶ 🖼）、编辑器/终端字体（有自己的设置）、代码块
