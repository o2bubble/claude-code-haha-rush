import { describe, it, expect } from "vitest";
import {
  parseKeys, formatKeys, normalizeKeys, displayKeys, matchesEvent,
  findConflicts, resolveBindings, isBindableKeys,
  DEFAULT_SHORTCUTS, type ShortcutEntry, type KeyboardEventLike,
} from "./shortcuts";

describe("键位解析 / 格式化", () => {
  it("解析基本组合", () => {
    expect(parseKeys("mod+shift+p")).toEqual({ mod: true, ctrl: false, alt: false, shift: true, key: "p" });
  });

  it("解析无修饰键（f1）", () => {
    expect(parseKeys("f1")).toEqual({ mod: false, ctrl: false, alt: false, shift: false, key: "f1" });
  });

  it("空串解析为空键位", () => {
    expect(parseKeys("")).toEqual({ mod: false, ctrl: false, alt: false, shift: false, key: "" });
  });

  it("归一化修饰键顺序（shift+mod+p → mod+shift+p）", () => {
    expect(normalizeKeys("shift+mod+p")).toBe("mod+shift+p");
    expect(normalizeKeys("p+shift+mod")).toBe("mod+shift+p");
  });

  it("大小写归一", () => {
    expect(normalizeKeys("MOD+SHIFT+P")).toBe("mod+shift+p");
  });

  it("容错：无法识别的片段被忽略，不抛错", () => {
    // 手改配置写错时的姿态 —— 容错优于抛错
    expect(normalizeKeys("mod+shift+p")).toBe("mod+shift+p");
    expect(() => normalizeKeys("mod++++p")).not.toThrow();
    expect(normalizeKeys("mod++++p")).toBe("mod+p"); // 空片段跳过
  });

  it("ctrl 与 mod 可共存（区分显式 Ctrl）", () => {
    expect(normalizeKeys("ctrl+mod+a")).toBe("mod+ctrl+a");
  });

  it("formatKeys 是 parseKeys 的逆", () => {
    for (const s of ["mod+b", "f1", "mod+shift+p", "mod+alt+b", "mod+,"]) {
      expect(formatKeys(parseKeys(s))).toBe(s);
    }
  });

  it("option 视作 alt（mac 习惯写法）", () => {
    expect(normalizeKeys("mod+option+b")).toBe("mod+alt+b");
  });
});

describe("displayKeys — 平台感知显示", () => {
  it("Windows：Ctrl + 加号连接", () => {
    expect(displayKeys("mod+shift+p", false)).toBe("Ctrl+Shift+P");
    expect(displayKeys("f1", false)).toBe("F1");
    expect(displayKeys("mod+alt+b", false)).toBe("Ctrl+Alt+B");
  });

  it("mac：符号 + 无分隔 + ⌃⌥⇧⌘ 顺序", () => {
    expect(displayKeys("mod+shift+p", true)).toBe("⇧⌘P");
    expect(displayKeys("f1", true)).toBe("F1");
    expect(displayKeys("mod+alt+b", true)).toBe("⌥⌘B");
    expect(displayKeys("mod+ctrl+alt+shift+x", true)).toBe("⌃⌥⇧⌘X");
  });

  it("特殊键名有符号", () => {
    expect(displayKeys("mod+arrowup", false)).toBe("Ctrl+↑");
    expect(displayKeys("escape", false)).toBe("Esc");
  });

  it("空键位 → 空串", () => {
    expect(displayKeys("", false)).toBe("");
  });
});

