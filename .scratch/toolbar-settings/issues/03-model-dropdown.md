# 03 — Toolbar 模型下拉

**What to build:** 在顶部工具栏添加模型/Profile 下拉菜单，列出可用 profiles，选择后通过 Tauri 命令切换模型并重启后端。

**Blocked by:** 01 — Rust 模型切换命令

**Status:** ready-for-agent

- [ ] 调用 `invoke("list_model_profiles")` 获取 profiles 列表 + 当前 active
- [ ] 显示当前模型的名称（从 profile label 或 model name 取）
- [ ] 点击展开下拉菜单，列出所有 profiles
- [ ] 选择后调用 `invoke("switch_model_profile", { profileId })`
- [ ] 重启过程：StatusBar 显示 "正在切换模型..." → 重启 → "已连接"
- [ ] WebSocket 重连后状态栏更新（现有的 auto-reconnect 自动处理）
- [ ] 工具栏和 ChatStatusBar 中的 model 显示同步更新
- [ ] UI 样式：紧凑 pill 按钮，与权限模式统一风格
