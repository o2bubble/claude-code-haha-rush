import { describe, it, expect } from "vitest";
import {
  buildPluginShortcutEntries,
  isGlobalHotkeyBindable,
  isBindableKeys,
  toAccelerator,
  resolveBindings,
  DEFAULT_SHORTCUTS,
  type PluginHotkeyDecl,
} from "./shortcuts";

const decl = (over: Partial<PluginHotkeyDecl> = {}): PluginHotkeyDecl => ({
  pluginName: "demo",
  commandId: "capture",
  title: "截图",
  hotkey: "mod+shift+a",
  ...over,
});

describe("buildPluginShortcutEntries — 插件命令 → 快捷键条目", () => {
  it("id 与 commandId 都是 plugin:<name>:<cmd>（必须一致：id 是覆盖表的 key）", () => {
    const [e] = buildPluginShortcutEntries([decl()]);
    expect(e.id).toBe("plugin:demo:capture");
    expect(e.commandId).toBe("plugin:demo:capture");
  });

  it("键位被归一化（顺序/大小写不敏感）", () => {
    const [e] = buildPluginShortcutEntries([decl({ hotkey: "Shift+Mod+A" })]);
    expect(e.keys).toBe("mod+shift+a");
  });

  it("显示名用插件给的 title；没有 i18n 键（labelKey 留空，靠 label 显示）", () => {
    const [e] = buildPluginShortcutEntries([decl()]);
    expect(e.label).toBe("截图");
    expect(e.labelKey).toBe("");
    expect(e.source).toBe("plugin");
    expect(e.group).toBe("plugins");
  });

  it("title 缺省时回退到 commandId（不显示空名）", () => {
    const [e] = buildPluginShortcutEntries([decl({ title: "" })]);
    expect(e.label).toBe("capture");
  });

  it("scope 缺省为 app；显式 os 时保留，并可带平台限定", () => {
    expect(buildPluginShortcutEntries([decl()])[0].scope).toBe("app");
    const [os] = buildPluginShortcutEntries([decl({ scope: "os", os: "win" })]);
    expect(os.scope).toBe("os");
    expect(os.os).toBe("win");
  });

  it("没声明 hotkey 的命令不产出条目（不占快捷键表）", () => {
    expect(buildPluginShortcutEntries([decl({ hotkey: "" })])).toHaveLength(0);
    expect(buildPluginShortcutEntries([decl({ hotkey: "   " })])).toHaveLength(0);
  });

  it("缺 pluginName / commandId 的坏声明被丢弃，不抛错", () => {
    expect(buildPluginShortcutEntries([
      decl({ pluginName: "" }),
      decl({ commandId: "" }),
    ])).toHaveLength(0);
  });

  it("多个插件互不干扰，id 不冲突", () => {
    const list = buildPluginShortcutEntries([
      decl({ pluginName: "a", commandId: "go" }),
      decl({ pluginName: "b", commandId: "go" }),
    ]);
    expect(list.map((e) => e.id)).toEqual(["plugin:a:go", "plugin:b:go"]);
  });
});

describe("插件条目的用户覆盖必须生效", () => {
  // 这条锁的是一个**容易写错的合并方向**：resolveBindings 是 defaults.map(...)，
  // 插件条目必须当 defaults 传进去，用户改的键才不会被当成"未知 id"丢弃。
  it("用户覆盖插件条目的键位 → 生效", () => {
    const entries = buildPluginShortcutEntries([decl()]);
    const merged = resolveBindings(entries, { "plugin:demo:capture": "mod+shift+z" });
    expect(merged[0].keys).toBe("mod+shift+z");
  });

  it("用户显式解绑（空串）→ keys 为空", () => {
    const entries = buildPluginShortcutEntries([decl()]);
    const merged = resolveBindings(entries, { "plugin:demo:capture": "" });
    expect(merged[0].keys).toBe("");
  });

  it("没有覆盖时用插件声明的默认键", () => {
    const entries = buildPluginShortcutEntries([decl()]);
    expect(resolveBindings(entries, {})[0].keys).toBe("mod+shift+a");
  });
});

describe("isGlobalHotkeyBindable — 全局热键的额外约束", () => {
  it("带 mod / ctrl / alt 的组合可以", () => {
    expect(isGlobalHotkeyBindable("mod+shift+a")).toBe(true);
    expect(isGlobalHotkeyBindable("ctrl+alt+p")).toBe(true);
    expect(isGlobalHotkeyBindable("alt+f1")).toBe(true);
  });

  it("功能键单独可以（不参与文本输入）", () => {
    expect(isGlobalHotkeyBindable("f9")).toBe(true);
    expect(isGlobalHotkeyBindable("shift+f9")).toBe(true);
  });

  it("只有 shift 的组合不行 —— 会抢走别的软件里的 Shift+字母输入", () => {
    expect(isGlobalHotkeyBindable("shift+a")).toBe(false);
    expect(isGlobalHotkeyBindable("shift+1")).toBe(false);
  });

  it("裸键不行", () => {
    expect(isGlobalHotkeyBindable("a")).toBe(false);
    expect(isGlobalHotkeyBindable("abc")).toBe(false);
  });

  it("局部交互键仍不行（继承应用级校验）", () => {
    expect(isGlobalHotkeyBindable("mod+enter")).toBe(false);
    expect(isGlobalHotkeyBindable("alt+escape")).toBe(false);
  });

  it("应用级校验本身不受影响（shift+a 仍可作应用内快捷键）", () => {
    expect(isBindableKeys("shift+a")).toBe(true);
  });
});

