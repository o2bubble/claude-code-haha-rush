import { describe, it, expect } from "vitest";
import { t } from "./index";
import { DEFAULT_SHORTCUTS } from "../services/shortcuts";
import zh from "./zh";
import en from "./en";

// `tsc` 对 i18n 键路径**完全无能为力** —— t() 接受任意字符串，拼错不报错，
// 只会在运行时把键名当译文显示出来（"shortcuts.item.paletteOpen" 直接印在界面上）。
//
// 这条测试就是在补这个缺口：直接断言每个用到的键**能解析出真实译文**。
// 起因：shortcuts 块曾被误放进 settings 命名空间，而代码读的是顶层路径，
// 导致整个快捷键页面显示原始键名。

/** 按 t() 的同一套规则（. 作路径分隔）取值；取不到返回 undefined。 */
function lookup(locale: unknown, key: string): unknown {
  let val: any = locale;
  for (const p of key.split(".")) {
    if (val == null) return undefined;
    val = val[p];
  }
  return val;
}

const GROUP_KEYS = DEFAULT_SHORTCUTS.map((s) => s.group).filter((g, i, a) => a.indexOf(g) === i);

describe("i18n — 快捷键面板的键路径必须能解析", () => {
  it("settings.catShortcuts 有译文（分类导航用）", () => {
    for (const [name, loc] of [["zh", zh], ["en", en]] as const) {
      const v = lookup(loc, "settings.catShortcuts");
      expect(typeof v, `${name}.settings.catShortcuts`).toBe("string");
    }
  });

  it("每个 group 键都有译文", () => {
    for (const [name, loc] of [["zh", zh], ["en", en]] as const) {
      for (const g of GROUP_KEYS) {
        const v = lookup(loc, `shortcuts.group.${g}`);
        expect(typeof v, `${name}.shortcuts.group.${g}`).toBe("string");
      }
    }
  });

  it("每条快捷键的 labelKey 都能在 zh 与 en 里解析", () => {
    for (const [name, loc] of [["zh", zh], ["en", en]] as const) {
      for (const s of DEFAULT_SHORTCUTS) {
        const v = lookup(loc, s.labelKey);
        expect(typeof v, `${name}.${s.labelKey}（id=${s.id}）`).toBe("string");
      }
    }
  });

  it("面板自身的固定文案键都可解析", () => {
    const FIXED = [
      "shortcuts.recording", "shortcuts.unbound", "shortcuts.resetOne",
      "shortcuts.resetAll", "shortcuts.conflictWarning",
      "shortcuts.contextualBadge", "shortcuts.hint",
    ];
    for (const [name, loc] of [["zh", zh], ["en", en]] as const) {
      for (const k of FIXED) {
        const v = lookup(loc, k);
        expect(typeof v, `${name}.${k}`).toBe("string");
      }
    }
  });

  it("t() 真的返回译文而不是回退成键名", () => {
    // 这是最贴近真实行为的断言 —— t() 解析不到时会**原样返回键**，
    // 所以"返回值 ≠ 键本身"才说明路径对了。
    expect(t("settings.catShortcuts")).not.toBe("settings.catShortcuts");
    expect(t("shortcuts.item.paletteOpen")).not.toBe("shortcuts.item.paletteOpen");
    expect(t("shortcuts.recording")).not.toBe("shortcuts.recording");
    expect(t("shortcuts.group.global")).not.toBe("shortcuts.group.global");
  });

  it("zh 与 en 的快捷键键集合一致（防止只加一边）", () => {
    const collect = (loc: unknown): string[] => {
      const sc = lookup(loc, "shortcuts");
      const out: string[] = [];
      const walk = (o: any, path: string) => {
        if (o == null || typeof o !== "object") return;
        for (const [k, v] of Object.entries(o)) {
          const p = path ? `${path}.${k}` : k;
          if (typeof v === "string") out.push(p);
          else walk(v, p);
        }
      };
      walk(sc, "");
      return out.sort();
    };
    expect(collect(zh)).toEqual(collect(en));
  });
});
