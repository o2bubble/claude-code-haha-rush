// ── 编辑器命令国际化 — id → 中文 label ──

import { describe, it, expect } from "vitest";
import { MONACO_COMMAND_ZH, localizeEditorCommand } from "./editorCommandI18n";

describe("localizeEditorCommand", () => {
  it("覆盖的 id 返回中文", () => {
    expect(localizeEditorCommand("editor.action.addCursorAbove", "Add Cursor Above")).toBe("在上面添加光标");
    expect(localizeEditorCommand("editor.action.formatDocument", "Format Document")).toBe("格式化文档");
    expect(localizeEditorCommand("editor.action.commentLine", "Toggle Line Comment")).toBe("切换行注释");
  });

  it("未覆盖的 id 保持英文原文", () => {
    expect(localizeEditorCommand("editor.action.someExoticCommand", "Convert Indentation to Spaces")).toBe("Convert Indentation to Spaces");
    expect(localizeEditorCommand("totally.unknown", "Unknown Action")).toBe("Unknown Action");
  });

  it("核心命令均被翻译（抽查高频项）", () => {
    const coreIds = [
      "undo", "redo",
      "editor.action.find", "editor.action.startFindReplaceAction",
      "editor.action.addCursorBelow", "editor.action.selectAll",
      "editor.action.deleteLines", "editor.action.indentLines",
      "editor.action.formatDocument", "editor.action.quickFix",
      "editor.action.rename", "editor.action.goToLine",
    ];
    for (const id of coreIds) {
      expect(MONACO_COMMAND_ZH[id], `missing translation for ${id}`).toBeDefined();
    }
  });
});
