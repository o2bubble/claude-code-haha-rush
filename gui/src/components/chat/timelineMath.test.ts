import { describe, it, expect } from "vitest";
import {
  timeToIndex, segmentizeByDay, layoutSegments, pixelToTime, timeToPixel, buildTicks,
} from "./timelineMath";

const H = 3600_000;
const M = 60_000;
// 本地 8/12 22:00 起始
const D0 = new Date(2026, 7, 12, 22, 0).getTime();
// 段1: 8/12 22:00-23:00 (index 0-2)，段2: 8/13 09:00-10:00 (index 3-5)
const timestamps = [D0, D0 + 30 * M, D0 + H, D0 + 11 * H, D0 + 11 * H + 30 * M, D0 + 12 * H];

describe("timeToIndex", () => {
  it("空数组返回 -1", () => {
    expect(timeToIndex([], 5000)).toBe(-1);
  });
  it("t 落在两条消息之间 → 之前最近一条", () => {
    expect(timeToIndex([1000, 2000, 3000], 2500)).toBe(1);
  });
  it("重复时间戳取同组最后一条", () => {
    expect(timeToIndex([1000, 3000, 3000, 4000], 3000)).toBe(2);
  });
  it("t 早于首条 → 0", () => {
    expect(timeToIndex([1000, 2000], 500)).toBe(0);
  });
  it("t 晚于末条 → 末条", () => {
    expect(timeToIndex([1000, 2000], 9000)).toBe(1);
  });
});

describe("segmentizeByDay", () => {
  it("空数组 → []", () => {
    expect(segmentizeByDay([])).toEqual([]);
  });
  it("单条消息 → 单段", () => {
    expect(segmentizeByDay([D0])).toHaveLength(1);
  });
  it("日历日变化即切段", () => {
    const segs = segmentizeByDay(timestamps);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ startTime: D0, endTime: D0 + H, startIndex: 0, endIndex: 2 });
    expect(segs[1]).toEqual({ startTime: D0 + 11 * H, endTime: D0 + 12 * H, startIndex: 3, endIndex: 5 });
  });
  it("同一天不切段（即使间隔数小时）", () => {
    const same = [D0, D0 + 3 * H, D0 + 8 * H]; // 8/12 22:00、次日01:00、06:00 仍同一天? 22:00+8h=次日06:00
    // 22:00+3h=01:00(次日) 22:00+8h=06:00(次日) — 都跨天了，改用同天更稳妥
    const s = new Date(2026, 7, 12, 9, 0).getTime();
    const same2 = [s, s + 3 * H, s + 8 * H];
    expect(segmentizeByDay(same2)).toHaveLength(1);
  });
});

describe("layoutSegments", () => {
  it("单段占满整高", () => {
    const layout = layoutSegments(segmentizeByDay([D0, D0 + M]), 200, 20);
    expect(layout[0].start).toBe(0);
    expect(layout[0].end).toBe(200);
  });
  it("等时长两段均分高度", () => {
    const layout = layoutSegments(segmentizeByDay(timestamps), 200, 20);
    expect(layout).toHaveLength(2);
    expect(layout[0].start).toBe(0);
    expect(layout[0].end).toBe(100);
    expect(layout[1].start).toBe(100);
    expect(layout[1].end).toBe(200);
  });
  it("短段被 minHeight 抬高（无消息日省略）", () => {
    // 段1: 8/12 单点(短)，段2: 8/13 长 100min
    const t = [D0, D0 + 11 * H, D0 + 11 * H + 100 * M];
    const layout = layoutSegments(segmentizeByDay(t), 300, 60);
    expect(layout).toHaveLength(2);
    expect(layout[0].end - layout[0].start).toBeGreaterThanOrEqual(60 * 0.5);
    expect(layout[1].end).toBe(300);
  });
  it("layout 首尾相接覆盖整高", () => {
    const layout = layoutSegments(segmentizeByDay(timestamps), 400, 20);
    expect(layout[0].start).toBe(0);
    for (let i = 1; i < layout.length; i++) {
      expect(layout[i].start).toBe(layout[i - 1].end);
    }
    expect(layout[layout.length - 1].end).toBe(400);
  });
});

