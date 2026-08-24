# 路径悬浮浮窗（方案 C）

## 目标
Assistant 消息渲染时，自动检测文本中的文件/目录路径，绘制虚线下划线暗示可交互，hover 300ms 后验证路径存在并弹出双动作浮窗（在编辑器中打开 / 在资源管理器中打开）。

## 设计约束
- 仅 assistant 消息，排除用户消息
- 排除 Markdown 代码块内的路径
- 路径规则：至少含一个 `/` 或 `\` 分隔符，排除纯文件名
- hover 防抖 300ms 展开 / 200ms 收起
- 复用现有：`path_exists`、`open_in_explorer`、`openReference`、`fileService.readFile`

## 阶段

### 阶段 1: 路径提取工具函数
**文件**: `gui/src/utils/pathDetector.ts`（新建）
- `findPathsInText(text: string): { path: string; start: number; end: number }[]`
  - 正则匹配至少含一个 `/` 或 `\` 的路径
  - 排除纯文件名
  - 返回路径在全文（含 markdown）中的字符偏移
- 测试：绝对路径、相对路径、Windows 盘符、纯文件名应跳过、代码块内路径应跳过（通过调用者传排除区间做交集）

### 阶段 2: DOM 后处理 + 路径悬浮组件
**文件**: `gui/src/components/chat/PathHoverPopover.tsx`（新建）
- `PathHoverPopover` 组件
  - 接收 `anchorBounds: DOMRect | null` 和 `path: string | null`，通过 Portal 渲染到 body
  - hover 300ms 防抖后调用 `path_exists`
  - 展开/收起防抖计时器
  - 浮窗内容：
    - 路径已存在：📄 在编辑器中打开 + 📂 在资源管理器中打开
    - 路径不存在：提示「文件不存在」，按钮置灰
  - 绝对定位，相对于锚点坐标渲染
  - 监听 body mousemove 或使用浮动容器 mouseenter/mouseleave 控制收起

### 阶段 3: MessageItem 集成
**文件**: `gui/src/components/chat/MessageItem.tsx`（修改）
- 在 assistant 消息的 `dangerouslySetInnerHTML` 渲染后（已有 `mdRef`）：
  - 运行 `findPathsInText` 获取路径集合（需排除代码块内的偏移）
  - 遍历路径，在 `mdRef.current` 的文本节点中定位匹配范围，包裹 `<span class="path-scan">` 带虚线下划线样式
  - 虚线下划线 span 注册 onMouseEnter/onMouseLeave，更新 `PathHoverPopover` 的锚点和路径状态

### 阶段 4: 样式和优化
- 虚线下划线样式：`textDecoration: underline dotted var(--accent); textUnderlineOffset: 3px; cursor: pointer;`
- 浮窗样式：与 app 主题一致，圆角边框阴影
- 缓存已验证的路径结果（Map<string, boolean>），避免重复 `path_exists` 调用
- 确保悬浮浮窗不触发消息区的滚动或重排

## 决策日志
| 日期 | 决定 |
|------|------|
| 2026-08-17 | 选方案 C（弱标记悬浮）而非 A（直接转 chip）或 B（划词），避免视觉干扰 |
| 2026-08-17 | 仅 assistant 消息，用户消息不做 |
| 2026-08-17 | hover 时验证 path_exists，而非渲染后批量验证 |
| 2026-08-17 | 路径规则：至少含一个分隔符，排除纯文件名 |
| 2026-08-17 | 排除 Markdown 代码块内的路径 |