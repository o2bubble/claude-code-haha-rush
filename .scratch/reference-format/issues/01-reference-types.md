# 01 — Reference 类型定义

**What to build:** `gui/src/types/reference.ts` — 统一定义引用类型和相关工具类型。

**Blocked by:** None

**Status:** ready-for-agent

- [ ] 定义 `ReferenceType = "file" | "dir" | "line" | "panel" | "session"`（可后续扩展）
- [ ] 定义 `Reference` interface: `{ type, path, startLine?, endLine?, label? }`
- [ ] 定义 `ParsedReference = Reference & { raw: string; start: number; end: number }`（解析器用）
- [ ] 确保 `path` 对所有类型都适用：file/dir 是文件系统路径，panel 是 panelId，session 是 sessionId

**实现说明：**
- `line` 类型表示文件中的行范围，`path` 存文件路径
- `label` 可选，用于显示时覆盖默认文本
