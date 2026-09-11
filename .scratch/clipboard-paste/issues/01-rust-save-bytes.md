# 01 — Rust save_bytes 命令（二进制写入）

**What to build:** 新增 `save_bytes` Tauri command 支持二进制文件写入（图片/文件粘贴需要）。

**Blocked by:** None

**Status:** completed

- [x] 添加 `base64 = "0.22"` 到 Cargo.toml
- [x] 新增 `save_bytes(path, base64_data)` Tauri command — base64 解码 → 写入文件，自动创建父目录
- [x] 注册到 `tauri::generate_handler![]`

**实现说明：**
- 用 `base64::engine::general_purpose::STANDARD` 解码
- 前端通过 FileReader + `readAsDataURL` 将 blob 转 base64，拆分 data URL 前缀后传入
