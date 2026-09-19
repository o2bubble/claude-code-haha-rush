// ── 全局热键：状态语义 与 被占来源判定 ──
//
// 背景：全局热键是**进程级独占**的（OS 机制），多开 GUI 时只有先注册的实例能用，
// 其余拿到 "already registered"。OS 的报错不区分"被另一个实例占"和"被微信占" ——
// 而这两种情况对用户意味着完全不同的动作（前者无需处理，后者需要换键）。
// 这里锁住判据与开关语义，避免以后有人把"让位"又改回标红。

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSettings: Record<string, unknown> = {};
vi.mock("../stores/settingsStore", () => ({
  getSettings: () => mockSettings,
}));

import { classifyTakenBy, hotkeysEnabled } from "./globalShortcutService";

beforeEach(() => {
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
});

describe("classifyTakenBy — 热键被谁占了", () => {
  it("多于一个实例 → 归因给另一个 GUI 实例（多开时最常见）", () => {
    expect(classifyTakenBy(2)).toBe("instance");
    expect(classifyTakenBy(5)).toBe("instance");
  });

  it("只有一个实例（只有自己）却失败 → 一定是别的软件，不含糊成「可能」", () => {
    expect(classifyTakenBy(1)).toBe("other");
  });

  it("异常输入（0/负数）按单实例处理 —— 宁可说「被其它软件占」也不误导成多开", () => {
    expect(classifyTakenBy(0)).toBe("other");
    expect(classifyTakenBy(-1)).toBe("other");
  });
});

describe("hotkeysEnabled — 本实例是否参与全局热键注册", () => {
  it("缺省（未设过开关）= 参与，老用户行为不变", () => {
    expect(hotkeysEnabled()).toBe(true);
  });

  it("显式 false = 主动让位", () => {
    mockSettings.globalHotkeysEnabled = false;
    expect(hotkeysEnabled()).toBe(false);
  });

  it("显式 true = 参与", () => {
    mockSettings.globalHotkeysEnabled = true;
    expect(hotkeysEnabled()).toBe(true);
  });
});
