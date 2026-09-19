import { describe, it, expect } from "vitest";
import { shouldDispatch } from "./shortcutDispatcher";

/** 测试用条目 id —— 不代表 Monaco 让位项（那两项单独测）。 */
const SHORTCUT_TEST_ID = "test.entry";

// shouldDispatch 是"为什么我按快捷键没反应"类问题的唯一源头，逐条锁住。
// ctx = { editing: 焦点在输入框/富文本/Monaco, inMonaco: 焦点在 Monaco }

describe("shouldDispatch — 上下文放行判定", () => {
  const noEdit = { editing: false, inMonaco: false };

  it("普通上下文：全部放行", () => {
    for (const k of ["f1", "mod+shift+p", "mod+r", "mod+b", "mod+,"]) {
      expect(shouldDispatch(SHORTCUT_TEST_ID, k, noEdit)).toBe(true);
    }
  });

  it("空键位永不放行", () => {
    expect(shouldDispatch(SHORTCUT_TEST_ID, "", noEdit)).toBe(false);
  });

  describe("输入上下文（焦点在输入框 / 富文本）", () => {
    const editing = { editing: true, inMonaco: false };

    it("单字母无修饰 → 不拦截（用户就是在打字）", () => {
      expect(shouldDispatch(SHORTCUT_TEST_ID, "b", editing)).toBe(false);
    });

    it("带修饰键的组合 → 放行（Ctrl+B 不是打字）", () => {
      expect(shouldDispatch(SHORTCUT_TEST_ID, "mod+b", editing)).toBe(true);
      expect(shouldDispatch(SHORTCUT_TEST_ID, "mod+shift+p", editing)).toBe(true);
      expect(shouldDispatch(SHORTCUT_TEST_ID, "alt+1", editing)).toBe(true);
    });

    it("功能键 → 放行（否则输入框里按 F1 打不开命令面板，很别扭）", () => {
      expect(shouldDispatch(SHORTCUT_TEST_ID, "f1", editing)).toBe(true);
      expect(shouldDispatch(SHORTCUT_TEST_ID, "f5", editing)).toBe(true);
    });

    it("无修饰的非功能键 → 不拦截", () => {
      expect(shouldDispatch(SHORTCUT_TEST_ID, "enter", editing)).toBe(false);
      expect(shouldDispatch(SHORTCUT_TEST_ID, "arrowup", editing)).toBe(false);
      expect(shouldDispatch(SHORTCUT_TEST_ID, "delete", editing)).toBe(false);
    });
  });

  describe("Monaco 内 — 命令面板键让位给编辑器", () => {
    const inMonaco = { editing: true, inMonaco: true };

    it("palette.open（F1）让给 Monaco", () => {
      expect(shouldDispatch("palette.open", "f1", inMonaco)).toBe(false);
    });

    it("palette.openAlt（Ctrl+Shift+P）让给 Monaco", () => {
      expect(shouldDispatch("palette.openAlt", "mod+shift+p", inMonaco)).toBe(false);
    });

    it("非命令面板项照常生效（Monaco 没绑那些键）", () => {
      expect(shouldDispatch("app.hardRefresh", "mod+r", inMonaco)).toBe(true);
      expect(shouldDispatch("notes.create", "mod+n", inMonaco)).toBe(true);
    });

    it("单字母仍不拦截", () => {
      expect(shouldDispatch(SHORTCUT_TEST_ID, "b", inMonaco)).toBe(false);
    });

    // 回归：让位判断曾按**按键字面量**匹配，用户把命令面板改绑到别的键后就失配
    // （该让的没让 / 不该让的让了）。改为按条目 id 判断。
    it("命令面板改绑后仍正确让位（不看按键是什么）", () => {
      expect(shouldDispatch("palette.open", "mod+alt+9", inMonaco)).toBe(false);
      expect(shouldDispatch("palette.openAlt", "mod+alt+8", inMonaco)).toBe(false);
    });

    it("旧字面量按键落在别的功能上时不再被误让位", () => {
      // 若用户把 F1 改绑给别的功能，那个功能在 Monaco 内应正常工作
      expect(shouldDispatch("app.hardRefresh", "f1", inMonaco)).toBe(true);
    });
  });

  describe("归一化 — 乱序写法同样判定正确", () => {
    it("乱序的修饰键不影响编辑态判定", () => {
      // shift+mod+p 归一化后带修饰键 → 输入框内放行
      expect(shouldDispatch(SHORTCUT_TEST_ID, "shift+mod+p", { editing: true, inMonaco: false })).toBe(true);
    });

    it("空键位恒不放行", () => {
      expect(shouldDispatch(SHORTCUT_TEST_ID, "  ", { editing: false, inMonaco: false })).toBe(false);
    });
  });
});

