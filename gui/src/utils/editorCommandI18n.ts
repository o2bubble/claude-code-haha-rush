// ── Monaco 编辑器命令国际化 — action id → 中文 label ──
// 覆盖核心编辑操作。未覆盖的命令保持 Monaco 英文原文。

export const MONACO_COMMAND_ZH: Record<string, string> = {
  // 撤销 / 重做
  "undo": "撤销",
  "redo": "重做",

  // 剪贴板
  "editor.action.clipboardCutAction": "剪切",
  "editor.action.clipboardCopyAction": "复制",
  "editor.action.clipboardPasteAction": "粘贴",

  // 选择
  "editor.action.selectAll": "全选",
  "editor.action.selectToBracket": "选择到括号",
  "editor.action.selectHighlights": "选择所有高亮",
  "editor.action.selectToNextFindMatch": "选择到下一个匹配",
  "editor.action.selectToPreviousFindMatch": "选择到上一个匹配",
  "editor.action.smartSelect.grow": "扩展选区",
  "editor.action.smartSelect.shrink": "收缩选区",
  "editor.action.splitSelectionIntoLines": "将选区拆分为多行",

  // 查找 / 替换
  "editor.action.find": "查找",
  "editor.action.startFindReplaceAction": "替换",
  "editor.action.nextMatchFindAction": "查找下一个",
  "editor.action.previousMatchFindAction": "查找上一个",
  "editor.action.nextSelectionMatchFindAction": "选择下一个匹配",
  "editor.action.previousSelectionMatchFindAction": "选择上一个匹配",
  "editor.action.selectAllMatches": "全选所有匹配",
  "editor.action.changeAll": "全部更改",
  "editor.action.addSelectionToNextFindMatch": "添加到下一个匹配选择",
  "editor.action.addSelectionToPreviousFindMatch": "添加到上一个匹配选择",
  "editor.action.moveSelectionToNextFindMatch": "移动到下一个匹配选择",
  "editor.action.moveSelectionToPreviousFindMatch": "移动到上一个匹配选择",

  // 多光标
  "editor.action.addCursorAbove": "在上面添加光标",
  "editor.action.addCursorBelow": "在下面添加光标",
  "editor.action.addCursorsToBottom": "在底部添加光标",
  "editor.action.addCursorsToTop": "在顶部添加光标",
  "editor.action.addCursorsToLineEnds": "在行尾添加光标",
  "editor.action.addCursorsToLineStarts": "在行首添加光标",
  "editor.action.insertCursorAbove": "在上面插入光标",
  "editor.action.insertCursorBelow": "在下面插入光标",
  "editor.action.columnSelectUp": "向上列选择",
  "editor.action.columnSelectDown": "向下列选择",
  "editor.action.columnSelectLeft": "向左列选择",
  "editor.action.columnSelectRight": "向右列选择",

  // 行操作
  "editor.action.moveLinesUpAction": "向上移动行",
  "editor.action.moveLinesDownAction": "向下移动行",
  "editor.action.copyLinesUpAction": "向上复制行",
  "editor.action.copyLinesDownAction": "向下复制行",
  "editor.action.deleteLines": "删除行",
  "editor.action.insertLineAfter": "在下方插入行",
  "editor.action.insertLineBefore": "在上方插入行",
  "editor.action.indentLines": "缩进行",
  "editor.action.outdentLines": "减少缩进",
  "editor.action.indentToBracket": "缩进到括号",
  "editor.action.outdentToBracket": "减少缩进到括号",
  "editor.action.sortLinesAscending": "升序排序行",
  "editor.action.sortLinesDescending": "降序排序行",
  "editor.action.trimTrailingWhitespace": "删除尾随空格",
  "editor.action.joinLines": "合并行",
  "editor.action.transpose": "交换字符",
  "editor.action.removeDuplicateLines": "删除重复行",

  // 注释 / 格式
  "editor.action.commentLine": "切换行注释",
  "editor.action.blockComment": "切换块注释",
  "editor.action.formatDocument": "格式化文档",
  "editor.action.formatSelection": "格式化选中内容",
  "editor.action.formatDocument.force": "强制格式化文档",

  // 折叠
  "editor.fold": "折叠",
  "editor.unfold": "展开",
  "editor.foldRecursively": "递归折叠",
  "editor.unfoldRecursively": "递归展开",
  "editor.foldAll": "全部折叠",
  "editor.unfoldAll": "全部展开",
  "editor.foldAllBlockComments": "折叠所有块注释",
  "editor.foldAllMarkerRegions": "折叠所有标记区域",
  "editor.unfoldAllMarkerRegions": "展开所有标记区域",

  // 导航 / 浏览
  "editor.action.goToLine": "转到行",
  "editor.action.revealDefinition": "转到定义",
  "editor.action.revealDefinitionAside": "侧边打开定义",
  "editor.action.goToImplementation": "转到实现",
  "editor.action.goToTypeDefinition": "转到类型定义",
  "editor.action.goToReferences": "转到引用",
  "editor.action.showHover": "显示悬停提示",
  "editor.action.quickFix": "快速修复",
  "editor.action.rename": "重命名符号",
  "editor.action.sourceAction": "源码操作",
  "editor.action.showDefinitionPreviewHover": "显示定义预览",
  "editor.action.triggerSuggest": "触发建议",
  "editor.action.triggerParameterHints": "触发参数提示",

  // 视图
  "editor.action.toggleWordHighlight": "切换单词高亮",
  "editor.action.wordHighlight.next": "下一个单词高亮",
  "editor.action.wordHighlight.strongly": "强烈单词高亮",
  "editor.action.toggleTabFocusMode": "切换 Tab 焦点模式",
  "editor.action.toggleRenderWhitespace": "切换空白字符显示",
  "editor.action.toggleMinimap": "切换迷你地图",
  "editor.action.toggleRenderControlCharacter": "切换控制字符显示",
  "editor.action.toggleWordWrap": "切换自动换行",
  "editor.action.inspectTokens": "检查令牌",
  "editor.action.showAccessibilityHelp": "显示辅助功能帮助",
  "editor.action.fontZoomIn": "字体放大",
  "editor.action.fontZoomOut": "字体缩小",
  "editor.action.fontZoomReset": "重置字体大小",

  // 标记 / 出现
  "editor.action.addCommentMarker": "添加注释标记",
  "editor.action.addNextOccurrence": "添加下一个出现",
  "editor.action.addPreviousOccurrence": "添加上一个出现",
  "editor.action.removeOccurrences": "移除出现",
  "editor.action.selectAllOccurrences": "选择所有出现",
  "editor.action.nextOccurrence": "下一个出现",
  "editor.action.previousOccurrence": "上一个出现",

  // 其他
  "editor.action.defineKeybinding": "自定义键绑定",
  "editor.action.showSnippets": "显示代码片段",
};

/** 取 Monaco 命令的中文 label，未覆盖保持原文 */
export function localizeEditorCommand(id: string, label: string): string {
  return MONACO_COMMAND_ZH[id] ?? label;
}
