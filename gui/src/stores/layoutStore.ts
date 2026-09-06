import type { IconKey, LayoutNode, SplitNode, TabGroup, TabInstance, FloatingWindow, TauriWindow, Visibility } from "../types/layout";
import { eventBus } from "../services/serviceBus";
import { Events } from "../services/events";
import { addStatusMessage } from "./statusMsgStore";
import { getPanel } from "./panelRegistry";
// ── 默认布局树 — 替换旧的固定四槽位 ──

function pt(panelId: string): string {
  return getPanel(panelId)?.title || panelId;
}

function createDefaultTree(): LayoutNode {
  return {
    type: "split",
    id: "root",
    direction: "horizontal",
    children: [
      // 左侧栏 — Sessions + Files + Settings
      {
        type: "group",
        id: "sidebar-left",
        tabStyle: "activity",
        tabs: [
          { id: "tab-sessions", panelId: "sessions", title: pt("sessions"), icon: "sessions" },
          { id: "tab-files", panelId: "files", title: pt("files"), icon: "files" },
          { id: "tab-plan", panelId: "plan", title: pt("plan"), icon: "plan" },
          { id: "tab-subagents", panelId: "subagents", title: pt("subagents"), icon: "subagents" },
          { id: "tab-skills", panelId: "skills", title: pt("skills"), icon: "skills" },
          { id: "tab-quick-prompts", panelId: "quick-prompts", title: pt("quick-prompts"), icon: "quickPrompts" },
          { id: "tab-workers", panelId: "workers", title: pt("workers"), icon: "workers" },
        ],
        activeTabId: "tab-sessions",
      },
      // 中间列 — Editor + Super Desktop + Terminal
      {
        type: "split",
        id: "center-column",
        direction: "vertical",
        children: [
          {
            type: "group",
            id: "editor-area",
            tabs: [
              { id: "tab-desktop", panelId: "super-desktop", title: pt("super-desktop"), icon: "superDesktop" },
              { id: "tab-editor", panelId: "editor", title: pt("editor"), icon: "editor" },
              { id: "tab-notes", panelId: "notes", title: pt("notes"), icon: "notes" },
            ],
            activeTabId: "tab-desktop",
          },
          {
            type: "group",
            id: "bottom-panel",
            tabStyle: "activity-bottom",
            tabs: [
              { id: "tab-terminal", panelId: "terminal", title: pt("terminal"), icon: "terminal" },
            ],
            activeTabId: "tab-terminal",
          },
        ],
        sizes: [75, 25],
      },
      // 右侧栏 — Chat（消息区 + 输入区，上下可拖拽）
      {
        type: "split",
        id: "chat-split",
        direction: "vertical",
        children: [
          {
            type: "group",
            id: "chat-messages-group",
            tabs: [
              { id: "tab-chat-msgs", panelId: "chat-messages", title: pt("chat-messages"), icon: "messages" },
            ],
            activeTabId: "tab-chat-msgs",
          },
          {
            type: "group",
            id: "chat-input-group",
            tabs: [
              { id: "tab-chat-input", panelId: "chat-input", title: pt("chat-input"), icon: "input" },
            ],
            activeTabId: "tab-chat-input",
          },
        ],
        sizes: [65, 35],
      },
    ],
    sizes: [25, 45, 30],
  };
}

// ── Serialization (icon is a serializable IconKey, carried straight through) ──

function serializeTab(tab: TabInstance): any {
  const out: any = { id: tab.id, panelId: tab.panelId, title: tab.title };
  if (tab.icon) out.icon = tab.icon;
  if (tab.viewId) out.viewId = tab.viewId;
  if (tab.activeChildId) out.activeChildId = tab.activeChildId;
  if (tab.children) out.children = tab.children.map(serializeTab);
  return out;
}

function serializeNode(node: LayoutNode): any {
  if (node.type === "split") {
    return {
      type: "split", id: node.id, direction: node.direction,
      children: node.children.map(serializeNode), sizes: node.sizes,
    };
  }
  return {
    type: "group", id: node.id,
    tabs: node.tabs.map(serializeTab),
    activeTabId: node.activeTabId,
    ...(node.tabStyle ? { tabStyle: node.tabStyle } : {}),
    ...(node.visibility ? { visibility: node.visibility } : {}),
  };
}

function serializeFloating(fp: FloatingWindow): any {
  return {
    type: "floating", id: fp.id,
    x: fp.x, y: fp.y, width: fp.width, height: fp.height, zIndex: fp.zIndex,
    group: serializeNode(fp.group),
  };
}

function serializeTauriWindow(tw: TauriWindow): any {
  return {
    type: "tauri", id: tw.id, label: tw.label,
    x: tw.x, y: tw.y, width: tw.width, height: tw.height,
    group: serializeNode(tw.group),
  };
}

/** Panels that should NOT be persisted — system-managed, opened temporarily */
function isEphemeral(panelId: string): boolean {
  const def = getPanel(panelId);
  return def?.userManaged === false;
}

export function serializeLayout(): object {
  return {
    tree: filterEphemeralTab(tree),
    floatingPanels: floatingPanels
      .filter((fp) => !fp.group.tabs.some((t) => isEphemeral(t.panelId)))
      .map(serializeFloating),
    tauriWindows: tauriWindows
      .filter((tw) => !tw.group.tabs.some((t) => isEphemeral(t.panelId)))
      .map(serializeTauriWindow),
  };
}

/** Strip ephemeral tabs from the layout tree before saving */
function filterEphemeralTab(node: LayoutNode): LayoutNode {
  if (node.type === "group") {
    const filtered = node.tabs.filter((t) => !isEphemeral(t.panelId));
    if (filtered.length === 0) return node; // empty group — caller handles
    return { ...node, tabs: filtered, activeTabId: filtered.some((t) => t.id === node.activeTabId) ? node.activeTabId : filtered[0]?.id ?? null };
  }
  return { ...node, children: node.children.map(filterEphemeralTab) };
}

// ── Deserialization (IconKey passes through; legacy data without icon falls back to registry) ──

function deserializeTab(data: any): TabInstance {
  // 只有字符串才是有效 IconKey；旧版遗留数据把 icon 存成了 ReactNode 对象（truthy 但非法），必须丢弃回退 registry
  const iconKey = (typeof data.icon === "string" ? data.icon as IconKey : undefined) ?? getPanel(data.panelId)?.icon;
  return {
    id: data.id,
    panelId: data.panelId,
    ...(data.viewId ? { viewId: data.viewId } : {}),
    title: data.title,
    ...(iconKey ? { icon: iconKey } : {}),
    ...(data.children ? { children: data.children.map(deserializeTab) } : {}),
    ...(data.activeChildId ? { activeChildId: data.activeChildId } : {}),
  };
}

