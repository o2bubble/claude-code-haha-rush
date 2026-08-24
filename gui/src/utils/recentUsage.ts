// ── 最近使用记录 — 命令面板按使用频率/时间排序（localStorage 持久化）──

export type RecentKind = "panel" | "command" | "session";

type RecentMap = Record<RecentKind, string[]>;

const STORAGE_KEY = "gui-recent-usage";
const MAX = 20;

/** 纯函数：把 id 记录到列表最前（去重、截断）。可单测。 */
export function recordIntoList(list: string[], id: string, max: number = MAX): string[] {
  const next = [id, ...list.filter((x) => x !== id)];
  return next.slice(0, max);
}

function readMap(): RecentMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { panel: [], command: [], session: [] };
    const parsed = JSON.parse(raw) as Partial<RecentMap>;
    return {
      panel: Array.isArray(parsed.panel) ? parsed.panel : [],
      command: Array.isArray(parsed.command) ? parsed.command : [],
      session: Array.isArray(parsed.session) ? parsed.session : [],
    };
  } catch {
    return { panel: [], command: [], session: [] };
  }
}

function writeMap(map: RecentMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch { /* localStorage 不可用时静默 */ }
}

/** 记录一次使用（id 为带前缀的完整 PaletteItem.id，如 "panel-editor"） */
export function recordRecent(kind: RecentKind, id: string): void {
  const map = readMap();
  map[kind] = recordIntoList(map[kind], id);
  writeMap(map);
}

/** 最近使用的完整 id 列表（最新在前） */
export function getRecent(kind: RecentKind): string[] {
  return readMap()[kind];
}

/** 按最近使用排序：出现过排最前（按时间倒序），未出现的保持原顺序在尾部 */
export function sortByRecent<T extends { id: string }>(items: T[], recentIds: string[]): T[] {
  if (recentIds.length === 0) return items;
  const rank = new Map(recentIds.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return 0; // 稳定排序，未使用的保持原顺序
  });
}