describe("matchesEvent — 事件匹配", () => {
  const ev = (o: Partial<KeyboardEventLike>): KeyboardEventLike =>
    ({ key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });

  it("Windows 下 mod 映射到 ctrl", () => {
    expect(matchesEvent(ev({ key: "p", ctrlKey: true, shiftKey: true }), parseKeys("mod+shift+p"), false)).toBe(true);
  });

  it("mac 下 mod 映射到 meta（ctrl 不命中）", () => {
    const parsed = parseKeys("mod+p");
    expect(matchesEvent(ev({ key: "p", metaKey: true }), parsed, true)).toBe(true);
    expect(matchesEvent(ev({ key: "p", ctrlKey: true }), parsed, true)).toBe(false);
  });

  it("多按了修饰键不命中（严格匹配）", () => {
    // 按了 Ctrl+Shift+P，但只绑了 Ctrl+P → 不命中（避免误触）
    expect(matchesEvent(ev({ key: "p", ctrlKey: true, shiftKey: true }), parseKeys("mod+p"), false)).toBe(false);
  });

  it("少按了修饰键不命中", () => {
    expect(matchesEvent(ev({ key: "p" }), parseKeys("mod+p"), false)).toBe(false);
  });

  it("键名大小写不敏感", () => {
    expect(matchesEvent(ev({ key: "P", ctrlKey: true }), parseKeys("mod+p"), false)).toBe(true);
  });

  it("F1 等无修饰键", () => {
    expect(matchesEvent(ev({ key: "F1" }), parseKeys("f1"), false)).toBe(true);
    expect(matchesEvent(ev({ key: "F1", ctrlKey: true }), parseKeys("f1"), false)).toBe(false);
  });

  it("空键位永不命中", () => {
    expect(matchesEvent(ev({ key: "" }), parseKeys(""), false)).toBe(false);
  });
});

describe("findConflicts — 软冲突检测", () => {
  const e = (id: string, keys: string, contextual?: boolean): ShortcutEntry =>
    ({ id, keys, scope: "app", labelKey: id, group: "g", contextual });

  it("不同功能同键 → 报冲突", () => {
    const c = findConflicts([e("a", "mod+b"), e("b", "mod+b")]);
    expect(c).toEqual([{ keys: "mod+b", ids: ["a", "b"] }]);
  });

  it("无冲突 → 空", () => {
    expect(findConflicts([e("a", "mod+b"), e("b", "mod+j")])).toEqual([]);
  });

  it("归一化后相同才算冲突（shift+mod+p == mod+shift+p）", () => {
    const c = findConflicts([e("a", "mod+shift+p"), e("b", "shift+mod+p")]);
    expect(c).toHaveLength(1);
  });

  it("上下文型不参与冲突检测（生效条件互斥）", () => {
    // 笔记 Ctrl+N 与某全局 Ctrl+N 不冲突 —— 前者只在笔记面板聚焦时生效
    const c = findConflicts([e("notes.create", "mod+n", true), e("other", "mod+n")]);
    expect(c).toEqual([]);
  });

  it("空键位（解绑）不参与", () => {
    const c = findConflicts([e("a", ""), e("b", "")]);
    expect(c).toEqual([]);
  });

  it("三方冲突全部列出，保持表内顺序", () => {
    const c = findConflicts([e("a", "mod+b"), e("b", "mod+b"), e("c", "mod+b")]);
    expect(c).toEqual([{ keys: "mod+b", ids: ["a", "b", "c"] }]);
  });
});

describe("resolveBindings — 默认表 + 用户覆盖", () => {
  const defaults: ShortcutEntry[] = [
    { id: "a", keys: "mod+b", scope: "app", labelKey: "a", group: "g" },
    { id: "ctx", keys: "mod+n", scope: "app", contextual: true, labelKey: "ctx", group: "g" },
  ];

  it("无覆盖 → 原样返回", () => {
    expect(resolveBindings(defaults, undefined)).toBe(defaults);
  });

  it("用户覆盖生效", () => {
    const r = resolveBindings(defaults, { a: "mod+alt+z" });
    expect(r[0].keys).toBe("mod+alt+z");
  });

  it("空串 = 显式解绑", () => {
    const r = resolveBindings(defaults, { a: "" });
    expect(r[0].keys).toBe("");
  });

  it("用户值被归一化", () => {
    const r = resolveBindings(defaults, { a: "SHIFT+MOD+P" });
    expect(r[0].keys).toBe("mod+shift+p");
  });

  it("上下文型不接受覆盖（只读）", () => {
    const r = resolveBindings(defaults, { ctx: "mod+9" });
    expect(r[1].keys).toBe("mod+n");
  });

  it("多余 id（旧版本残留）被忽略", () => {
    const r = resolveBindings(defaults, { nonexistent: "mod+1" });
    expect(r.map((x) => x.keys)).toEqual(["mod+b", "mod+n"]);
  });

  it("未覆盖的条目保持默认", () => {
    const r = resolveBindings(defaults, { a: "mod+z" });
    expect(r[1].keys).toBe("mod+n");
  });

  it("不修改原数组（纯函数）", () => {
    const before = JSON.stringify(defaults);
    resolveBindings(defaults, { a: "mod+z" });
    expect(JSON.stringify(defaults)).toBe(before);
  });
});