function deserializeNode(data: any): LayoutNode {
  if (data.type === "split") {
    return {
      type: "split", id: data.id, direction: data.direction,
      children: data.children.map(deserializeNode), sizes: data.sizes,
    };
  }
  return {
    type: "group", id: data.id,
    tabs: data.tabs.map(deserializeTab),
    activeTabId: data.activeTabId,
    ...(data.tabStyle ? { tabStyle: data.tabStyle } : {}),
    ...(data.visibility ? { visibility: data.visibility } : {}),
  };
}

function deserializeFloating(data: any): FloatingWindow | null {
  const group = deserializeNode(data.group);
  if (group.type !== "group") return null; // corrupted data — skip
  return {
    type: "floating", id: data.id,
    x: data.x, y: data.y, width: data.width, height: data.height, zIndex: data.zIndex,
    group,
  };
}

function deserializeTauriWindow(data: any): TauriWindow | null {
  const group = deserializeNode(data.group);
  if (group.type !== "group") return null;
  return { type: "tauri", id: data.id, label: data.label, x: data.x, y: data.y, width: data.width, height: data.height, group };
}

/** 与 serializeLayout 的 isEphemeral 语义一致 — 复合组 tab(panelId="") 的 getPanel 为 undefined，不算 ephemeral */
function isEphemeralTab(t: any): boolean {
  return getPanel(t.panelId)?.userManaged === false;
}

export function deserializeLayout(data: any): { tree: LayoutNode; floatingPanels: FloatingWindow[]; tauriWindows: TauriWindow[] } {
  return {
    tree: deserializeNode(data.tree),
    floatingPanels: ((data.floatingPanels || []) as any[])
      .map(deserializeFloating)
      .filter((fp: any) => fp && !fp.group?.tabs?.some(isEphemeralTab)) as FloatingWindow[],
    tauriWindows: ((data.tauriWindows || []) as any[])
      .map(deserializeTauriWindow)
      .filter((tw: any) => tw && !tw.group?.tabs?.some(isEphemeralTab)) as TauriWindow[],
  };
}

/** Walk the layout tree and restore titles from panel registry (persisted titles are stale after i18n/code updates) */
function refreshTitles(node: LayoutNode): LayoutNode {
  if (node.type === "group") {
    const tabs = node.tabs.map((t) => {
      // 先刷新复合 tab 的 children — 旧持久化数据(合并面板时)把硬编码英文标题存进了
      // children,不刷新会一直在 bar 上显示英文
      const children = t.children?.map((c) => {
        const cp = getPanel(c.panelId);
        const cTitle = cp?.title ?? c.title;
        return cTitle !== c.title ? { ...c, title: cTitle } : c;
      });
      // 复合 tab(panelId="")本身无 panel 定义,标题跟随活跃子面板(已刷新);
      // 普通 tab 从 registry 取标题
      const activeChild = children?.find((c) => c.id === t.activeChildId) ?? children?.[0];
      const title = activeChild?.title ?? getPanel(t.panelId)?.title ?? t.title;
      return { ...t, title, ...(children ? { children } : {}) };
    });
    return { ...node, tabs };
  }
  // SplitNode
  return { ...node, children: node.children.map(refreshTitles) };
}

/** Atomic restore on startup — applies layout + floatingPanels, skips save */
export function restoreLayout(data: any) {
  _skipSave = true;
  const restored = deserializeLayout(data);
  tree = refreshTitles(restored.tree);
  floatingPanels = restored.floatingPanels.map((fp) => ({
    ...fp,
    group: refreshTitles(fp.group) as TabGroup,
  }));
  tauriWindows = restored.tauriWindows.map((tw) => ({
    ...tw,
    group: refreshTitles(tw.group) as TabGroup,
  }));
  _floatingZCounter = Math.max(1000, ...restored.floatingPanels.map((f) => f.zIndex)) + 1;
  eventBus.emit(Events.LAYOUT_TREE_CHANGED, { tree }, { sticky: true });
  eventBus.emit(Events.LAYOUT_FLOATING_CHANGED, { floatingPanels: [...floatingPanels] }, { sticky: true });
  setTimeout(() => { _skipSave = false; }, 100);

  // Restore Tauri native windows (dedup by panelId)
  const seenPanels = new Set<string>();
  const unique = tauriWindows.filter((tw) => {
    const pid = tw.group.tabs[0]?.panelId;
    if (!pid || seenPanels.has(pid)) return false;
    seenPanels.add(pid);
    return true;
  });
  tauriWindows = unique;
  for (const tw of tauriWindows) {
    const tab = tw.group.tabs[0];
    if (!tab) continue;
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke("create_floating_window", { label: tw.label, panelId: tab.panelId, title: tab.title, width: tw.width, height: tw.height }).catch(() => {});
    }).catch(() => {});
  }
}

/** Re-apply panel-registry titles to the CURRENT tree. The default layout is
 *  created at module load — before registerPanel() runs — so its tabs carry
 *  English panel ids (getPanel() not yet registered). Call once after panels are
 *  registered so even a layout-less workspace (default layout) shows localized
 *  titles. */
export function refreshAllTitles() {
  tree = refreshTitles(tree);
  eventBus.emit(Events.LAYOUT_TREE_CHANGED, { tree }, { sticky: true });
}

// ── Debounced auto-save flag (save I/O is in App.tsx hook) ──

let _skipSave = false;

export function setSkipSave(skip: boolean) {
  _skipSave = skip;
}

export function getSkipSave(): boolean {
  return _skipSave;
}

// ── 全局状态 ──

let tree: LayoutNode = createDefaultTree();

export function getTree(): LayoutNode {
  return tree;
}

export function setTree(newTree: LayoutNode) {
  tree = newTree;
  eventBus.emit(Events.LAYOUT_TREE_CHANGED, { tree }, { sticky: true });
}

// ── 悬浮面板状态 ──

let floatingPanels: FloatingWindow[] = [];
let _floatingZCounter = 1000;

function notifyFloatingChange() {
  eventBus.emit(Events.LAYOUT_FLOATING_CHANGED, { floatingPanels: [...floatingPanels] }, { sticky: true });
  eventBus.emit(Events.LAYOUT_TREE_CHANGED, { tree }, { sticky: true });
}

