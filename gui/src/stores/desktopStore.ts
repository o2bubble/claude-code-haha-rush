import { eventBus } from "../services/serviceBus";
import { Events } from "../services/events";
import { dataBus } from "../services/dataBus";
import { withTimeout, DEFAULT_LOAD_TIMEOUT_MS } from "../services/asyncUtils";
import type { Desktop, DesktopItem, Connection, ItemContent } from "../types/desktop";
import { pushSnapshot as pushSnapshotRaw, undo as undoRaw, redo as redoRaw } from "./desktopHistoryStore";
import type { DesktopSnapshot, DesktopStateLike } from "./desktopHistoryStore";
import { setSelection } from "../components/desktop/selectionStore";
import { addStatusMessage } from "./statusMsgStore";
import { getItemType } from "../services/itemTypeRegistry";

// ─── Tauri invoke (dynamic import) ───

async function tauriInvoke(cmd: string, args?: Record<string, unknown>): Promise<any> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke(cmd, args);
  } catch {
    // Tauri API not available (dev server, SSR, etc.)
    return undefined;
  }
}

// ─── Load timeout ───
// db_get_desktops 走工作区 DB（可能是网络盘/被多实例占用），慢或卡住时不能让面板
// 永久转圈。统一超时：超时按「失败」处理，前端落到错误/重试态而不是无限 loading。
const LOAD_TIMEOUT_MS = DEFAULT_LOAD_TIMEOUT_MS;

// ─── State ───

let desktops: Desktop[] = [];
let activeDesktopId: string | null = null;
let registeredItemIds = new Set<string>();
let _viewportAnimate = false;
let _loading = false;
/** 是否至少完成过一次桌面加载（面板据此避免每次激活都重新 loading） */
let _loadedOnce = false;
const _loadListeners = new Set<() => void>();

export function isDesktopLoading(): boolean { return _loading; }

export function onDesktopLoadChange(fn: () => void): () => void {
  _loadListeners.add(fn);
  return () => _loadListeners.delete(fn);
}

function notifyLoadChange(): void {
  for (const fn of _loadListeners) fn();
}

export function shouldAnimateViewport(): boolean {
  if (_viewportAnimate) { _viewportAnimate = false; return true; }
  return false;
}
let _nextZIndex = 100;
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
// 变更集：notify 后仍未落盘的桌面 id。scheduleSave/forceSaveDesktop 按**脏桌面**
// 逐个保存整快照——不能只存 getActiveDesktop()：MCP 可以指定任意 desktopId 变更
// 非激活桌面，只存激活桌面会让那些条目"内存有、盘上无"且 API 照样返回成功。
const _dirtyDesktops = new Set<string>();

// ─── History helpers (wrap desktopHistoryStore, passing internal state) ───

function _push(desktopId: string): void {
  const d = desktops.find((d) => d.id === desktopId);
  if (d) pushSnapshotRaw(desktopId, d);
}

function _undo(desktopId: string): DesktopSnapshot | null {
  const d = desktops.find((d) => d.id === desktopId);
  if (!d) return null;
  return undoRaw(desktopId, d);
}

function _redo(desktopId: string): DesktopSnapshot | null {
  const d = desktops.find((d) => d.id === desktopId);
  if (!d) return null;
  return redoRaw(desktopId, d);
}

/** Public snapshot push — usable by external components. */
export function pushHistory(desktopId: string): void { _push(desktopId); }

/** Public undo/redo — usable by external components (CanvasToolbar). */
export function undoHistory(desktopId: string): DesktopSnapshot | null { return _undo(desktopId); }
export function redoHistory(desktopId: string): DesktopSnapshot | null { return _redo(desktopId); }

// ─── Getters ───

export function getDesktops(): Desktop[] {
  return desktops;
}

export function getActiveDesktop(): Desktop | undefined {
  return desktops.find((d) => d.id === activeDesktopId);
}

export function getActiveDesktopId(): string | null {
  return activeDesktopId;
}

export function getDesktopItem(itemId: string): DesktopItem | undefined {
  for (const d of desktops) {
    const item = d.items.find((i) => i.id === itemId);
    if (item) return item;
  }
  return undefined;
}