// ── 编译缓存的键（动态条目必须进键）──
//
// 这条锁的是一个**极易漏**的点：缓存键若只看 overrides，装/卸插件不会改变
// overrides → 编译结果永不刷新 → 新插件的快捷键要重启才生效、卸载的插件
// 命令继续被触发。startShortcutDispatcher 本身依赖 window（node 环境测不了），
// 故把键的计算抽成纯函数单独锁住。

import { bindingCacheKey } from "./shortcutDispatcher";
import type { ShortcutEntry } from "./shortcuts";

const pluginEntry = (over: Partial<ShortcutEntry> = {}): ShortcutEntry => ({
  id: "plugin:demo:capture",
  keys: "mod+shift+a",
  commandId: "plugin:demo:capture",
  scope: "app",
  label: "截图",
  labelKey: "",
  group: "plugins",
  ...over,
});

describe("bindingCacheKey — 覆盖配置与动态条目都进键", () => {
  it("完全相同的输入 → 同一个键（避免无谓重编）", () => {
    const a = bindingCacheKey({ x: "mod+a" }, [pluginEntry()]);
    const b = bindingCacheKey({ x: "mod+a" }, [pluginEntry()]);
    expect(a).toBe(b);
  });

  it("overrides 变了 → 键变", () => {
    const a = bindingCacheKey({ x: "mod+a" }, []);
    const b = bindingCacheKey({ x: "mod+b" }, []);
    expect(a).not.toBe(b);
  });

  it("**新增插件条目 → 键变**（装插件后立即生效，不必重启）", () => {
    const before = bindingCacheKey(undefined, []);
    const after = bindingCacheKey(undefined, [pluginEntry()]);
    expect(before).not.toBe(after);
  });

  it("**移除插件条目 → 键变**（卸载后不残留幽灵快捷键）", () => {
    const before = bindingCacheKey(undefined, [pluginEntry()]);
    const after = bindingCacheKey(undefined, []);
    expect(before).not.toBe(after);
  });

  it("插件改了自己的默认键（插件升级）→ 键变", () => {
    const a = bindingCacheKey(undefined, [pluginEntry({ keys: "mod+shift+a" })]);
    const b = bindingCacheKey(undefined, [pluginEntry({ keys: "mod+shift+z" })]);
    expect(a).not.toBe(b);
  });

  it("scope 从 app 改成 os → 键变（它决定走不走全局热键）", () => {
    const a = bindingCacheKey(undefined, [pluginEntry({ scope: "app" })]);
    const b = bindingCacheKey(undefined, [pluginEntry({ scope: "os" })]);
    expect(a).not.toBe(b);
  });

  it("无关字段变化（label/run）→ 键不变（不做无意义的重新编译）", () => {
    const a = bindingCacheKey(undefined, [pluginEntry({ label: "A" })]);
    const b = bindingCacheKey(undefined, [pluginEntry({ label: "B" })]);
    expect(a).toBe(b);
  });

  it("条目顺序变化 → 键变（顺序即优先级，不能忽略）", () => {
    const e1 = pluginEntry({ id: "plugin:a:x" });
    const e2 = pluginEntry({ id: "plugin:b:y" });
    expect(bindingCacheKey(undefined, [e1, e2]))
      .not.toBe(bindingCacheKey(undefined, [e2, e1]));
  });

  it("overrides 从 undefined 到空对象 → 键不变（语义等价）", () => {
    expect(bindingCacheKey(undefined, [])).toBe(bindingCacheKey({}, []));
  });
});
