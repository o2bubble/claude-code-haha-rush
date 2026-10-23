import { describe, it, expect } from "vitest";
import {
  DEFAULT_RECENT_MAX,
  MAX_RECENT_MAX,
  clampRecentMax,
  recordSessionRecent,
  pruneMissing,
  groupByDay,
  dayKey,
  type RecentSessionEntry,
} from "./sessionRecents";

// 固定"现在"：2026-10-23 12:00 本地时间（用本地构造，避免时区影响断言）
const NOW = new Date(2026, 9, 23, 12, 0, 0).getTime();
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

const LABELS = { today: "今天", yesterday: "昨天" };

describe("clampRecentMax — IntField 不做数值钳制，这里兜底", () => {
  it("缺省/非法 → 默认值", () => {
    expect(clampRecentMax(undefined)).toBe(DEFAULT_RECENT_MAX);
    expect(clampRecentMax(null)).toBe(DEFAULT_RECENT_MAX);
    expect(clampRecentMax(NaN)).toBe(DEFAULT_RECENT_MAX);
  });
  it("低于/高于区间 → 钳到边界", () => {
    expect(clampRecentMax(0)).toBe(1);
    expect(clampRecentMax(-5)).toBe(1);
    expect(clampRecentMax(999)).toBe(MAX_RECENT_MAX);
  });
  it("合法值原样（取整）", () => {
    expect(clampRecentMax(7)).toBe(7);
    expect(clampRecentMax(7.9)).toBe(7);
  });
});

describe("recordSessionRecent — 置顶/去重/截断", () => {
  const list: RecentSessionEntry[] = [
    { id: "a", openedAt: at(2026, 10, 23, 11) },
    { id: "b", openedAt: at(2026, 10, 23, 10) },
    { id: "c", openedAt: at(2026, 10, 22, 9) },
  ];

  it("新会话置顶", () => {
    const next = recordSessionRecent(list, "d", NOW, 25);
    expect(next.map((e) => e.id)).toEqual(["d", "a", "b", "c"]);
    expect(next[0].openedAt).toBe(NOW);
  });

  it("重复打开 → 去重并更新时间", () => {
    const next = recordSessionRecent(list, "c", NOW, 25);
    expect(next.map((e) => e.id)).toEqual(["c", "a", "b"]);
    expect(next[0].openedAt).toBe(NOW);
  });

  it("超上限 → 淘汰最旧的", () => {
    const next = recordSessionRecent(list, "d", NOW, 2);
    expect(next.map((e) => e.id)).toEqual(["d", "a"]);
  });

  it("max=1 只留一条", () => {
    expect(recordSessionRecent(list, "x", NOW, 1).map((e) => e.id)).toEqual(["x"]);
  });

  it("上限调小后再次记录即完成截断", () => {
    expect(recordSessionRecent(list, "a", NOW, 2).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("不改动入参", () => {
    const before = list.map((e) => e.id);
    recordSessionRecent(list, "z", NOW, 25);
    expect(list.map((e) => e.id)).toEqual(before);
  });
});

describe("pruneMissing — 删除的会话不留死链", () => {
  it("保留存在项与顺序", () => {
    const list: RecentSessionEntry[] = [
      { id: "a", openedAt: 3 },
      { id: "gone", openedAt: 2 },
      { id: "b", openedAt: 1 },
    ];
    const next = pruneMissing(list, new Set(["a", "b"]));
    expect(next.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("全部消失 → 空", () => {
    expect(pruneMissing([{ id: "x", openedAt: 1 }], new Set())).toEqual([]);
  });
});

describe("groupByDay — 按本地日期分组", () => {
  it("今天/昨天/更早 各自成组，组内按时间倒序", () => {
    const list: RecentSessionEntry[] = [
      { id: "newest", openedAt: at(2026, 10, 23, 11) },
      { id: "today-earlier", openedAt: at(2026, 10, 23, 8) },
      { id: "yesterday", openedAt: at(2026, 10, 22, 20) },
      { id: "older", openedAt: at(2026, 10, 20, 9) },
    ];
    const groups = groupByDay(list, NOW, LABELS);
    expect(groups.map((g) => g.label)).toEqual(["今天", "昨天", "10-20"]);
    expect(groups[0].items.map((e) => e.id)).toEqual(["newest", "today-earlier"]);
    expect(groups[1].items.map((e) => e.id)).toEqual(["yesterday"]);
    expect(groups[2].items.map((e) => e.id)).toEqual(["older"]);
  });

  it("跨年 → 标签带年份", () => {
    const groups = groupByDay(
      [{ id: "old", openedAt: at(2025, 12, 31, 23) }],
      NOW,
      LABELS,
    );
    expect(groups[0].label).toBe("2025-12-31");
  });

  it("乱序输入 → 先按 openedAt 倒序再分组（不会把同一天拆成两块）", () => {
    const list: RecentSessionEntry[] = [
      { id: "today-old", openedAt: at(2026, 10, 23, 7) },
      { id: "yesterday", openedAt: at(2026, 10, 22, 22) },
      { id: "today-new", openedAt: at(2026, 10, 23, 11) },
    ];
    const groups = groupByDay(list, NOW, LABELS);
    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe(dayKey(NOW));
    expect(groups[0].items.map((e) => e.id)).toEqual(["today-new", "today-old"]);
  });

  it("空输入 → 空分组", () => {
    expect(groupByDay([], NOW, LABELS)).toEqual([]);
  });

  it("昨天的判定按日历日而不是 24 小时（跨午夜也一样）", () => {
    // 现在 00:10，昨天 23:50 仍是"昨天"
    const now = new Date(2026, 9, 23, 0, 10).getTime();
    const groups = groupByDay([{ id: "x", openedAt: new Date(2026, 9, 22, 23, 50).getTime() }], now, LABELS);
    expect(groups[0].label).toBe("昨天");
  });
});