/** Owning desktop id of an item (for dirty-marking after item-scoped mutations). */
function ownerDesktopIdOfItem(itemId: string): string | undefined {
  for (const d of desktops) {
    if (d.items.some((i) => i.id === itemId)) return d.id;
  }
  return undefined;
}

/** Owning desktop id of a connection (for dirty-marking after connection mutations). */
function ownerDesktopIdOfConnection(connectionId: string): string | undefined {
  for (const d of desktops) {
    if (d.connections.some((c) => c.id === connectionId)) return d.id;
  }
  return undefined;
}

// ─── DataBus sync (Leaf windows) ───

/** Replace entire desktop state from DataBus sync (Hub receiving from Leaf, or Leaf receiving from Hub). Emits EventBus only — no DataBus publish — to prevent infinite loop. */
export function syncDesktopsFromBus(data: Desktop[], activeId: string | null): void {
  desktops = data;
  activeDesktopId = activeId;
  // Emit EventBus for local component re-renders (no DataBus publish → no loop)
  eventBus.emit(Events.DESKTOP_CHANGED, { desktops: [...desktops], activeDesktopId }, { sticky: true });
  scheduleSave();
}

// ─── Initialization ───

let _lastLoadError: string | null = null;

/** Last load error (null = last load succeeded). The panel uses this to show a
 *  retry state instead of spinning forever when the DB call fails/times out. */
export function getDesktopLoadError(): string | null {
  return _lastLoadError;
}

async function fetchDesktops(): Promise<void> {
  _loading = true;
  notifyLoadChange();
  try {
    // 未落盘的本地变更先 flush 再拉服务端——否则 500ms 防抖窗内的
    // 新建条目会被服务端旧快照整体覆盖（create_item 假成功的放大器）。
    // _refetching 期间 scheduleSave 被抑制，手动补 flush 不成环。
    if (_dirtyDesktops.size > 0) await flushDirtyDesktops();
    const records = await withTimeout(
      tauriInvoke("db_get_desktops"),
      LOAD_TIMEOUT_MS,
      "加载桌面数据超时"
    );
    if (records && Array.isArray(records) && records.length > 0) {
      // 保留本地已存在桌面的视口（pan/zoom + 网格）——跨 GUI refetch（server:data-changed）
      // 或自 echo 时，服务端记录的 view 可能比本地旧（500ms 防抖保存尚未落库 / 他窗并发
      // 改动）。无条件用服务端 view 重建会让用户刚做的缩放/平移"闪回"回旧值。items/
      // connections/name 仍以服务端为准，只有视图保持本地（视图是本地交互态）。
      const prevById = new Map(desktops.map((d) => [d.id, d]));
      desktops = records.map((r: any) => {
        const rec = recordToDesktop(r);
        const prev = prevById.get(rec.id);
        if (prev) {
          rec.panX = prev.panX;
          rec.panY = prev.panY;
          rec.zoom = prev.zoom;
          rec.showGrid = prev.showGrid;
          rec.gridSize = prev.gridSize;
          rec.snapToGrid = prev.snapToGrid;
        }
        return rec;
      });
      activeDesktopId = desktops[0].id;
      // Restore max zIndex
      _nextZIndex = 100;
      for (const d of desktops) {
        for (const item of d.items) {
          if (item.zIndex >= _nextZIndex) _nextZIndex = item.zIndex + 1;
        }
      }
      _lastLoadError = null;
    } else {
      // Bound workspace has no desktops — don't keep stale data from another DB
      desktops = [];
      activeDesktopId = null;
      _nextZIndex = 100;
      _lastLoadError = null;
    }
    notifyDesktopChanged();
  } catch (e: any) {
    // 失败不抛出：已有数据则保留旧桌面，首次失败保持空态 —— 面板据此显示重试，
    // 而不是因为 DB 慢/锁而永久转圈。
    _lastLoadError = e?.message || String(e);
    console.error("[desktop] load failed:", _lastLoadError);
  } finally {
    _loading = false;
    _loadedOnce = true;
    notifyLoadChange();
  }
}

