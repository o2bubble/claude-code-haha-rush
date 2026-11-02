import { describe, it, expect } from "vitest";
import {
  timeToIndex, segmentizeByDay, layoutSegments, pixelToTime, timeToPixel, buildTicks,
  promptPreview, findNearestPrompt, clusterPrompts, pickEven,
  hitRange, DOT_HIT_MAX, DOT_HIT_MIN, buildUserPrompts, seekIndexAt,
  PROMPT_SNAP_RADIUS,
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

describe("promptPreview — 提示文本 → 单行预览", () => {
  it("折叠空白与换行", () => {
    expect(promptPreview("hello\n\n  world\t!")).toBe("hello world !");
  });

  it("超长截断并加省略号", () => {
    const out = promptPreview("x".repeat(200), 60);
    expect(out).toHaveLength(61); // 60 + '…'
    expect(out.endsWith("…")).toBe(true);
  });

  it("@ref{file:...} 还原成可读文件名（取路径末段；带行号则保留）", () => {
    expect(promptPreview("看看 @ref{file:C:\\a\\b\\Editor.tsx} 这段")).toBe("看看 Editor.tsx 这段");
    // 行号保留 —— 引用到具体行是有用信息，别丢
    expect(promptPreview("看看 @ref{file:/a/b/FileTree.tsx:42}")).toBe("看看 FileTree.tsx:42");
  });

  it("@ref 带 label 时取 label", () => {
    expect(promptPreview("@ref{session:xyz789|上一个会话}")).toBe("上一个会话");
  });

  it("多个 @ref 都还原", () => {
    expect(promptPreview("@ref{file:/a/x.ts} 和 @ref{panel:plan}")).toBe("x.ts 和 plan");
  });

  it("空/纯空白 → 空串", () => {
    expect(promptPreview("")).toBe("");
    expect(promptPreview("   \n  ")).toBe("");
  });
});

describe("findNearestPrompt — 悬停命中查找", () => {
  const mk = (index: number, pixel: number) => ({ index, time: pixel * 1000, preview: `p${index}`, pixel });

  it("命中阈值内最近的一条", () => {
    const list = [mk(0, 10), mk(1, 50), mk(2, 100)];
    expect(findNearestPrompt(52, list, 7)?.index).toBe(1);
    expect(findNearestPrompt(100, list, 7)?.index).toBe(2);
  });

  it("两条都在阈值内 → 取更近的（刻度密时不乱跳）", () => {
    const list = [mk(0, 48), mk(1, 54)];
    expect(findNearestPrompt(50, list, 7)?.index).toBe(0); // 距 2 vs 4
    expect(findNearestPrompt(53, list, 7)?.index).toBe(1); // 距 5 vs 1
  });

  it("超出阈值 → null", () => {
    expect(findNearestPrompt(200, [mk(0, 10)], 7)).toBeNull();
  });

  it("空列表 → null", () => {
    expect(findNearestPrompt(50, [], 7)).toBeNull();
  });

  // 时间线的吸附半径（2026-11-02 用户反馈「其他用来随意时间的定位用不了了」）：
  // 吸附只在圆点附近生效，绝不能覆盖整条轴 —— 那会把自由扫时间挤掉。
  it("PROMPT_SNAP_RADIUS 必须有限且不大（锁死「整条轴归提问」的回归）", () => {
    expect(Number.isFinite(PROMPT_SNAP_RADIUS)).toBe(true);
    expect(PROMPT_SNAP_RADIUS).toBeGreaterThan(0);
    expect(PROMPT_SNAP_RADIUS).toBeLessThanOrEqual(12);
  });
});

// ── 时间线的选中规则 ──
//
// **圆点附近** → 精确跳那条提问（旧的时间反算会落到上一轮的助手消息：
// 提问后面紧跟助手回复，指针稍偏上就取到回复那条，实测真实会话 10/10 全错）。
// **其余位置** → 保持原来的时间反算，按时间自由浏览（这是时间线的本职，
// 2026-11-02 用户明确要求保留）。
describe("seekIndexAt — 时间线指针 → 消息下标", () => {
  const TS = [D0, D0 + 1000, D0 + 2000];
  const layout = layoutSegments(segmentizeByDay(TS), 200, 0);   // 10ms / px
  const tick = (index: number, pixel: number) => ({
    index, time: D0 + pixel * 10, preview: `p${index}`, pixel,
  });

  it("指针在提问点**上方**一点 → 仍吸附到那条提问（旧规则会落到上一条）", () => {
    // 其余位置的时间反算会得到 index 0（上一轮的助手消息）
    expect(seekIndexAt(90, [tick(1, 100)], layout, TS)).toBe(1);
  });

  it("指针在提问点下方一点 → 同一条", () => {
    expect(seekIndexAt(110, [tick(1, 100)], layout, TS)).toBe(1);
  });

  it("超出吸附半径 → 回到时间轴反算（自由扫时间不被圆点吃掉）", () => {
    // 21 条消息（每 100ms 一条），像素 20 = D0+200 = index 2
    const ts = Array.from({ length: 21 }, (_, i) => D0 + i * 100);
    const ticks = [tick(15, 20)];
    // 命中（±10px 内）→ 该提问
    expect(seekIndexAt(20, ticks, layout, ts)).toBe(15);
    expect(seekIndexAt(30, ticks, layout, ts)).toBe(15);
    expect(seekIndexAt(10, ticks, layout, ts)).toBe(15);
    // 离开吸附半径 → 按时间定位（该时刻之前最近一条，不是提问的 index 15）
    expect(seekIndexAt(55, ticks, layout, ts)).toBe(5);
    expect(seekIndexAt(100, ticks, layout, ts)).toBe(10);
  });

  it("没有任何提问刻度 → 时间轴反算（该时刻之前最近一条）", () => {
    expect(seekIndexAt(90, [], layout, TS)).toBe(0);
    expect(seekIndexAt(200, [], layout, TS)).toBe(2);
  });
});

// ── 提问刻度的来源（index 必须指向**传进来的数组**）──
//
// 时间线 / 搜索 / 列表吃的是同一个数组（「只看我的消息」下是过滤后的那份）。
// 一旦有人拿全量数组算刻度、又拿过滤后的数组滚动，点哪条都会偏移。
describe("buildUserPrompts", () => {
  const mkMsg = (role: "user" | "assistant", content: string, extra: Record<string, unknown> = {}) => ({
    role, content, timestamp: 1000, ...extra,
  });

  it("index 就是传入数组的下标（与数组下标空间一致）", () => {
    const msgs = [mkMsg("user", "a"), mkMsg("assistant", "b"), mkMsg("user", "c")];
    const out = buildUserPrompts(msgs);
    expect(out.map((p) => p.index)).toEqual([0, 2]);
    expect(out.map((p) => p.preview)).toEqual(["a", "c"]);
  });

  it("跳过程序代发的用户消息（isMeta：中断标记 / 自动续跑 / 自动唤醒）", () => {
    const msgs = [
      mkMsg("user", "我的问题"),
      mkMsg("user", "[Request interrupted by user]", { isMeta: true }),
      mkMsg("user", "Continue from where you left off.", { isMeta: true }),
    ];
    expect(buildUserPrompts(msgs).map((p) => p.index)).toEqual([0]);
  });

  it("空列表 → []", () => {
    expect(buildUserPrompts([])).toEqual([]);
  });
});

describe("clusterPrompts — 渲染聚类（防密集糊成一片）", () => {
  const mk = (index: number, pixel: number) => ({ index, time: pixel * 1000, preview: `p${index}`, pixel });

  it("稀疏时各自成簇（不改变渲染数量）", () => {
    const out = clusterPrompts([mk(0, 10), mk(1, 50), mk(2, 120)], 8);
    expect(out).toHaveLength(3);
    expect(out.map((c) => c.items.length)).toEqual([1, 1, 1]);
  });

  it("间距小于阈值 → 并作一簇，标记取簇内中点", () => {
    const out = clusterPrompts([mk(0, 100), mk(1, 104)], 8);
    expect(out).toHaveLength(1);
    expect(out[0].items).toHaveLength(2);
    expect(out[0].pixel).toBe(102); // (100+104)/2
  });

  it("链式聚合：3px 间隔的一串连成一个簇", () => {
    const out = clusterPrompts([mk(0, 100), mk(1, 103), mk(2, 106), mk(3, 109)], 8);
    expect(out).toHaveLength(1);
    expect(out[0].items).toHaveLength(4);
  });

  it("阈值按簇内最后一条算 —— 相邻就聚，不看首尾跨度", () => {
    // 100/104/108：相邻都 <8，故全聚（而不是按首尾跨度 20 拆开）
    const out = clusterPrompts([mk(0, 100), mk(1, 104), mk(2, 108)], 8);
    expect(out).toHaveLength(1);
    expect(out[0].pixel).toBe(104); // (100+108)/2
  });

  it("乱序输入按像素排序后再聚", () => {
    const out = clusterPrompts([mk(0, 50), mk(1, 10), mk(2, 12)], 8);
    expect(out).toHaveLength(2);
    expect(out[0].items.map((i) => i.pixel)).toEqual([10, 12]);
    expect(out[1].items.map((i) => i.pixel)).toEqual([50]);
  });

  it("空输入 → []", () => {
    expect(clusterPrompts([], 8)).toEqual([]);
  });
});

// ── 点击刻度的**精确性**（2026-10-28 用户反馈）──
//
// 用户原话：「独立的一个点有办法精准跳转，而不是鼠标对应的位置只能跳到附近」。
// 触点在 UI 层变成了真正的可点元素（TimeLineBar 的 role="button"），点中即
// `onSeek(items[0].index)`。这些用例锁住"index 在聚类/取样的整个链路上不丢、不错位"：
// 一旦某处退化成"按像素反算时间再二分"，就会跳偏一到几条 —— 那正是要修的 bug。

describe("用户提示刻度的 index 精确性（点哪条跳哪条）", () => {
  const mk = (index: number, pixel: number) => ({
    index, time: pixel * 1000, preview: `p${index}`, pixel,
  });

  it("单条簇里的 index 就是那条消息的下标（不做任何近似）", () => {
    // 关键场景：两条消息时间几乎相同，像素只差 3px —— 视觉上一个点，
    // 但它们各自的 index 必须原封不动地带出来
    const out = clusterPrompts([mk(7, 100), mk(9, 103)], 8);
    expect(out).toHaveLength(1);
    expect(out[0].items.map((i) => i.index)).toEqual([7, 9]);
    // 点这个簇 → 浮层按 index 逐条跳，7 和 9 是两个不同的落点
  });

  it("聚类不重排、不丢弃、不复制 index（长度守恒）", () => {
    const input = [mk(0, 10), mk(1, 12), mk(2, 40), mk(3, 41), mk(4, 42), mk(5, 90)];
    const out = clusterPrompts(input, 8);
    const flat = out.flatMap((c) => c.items.map((i) => i.index));
    expect(flat.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("簇内按像素升序（浮层列表自上而下 = 时间先后）", () => {
    const out = clusterPrompts([mk(5, 42), mk(3, 40), mk(4, 41)], 8);
    expect(out[0].items.map((i) => i.index)).toEqual([3, 4, 5]);
  });

  it("pickEven 取样保留完整对象（index 随之保留，不会退化成时间代理）", () => {
    const list = Array.from({ length: 300 }, (_, i) => mk(i, i * 3));
    const picked = pickEven(list, 120);
    expect(picked).toHaveLength(120);
    // 首末必须保留（用户最可能从两头找）
    expect(picked[0].index).toBe(0);
    expect(picked[picked.length - 1].index).toBe(299);
    // 每个取样项都还是原来的对象（index/preview 一一对应）
    for (const p of picked) {
      expect(p.preview).toBe(`p${p.index}`);
    }
  });
});

// ── 命中区切分（点击精准的几何保证）──
//
// 关键性质：**相邻命中区不重叠**。重叠 = 点击由 DOM 顺序决定 = "点了上一个却跳到
// 下一个"，那正是用户抱怨的"只能跳到附近"的一种表现。

describe("hitRange — 命中区按中线切分", () => {
  const cl = (...pixels: number[]) => pixels.map((pixel) => ({ pixel }));

  it("中间点：上下各到与邻居的中线", () => {
    const c = cl(10, 20, 30);
    expect(hitRange(c, 1)).toEqual({ top: 15, bottom: 25 });
  });

  it("首尾点向外延伸半个最大高度", () => {
    const c = cl(10, 20, 30);
    expect(hitRange(c, 0).top).toBe(10 - DOT_HIT_MAX / 2);
    expect(hitRange(c, 2).bottom).toBe(30 + DOT_HIT_MAX / 2);
  });

  it("相邻命中区**不重叠**（稀疏与密集都成立）", () => {
    for (const pixels of [[10, 50, 120], [10, 18, 26, 34], [100, 108, 116, 300]]) {
      const c = cl(...pixels);
      for (let i = 0; i < c.length - 1; i++) {
        const a = hitRange(c, i);
        const b = hitRange(c, i + 1);
        // 相邻区最多在边界相接，不得交叠
        expect(a.bottom).toBeLessThanOrEqual(b.top + 1e-9);
      }
    }
  });

  it("极密处（中间点的中线区间 < 最小高度）撑到最小高度，不会缩成 0", () => {
    // 中间点：top=(100+101)/2=100.5、bottom=(101+102)/2=101.5 → 原始只有 1px，
    // 必须撑到 DOT_HIT_MIN，否则密集区完全点不中
    const c = cl(100, 101, 102);
    const mid = hitRange(c, 1);
    expect(mid.bottom - mid.top).toBeCloseTo(DOT_HIT_MIN, 5);
    // 首尾点向外延伸，本来就够高（不需要钳制）
    expect(hitRange(c, 0).bottom - hitRange(c, 0).top).toBeGreaterThan(DOT_HIT_MIN);
  });

  it("每个点的命中区都**包含自己的像素位置**（点得中自己）", () => {
    const c = cl(10, 12, 100, 101, 102, 200);
    c.forEach((item, i) => {
      const r = hitRange(c, i);
      expect(item.pixel).toBeGreaterThanOrEqual(r.top);
      expect(item.pixel).toBeLessThanOrEqual(r.bottom);
    });
  });

  // 2026-11-02 用户反馈：「时间轴上只能点到点，其他用来随意时间的定位用不了了」。
  // 根因就在这里：命中区只按邻居中线切分、没有封顶 —— 两个点隔 400px 时
  // 每个点的隐形可点区域高达 200px，整条轴都被"点"吃掉。
  it("命中区高度被 DOT_HIT_MAX **封顶**（稀疏处也只是一小圈）", () => {
    const c = cl(100, 500);   // 相距 400px
    for (let i = 0; i < c.length; i++) {
      const r = hitRange(c, i);
      expect(r.bottom - r.top).toBeLessThanOrEqual(DOT_HIT_MAX + 1e-9);
    }
  });

  it("封顶后两点中间是**自由区**（不命中任何点）", () => {
    const c = cl(100, 500);
    const near = (y: number) =>
      c.some((_, i) => {
        const r = hitRange(c, i);
        return y >= r.top && y <= r.bottom;
      });
    // 各占 DOT_HIT_MAX → 中间 111..489 都应该是自由区
    expect(near(300)).toBe(false);
    expect(near(200)).toBe(false);
    expect(near(400)).toBe(false);
    // 点自己附近仍然命中
    expect(near(100)).toBe(true);
    expect(near(500)).toBe(true);
  });
});
