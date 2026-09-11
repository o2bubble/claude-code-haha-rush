# 08 — TextItem + RefItem 内容子组件

**What to build:** 创建 `TextItem.tsx` 和 `RefItem.tsx`

**TextItem:**
- [ ] contentEditable div，支持 markdown 书写
- [ ] Markdown 预览 toggle（调用 `marked` 库动态渲染，与 MessageItem 模式一致）
- [ ] `useEffect` → `registerDataSource()` 注册 dataRegistry（keys: text, wordCount, lines）
- [ ] queryHandler: 按 key 返回文本、字数、行数
- [ ] cleanup → `unloadDataSource()`

**RefItem:**
- [ ] 显示 @ref 引用列表（复用 ReferenceLink 组件）
- [ ] 可选附注文本（contentEditable）
- [ ] 点击 ref → `openReference(reference)` 跳转
- [ ] `useEffect` → `registerDataSource()` 注册 dataRegistry（keys: paths, files）
- [ ] queryHandler: 返回引用文件路径列表
