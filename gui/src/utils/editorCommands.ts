// ── 编辑器命令注册 — 持有活动 Monaco 实例，暴露 getSupportedActions 构建 PaletteItem ──

import type { PaletteItem } from "./commandPaletteLogic";
import { localizeEditorCommand } from "./editorCommandI18n";

interface MonacoAction {
  id: string;
  label: string;
  run: () => Promise<void> | void;
}

let activeEditor: { getSupportedActions: () => MonacoAction[] } | null = null;

/** Editor.tsx handleMount 时注册 */
export function setActiveEditor(editor: { getSupportedActions: () => MonacoAction[] } | null) {
  activeEditor = editor;
}

/** 从活动编辑器构建"编辑器命令"组（无编辑器时返回空数组） */
export function buildEditorCommandItems(): PaletteItem[] {
  if (!activeEditor) return [];
  try {
    const actions = activeEditor.getSupportedActions() ?? [];
    return actions.map((a) => ({
      id: `editor-${a.id}`,
      kind: "editor" as const,
      label: localizeEditorCommand(a.id, a.label),
      icon: "editor",
      run: () => void a.run(),
    }));
  } catch {
    return [];
  }
}
