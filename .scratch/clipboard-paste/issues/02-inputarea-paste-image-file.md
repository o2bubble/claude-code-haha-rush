# 02 — InputArea 粘贴图片/文件处理

**What to build:** paste 事件检测剪贴板中的图片和文件，自动保存到 `<workspace>/.claude/pasted/`，插入 `@ref{file:path|name}` chip。

**Blocked by:** 01 — save_bytes 命令

**Status:** completed

- [x] 通过 `useEvent<SettingsChangedPayload>` 获取 workDir
- [x] `saveClipboardItem(blob, baseName?)` 辅助函数：blob → base64 → invoke save_bytes → 返回文件路径
- [x] 图片（`image/*`）：从 `clipboardData.items` 检测，自动命名 `pasted-<timestamp>.<ext>`
- [x] 文件（`clipboardData.files`）：保留原名，保存到 pasted 目录
- [x] 文件名冲突处理：同名文件会自动创建父目录，Tauri 的 `create_dir_all` 确保目录存在
- [x] 保存后插入 `@ref{file:<path>|<name>}` chip，可点击删除
- [x] 图片/文件优先于文本处理（`items` → `files` → `text` 检测顺序）

**实现说明：**
- 文件保存到 `<workspace>/.claude/pasted/`，agent 可通过相对路径引用
- base64 编码通过浏览器原生 `FileReader.readAsDataURL` 完成（性能优于 JS 循环）
- 如果 workDir 未配置，图片/文件粘贴静默跳过
