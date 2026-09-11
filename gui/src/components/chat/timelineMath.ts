// timelineMath.ts — 消息时间线导航栏的纯计算（按天分桶 + 分段映射 + 连续天刻度）
// 会话可能持续多天但只有部分天有消息：按「日历日」切活跃段，没消息的天不占空间，
// 每个活跃日分配轴高（minHeight 兜底）；天刻度 = 每个活跃日一条（分隔天），
// 文字稀疏（活跃日很多时隔 N 天显示日期）。全部纯函数，便于单测。

export type Tick = { time: number; kind: "day" | "hour" | "start" | "end"; showLabel?: boolean };

/** 用户提示刻度：时间线上一类独立标记，用于回溯"我在哪儿说过什么"。
 *  index 指向 messages 下标（点击刻度即定位到该条）。 */
export interface UserPrompt {
  index: number;
  time: number;
  /** 悬停提示用的单行预览（已折叠空白/截断，见 promptPreview）。 */
  preview: string;
}

/** 落在用户提示上的悬停命中：带像素位置便于渲染高亮。 */
export interface UserPromptHit extends UserPrompt {
  pixel: number;
}

/** 提示文本 → 单行预览：把 @ref 语法还原成可读标签、折叠空白、截断。
 *  @ref{file:/a/b/c.ts} → c.ts；带 label 的取 label；未知形态保留原文。 */
export function promptPreview(text: string, maxLen = 60): string {
  const withRefs = (text || "").replace(/@ref\{([^}]*)\}/g, (_m, body: string) => {
    const [target, label] = body.split("|");
    if (label && label.trim()) return label.trim();
    const t = (target || "").trim();
    if (!t) return "";
    // target 形如 <type>:<path>[:line]；取路径末段作可读名
    const path = t.includes(":") ? t.slice(t.indexOf(":") + 1) : t;
    return path.split(/[/\\]/).pop()?.trim() || t;
  });
  const flat = withRefs.replace(/\s+/g, " ").trim();
  return flat.length > maxLen ? flat.slice(0, maxLen) + "…" : flat;
}

/** 找离 y（像素）最近且不超过 threshold 的用户提示；无命中 → null。
 *  两条都在阈值内时取更近的一条（刻度密时不至于乱跳）。 */
