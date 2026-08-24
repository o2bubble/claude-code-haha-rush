# 研究发现

## 消息渲染机制
- assistant 消息使用 `renderMarkdown()`（`marked` 库）→ `dangerouslySetInnerHTML` 插入 HTML
- 无法直接在 JSX 中插入路径组件，必须通过 **DOM 后处理**（类似已有的代码块复制按钮注入方式）
- `mdRef` ref 指向 markdown 容器 div，可以操作其 DOM

## 路径检测策略
- 需在原始 markdown 文本（`text` 变量）上运行正则匹配
- 然后与代码块区间做交集排除（找到所有 `<pre><code>` 的偏移区间）
- 将匹配范围映射到渲染后 DOM 的 TextNode 上包裹 span

## 可用基础设施
- `isRealFilePath()` / `path_exists` — 验证路径存在
- `open_in_explorer` — 在资源管理器中打开
- `openReference` — 在编辑器中打开（可复用 fileService.readFile + editorStore.openFile）
- `path` 匹配需兼容正斜杠和反斜杠两种格式

## 渲染后 DOM 修改
- `mdRef.current.innerHTML` 中的文本节点定位需要稳健的 TextNode 遍历
- 类似代码块复制按钮的注入模式（useEffect + container.querySelectorAll）
- 使用 TreeWalker 遍历 TextNode，匹配 path 偏移