export function getFloatingPanels(): FloatingWindow[] {
  return floatingPanels;
}

export function addFloatingPanel(group: TabGroup, x: number, y: number, width: number, height: number): string {
  const id = `float-${crypto.randomUUID()}`;
  floatingPanels.push({ type: "floating", id, group, x, y, width, height, zIndex: _floatingZCounter++ });
  notifyFloatingChange();
  return id;
}

export function removeFloatingPanel(id: string) {
  const idx = floatingPanels.findIndex((fp) => fp.id === id);
  if (idx === -1) return;
  floatingPanels.splice(idx, 1);
  notifyFloatingChange();
}

export function updateFloatingPosition(id: string, x: number, y: number) {
  const fp = floatingPanels.find((fp) => fp.id === id);
  if (!fp) return;
  fp.x = x; fp.y = y;
  notifyFloatingChange(); // persist on drag end (called only on mouseup)
}

export function updateFloatingSize(id: string, width: number, height: number) {
  const fp = floatingPanels.find((fp) => fp.id === id);
  if (!fp) return;
  fp.width = width; fp.height = height;
  notifyFloatingChange();
}

export function bringFloatingToFront(id: string) {
  const fp = floatingPanels.find((fp) => fp.id === id);
  if (!fp) return;
  fp.zIndex = _floatingZCounter++;
  notifyFloatingChange();
}

export function addTabToFloating(floatingId: string, tab: TabInstance) {
  const fp = floatingPanels.find((fp) => fp.id === floatingId);
  if (!fp) return;
  fp.group.tabs.push(tab);
  fp.group.activeTabId = tab.id;
  notifyFloatingChange();
}

export function removeTabFromFloating(floatingId: string, tabId: string) {
  const fp = floatingPanels.find((fp) => fp.id === floatingId);
  if (!fp) return;
  const g = fp.group;
  const next = g.tabs.filter((t) => t.id !== tabId);
  const active = g.activeTabId === tabId ? (next[next.length - 1]?.id ?? null) : g.activeTabId;
  g.tabs = next;
  g.activeTabId = active;
  if (next.length === 0) { removeFloatingPanel(floatingId); return; }
  notifyFloatingChange();
}

export function setActiveTabInFloating(floatingId: string, tabId: string) {
  const fp = floatingPanels.find((fp) => fp.id === floatingId);
  if (!fp) return;
  fp.group.activeTabId = tabId;
  notifyFloatingChange();
}

/** 从浮窗的复合父 tab 中移除一个子 tab，collapsing 逻辑与 removeChildFromCompound 一致 */
export function removeChildFromFloatingTab(floatingId: string, parentTabId: string, childId: string) {
  const fp = floatingPanels.find((fp) => fp.id === floatingId);
  if (!fp) return;
  const parentTab = fp.group.tabs.find((t) => t.id === parentTabId);
  if (!parentTab?.children) return;
  const removed = parentTab.children.find((c) => c.id === childId);
  const remain = parentTab.children.filter((c) => c.id !== childId);
  if (remain.length <= 1) {
    // 剩 1 个子面板 → 复合组自动解散，图标/标题回归该子面板本身
    const last = remain[0] ?? removed;
    if (last) {
      parentTab.panelId = last.panelId;
      parentTab.title = last.title;
      parentTab.icon = last.icon ?? "default";
    }
    parentTab.children = undefined;
    parentTab.activeChildId = undefined;
  } else {
    parentTab.children = remain;
    if (parentTab.activeChildId === childId) parentTab.activeChildId = remain[0]?.id ?? null;
  }
  notifyFloatingChange();
}

/** 从拖出的 tab 创建浮窗 — 由 executeDrop 在空区 drop 时调用 */
export function createFloatingFromTab(tab: TabInstance, preferredX?: number, preferredY?: number) {
  const tabClone: TabInstance = {
    ...tab,
    id: `tab-${tab.panelId}-${crypto.randomUUID().slice(0, 8)}`,
    icon: tab.icon ?? "default",
    children: tab.children ? tab.children.map((c) => ({ ...c })) : undefined,
  };
  const group: TabGroup = {
    type: "group",
    id: `group-float-${crypto.randomUUID()}`,
    tabs: [tabClone],
    activeTabId: tabClone.id,
    tabStyle: "tabs",
  };
  const x = preferredX ?? Math.max(50, (window.innerWidth - 600) / 2 + floatingPanels.length * 30);
  const y = preferredY ?? Math.max(50, (window.innerHeight - 400) / 2 + floatingPanels.length * 30);
  addFloatingPanel(group, x, y, 600, 400);
}

// ── Tauri 原生子窗口状态 ──

let tauriWindows: TauriWindow[] = [];

function notifyTauriWindowsChange() {
  // Reuse floating changed event — consumers that care about both can handle it
  eventBus.emit(Events.LAYOUT_FLOATING_CHANGED, {
    floatingPanels: [...floatingPanels],
    tauriWindows: [...tauriWindows],
  } as any, { sticky: true });
}

export function getTauriWindows(): TauriWindow[] {
  return tauriWindows;
}

/** Find the tauri window matching the current FloatingApp's webview label. */
export function getTauriWindowByLabel(label: string): TauriWindow | undefined {
  return tauriWindows.find((tw) => tw.label === label);
}

/** Create a Tauri native window from a tab and register it in the layout system.
 *  The CALLER is responsible for removing the tab from its source group/floating panel first.
 *  Returns the generated Tauri window label. */