let _loadPromise: Promise<void> | null = null;
// True while mirroring server state (cross-GUI refetch). Suppresses the save that
// notifyDesktopChanged would otherwise trigger — otherwise refetch → save →
// db_changed broadcast → refetch ... creates an infinite A⇄B sync loop.
let _refetching = false;

/** Load the bound workspace's desktops once. Resolves only AFTER the persisted
 *  list has been fetched (waits for BACKEND_PORT_READY — the workspace may not
 *  be bound yet, and before bind the Rust DB still points at the global workDir).
 *  Callers wait on this before deciding to create a fresh desktop, so a panel
 *  mounting pre-bind can't create duplicate "Desktop 1"s. BACKEND_PORT_READY is
 *  sticky, so a mount after the bind resolves immediately.
 *
 *  Always resolves (never rejects): if BACKEND_PORT_READY never fires or the DB
 *  call hangs, a timeout forces a final fetch attempt and settles the promise, so
 *  a loading spinner can never spin forever. Failures surface via
 *  getDesktopLoadError(). */
export function loadDesktops(): Promise<void> {
  if (_loadPromise) return _loadPromise;
  _loadPromise = new Promise<void>((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const off = eventBus.on(Events.BACKEND_PORT_READY, () => {
      off();
      clearTimeout(timer); // 事件已到，取消兜底定时器，避免并发二次 fetch
      void fetchDesktops().finally(finish);
    });
    // 兜底超时：事件不来不能永久 pending —— 强制拉一次（失败走 catch 空态）再结束
    timer = setTimeout(() => {
      off();
      void fetchDesktops().finally(finish);
    }, LOAD_TIMEOUT_MS);
  });
  return _loadPromise;
}

/** 是否已加载过桌面（面板据此跳过重复 loading，直接显示 store 里的缓存数据） */
export function hasLoadedDesktops(): boolean {
  return _loadedOnce;
}

/** 强制重新加载（跨 GUI db_changed refetch 用）——绕过 load-once 守卫，重新拉最新。 */
export async function reloadDesktops(): Promise<void> {
  _refetching = true;
  try {
    await fetchDesktops();
  } finally {
    _refetching = false;
  }
}

/** 清除缓存的加载 promise，允许面板「重试」时重新走一遍完整加载流程 */
export function resetDesktopsLoad(): void {
  _loadPromise = null;
  _loadedOnce = false;
}

// 切换工作区后桌面数据需重新加载（新工作区 DB）——重置加载缓存
eventBus.on(Events.WORKSPACE_BOUND, () => {
  _loadPromise = null;
  _loadedOnce = false;
});

function recordToDesktop(r: any): Desktop {
  return {
    id: r.id,
    name: r.name,
    items: (r.items || []).map((i: any) => recordToItem(i)),
    connections: (r.connections || []).map((c: any) => recordToConnection(c)),
    panX: r.pan_x ?? 0,
    panY: r.pan_y ?? 0,
    zoom: r.zoom ?? 1,
    showGrid: r.show_grid ?? true,
    gridSize: r.grid_size ?? 20,
    snapToGrid: r.snap_to_grid ?? false,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
  };
}

function recordToItem(r: any): DesktopItem {
  let content: ItemContent;
  try {
    content = JSON.parse(r.content_json);
  } catch {
    content = { type: "text", format: "plain", text: "" };
  }
  return {
    id: r.id,
    desktopId: r.desktop_id,
    x: r.x ?? 100,
    y: r.y ?? 100,
    width: r.width ?? 300,
    height: r.height ?? 200,
    zIndex: r.z_index ?? 0,
    content,
    label: r.label || "",
    color: r.color || undefined,
    collapsed: r.collapsed ?? false,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
  };
}

function recordToConnection(r: any): Connection {
  return {
    id: r.id,
    desktopId: r.desktop_id,
    from: { itemId: r.from_item_id, side: r.from_side },
    to: { itemId: r.to_item_id, side: r.to_side },
    label: r.label || undefined,
    strokeColor: r.stroke_color || undefined,
    strokeWidth: r.stroke_width || undefined,
    strokeDasharray: r.stroke_dasharray || undefined,
    createdAt: new Date(r.created_at).getTime(),
  };
}

