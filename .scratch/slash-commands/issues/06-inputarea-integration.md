# 06 �?InputArea `/` 检测集�?
**What to build:** `InputArea.tsx` 增加 `/` 检测逻辑，触�?`SlashCommandDropdown` 的显�?隐藏/过滤/选中�?
**Blocked by:** 03 (需�?slashCommands 数据), 05 (需要下拉框组件)

**Status:** completed

- [ ] `onInput` handler 增加检测：提取当前文本中最后一�?`/` 后的内容
  - 如果光标前最近的 `/` 在行首（或前面是空格），则触发下�?  - 提取 `/` 到光标位置的文本作为 filter，传给下拉框
- [ ] 如果不在 `/` 上下文，关闭下拉�?- [ ] `onKeyDown` handler 增加�?  - 下拉框打开时，↑↓ �?导航，Enter �?选中（阻止发送），Escape �?关闭
  - 下拉框关闭时，Enter �?正常发�?- [ ] 选中回调：获�?contenteditable 当前文本 �?找到最后一�?`/` 位置 �?替换 `/partial` �?`/cmd ` �?光标移到末尾 �?关闭下拉�?- [ ] 计算下拉框锚点位置：通过 Selection API 获取光标 getBoundingClientRect

**实现说明�?*
- 只检测最后一�?`/`（不支持一行多�?`/`�?- `/` 触发条件：光标位置前最近的 `/` 前面是行�?空格/换行
- 不修改现�?`extractContent()` 逻辑——命令以文本形式发�?- contenteditable �?`/cmd ` 文本会被 `extractContent()` 当作普通文本提�?