export function createTauriWindowFromTab(tab: TabInstance): string {
  const customLabel = (tab as any)._customLabel as string | undefined;
  // Tauri window labels allow only [A-Za-z0-9-/:_.] — a URL-encoded Chinese
  // title would inject '%' and the build silently fails (see create_floating_window
  // FAILED in the Rust log). Drop the title from the label; the panelId slug +
  // timestamp is unique and always ASCII-safe.
  const label = customLabel || `float-${tab.panelId.replace(/[^A-Za-z0-9\-_:/]+/g, "-")}--${Date.now().toString(36)}`;
  const tabClone: TabInstance = {
    ...tab,
    id: `tab-${tab.panelId}-${crypto.randomUUID().slice(0, 8)}`,
    icon: tab.icon ?? "default",
    children: tab.children ? tab.children.map((c) => ({ ...c })) : undefined,
  };
  const group: TabGroup = {
    type: "group",
    id: `group-${label}`,
    tabs: [tabClone],
    activeTabId: tabClone.id,
    tabStyle: "tabs",
  };
  const tw: TauriWindow = {
    type: "tauri",
    id: crypto.randomUUID().slice(0, 8),
    label,
    x: 200, y: 100, width: 600, height: 400,
    group,
  };
  // Dedup: skip for desktop-item-view (multiple items can have separate windows)
  if (tab.panelId !== "desktop-item-view") {
    const existingIdx = tauriWindows.findIndex((tw) =>
      tw.group.tabs[0]?.panelId === tab.panelId
    );
    if (existingIdx !== -1) {
      tauriWindows.splice(existingIdx, 1);
    }
  }

  tauriWindows.push(tw);
  notifyTauriWindowsChange();

  addStatusMessage(`正在打开新窗口：${tab.title}...`, "info");

  // Spawn the Tauri native window (async, fire-and-forget)
  import("@tauri-apps/api/core").then(({ invoke }) => {
    invoke("create_floating_window", { label, panelId: tab.panelId, title: tab.title, width: 600, height: 400 })
      .then(() => addStatusMessage(`新窗口已打开：${tab.title}`, "success"))
      .catch((e: unknown) => {
        console.error("[layoutStore] create_floating_window failed:", e);
        addStatusMessage(`新窗口打开失败：${e instanceof Error ? e.message : String(e)}`, "error");
      });
  }).catch((e: unknown) => {
    console.error("[layoutStore] failed to load Tauri invoke:", e);
  });

  return label;
}

/** Remove a Tauri window from the registry. */
export function removeTauriWindow(label: string) {
  const idx = tauriWindows.findIndex((tw) => tw.label === label);
  if (idx === -1) return;
  tauriWindows.splice(idx, 1);
  notifyTauriWindowsChange();
}

// ── 工具函数：遍历树 ──

export function findGroup(root: LayoutNode, groupId: string): TabGroup | null {
  if (root.type === "group") {
    return root.id === groupId ? root : null;
  }
  for (const child of root.children) {
    const found = findGroup(child, groupId);
    if (found) return found;
  }
  return null;
}

/** 树中第一个存在的组（面板管理的 fallback 落点） */
export function findFirstGroup(node: LayoutNode): TabGroup | null {
  if (node.type === "group") return node;
  for (const child of node.children) {
    const g = findFirstGroup(child);
    if (g) return g;
  }
  return null;
}

/** Ensure a panel is visible and focused in the layout tree. If hidden/collapsed, expand it. If in a floating panel or Tauri window, activate its tab. */
export function activatePanel(panelId: string): boolean {
  // 1. Search main layout tree
  const found = findTabByPanelId(tree, panelId);
  if (found) {
    ensureGroupVisible(found.groupId);
    if (found.childTabId) {
      setActiveChild(found.groupId, found.tabId, found.childTabId);
    } else {
      setActiveTab(found.groupId, found.tabId);
    }
    return true;
  }

  // 2. Search floating panels
  for (const fp of floatingPanels) {
    const foundFp = findTabByPanelId(fp.group, panelId);
    if (foundFp) {
      fp.group.visibility = "expanded";
      if (foundFp.childTabId) {
        fp.group.activeTabId = foundFp.tabId;
        const parent = fp.group.tabs.find(t => t.id === foundFp.tabId);
        if (parent) parent.activeChildId = foundFp.childTabId;
      } else {
        fp.group.activeTabId = foundFp.tabId;
      }
      notifyFloatingChange();
      return true;
    }
  }

  // 3. Search Tauri windows
  for (const tw of tauriWindows) {
    const foundTw = findTabByPanelId(tw.group, panelId);
    if (foundTw) {
      // Bring window to front + activate tab
      tw.group.activeTabId = foundTw.tabId;
      notifyTauriWindowsChange();
      return true;
    }
  }

  // 4. Not found anywhere — add a new tab to the default group (fallback to the
  //    first existing group so it works under any preset, e.g. editor under chat)
  const panel = getPanel(panelId as string);
  if (panel) {
    const defaultGroupId = DEFAULT_PANEL_GROUPS[panelId];
    const target = defaultGroupId ? findGroup(tree, defaultGroupId) ?? findFirstGroup(tree) : findFirstGroup(tree);
    if (target) {
      const tab: TabInstance = {
        id: `tab-${panelId}-${crypto.randomUUID().slice(0, 8)}`,
        panelId,
        title: panel.title,
        icon: panel.icon,
      };
      ensureGroupVisible(target.id);
      addTab(target.id, tab);
      return true;
    }
  }

  return false;
}

/** Default group for each panel — used when panel tab is missing from layout */
const DEFAULT_PANEL_GROUPS: Record<string, string> = {
  sessions: "sidebar-left",
  files: "sidebar-left",
  plan: "sidebar-left",
  subagents: "sidebar-left",
  workers: "sidebar-left",
  editor: "editor-area",
  terminal: "bottom-panel",
  "chat-messages": "chat-messages-group",
  "chat-input": "chat-input-group",
  settings: "sidebar-left",
  "quick-prompts": "sidebar-left",
};

/** 面板是否已打开：tree/floating/tauri 中存在 tab 且所在组未隐藏 */
export function isPanelOpenInTree(panelId: string): boolean {
  const found = findTabByPanelId(getTree(), panelId);
  if (!found) return false;
  const g = findGroup(getTree(), found.groupId);
  return g ? g.visibility !== "hidden" : true;
}

/** 切换面板开关（Toolbar 面板下拉 & 命令面板共用）：
 *  已打开 → removeTab 隐藏；已存在但隐藏 → 显示并激活；不存在 → addTab 到默认组 */
export function togglePanelInTree(panelId: string): boolean {
  const panel = getPanel(panelId as string);
  if (!panel) return false;
  const existing = findTabByPanelId(getTree(), panelId);
  if (existing) {
    const g = findGroup(getTree(), existing.groupId);
    if (g && g.visibility !== "hidden") {
      removeTab(existing.groupId, existing.tabId);
    } else {
      ensureGroupVisible(existing.groupId);
      setActiveTab(existing.groupId, existing.tabId);
    }
    return true;
  }
  const targetGroupId = DEFAULT_PANEL_GROUPS[panelId] || "sidebar-left";
  // 目标组可能不在当前预设树中（如聊天预设缺 editor-area/bottom-panel）——
  // addTab 对不存在的组静默失败，面板会"点不开"。退化到第一个存在的组。
  const target = findGroup(getTree(), targetGroupId) ?? findFirstGroup(getTree());
  if (!target) return false;
  addTab(target.id, {
    id: `tab-${panelId}-${crypto.randomUUID().slice(0, 8)}`,
    panelId,
    title: panel.title,
    icon: panel.icon,
  });
  ensureGroupVisible(target.id);
  return true;
}

