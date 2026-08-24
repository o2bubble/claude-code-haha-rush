# 05 �?SlashCommandDropdown 组件

**What to build:** 新建 `gui/src/components/chat/SlashCommandDropdown.tsx`，React portal 渲染的命令下拉框�?
**Blocked by:** 02 (需�?chatStore.slashCommands 数据)

**Status:** completed

- [ ] Props: `{ filter: string, onSelect: (cmd: string) => void, onClose: () => void, anchorRect: DOMRect }`
- [ ] �?`chatStore` �?props 读取 `slashCommands`
- [ ] 过滤：`cmd.cmd.includes(filter)` �?`cmd.desc.includes(filter)`
- [ ] 渲染：portal �?`document.body`，绝对定位在 `anchorRect` 下方
- [ ] 键盘导航：↑�?移动高亮，Enter 选中，Escape 关闭
- [ ] 鼠标：hover 高亮，click 选中
- [ ] 显示格式：`/cmd` + 灰色描述文字，左对齐
- [ ] 滚动：列表过长时 `maxHeight: 300px` + `overflow: auto`
- [ ] 选中后回�?`onSelect(cmd.cmd)`，InputArea 侧负责插入文本并关闭
- [ ] 视觉风格：白�?+ 边框 + 阴影，匹�?GUI 浅色主题（Segoe UI, 12px�?
**实现说明�?*
- 使用 `ReactDOM.createPortal` 渲染�?body
- anchorRect �?InputArea 通过 `getBoundingClientRect()` + Selection API 计算
- 不直接操�?contenteditable DOM——通过 callback 通知 InputArea