describe("toAccelerator — 键位 → Tauri accelerator", () => {
  it("mod 映射为 CommandOrControl（跨平台 Ctrl/Cmd）", () => {
    expect(toAccelerator("mod+shift+a")).toBe("CommandOrControl+Shift+KeyA");
  });

  it("显式 ctrl 与 mod 可共存且顺序固定", () => {
    expect(toAccelerator("mod+ctrl+alt+shift+b")).toBe("CommandOrControl+Control+Alt+Shift+KeyB");
  });

  it("字母 / 数字 / 功能键 / 方向键 / 符号的映射", () => {
    expect(toAccelerator("mod+z")).toBe("CommandOrControl+KeyZ");
    expect(toAccelerator("mod+1")).toBe("CommandOrControl+Digit1");
    expect(toAccelerator("f12")).toBe("F12");
    expect(toAccelerator("mod+arrowup")).toBe("CommandOrControl+ArrowUp");
    expect(toAccelerator("mod+,")).toBe("CommandOrControl+Comma");
    expect(toAccelerator("mod+.")).toBe("CommandOrControl+Period");
  });

  it("`plus` 映射为 Plus（与 formatKeys 的 `+` 表示法配套）", () => {
    expect(toAccelerator("mod+plus")).toBe("CommandOrControl+Plus");
  });

  it("空键位返回 null（调用方应跳过注册）", () => {
    expect(toAccelerator("")).toBeNull();
  });

  it("未收录的键名返回 null —— 不猜一个可能的错键", () => {
    expect(toAccelerator("mod+不明键")).toBeNull();
  });
});

describe("内置表不受本次改动影响", () => {
  it("DEFAULT_SHORTCUTS 仍全部是 app 作用域（os 只来自插件）", () => {
    expect(DEFAULT_SHORTCUTS.every((e) => e.scope === "app")).toBe(true);
  });

  it("内置条目没有 label / source 字段（保持原样，靠 labelKey 走 i18n）", () => {
    expect(DEFAULT_SHORTCUTS.every((e) => e.label === undefined)).toBe(true);
    expect(DEFAULT_SHORTCUTS.every((e) => e.source === undefined)).toBe(true);
  });
});

// ── 全局热键收集（纯函数部分）──
//
// `startGlobalShortcuts` 本身依赖 Tauri 插件与 window（node 环境测不了），
// 但"哪些条目该注册、转成什么 accelerator"是纯逻辑，单独锁住。

import { collectGlobalHotkeys } from "./globalShortcutService";

describe("collectGlobalHotkeys — 该注册哪些条目", () => {
  it("只收 scope=os 的条目（内置表全是 app，故默认一条都没有）", () => {
    expect(collectGlobalHotkeys(undefined, [], false)).toHaveLength(0);
  });

  it("收插件声明的 os 条目并转出 accelerator", () => {
    const entries = buildPluginShortcutEntries([
      decl({ scope: "os", hotkey: "mod+shift+a" }),
    ]);
    const got = collectGlobalHotkeys(undefined, entries, false);
    expect(got).toHaveLength(1);
    expect(got[0].accelerator).toBe("CommandOrControl+Shift+KeyA");
    expect(got[0].label).toBe("截图");
  });

  it("scope=app 的插件条目不注册为全局热键（交给应用内分发器）", () => {
    const entries = buildPluginShortcutEntries([decl({ scope: "app" })]);
    expect(collectGlobalHotkeys(undefined, entries, false)).toHaveLength(0);
  });

  it("os 字段限定平台：win 条目在 mac 上不注册，反之亦然", () => {
    const winOnly = buildPluginShortcutEntries([decl({ scope: "os", os: "win" })]);
    expect(collectGlobalHotkeys(undefined, winOnly, false)).toHaveLength(1); // isMac=false
    expect(collectGlobalHotkeys(undefined, winOnly, true)).toHaveLength(0);  // isMac=true

    const macOnly = buildPluginShortcutEntries([decl({ scope: "os", os: "mac" })]);
    expect(collectGlobalHotkeys(undefined, macOnly, true)).toHaveLength(1);
    expect(collectGlobalHotkeys(undefined, macOnly, false)).toHaveLength(0);
  });

  it("用户改键后按新键注册（overrides 生效）", () => {
    const entries = buildPluginShortcutEntries([decl({ scope: "os" })]);
    const got = collectGlobalHotkeys({ "plugin:demo:capture": "ctrl+alt+p" }, entries, false);
    expect(got[0].keys).toBe("ctrl+alt+p");
    expect(got[0].accelerator).toBe("Control+Alt+KeyP");
  });

  it("用户解绑（空串）→ 不再注册", () => {
    const entries = buildPluginShortcutEntries([decl({ scope: "os" })]);
    expect(collectGlobalHotkeys({ "plugin:demo:capture": "" }, entries, false)).toHaveLength(0);
  });

  it("不满足全局热键要求的键位：保留条目但标 error、accelerator 为 null", () => {
    const entries = buildPluginShortcutEntries([decl({ scope: "os", hotkey: "shift+a" })]);
    const got = collectGlobalHotkeys(undefined, entries, false);
    // 条目仍保留（面板据此显示"为什么没生效"），但不产出 accelerator
    expect(got).toHaveLength(1);
    expect(got[0].accelerator).toBeNull();
    expect(got[0].error).toBeTruthy();
  });
});