/** Find the group and tab containing a panel, including inside compound tab children */
export function findTabByPanelId(root: LayoutNode, panelId: string): { groupId: string; tabId: string; childTabId?: string } | null {
  function search(node: LayoutNode): { groupId: string; tabId: string; childTabId?: string } | null {
    if (node.type === "group") {
      for (const tab of node.tabs) {
        if (tab.panelId === panelId) return { groupId: node.id, tabId: tab.id };
        if (tab.children) {
          for (const child of tab.children) {
            if (child.panelId === panelId) return { groupId: node.id, tabId: tab.id, childTabId: child.id };
          }
        }
      }
      return null;
    }
    for (const child of node.children) {
      const found = search(child);
      if (found) return found;
    }
    return null;
  }
  return search(root);
}

function mapTree(root: LayoutNode, fn: (node: LayoutNode) => LayoutNode): LayoutNode {
  const next = fn(root);
  if (next.type === "split") {
    return { ...next, children: next.children.map((c) => mapTree(c, fn)) };
  }
  return next;
}

function mapGroup(root: LayoutNode, groupId: string, fn: (g: TabGroup) => LayoutNode): LayoutNode {
  if (root.type === "group" && root.id === groupId) return fn(root);
  if (root.type === "split") {
    return { ...root, children: root.children.map((c) => mapGroup(c, groupId, fn)) };
  }
  return root;
}

/** 从任意节点向上查找父 SplitNode 及其在 children 中的下标 */
export function findParentSplit(root: LayoutNode, targetId: string): { split: SplitNode; index: number } | null {
  if (root.type === "split") {
    for (let i = 0; i < root.children.length; i++) {
      const child = root.children[i];
      if (child.id === targetId) {
        return { split: root, index: i };
      }
      if (child.type === "split") {
        const found = findParentSplit(child, targetId);
        if (found) return found;
      }
    }
  }
  return null;
}

/** 确保 group 在父 split 中可见（当前 size<=0 时分配默认比例） */
function setVisibility(groupId: string, v: Visibility) {
  tree = mapGroup(tree, groupId, (g) => ({ ...g, visibility: v === "expanded" ? undefined : v }));
}

function redistributeSizes(groupId: string, toZero: boolean) {
  const parent = findParentSplit(tree, groupId);
  if (!parent || parent.split.children.length <= 1) return;
  const sizes = [...parent.split.sizes];
  if (toZero) {
    if (sizes[parent.index] <= 0) return;
    const freed = sizes[parent.index];
    sizes[parent.index] = 0;
    // Give all freed space to the largest visible sibling
    let largest = -1;
    let maxSize = 0;
    for (let i = 0; i < sizes.length; i++) {
      if (i !== parent.index && sizes[i] > maxSize) { maxSize = sizes[i]; largest = i; }
    }
    if (largest >= 0 && sizes[largest] > 0) {
      sizes[largest] += freed;
    }
  } else {
    if (sizes[parent.index] > 0) return;
    let takeFrom = 0;
    let maxSize = 0;
    for (let i = 0; i < sizes.length; i++) {
      if (i !== parent.index && sizes[i] > maxSize) { maxSize = sizes[i]; takeFrom = i; }
    }
    const defaultSize = 25;
    sizes[takeFrom] = Math.max(25, sizes[takeFrom] - defaultSize);
    sizes[parent.index] = defaultSize;
  }
  tree = mapTree(tree, (node) => node.type === "split" && node.id === parent.split.id ? { ...node, sizes } : node);
}

export function ensureGroupVisible(groupId: string, defaultSize: number = 25) {
  setVisibility(groupId, "expanded");
  redistributeSizes(groupId, false);
  eventBus.emit(Events.LAYOUT_TREE_CHANGED, { tree }, { sticky: true });
}

/** 系统锚点 group ID — 只能隐藏不能删除 */
export const PINNED_GROUPS = new Set(["sidebar-left", "editor-area", "chat-messages-group", "chat-input-group", "bottom-panel"]);

/** 隐藏 group（size 设为 0，空间按比例分给兄弟节点） */
export function hideGroup(groupId: string) {
  setVisibility(groupId, "hidden");
  redistributeSizes(groupId, true);
  eventBus.emit(Events.LAYOUT_TREE_CHANGED, { tree }, { sticky: true });
}

// ── Tab 操作 ──

export function addTab(groupId: string, tab: TabInstance) {
  setTree(
    mapGroup(tree, groupId, (g) => ({
      ...g,
      tabs: [...g.tabs, tab],
      activeTabId: tab.id,
    }))
  );
}

export function removeTab(groupId: string, tabId: string) {
  setTree(
    mapGroup(tree, groupId, (g) => {
      const next = g.tabs.filter((t) => t.id !== tabId);
      const active = g.activeTabId === tabId
        ? (next[next.length - 1]?.id ?? null)
        : g.activeTabId;
      return { ...g, tabs: next, activeTabId: active };
    })
  );
  // Auto-hide group if last tab was removed (except editor-area)
  if (groupId !== "editor-area") {
    const g = findGroup(tree, groupId);
    if (g && g.tabs.length === 0) {
      hideGroup(groupId);
    }
  }
}

export function setActiveTab(groupId: string, tabId: string) {
  setTree(
    mapGroup(tree, groupId, (g) => ({
      ...g,
      activeTabId: tabId,
    }))
  );
}

/** 复合组内切换活跃子 tab */
export function setActiveChild(groupId: string, tabId: string, childId: string) {
  setTree(
    mapGroup(tree, groupId, (g) => ({
      ...g,
      tabs: g.tabs.map((t) =>
        t.id === tabId ? { ...t, activeChildId: childId } : t
      ),
    }))
  );
}