// ─── Desktop mutations ───

export function createDesktop(name: string): Desktop {
  const d: Desktop = {
    id: crypto.randomUUID(),
    name,
    items: [],
    connections: [],
    panX: 0,
    panY: 0,
    zoom: 1,
    showGrid: true,
    gridSize: 20,
    snapToGrid: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  desktops = [...desktops, d];
  if (!activeDesktopId) activeDesktopId = d.id;
  notifyDesktopChanged(d.id);
  return d;
}

export function deleteDesktop(id: string): void {
  tauriInvoke("db_delete_desktop", { id });
  desktops = desktops.filter((d) => d.id !== id);
  if (activeDesktopId === id) {
    activeDesktopId = desktops[0]?.id ?? null;
  }
  notifyDesktopChanged();
}

export function setActiveDesktop(id: string): void {
  activeDesktopId = id;
  notifyDesktopChanged();
}

export function renameDesktop(id: string, name: string): void {
  desktops = desktops.map((d) =>
    d.id === id ? { ...d, name, updatedAt: Date.now() } : d
  );
  notifyDesktopChanged(id);
}

// ─── Viewport ───

export function updateDesktopViewport(
  id: string,
  partial: { panX?: number; panY?: number; zoom?: number; showGrid?: boolean; gridSize?: number; snapToGrid?: boolean }
): void {
  desktops = desktops.map((d) =>
    d.id === id ? { ...d, ...partial, updatedAt: Date.now() } : d
  );
  notifyDesktopChanged(id);
}

export function clearDesktop(id: string): void {
  _push(id);
  desktops = desktops.map((d) =>
    d.id === id ? { ...d, items: [], connections: [], updatedAt: Date.now() } : d
  );
  registeredItemIds.clear();
  notifyDesktopChanged(id);
}

// ─── Item mutations ───

export function addItem(
  desktopId: string,
  partial: Omit<DesktopItem, "id" | "desktopId" | "zIndex" | "createdAt" | "updatedAt">
): DesktopItem {
  _push(desktopId);
  // Snap new item position if snap-to-grid is on
  const d = desktops.find((d) => d.id === desktopId);
  let { x, y } = partial;
  if (d?.snapToGrid) {
    x = Math.round(x / d.gridSize) * d.gridSize;
    y = Math.round(y / d.gridSize) * d.gridSize;
  }
  const full: DesktopItem = {
    ...partial,
    x, y,
    id: crypto.randomUUID(),
    desktopId,
    zIndex: _nextZIndex++,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  desktops = desktops.map((d) =>
    d.id === desktopId
      ? { ...d, items: [...d.items, full], updatedAt: Date.now() }
      : d
  );
  notifyDesktopChanged(desktopId);
  return full;
}

export function updateItem(
  itemId: string,
  partial: Partial<Omit<DesktopItem, "id" | "desktopId" | "createdAt">>
): void {
  for (const d of desktops) {
    if (d.items.some((i) => i.id === itemId)) { _push(d.id); break; }
  }
  desktops = desktops.map((d) => ({
    ...d,
    items: d.items.map((i) =>
      i.id === itemId ? { ...i, ...partial, updatedAt: Date.now() } : i
    ),
    updatedAt: Date.now(),
  }));
  notifyDesktopChanged(ownerDesktopIdOfItem(itemId));
}

export function removeItem(itemId: string): void {
  for (const d of desktops) {
    if (d.items.some((i) => i.id === itemId)) { _push(d.id); break; }
  }
  // 删除后项已移除，ownerDesktopIdOfItem 必返回 undefined → scheduleSave 退化
  // 标激活桌面脏、真实 owner 永不落盘（删非激活桌面的项=假成功）。删除前先捕获 owner。
  const ownerId = ownerDesktopIdOfItem(itemId);
  desktops = desktops.map((d) => ({
    ...d,
    items: d.items.filter((i) => i.id !== itemId),
    connections: d.connections.filter(
      (c) => c.from.itemId !== itemId && c.to.itemId !== itemId
    ),
    updatedAt: Date.now(),
  }));
  registeredItemIds.delete(itemId);
  notifyDesktopChanged(ownerId);
}

export function moveItem(itemId: string, x: number, y: number): void {
  desktops = desktops.map((d) => ({
    ...d,
    items: d.items.map((i) =>
      i.id === itemId ? { ...i, x, y, updatedAt: Date.now() } : i
    ),
    updatedAt: Date.now(),
  }));
  eventBus.emit(Events.DESKTOP_ITEM_MOVED, { itemId, x, y });
  notifyDesktopChanged(ownerDesktopIdOfItem(itemId));
}

export function resizeItem(itemId: string, width: number, height: number): void {
  desktops = desktops.map((d) => ({
    ...d,
    items: d.items.map((i) =>
      i.id === itemId
        ? { ...i, width: Math.max(50, width), height: Math.max(50, height), updatedAt: Date.now() }
        : i
    ),
    updatedAt: Date.now(),
  }));
  notifyDesktopChanged(ownerDesktopIdOfItem(itemId));
}

/** Move multiple items in a single store update. Caller pushes history once. */
export function batchMoveItems(updates: Map<string, { x: number; y: number }>): void {
  desktops = desktops.map((d) => ({
    ...d,
    items: d.items.map((i) => {
      const u = updates.get(i.id);
      return u ? { ...i, x: u.x, y: u.y, updatedAt: Date.now() } : i;
    }),
    updatedAt: Date.now(),
  }));
  notifyDesktopChanged(ownerDesktopIdOfItem([...updates.keys()][0]));
}

export function bringItemToFront(itemId: string): void {
  desktops = desktops.map((d) => ({
    ...d,
    items: d.items.map((i) =>
      i.id === itemId ? { ...i, zIndex: _nextZIndex++, updatedAt: Date.now() } : i
    ),
    updatedAt: Date.now(),
  }));
  notifyDesktopChanged(ownerDesktopIdOfItem(itemId));
}

// ─── Connection mutations ───

export function addConnection(
  desktopId: string,
  partial: Omit<Connection, "id" | "desktopId" | "createdAt">
): Connection {
  _push(desktopId);
  const full: Connection = {
    ...partial,
    id: crypto.randomUUID(),
    desktopId,
    createdAt: Date.now(),
  };
  desktops = desktops.map((d) =>
    d.id === desktopId
      ? { ...d, connections: [...d.connections, full], updatedAt: Date.now() }
      : d
  );
  notifyDesktopChanged(desktopId);
  return full;
}

export function removeConnection(connectionId: string): void {
  for (const d of desktops) {
    if (d.connections.some((c) => c.id === connectionId)) { _push(d.id); break; }
  }
  // 删除后连线已移除，ownerDesktopIdOfConnection 必返回 undefined → scheduleSave
  // 退化标激活桌面脏。删除前先捕获 owner。
  const ownerId = ownerDesktopIdOfConnection(connectionId);
  desktops = desktops.map((d) => ({
    ...d,
    connections: d.connections.filter((c) => c.id !== connectionId),
    updatedAt: Date.now(),
  }));
  notifyDesktopChanged(ownerId);
}

export function updateConnection(
  connectionId: string,
  partial: Partial<Omit<Connection, "id" | "desktopId" | "createdAt">>
): void {
  for (const d of desktops) {
    if (d.connections.some((c) => c.id === connectionId)) { _push(d.id); break; }
  }
  desktops = desktops.map((d) => ({
    ...d,
    connections: d.connections.map((c) =>
      c.id === connectionId ? { ...c, ...partial } : c
    ),
    updatedAt: Date.now(),
  }));
  notifyDesktopChanged(ownerDesktopIdOfConnection(connectionId));
}

/** Restore desktop state from a snapshot (undo/redo). Does NOT push a snapshot. */
export function restoreSnapshot(
  desktopId: string,
  snap: { items: DesktopItem[]; connections: Connection[]; panX: number; panY: number; zoom: number }
): void {
  desktops = desktops.map((d) =>
    d.id === desktopId
      ? { ...d, items: snap.items, connections: snap.connections, panX: snap.panX, panY: snap.panY, zoom: snap.zoom, updatedAt: Date.now() }
      : d
  );
  notifyDesktopChanged(desktopId);
}

// ─── Batch / search / smart-place ───

/** Read multiple items at once. Missing IDs are silently skipped. */
export function getDesktopItems(itemIds: string[]): DesktopItem[] {
  const result: DesktopItem[] = [];
  const idSet = new Set(itemIds);
  for (const d of desktops) {
    for (const item of d.items) {
      if (idSet.has(item.id)) result.push(item);
    }
  }
  return result;
}

/**
 * Search items by keyword (case-insensitive).
 * Matches against label + text content fields depending on content type.
 */
export function searchItems(query: string, desktopId?: string): DesktopItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const results: DesktopItem[] = [];
  const targets = desktopId
    ? desktops.filter((d) => d.id === desktopId)
    : desktops;

  for (const d of targets) {
    for (const item of d.items) {
      if (item.label.toLowerCase().includes(q)) {
        results.push(item);
        continue;
      }
      if (itemContentMatches(item, q)) {
        results.push(item);
      }
    }
  }
  return results;
}

/** Extract searchable text from an item's content via the per-type registry. */
function itemContentMatches(item: DesktopItem, q: string): boolean {
  const searchText = getItemType(item.content.type)?.searchText?.(item) ?? "";
  return searchText.toLowerCase().includes(q);
}

/**
 * Find a non-overlapping position for a new item near the viewport center.
 * Uses outward spiral search from the center. Returns canvas coordinates.
 */
/** Center the viewport on a specific item (by id), switching desktop if needed. */
export function panToItem(itemId: string): string | null {
  for (const d of desktops) {
    // Support both full UUID and short prefix (AI may truncate to 8 chars)
    const item = d.items.find((i) => i.id === itemId || i.id.startsWith(itemId));
    if (!item) continue;
    // Switch to this desktop (no animation needed for tab switch)
    setActiveDesktop(d.id);
    // Center viewport on item with smooth animation
    _viewportAnimate = true;
    const viewW = window.innerWidth * 0.45;
    const viewH = window.innerHeight * 0.5;
    const cx = item.x + item.width / 2;
    const cy = item.y + item.height / 2;
    updateDesktopViewport(d.id, {
      panX: viewW / 2 - cx * d.zoom,
      panY: viewH / 2 - cy * d.zoom,
    });
    setSelection(new Set([item.id]));
    return item.id;
  }
  return null;
}

export function findSmartPlace(
  desktop: { items: DesktopItem[]; snapToGrid: boolean; gridSize: number },
  itemW: number,
  itemH: number,
): { x: number; y: number } {
  // Start from a fixed anchor near top-left, spiral outward to avoid overlaps
  const anchorX = 100, anchorY = 100;
  const step = desktop.snapToGrid ? desktop.gridSize : 30;
  const maxSteps = 100;

  const overlaps = (x: number, y: number): boolean => {
    for (const it of desktop.items) {
      if (!(x + itemW < it.x || y + itemH < it.y || x > it.x + it.width || y > it.y + it.height)) {
        return true;
      }
    }
    return false;
  };

  const snap = (v: number): number =>
    desktop.snapToGrid ? Math.round(v / desktop.gridSize) * desktop.gridSize : v;

  for (let i = 0; i < maxSteps; i++) {
    const layer = Math.ceil((Math.sqrt(i + 1) - 1) / 2);
    const sideLen = 2 * layer + 1;
    let idx = i - (sideLen - 2) * (sideLen - 2);
    if (idx >= 4 * (sideLen - 1)) idx = 0;

    let dx = 0, dy = 0;
    const side = Math.floor(idx / (sideLen - 1));
    const pos = idx % (sideLen - 1) - (sideLen - 2) / 2;
    switch (side) {
      case 0: dx = pos; dy = -layer; break;
      case 1: dx = layer; dy = pos; break;
      case 2: dx = -pos; dy = layer; break;
      case 3: dx = -layer; dy = -pos; break;
    }

    const tx = snap(anchorX + dx * step);
    const ty = snap(anchorY + dy * step);

    if (!overlaps(tx, ty)) return { x: tx, y: ty };
  }

  return { x: snap(anchorX + 20), y: snap(anchorY + 20) };
}

// ─── Data registry tracking ───

export function markItemRegistered(itemId: string): void {
  registeredItemIds.add(itemId);
}

export function markItemUnregistered(itemId: string): void {
  registeredItemIds.delete(itemId);
}

export function isItemRegistered(itemId: string): boolean {
  return registeredItemIds.has(itemId);
}

// ─── Persistence ───

function desktopToRecord(d: Desktop): any {
  return {
    id: d.id,
    name: d.name,
    pan_x: d.panX,
    pan_y: d.panY,
    zoom: d.zoom,
    show_grid: d.showGrid,
    grid_size: d.gridSize,
    snap_to_grid: d.snapToGrid,
    sort_order: 0,
    created_at: new Date(d.createdAt).toISOString(),
    updated_at: new Date().toISOString(),
    items: d.items.map((i) => ({
      id: i.id,
      desktop_id: i.desktopId,
      x: i.x,
      y: i.y,
      width: i.width,
      height: i.height,
      z_index: i.zIndex,
      content_type: i.content.type,
      content_json: JSON.stringify(i.content),
      label: i.label,
      color: i.color ?? null,
      collapsed: i.collapsed ?? false,
      created_at: new Date(i.createdAt).toISOString(),
      updated_at: new Date(i.updatedAt).toISOString(),
    })),
    connections: d.connections.map((c) => ({
      id: c.id,
      desktop_id: c.desktopId,
      from_item_id: c.from.itemId,
      from_side: c.from.side,
      to_item_id: c.to.itemId,
      to_side: c.to.side,
      label: c.label ?? null,
      stroke_color: c.strokeColor ?? null,
      stroke_width: c.strokeWidth ?? null,
      stroke_dasharray: c.strokeDasharray ?? null,
      created_at: new Date(c.createdAt).toISOString(),
    })),
  };
}

function scheduleSave(dirtyDesktopId?: string): void {
  // 标脏的是**被改的桌面**；无参调用（视口/激活切换等）退回激活桌面。
  const target = dirtyDesktopId
    ? (desktops.find((d) => d.id === dirtyDesktopId)?.id ?? dirtyDesktopId)
    : getActiveDesktop()?.id;
  if (target) _dirtyDesktops.add(target);
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    void flushDirtyDesktops();
  }, 500);
}

