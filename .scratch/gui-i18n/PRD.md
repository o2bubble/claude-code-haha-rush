# GUI 国际化 (i18n) — PRD

> 2026-07-20

## 目标

GUI 当前所有文本硬编码为英文。需要支持中文/英文切换，默认中文，语言设置持久化到 `settings.json`。

## 设计

### 语言选择

- `zh` (简体中文) — 默认
- `en` (English)

设置存储在 `AppSettings.language`，跟随 `%APPDATA%/claude-code-gui/settings.json` 持久化。

### 架构

```
gui/src/i18n/
├── index.ts          # t(key), setLanguage(lang), getLanguage()
├── zh.ts             # 中文 locale
└── en.ts             # 英文 locale
```

- **嵌套 key 结构**：`t("toolbar.toggleLeft")` → "切换左侧面板"
- **模块级状态**：与 layoutStore 同款 subscribe 模式
- **类型安全**：`LocaleKey` 类型约束 key path

### 数据模型

**`AppSettings` 扩展**：
```ts
interface AppSettings {
  workDir: string;
  isFirstLaunch: boolean;
  language: "zh" | "en";  // 新增，默认 "zh"
}
```

**Rust 侧**：`AppSettings` struct 加 `language` 字段。

### UI 变更

**SettingsPanel 新增**：
- 语言下拉框：中文 / English
- 切换时即时生效（调用 `setLanguage` + 更新 settingsStore）

**受影响的组件**（硬编码文本 → `t()` 调用）：
| 文件 | 文本数 | 示例 key |
|------|--------|----------|
| `LayoutRenderer.tsx` | ~12 | `menu.hide`, `menu.splitRight`, `menu.openNewWindow` |
| `ChatPanel.tsx` | ~10 | `chat.placeholder`, `chat.send`, `chat.connecting` |
| `SessionPanel.tsx` | ~6 | `sessions.title`, `sessions.notConnected` |
| `SettingsPanel.tsx` | ~8 | `settings.title`, `settings.workDir`, `settings.browse` |
| `FirstLaunchWizard.tsx` | ~6 | `wizard.title`, `wizard.subtitle`, `wizard.start` |
| `FileBrowserPanel.tsx` | ~2 | `files.notConfigured` |
| `Toolbar.tsx` | ~4 | `toolbar.toggleLeft`, `toolbar.settings` |
| `FloatingRenderer.tsx` | ~5 | `float.closeTab`, `float.openNewWindow` |
| `TasksPanel.tsx` | ~5 | `tasks.running`, `tasks.done` |
| `FloatingApp.tsx` | ~4 | `placeholder.chat`, `placeholder.sessions` |

### 不受影响的部分

- 聊天消息内容（后端返回，非 UI 文本）
- 文件名、路径等动态数据
- 调试日志

## Implementation

### Phase 1: 基础设施
- [ ] `gui/src/i18n/zh.ts` + `en.ts` locale 文件
- [ ] `gui/src/i18n/index.ts` t() + subscribe
- [ ] `types/layout.ts` → `types/gui.ts` 加 `Language` type
- [ ] `AppSettings` 加 `language` 字段（TS + Rust）
- [ ] settingsStore 持久化语言

### Phase 2: 逐步替换
1. [ ] Toolbar.tsx — 4 处
2. [ ] SettingsPanel.tsx — 8 处 + 语言下拉框
3. [ ] FirstLaunchWizard.tsx — 6 处
4. [ ] SessionPanel.tsx — 6 处
5. [ ] ChatPanel.tsx — 10 处
6. [ ] FileBrowserPanel.tsx — 2 处
7. [ ] TasksPanel.tsx — 5 处
8. [ ] FloatingRenderer.tsx — 5 处
9. [ ] LayoutRenderer.tsx — 12 处
10. [ ] FloatingApp.tsx — 4 处

### Phase 3: Settings 集成
- [ ] SettingsPanel 加语言下拉框
- [ ] 切换语言时触发全 UI 重渲染

## 验证

1. 默认启动显示中文 UI
2. Settings 中切换为 English → 即时刷新
3. 重启后保持上次选择的语言
4. `t()` 调用不存在的 key → 返回 key 本身（fallback）