/** 从复合组中拆出一个子 tab 为独立 tab */
export function removeChildFromCompound(groupId: string, parentTabId: string, childId: string) {
  setTree(
    mapGroup(tree, groupId, (g) => ({
      ...g,
      tabs: g.tabs.flatMap((t) => {
        if (t.id !== parentTabId || !t.children) return [t];
        const childIdx = t.children.findIndex((c) => c.id === childId);
        if (childIdx === -1) return [t];
        const removed = t.children[childIdx];
        const remain = t.children.filter((_, i) => i !== childIdx);
        const result: TabInstance[] = [];
        // 添加拆分出的独立 tab
        if (removed) {
          result.push({ id: `tab-${removed.panelId}-${crypto.randomUUID().slice(0, 8)}`, panelId: removed.panelId, title: removed.title, icon: removed.icon ?? "default" });
        }
        // 处理父 tab
        if (remain.length <= 1) {
          // 剩 1 个子面板 → 复合组自动解散：图标/标题回归该子面板本身，
          // 而不是保留 compoundGroup(layers) 图标
          const last = remain[0] ?? removed;
          result.push({ ...t, panelId: last.panelId, title: last.title, icon: last.icon ?? "default", children: undefined, activeChildId: undefined });
        } else {
          result.push({ ...t, children: remain, activeChildId: t.activeChildId === childId ? (remain[0]?.id ?? null) : t.activeChildId });
        }
        return result;
      }),
    }))
  );
}

/** 调整 tab 在组内的顺序 */
export function moveTab(groupId: string, tabId: string, beforeTabId: string | null) {
  setTree(
    mapGroup(tree, groupId, (g) => {
      const tab = g.tabs.find((t) => t.id === tabId);
      if (!tab) return g;
      const others = g.tabs.filter((t) => t.id !== tabId);
      if (beforeTabId === null) {
        return { ...g, tabs: [...others, tab] };
      }
      const idx = others.findIndex((t) => t.id === beforeTabId);
      if (idx === -1) return g;
      const next = [...others];
      next.splice(idx, 0, tab);
      return { ...g, tabs: next };
    })
  );
}

/** 切换 tab 图标 */
export function setTabIcon(groupId: string, tabId: string, icon: IconKey) {
  setTree(
    mapGroup(tree, groupId, (g) => ({
      ...g,
      tabs: g.tabs.map((t) => (t.id === tabId ? { ...t, icon } : t)),
    }))
  );
}

/** 调整复合子 tab 在父 tab 内的顺序 */
export function moveChild(groupId: string, parentTabId: string, childId: string, beforeChildId: string | null) {
  setTree(
    mapGroup(tree, groupId, (g) => ({
      ...g,
      tabs: g.tabs.map((t) => {
        if (t.id !== parentTabId || !t.children) return t;
        const child = t.children.find((c) => c.id === childId);
        if (!child) return t;
        const others = t.children.filter((c) => c.id !== childId);
        if (beforeChildId === null) {
          return { ...t, children: [...others, child] };
        }
        const idx = others.findIndex((c) => c.id === beforeChildId);
        if (idx === -1) return t;
        const next = [...others];
        next.splice(idx, 0, child);
        return { ...t, children: next };
      }),
    }))
  );
}

/** 从复合 tab 中拖一个子 tab 到同组另一个 tab 的 children 中（或图标上） */
export function moveChildBetweenTabs(groupId: string, sourceParentId: string, childId: string, targetTabId: string) {
  setTree(
    mapGroup(tree, groupId, (g) => {
      // 在 map 外部先找到要移动的 child，避免闭包作用域问题
      const sourceParent = g.tabs.find((t) => t.id === sourceParentId);
      const removed = sourceParent?.children?.find((c) => c.id === childId);
      if (!removed) return g;

      return {
        ...g,
        tabs: g.tabs.map((t) => {
          // 从源父 tab 移除 child
          if (t.id === sourceParentId && t.children) {
            const childIdx = t.children.findIndex((c) => c.id === childId);
            const remain = t.children.filter((_, i) => i !== childIdx);
            if (remain.length <= 1) {
              // 剩 1 个子面板 → 源复合组自动解散，图标/标题回归剩余子面板
              const last = remain[0] ?? removed;
              return { ...t, panelId: last.panelId, title: last.title, icon: last.icon ?? "default", children: undefined, activeChildId: undefined };
            }
            return { ...t, children: remain, activeChildId: t.activeChildId === childId ? (remain[0]?.id ?? null) : t.activeChildId };
          }
          // 加到目标 tab 的 children
          if (t.id === targetTabId) {
            const newChild: TabInstance = {
              id: `child-${removed.panelId}-${crypto.randomUUID().slice(0, 8)}`,
              panelId: removed.panelId,
              title: removed.title,
              icon: removed.icon,
            };
            const existing = t.children ?? (t.panelId ? [{ id: `child-${t.panelId}-${crypto.randomUUID().slice(0, 8)}`, panelId: t.panelId, title: t.title, icon: t.icon }] : []);
            const wasSingle = !t.children;
            return {
              ...t,
              panelId: "",
              icon: wasSingle ? "compoundGroup" : t.icon,
              children: [...existing, newChild],
              activeChildId: t.activeChildId ?? existing[0]?.id ?? newChild.id,
            };
          }
          return t;
        }),
      };
    })
  );
}

/** 将 source 标签合并为 target 标签的复合子组 */
export function mergeIntoTab(groupId: string, targetTabId: string, sourceGroupId: string, sourceTabId: string) {
  let sourceTab: TabInstance | null = null;

  // 从源组取出
  const afterRemove = mapGroup(tree, sourceGroupId, (g) => {
    sourceTab = g.tabs.find((t) => t.id === sourceTabId) ?? null;
    const next = g.tabs.filter((t) => t.id !== sourceTabId);
    const active = g.activeTabId === sourceTabId
      ? (next[next.length - 1]?.id ?? null)
      : g.activeTabId;
    return { ...g, tabs: next, activeTabId: active };
  });

  if (!sourceTab) return;

  // 合并到目标 tab 的 children
  setTree(
    mapGroup(afterRemove, groupId, (g) => ({
      ...g,
      tabs: g.tabs.map((t) => {
        if (t.id !== targetTabId) return t;
        const existing = t.children ?? (t.panelId ? [{ id: t.id, panelId: t.panelId, title: t.title, icon: t.icon }] : []);
        // 若 source 已是复合组 → 展开所有子 tab；否则创建单个 child
        const incoming: TabInstance[] = sourceTab!.children?.length
          ? sourceTab!.children.map((c) => ({
              id: `child-${c.panelId}-${crypto.randomUUID().slice(0, 8)}`,
              panelId: c.panelId,
              title: c.title,
              icon: c.icon,
            }))
          : [{
              id: `child-${sourceTab!.panelId}-${crypto.randomUUID().slice(0, 8)}`,
              panelId: sourceTab!.panelId,
              title: sourceTab!.title,
              icon: sourceTab!.icon,
            }];
        const wasSingle = !t.children; // 首次合并 → 生成组图标
        return {
          ...t,
          panelId: "",
          icon: wasSingle ? "compoundGroup" : t.icon,
          children: [...existing, ...incoming],
          activeChildId: t.activeChildId ?? existing[0]?.id ?? incoming[0]?.id,
        };
      }),
    }))
  );
}