describe("DEFAULT_SHORTCUTS — 表本身的自洽性", () => {
  it("id 唯一", () => {
    const ids = DEFAULT_SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("非上下文型条目之间无冲突", () => {
    const c = findConflicts(DEFAULT_SHORTCUTS);
    expect(c).toEqual([]);
  });

  it("每条键位都可解析（非空则至少有个键名）", () => {
    for (const s of DEFAULT_SHORTCUTS) {
      if (s.keys) expect(parseKeys(s.keys).key).not.toBe("");
    }
  });

  it("键位都已归一化（表内不写 shift+mod 这种乱序）", () => {
    for (const s of DEFAULT_SHORTCUTS) {
      if (s.keys) expect(s.keys).toBe(normalizeKeys(s.keys));
    }
  });

  it("scope 只允许 app（本期不产出 os 条目）", () => {
    for (const s of DEFAULT_SHORTCUTS) expect(s.scope).toBe("app");
  });
});

// ── 可绑定性（录制器拒绝局部键的依据）──

describe("isBindableKeys — 局部交互键不可绑", () => {
  it("拒绝 Enter / Esc / Tab / 方向键 / 退格 / 删除 / 空格", () => {
    for (const k of ["enter", "escape", "tab", "arrowup", "arrowdown",
                     "arrowleft", "arrowright", "backspace", "delete", " "]) {
      expect(isBindableKeys(k), k).toBe(false);
    }
  });

  it("拒绝带修饰键的局部键（仍是局部语义）", () => {
    expect(isBindableKeys("mod+enter")).toBe(false);
    expect(isBindableKeys("shift+tab")).toBe(false);
  });

  it("空键位不可绑", () => {
    expect(isBindableKeys("")).toBe(false);
  });

  it("普通字母 / 数字 / 功能键可绑", () => {
    for (const k of ["mod+b", "f1", "mod+shift+p", "alt+1", "mod+,"]) {
      expect(isBindableKeys(k), k).toBe(true);
    }
  });

  it("大小写与乱序不影响判定", () => {
    expect(isBindableKeys("MOD+B")).toBe(true);
    expect(isBindableKeys("shift+ENTER")).toBe(false);
  });
});

describe("formatKeys — 边界键名（录制时实际会用到的形状）", () => {
  it("加号键名往返无损（写成 plus，避免与分隔符冲突）", () => {
    // "+" 是分隔符，直接拼会得到 "mod++" —— 再解析按 + 切分后键名丢失。
    // 故统一表示为 "plus"，保证 formatKeys → parseKeys 往返一致。
    const s = formatKeys({ mod: true, ctrl: false, alt: false, shift: false, key: "+" });
    expect(s).toBe("mod+plus");
    const back = parseKeys(s);
    expect(back.key).toBe("+");
    expect(back.mod).toBe(true);
  });

  it("plus 可手写（配置里直接写 mod+plus 也能解析）", () => {
    expect(parseKeys("mod+plus").key).toBe("+");
    expect(normalizeKeys("mod+plus")).toBe("mod+plus");
  });

  it("普通组合不受影响", () => {
    expect(formatKeys({ mod: true, ctrl: false, alt: true, shift: false, key: "b" })).toBe("mod+alt+b");
  });
});