describe("pixelToTime / timeToPixel（分段）", () => {
  const layout = layoutSegments(segmentizeByDay(timestamps), 200, 20);

  it("段内像素 ↔ 段内时间线性", () => {
    expect(pixelToTime(0, layout)).toBe(D0);
    expect(pixelToTime(100, layout)).toBe(D0 + H);
    expect(pixelToTime(50, layout)).toBe(D0 + 30 * M);
    expect(pixelToTime(150, layout)).toBe(D0 + 11 * H + 30 * M);
  });
  it("timeToPixel 是 pixelToTime 的反函数（段内部时间点）", () => {
    // 段边界（seg1.end / seg2.start）共享同一像素、归属前段，往返不唯一，只测段内点
    for (const t of [D0, D0 + 30 * M, D0 + 11 * H + 30 * M]) {
      const px = timeToPixel(t, layout);
      expect(pixelToTime(px, layout)).toBeCloseTo(t, -1);
    }
  });
  it("段间（省略日）吸附到最近段边界", () => {
    // 8/12 23:00 ~ 8/13 09:00 之间是省略的无消息时段
    const mid = D0 + 6 * H; // 8/13 04:00
    expect(timeToPixel(mid, layout)).toBe(100);
  });
  it("段边界之外 clamp 到两端像素", () => {
    expect(timeToPixel(D0 - 99999, layout)).toBe(0);
    expect(timeToPixel(D0 + 999 * H, layout)).toBe(200);
  });
  it("空 layout 返回 0，不产生 NaN", () => {
    expect(pixelToTime(0, [])).toBe(0);
    expect(timeToPixel(0, [])).toBe(0);
  });
});

describe("buildTicks（按天分段 + 天刻度）", () => {
  const layout = layoutSegments(segmentizeByDay(timestamps), 200, 20);

  it("每个活跃日一条天刻度（段首），日期不同", () => {
    const days = buildTicks(layout, { maxCount: 8 }).filter((x) => x.kind === "day");
    expect(days).toHaveLength(2);
    const d1 = new Date(days[0].time);
    const d2 = new Date(days[1].time);
    expect(`${d1.getFullYear()}-${d1.getMonth()}-${d1.getDate()}`).toBe("2026-7-12");
    expect(`${d2.getFullYear()}-${d2.getMonth()}-${d2.getDate()}`).toBe("2026-7-13");
    expect(days[0].showLabel).toBe(true);
    expect(days[1].showLabel).toBe(true);
  });
  it("活跃日很多时天刻度全画、文字稀疏", () => {
    const base = new Date(2026, 7, 6, 9, 0).getTime();
    const ts: number[] = [];
    for (let i = 0; i < 8; i++) ts.push(base + i * 86400000);
    const l = layoutSegments(segmentizeByDay(ts), 400, 20);
    const days = buildTicks(l, { maxCount: 8 }).filter((x) => x.kind === "day");
    expect(days).toHaveLength(8); // 每天一条刻度
    const labeled = days.filter((x) => x.showLabel);
    expect(labeled.length).toBeLessThan(days.length);
    expect(labeled[0].showLabel).toBe(true);
    expect(labeled[labeled.length - 1].showLabel).toBe(true);
  });
  it("跨天会话同时产出时间刻度（右侧时分）", () => {
    const times = buildTicks(layout, { maxCount: 8 }).filter((x) => x.kind !== "day");
    expect(times.length).toBeGreaterThanOrEqual(2);
  });
  it("空 layout → []", () => {
    expect(buildTicks([], { maxCount: 8 })).toEqual([]);
  });
});