/** 解散复合组：把复合 tab 的子面板拆成同组的独立 tab（右键「解散分组」） */
export function dissolveCompoundGroup(groupId: string, tabId: string) {
  setTree(
    mapGroup(tree, groupId, (g) => {
      const idx = g.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return g;
      const comp = g.tabs[idx];
      if (!comp.children?.length) return g;
      const singles: TabInstance[] = comp.children.map((c) => ({
        id: `tab-${c.panelId}-${crypto.randomUUID().slice(0, 8)}`,
        panelId: c.panelId,
        title: c.title,
        icon: c.icon ?? "default",
      }));
      const activeChild = comp.children.find((c) => c.id === comp.activeChildId);
      const newActiveId =
        singles.find((s) => s.panelId === activeChild?.panelId)?.id ??
        singles[0]?.id ??
        null;
      const tabs = [...g.tabs];
      tabs.splice(idx, 1, ...singles);
      return {
        ...g,
        tabs,
        activeTabId: g.activeTabId === tabId ? newActiveId : g.activeTabId,
      };
    })
  );
}

// ── 分割 / 合并 ──

export function splitGroup(groupId: string, hint: "left" | "right" | "top" | "bottom", newTab: TabInstance) {
  const direction: "horizontal" | "vertical" = (hint === "left" || hint === "right") ? "horizontal" : "vertical";
  const prepend = hint === "left" || hint === "top";
  const newGroup: TabGroup = {
    type: "group",
    id: `group-${crypto.randomUUID()}`,
    tabs: [newTab],
    activeTabId: newTab.id,
  };

  setTree(
    mapGroup(tree, groupId, (g) => {
      const split: SplitNode = {
        type: "split",
        id: `split-${crypto.randomUUID()}`,
        direction,
        children: prepend ? [newGroup, g] : [g, newGroup],
        sizes: [50, 50],
      };
      return split;
    })
  );
}

/** 空分割 — 将 TabGroup 一分为二，新侧为空白 TabGroup */
export function splitGroupEmpty(groupId: string, hint: "left" | "right" | "top" | "bottom") {
  const direction: "horizontal" | "vertical" = (hint === "left" || hint === "right") ? "horizontal" : "vertical";
  const prepend = hint === "left" || hint === "top";
  const newGroup: TabGroup = {
    type: "group",
    id: `group-${crypto.randomUUID()}`,
    tabs: [],
    activeTabId: null,
  };

  setTree(
    mapGroup(tree, groupId, (g) => {
      const split: SplitNode = {
        type: "split",
        id: `split-${crypto.randomUUID()}`,
        direction,
        children: prepend ? [newGroup, g] : [g, newGroup],
        sizes: [50, 50],
      };
      return split;
    })
  );
}

/** 移除一个 TabGroup，将其父 SplitNode 合并（如果只剩一个子节点） */
export function closeGroup(groupId: string) {
  setTree(removeAndMerge(tree, groupId));
}

function removeAndMerge(root: LayoutNode, targetId: string): LayoutNode {
  if (root.type === "group") return root;
  const idx = root.children.findIndex((c) => c.type === "group" && c.id === targetId);
  if (idx === -1) {
    return { ...root, children: root.children.map((c) => removeAndMerge(c, targetId)) };
  }
  // 找到目标，移除它
  const newChildren = root.children.filter((_, i) => i !== idx);
  const newSizes = root.sizes.filter((_, i) => i !== idx);
  // 如果只剩一个子节点，收起 split
  if (newChildren.length === 1) {
    return newChildren[0];
  }
  // 归一化：使所有子节点比例和为 100
  const total = newSizes.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    const each = 100 / newChildren.length;
    return { ...root, children: newChildren, sizes: newChildren.map(() => each) };
  }
  return {
    ...root,
    children: newChildren,
    sizes: newSizes.map((s) => (s / total) * 100),
  };
}

// ── 调整分割比例 ──

export function updateSizes(splitId: string, sizes: number[]) {
  setTree(
    mapTree(tree, (node) => {
      if (node.type === "split" && node.id === splitId) {
        return { ...node, sizes };
      }
      return node;
    })
  );
}

// ── 面板显隐（三态统一） ──

/** Activity Bar 图标点击: expanded ↔ collapsed，hidden → collapsed */
export function toggleGroupCollapse(groupId: string) {
  const group = findGroup(tree, groupId);
  if (!group) return;
  const cur: Visibility = group.visibility || "expanded";
  const next = cur === "collapsed" ? "expanded" : "collapsed";
  setVisibility(groupId, next);
  if (cur === "hidden") redistributeSizes(groupId, false);
  eventBus.emit(Events.LAYOUT_TREE_CHANGED, { tree }, { sticky: true });
}

/** Toolbar 按钮: visible → hidden, hidden → expanded（支持 group 或 split） */
export function toggleGroupHidden(nodeId: string) {
  const parent = findParentSplit(tree, nodeId);
  if (!parent) return;
  const group = findGroup(tree, nodeId);
  if (group) {
    const cur: Visibility = group.visibility || "expanded";
    if (cur === "hidden") {
      setVisibility(nodeId, "expanded");
      redistributeSizes(nodeId, false);
    } else {
      setVisibility(nodeId, "hidden");
      redistributeSizes(nodeId, true);
    }
  } else {
    // Split node: just toggle sizes
    if (parent.split.sizes[parent.index] > 0) {
      redistributeSizes(nodeId, true);
    } else {
      redistributeSizes(nodeId, false);
    }
  }
  eventBus.emit(Events.LAYOUT_TREE_CHANGED, { tree }, { sticky: true });
}

// Shortcuts
export function toggleLeftPanel() { toggleGroupHidden("sidebar-left"); }
export function toggleRightPanel() {
  // 右侧聊天列：默认布局为 chat-split(split，含消息+输入)；用户自定义布局可能把右
  // 侧改成单独的 chat-messages-group(group，直接挂根，如根 split sizes=[..,30] 末位)。
  // 若硬编码 chat-split，而它已不在树里 → findParentSplit 返回 null → toggleGroupHidden
  // 第 1154 行 if(!parent) return 静默失效(点按钮无反应)。动态挑树里真正存在的那个。
  const target = findParentSplit(tree, "chat-split") ? "chat-split" : "chat-messages-group";
  toggleGroupHidden(target);
}
export function toggleBottomPanel() { toggleGroupHidden("bottom-panel"); }

