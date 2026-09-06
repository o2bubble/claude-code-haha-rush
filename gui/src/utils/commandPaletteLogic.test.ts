// ── CommandPalette 纯逻辑 — 过滤、分组、展平 ──

import { describe, it, expect } from "vitest";
import { matchPaletteItem, groupPaletteItems, flattenGroups, shouldOpenPalette, type PaletteItem } from "./commandPaletteLogic";

function item(partial: Partial<PaletteItem> & { id: string; kind: PaletteItem["kind"]; label: string }): PaletteItem {
  return { run: () => {}, ...partial } as PaletteItem;
}

describe("matchPaletteItem", () => {
  it("空查询匹配所有", () => {
    expect(matchPaletteItem(item({ id: "a", kind: "panel", label: "终端" }), "")).toBe(true);
    expect(matchPaletteItem(item({ id: "a", kind: "panel", label: "终端" }), "   ")).toBe(true);
  });

  it("大小写不敏感子串匹配 label", () => {
    expect(matchPaletteItem(item({ id: "a", kind: "command", label: "/code-review" }), "code")).toBe(true);
    expect(matchPaletteItem(item({ id: "a", kind: "command", label: "/Code-Review" }), "review")).toBe(true);
    expect(matchPaletteItem(item({ id: "a", kind: "command", label: "/commit" }), "push")).toBe(false);
  });

  it("sublabel 也参与匹配", () => {
    expect(matchPaletteItem(item({ id: "a", kind: "panel", label: "编辑器", sublabel: "代码编辑和预览" }), "代码")).toBe(true);
    expect(matchPaletteItem(item({ id: "a", kind: "panel", label: "编辑器", sublabel: "代码编辑" }), "预览")).toBe(false);
  });
});

describe("groupPaletteItems", () => {
  const editor = item({ id: "e", kind: "editor", label: "Add Cursor Above" });
  const panel = item({ id: "p", kind: "panel", label: "终端" });
  const cmd = item({ id: "c", kind: "command", label: "/commit" });
  const sess = item({ id: "s", kind: "session", label: "重构 auth" });

  it("编辑器聚焦时编辑器命令组置顶", () => {
    const groups = groupPaletteItems([panel, cmd, editor, sess], "", true);
    expect(groups.map((g) => g.kind)).toEqual(["editor", "panel", "command", "session"]);
  });

  it("非编辑器聚焦时编辑器命令组排最后", () => {
    const groups = groupPaletteItems([editor, panel, cmd, sess], "", false);
    expect(groups.map((g) => g.kind)).toEqual(["panel", "command", "session", "editor"]);
  });

  it("插件命令组参与分组（位于设置后、编辑器前）", () => {
    const plugin = item({ id: "plugin:demo:refresh", kind: "plugin", label: "刷新行情" });
    const groups = groupPaletteItems([panel, cmd, plugin], "", false);
    expect(groups.map((g) => g.kind)).toEqual(["panel", "command", "plugin"]);
    expect(groups[2].items[0].id).toBe("plugin:demo:refresh");
  });

  it("插件命令出现在设置与编辑器之间", () => {
    const plugin = item({ id: "plugin:demo:refresh", kind: "plugin", label: "刷新" });
    const setting = item({ id: "setting-1", kind: "setting", label: "设置" });
    const editor = item({ id: "editor-1", kind: "editor", label: "Add Cursor" });
    const groups = groupPaletteItems([editor, setting, plugin], "", false);
    expect(groups.map((g) => g.kind)).toEqual(["setting", "plugin", "editor"]);
  });

  it("插件命令组不匹配时被丢弃", () => {
    const plugin = item({ id: "plugin:demo:refresh", kind: "plugin", label: "刷新" });
    const groups = groupPaletteItems([plugin], "xyz", false);
    expect(groups).toHaveLength(0);
  });

  it("只保留有匹配项的组", () => {
    const groups = groupPaletteItems([panel, cmd, editor, sess], "commit", false);
    expect(groups.map((g) => g.kind)).toEqual(["command"]);
    expect(groups[0].items[0].id).toBe("c");
  });

  it("空查询显示所有组（无匹配组被丢弃）", () => {
    const groups = groupPaletteItems([panel, cmd, editor, sess], "", false);
    expect(groups.length).toBe(4);
  });
});

describe("flattenGroups", () => {
  it("按组顺序展平", () => {
    const a = item({ id: "a", kind: "panel", label: "A" });
    const b = item({ id: "b", kind: "command", label: "B" });
    const c = item({ id: "c", kind: "session", label: "C" });
    const flat = flattenGroups([
      { kind: "panel", items: [a] },
      { kind: "command", items: [b] },
      { kind: "session", items: [c] },
    ]);
    expect(flat.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});

describe("shouldOpenPalette — 全局快捷键判定", () => {
  const F1 = { key: "F1", ctrlKey: false, metaKey: false, shiftKey: false };
  const ctrlShiftP = { key: "p", ctrlKey: true, metaKey: false, shiftKey: true };
  const cmdShiftP = { key: "P", ctrlKey: false, metaKey: true, shiftKey: true };
  const plainK = { key: "k", ctrlKey: true, metaKey: false, shiftKey: false };

  it("F1 触发（编辑器外、面板未开）", () => {
    expect(shouldOpenPalette(F1, false, false)).toBe(true);
  });

  it("Ctrl+Shift+P / Cmd+Shift+P 触发", () => {
    expect(shouldOpenPalette(ctrlShiftP, false, false)).toBe(true);
    expect(shouldOpenPalette(cmdShiftP, false, false)).toBe(true);
  });

  it("面板已打开时不触发", () => {
    expect(shouldOpenPalette(F1, true, false)).toBe(false);
    expect(shouldOpenPalette(ctrlShiftP, true, false)).toBe(false);
  });

  it("焦点在 Monaco 内时不触发（交给 Monaco）", () => {
    expect(shouldOpenPalette(F1, false, true)).toBe(false);
    expect(shouldOpenPalette(ctrlShiftP, false, true)).toBe(false);
  });

  it("其他按键不触发", () => {
    expect(shouldOpenPalette(plainK, false, false)).toBe(false);
  });
});
