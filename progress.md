# 进度日志

## 2026-08-17

### 开始
- 需求确认：Grilling 后确认方案 C（弱标记悬浮浮窗）
- 技术调研：阅读 MessageItem.tsx、referenceActions.ts、referenceParser.ts、clipboardService.ts
- 拆出 4 个阶段 tickets

### 待办
- 阶段 1: 创建 `gui/src/utils/pathDetector.ts` — 路径正则匹配工具
- 阶段 2: 创建 `gui/src/components/chat/PathHoverPopover.tsx` — 悬浮浮窗组件
- 阶段 3: 修改 `gui/src/components/chat/MessageItem.tsx` — 集成路径检测 + 浮窗
- 阶段 4: 样式优化 + 缓存 + 测试