// ── 布局预设 — 替代「恢复默认布局」：从预设里选一套面板排布 ──

export interface LayoutPreset {
  id: string;
  nameKey: string;
  descKey: string;
  /** 构建一棵全新的布局树（标题用 pt()，应用时还会 refreshTitles 兜底） */
  build: () => LayoutNode;
}

/** 以聊天为主：右栏清空，聊天两件套放中间，技能放左侧栏切分后的下部分 */
function buildChatLayout(): LayoutNode {
  return {
    type: "split",
    id: "root",
    direction: "horizontal",
    children: [
      {
        type: "split",
        id: "sidebar-column",
        direction: "vertical",
        children: [
          {
            type: "group",
            id: "sidebar-left",
            tabStyle: "activity",
            tabs: [
              { id: "tab-sessions", panelId: "sessions", title: pt("sessions"), icon: "sessions" },
              { id: "tab-files", panelId: "files", title: pt("files"), icon: "files" },
            ],
            activeTabId: "tab-sessions",
          },
          {
            type: "group",
            id: "skills-panel",
            tabs: [
              { id: "tab-skills", panelId: "skills", title: pt("skills"), icon: "skills" },
            ],
            activeTabId: "tab-skills",
          },
        ],
        sizes: [62, 38],
      },
      {
        type: "split",
        id: "center-column",
        direction: "vertical",
        children: [
          {
            type: "group",
            id: "chat-center-group",
            tabs: [
              { id: "tab-chat-msgs", panelId: "chat-messages", title: pt("chat-messages"), icon: "messages" },
              { id: "tab-editor", panelId: "editor", title: pt("editor"), icon: "editor" },
            ],
            activeTabId: "tab-chat-msgs",
          },
          {
            type: "group",
            id: "bottom-panel",
            tabStyle: "activity-bottom",
            tabs: [
              { id: "tab-chat-input", panelId: "chat-input", title: pt("chat-input"), icon: "input" },
            ],
            activeTabId: "tab-chat-input",
          },
        ],
        sizes: [78, 22],
      },
    ],
    sizes: [22, 78],
  };
}

/** 信息密度最高：镜像 claude-code-haha-dev 工作区的四区布局 */
function buildDenseLayout(): LayoutNode {
  return {
    type: "split",
    id: "root",
    direction: "horizontal",
    children: [
      {
        type: "split",
        id: "sidebar-column",
        direction: "vertical",
        children: [
          {
            type: "group",
            id: "sidebar-left",
            tabStyle: "activity",
            tabs: [
              { id: "tab-sessions", panelId: "sessions", title: pt("sessions"), icon: "sessions" },
              { id: "tab-files", panelId: "files", title: pt("files"), icon: "files" },
              { id: "tab-subagents", panelId: "subagents", title: pt("subagents"), icon: "subagents" },
              { id: "tab-skills", panelId: "skills", title: pt("skills"), icon: "skills" },
              { id: "tab-workers", panelId: "workers", title: pt("workers"), icon: "workers" },
            ],
            activeTabId: "tab-files",
          },
          {
            type: "split",
            id: "sidebar-bottom",
            direction: "vertical",
            children: [
              {
                type: "group",
                id: "quick-prompts-panel",
                tabs: [
                  { id: "tab-quick-prompts", panelId: "quick-prompts", title: pt("quick-prompts"), icon: "quickPrompts" },
                ],
                activeTabId: "tab-quick-prompts",
              },
              {
                type: "group",
                id: "plan-panel",
                tabs: [
                  { id: "tab-plan", panelId: "plan", title: pt("plan"), icon: "plan" },
                ],
                activeTabId: "tab-plan",
              },
            ],
            sizes: [50, 50],
          },
        ],
        sizes: [47, 53],
      },
      {
        type: "split",
        id: "center-column",
        direction: "vertical",
        children: [
          {
            type: "group",
            id: "editor-area",
            tabs: [
              { id: "tab-desktop", panelId: "super-desktop", title: pt("super-desktop"), icon: "superDesktop" },
              { id: "tab-editor", panelId: "editor", title: pt("editor"), icon: "editor" },
              { id: "tab-notes", panelId: "notes", title: pt("notes"), icon: "notes" },
            ],
            activeTabId: "tab-desktop",
          },
          {
            type: "group",
            id: "bottom-panel",
            tabStyle: "activity-bottom",
            tabs: [
              { id: "tab-chat-input", panelId: "chat-input", title: pt("chat-input"), icon: "input" },
              { id: "tab-terminal", panelId: "terminal", title: pt("terminal"), icon: "terminal" },
            ],
            activeTabId: "tab-chat-input",
          },
        ],
        sizes: [68, 32],
      },
      {
        type: "group",
        id: "chat-messages-group",
        tabs: [
          { id: "tab-chat-msgs", panelId: "chat-messages", title: pt("chat-messages"), icon: "messages" },
        ],
        activeTabId: "tab-chat-msgs",
      },
    ],
    sizes: [20, 50, 30],
  };
}

export const LAYOUT_PRESETS: LayoutPreset[] = [
  { id: "default", nameKey: "layoutPreset.default", descKey: "layoutPreset.defaultDesc", build: createDefaultTree },
  { id: "chat", nameKey: "layoutPreset.chat", descKey: "layoutPreset.chatDesc", build: buildChatLayout },
  { id: "dense", nameKey: "layoutPreset.dense", descKey: "layoutPreset.denseDesc", build: buildDenseLayout },
];

export function getLayoutPreset(id: string): LayoutPreset | undefined {
  return LAYOUT_PRESETS.find((p) => p.id === id);
}

/** 应用一套预设：替换主布局树、清空浮动窗口，改动走正常布局保存链路 */
export function applyLayoutPreset(id: string): boolean {
  const preset = getLayoutPreset(id);
  if (!preset) return false;
  tree = refreshTitles(preset.build());
  floatingPanels = [];
  _floatingZCounter = 1000;
  eventBus.emit(Events.LAYOUT_TREE_CHANGED, { tree }, { sticky: true });
  eventBus.emit(Events.LAYOUT_FLOATING_CHANGED, { floatingPanels: [] }, { sticky: true });
  return true;
}

export function resetLayout() {
  applyLayoutPreset("default");
}