/** Persist every dirty desktop (whole-snapshot per desktop). Resolves when all
 *  pending writes settle — MCP mutations await this so "API success" means
 *  actually on disk. */
async function flushDirtyDesktops(): Promise<void> {
  if (_dirtyDesktops.size === 0) return;
  const ids = [..._dirtyDesktops];
  _dirtyDesktops.clear();
  await Promise.all(ids.map(async (id) => {
    const d = desktops.find((x) => x.id === id);
    if (!d) return;
    try {
      const record = desktopToRecord(d);
      const superseded = (await tauriInvoke("db_save_desktop", { desktop: record })) as boolean;
      if (superseded) {
        addStatusMessage("该桌面已被其他窗口修改，已用最新覆盖", "warn");
      }
    } catch {
      // 写失败 → 重新标记脏，下次 schedule/flush 重试
      _dirtyDesktops.add(id);
    }
  }));
}

/** Force immediate persistence — call after MCP/batch mutations. Awaits until
 *  every dirty desktop is on disk. */
export async function forceSaveDesktop(): Promise<void> {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  await flushDirtyDesktops();
}

// ─── Notification ───

function notifyDesktopChanged(dirtyDesktopId?: string): void {
  const payload = { desktops: [...desktops], activeDesktopId };
  eventBus.emit(Events.DESKTOP_CHANGED, payload, { sticky: true });
  // Publish to DataBus for cross-window sync (Leaf → Hub and Hub → Leaf)
  dataBus.publish("desktop.list", payload.desktops, { sticky: true });
  dataBus.publish("desktop.items", payload.activeDesktopId, { sticky: true });
  if (!_refetching) scheduleSave(dirtyDesktopId);
}
