# 03 — 消息列表中的引用链接渲染

**What to build:** 在 `MessageItem.tsx` 中检测消息文本里的 `@ref{...}` 并将其渲染为可点击的内联链接。

**Blocked by:** 02 — 引用解析器

**Status:** ready-for-agent

- [ ] 创建 `ReferenceLink.tsx` 组件：接收 `ParsedReference`，渲染为可点击的 `<span>`（蓝色、下划线、cursor:pointer）
- [ ] 类型对应图标：file→File icon、dir→FolderOpen icon、panel→对应 panel 图标
- [ ] 显示文本：`label` 有值时显示 label，否则显示 `path` 的 basename
- [ ] hover 显示 tooltip：完整路径或描述
- [ ] 在 `MessageItem.tsx` 的 markdown 渲染后，将文本中的 `@ref{...}` 替换为 `<ReferenceLink>` 组件
- [ ] 或者：在渲染层处理，对非 user 消息先 `parseReferences` 再切分文本段渲染

**实现说明：**
- 最简单方案：在 `renderMarkdown` 之前，先对原始文本做引用替换，但 markdown 渲染可能干扰
- 推荐方案：先 markdown 渲染，再用 DOM 遍历替换文本节点中的 `@ref{...}`
- 或者用 useMemo 直接切分纯文本，跳过 markdown 对引用行的影响
- user 消息不需要解析引用（不会展示 markdown，直接渲染文本）