export function findNearestPrompt(
  y: number,
  prompts: UserPromptHit[],
  threshold: number,
): UserPromptHit | null {
  let best: UserPromptHit | null = null;
  let bestDist = Infinity;
  for (const p of prompts) {
    const d = Math.abs(p.pixel - y);
    if (d <= threshold && d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

/** 渲染用像素簇：相邻两条像素间距 < minGap 时并作一个标记。
 *  密度高时刻度中心距会小于点直径（视觉上糊成一片），聚类后每簇只画一个点。
 *  **吸附不受聚类影响** —— 仍用原始刻度取最近的那条，精度不打折。 */
export interface PromptCluster {
  /** 簇标记位置（簇内首尾像素的中点） */
  pixel: number;
  /** 簇内刻度，按 pixel 升序 */
  items: UserPromptHit[];
}

export function clusterPrompts(ticks: UserPromptHit[], minGap: number): PromptCluster[] {
  if (ticks.length === 0) return [];
  const sorted = [...ticks].sort((a, b) => a.pixel - b.pixel);
  const out: PromptCluster[] = [];
  let cur: UserPromptHit[] = [sorted[0]];
  const flush = () => {
    const first = cur[0].pixel;
    const last = cur[cur.length - 1].pixel;
    out.push({ pixel: (first + last) / 2, items: cur });
  };
  for (let i = 1; i < sorted.length; i++) {
    // 与簇内**最后一条**比间距（链式聚合：3px 间隔的一串会连成一个簇）
    if (sorted[i].pixel - cur[cur.length - 1].pixel < minGap) {
      cur.push(sorted[i]);
    } else {
      flush();
      cur = [sorted[i]];
    }
  }
  flush();
  return out;
}

/** 活跃段：同一天内连续的消息子集 */
export interface TimeSegment {
  startTime: number;
  endTime: number;
  startIndex: number;
  endIndex: number;
}

/** 段在时间轴上的像素范围 */
export interface SegmentLayout {
  seg: TimeSegment;
  start: number;
  end: number;
}

/** 每段最小轴高（px），避免消息少的活跃日被压没 */
export const MIN_SEGMENT_PX = 48;

/** 时间 → 消息索引：二分找到「t 之前最近一条」消息（含重复时间戳的最后一条）。
 *  输入须按时间递增。t 早于首条 → 0；t 晚于末条 → 末条。空数组 → -1。 */
export function timeToIndex(timestamps: number[], t: number): number {
  if (timestamps.length === 0) return -1;
  let lo = 0;
  let hi = timestamps.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timestamps[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** 按本地日历日切活跃段：日历日变化即切段。输入须递增。 */
export function segmentizeByDay(timestamps: number[]): TimeSegment[] {
  if (timestamps.length === 0) return [];
  const dayKey = (t: number) => {
    const d = new Date(t);
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  };
  const segs: TimeSegment[] = [];
  let start = timestamps[0];
  let startIdx = 0;
  for (let i = 1; i < timestamps.length; i++) {
    if (dayKey(timestamps[i]) !== dayKey(timestamps[i - 1])) {
      segs.push({ startTime: start, endTime: timestamps[i - 1], startIndex: startIdx, endIndex: i - 1 });
      start = timestamps[i];
      startIdx = i;
    }
  }
  segs.push({ startTime: start, endTime: timestamps[timestamps.length - 1], startIndex: startIdx, endIndex: timestamps.length - 1 });
  return segs;
}

/** 给各段分配像素范围：先按时长比例，低于 MIN 的抬高，再归一化到整高。结果首尾相接覆盖 [0, height]。 */
export function layoutSegments(segs: TimeSegment[], height: number, minHeight: number = MIN_SEGMENT_PX): SegmentLayout[] {
  if (segs.length === 0 || height <= 0) return [];
  const totalDur = segs.reduce((s, x) => s + Math.max(0, x.endTime - x.startTime), 0);
  if (totalDur <= 0) {
    const each = height / segs.length;
    return segs.map((seg, i) => ({ seg, start: i * each, end: (i + 1) * each }));
  }
  const clamped = segs.map((x) => Math.max(minHeight, (height * Math.max(0, x.endTime - x.startTime)) / totalDur));
  const sum = clamped.reduce((a, b) => a + b, 0);
  const scale = sum > 0 ? height / sum : 1;
  const h = clamped.map((x) => x * scale);
  const layout: SegmentLayout[] = [];
  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    layout.push({ seg: segs[i], start: acc, end: acc + h[i] });
    acc += h[i];
  }
  if (layout.length > 0) layout[layout.length - 1].end = height;
  return layout;
}

/** 像素 y → 时间：找到 y 所在段，段内线性映射。空 layout → 0。 */
export function pixelToTime(y: number, layout: SegmentLayout[]): number {
  if (layout.length === 0) return 0;
  for (const { seg, start, end } of layout) {
    if (y >= start && y <= end) {
      const span = end - start;
      if (span <= 0) return seg.startTime;
      return seg.startTime + ((y - start) / span) * (seg.endTime - seg.startTime);
    }
  }
  return y < layout[0].start ? layout[0].seg.startTime : layout[layout.length - 1].seg.endTime;
}

/** 时间 → 像素：段内线性映射；落在段间（省略的无消息日）吸附到最近段边界。空 layout → 0。 */
export function timeToPixel(t: number, layout: SegmentLayout[]): number {
  if (layout.length === 0) return 0;
  if (t <= layout[0].seg.startTime) return layout[0].start;
  const last = layout[layout.length - 1];
  if (t >= last.seg.endTime) return last.end;
  for (const { seg, start, end } of layout) {
    if (t <= seg.endTime) {
      if (t < seg.startTime) return start; // 段间（省略日）吸附段边界
      const span = end - start;
      if (span <= 0) return start;
      return start + ((t - seg.startTime) / (seg.endTime - seg.startTime)) * span;
    }
  }
  return last.end;
}

/** 按时间跨度选小时节点步长（毫秒）。跨度越大步长越粗。 */
function pickHourStep(span: number): number {
  const M = 60_000;
  const H = 3600_000;
  if (span <= 30 * M) return 10 * M;
  if (span <= 2 * H) return 30 * M;
  if (span <= 6 * H) return H;
  if (span <= 24 * H) return 2 * H;
  return 6 * H;
}

/** 均分取样：数组超 n 时均匀取 n 个（保首末）。 */
export function pickEven<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const picked: T[] = [];
  for (let i = 0; i < n; i++) picked.push(arr[Math.min(arr.length - 1, Math.round(i * step))]);
  picked[0] = arr[0];
  picked[picked.length - 1] = arr[arr.length - 1];
  return picked;
}

/** 生成刻度，左右分栏语义：
 *  - 天刻度（day）：左侧，每个活跃日一条刻度线（分隔天），位置在该日最早消息处，
 *    日期文字稀疏（活跃日很多时隔 N 天显示）；
 *  - 时间刻度（start/end/hour）：右侧，段内整点/端点，仅显示时分。
 *  天刻度不因 maxCount 截断（每个活跃日都在），时间刻度独立 clamp。 */
export function buildTicks(layout: SegmentLayout[], opts?: { maxCount?: number }): Tick[] {
  if (layout.length === 0) return [];
  const maxCount = opts?.maxCount ?? 8;

  // 天刻度：每个活跃日一条（段首 = 该日最早消息），文字稀疏
  const dayTicks: Tick[] = layout.map(({ seg }) => ({
    time: seg.startTime,
    kind: "day" as const,
    showLabel: true,
  }));
  const labelStep = dayTicks.length > 6 ? Math.ceil(dayTicks.length / 4) : 1;
  dayTicks.forEach((tk, i) => {
    tk.showLabel = i % labelStep === 0 || i === dayTicks.length - 1;
  });

  // 时间刻度：每段端点 + 段内整点/半整点
  const timeCands: Tick[] = [];
  for (const { seg } of layout) {
    timeCands.push({ time: seg.startTime, kind: "start" });
    const dur = seg.endTime - seg.startTime;
    if (dur > 0) {
      const step = pickHourStep(dur);
      for (let h = Math.ceil(seg.startTime / step) * step; h < seg.endTime; h += step) {
        timeCands.push({ time: h, kind: "hour" });
        if (timeCands.length > 64) break;
      }
    }
    timeCands.push({ time: seg.endTime, kind: "end" });
  }
  timeCands.sort((a, b) => a.time - b.time);
  const timeOut: Tick[] = [];
  for (const tk of timeCands) {
    if (timeOut.length === 0) {
      timeOut.push(tk);
      continue;
    }
    if (tk.time === timeOut[timeOut.length - 1].time) {
      if (tk.kind === "start" || tk.kind === "end") timeOut[timeOut.length - 1] = tk;
      continue;
    }
    timeOut.push(tk);
  }
  // 时间刻度独立 clamp：不因活跃日多而被挤光（右侧始终有足够的时间刻度）
  const timeLimit = Math.max(4, maxCount);
  const timeTicks = pickEven(timeOut, timeLimit);

  return [...dayTicks, ...timeTicks].sort((a, b) => a.time - b.time);
}
