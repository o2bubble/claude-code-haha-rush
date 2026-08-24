# 02 — settingsStore 加 favoriteSkills 字段

**What to build:** `AppSettings` 新增 `favoriteSkills?: string[]`，支持收藏持久化。

**Status:** completed

- [x] Interface 加 `favoriteSkills?: string[]`
- [x] 读取：`getSettings().favoriteSkills ?? []`
- [x] 写入：`updateSettings({ favoriteSkills: [...] })`
- [x] 自动持久化到 settings.json

**实现说明:**
- Optional 字段，旧 settings.json 自动兼容
