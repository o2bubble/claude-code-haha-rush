// ── 「最近打开的会话」记录池（MRU）──
//
// 会话面板的「最近」Tab 用它：按"打开时间"倒序列出最近打开过的会话，
// 并按本地日期分组（今天/昨天/MM-DD）。
//
// ⚠️ **为什么存 openedAt 而不是复用 Session.timestamp**：
// `Session.timestamp` 是会话文件的 **mtime**（最后一次写消息的时间，见
// `src/entrypoints/ideMode.ts` 的 `timestamp: new Date(lite.mtime)`）——
// 它表示"最后交互"，不是"最后打开"。用它分组会把 MRU 顺序切成碎块
// （同一天的会话在列表里出现多次），也表达不了"只翻看没发消息"的打开。
//
// 纯函数模块：不读设置、不碰存储，便于单测。

export interface RecentSessionEntry {
  id: string;
  /** 打开时刻（Unix ms）。MRU 排序与日期分组都用它。 */
  openedAt: number;
}

/** 记录池默认上限（设置项 `recentSessionMax` 的缺省值）。 */
export const DEFAULT_RECENT_MAX = 25;
export const MIN_RECENT_MAX = 1;
export const MAX_RECENT_MAX = 200;

/**
 * 把设置里的原始值钳到合法区间。
 *
 * ⚠️ 必须做：`IntField` 只把 min/max 传给 `<input type="number">`，**不做数值
 * 钳制**（清空输入框 → `parseInt(...) || min`；输入 999 → 原样回调）。
 */
export function clampRecentMax(n: number | undefined | null): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_RECENT_MAX;
  return Math.min(MAX_RECENT_MAX, Math.max(MIN_RECENT_MAX, Math.trunc(n)));
}

/** 记一次打开：置顶（时间更新）+ 去重 + 截断到上限。 */
export function recordSessionRecent(
  list: RecentSessionEntry[],
  id: string,
  now: number,
  max: number,
): RecentSessionEntry[] {
  const limit = Math.max(1, Math.trunc(max) || 1);
  const rest = list.filter((e) => e.id !== id);
  return [{ id, openedAt: now }, ...rest].slice(0, limit);
}

/**
 * 丢掉已不存在的会话（被删除后不留死链）。
 *
 * ⚠️ 调用方必须确保会话列表**完整**（`sessionsLoaded && isSessionListComplete`）：
 * 列表截断/分页/尚未到达时"不在列表"≠"已删除"。
 */
export function pruneMissing(
  list: RecentSessionEntry[],
  liveIds: Set<string>,
): RecentSessionEntry[] {
  return list.filter((e) => liveIds.has(e.id));
}

/** 本地日期键 `YYYY-MM-DD`（用于分组，避免跨时区/夏令时误差）。 */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface RecentDayGroup {
  /** `YYYY-MM-DD`，React key 用 */
  key: string;
  /** 展示用标签：今天 / 昨天 / `MM-DD`（跨年 `YYYY-MM-DD`） */
  label: string;
  items: RecentSessionEntry[];
}

/**
 * 按打开时间的本地日期分组（组内、组间都按时间倒序）。
 *
 * 标签由调用方传入（i18n 不该耦合进纯函数）；同年省略年份，跨年补全年份。
 */
export function groupByDay(
  entries: RecentSessionEntry[],
  now: number,
  labels: { today: string; yesterday: string },
): RecentDayGroup[] {
  const sorted = [...entries].sort((a, b) => b.openedAt - a.openedAt);
  const n = new Date(now);
  const todayKey = dayKey(now);
  const yesterdayKey = dayKey(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1).getTime());
  const thisYear = n.getFullYear();

  const groups: RecentDayGroup[] = [];
  for (const e of sorted) {
    const key = dayKey(e.openedAt);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      let label: string;
      if (key === todayKey) label = labels.today;
      else if (key === yesterdayKey) label = labels.yesterday;
      else {
        const d = new Date(e.openedAt);
        const pad = (x: number) => String(x).padStart(2, "0");
        label =
          d.getFullYear() === thisYear
            ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
            : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      }
      g = { key, label, items: [] };
      groups.push(g);
    }
    g.items.push(e);
  }
  return groups;
}
