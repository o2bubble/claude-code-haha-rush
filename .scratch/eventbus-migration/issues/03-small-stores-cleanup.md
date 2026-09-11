# 03 — 小 store 迁移 + useChatConnection 清理

**What to build:** 将 editorStore、settingsStore、i18n、panelRegistry 的自定义 subscribe 替换为 EventBus。删除 useChatConnection.ts（与 backendService 功能重复），ChatInputPanel 改用 useBackend。

**Blocked by:** 02 — layoutStore EventBus 迁移

**Status:** ready-for-agent

- [ ] editorStore: 删 subscribe/notify，改为 `eventBus.emit(EDITOR_CHANGED, {tabs, activePath}, sticky)`
- [ ] settingsStore: 删 subscribe/listeners，改为 `eventBus.emit(SETTINGS_CHANGED, {settings}, sticky)`
- [ ] i18n: 删 subscribe/listeners，改为 `eventBus.emit(LANGUAGE_CHANGED, {language}, sticky)`
- [ ] panelRegistry: 删 subscribe/listeners，改为 `eventBus.emit(PANEL_REGISTRY_CHANGED, {panels}, sticky)`
- [ ] EditorPanel、SettingsPanel、FileBrowserPanel: subscribe → useEventHandler/useEvent
- [ ] App.tsx: i18nSubscribe → eventBus.on(LANGUAGE_CHANGED)
- [ ] LayoutRenderer: panelSubscribe → useEventHandler(PANEL_REGISTRY_CHANGED)
- [ ] 删除 useChatConnection.ts，ChatInputPanel 改用 useBackend().port
