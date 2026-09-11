import React, { memo, useState, useEffect, useRef, useCallback } from "react";
import { getFloatingPanels, updateFloatingPosition, updateFloatingSize, bringFloatingToFront, removeFloatingPanel, setActiveTabInFloating, removeTabFromFloating, removeChildFromFloatingTab, createFloatingFromTab, createTauriWindowFromTab, addTab, ensureGroupVisible } from "../stores/layoutStore";
import { useEventHandler } from "../services/useService";
import { Events, type LayoutFloatingChangedPayload } from "../services/events";
import { resolveTabRender } from "../stores/panelRegistry";
import { prepareDrag, ensureGlobalDragListeners, subscribeDragState, computeDropTarget, ROOT_EDGE_GROUPS } from "./LayoutRenderer";
import { showCtxMenu } from "./ContextMenu";
import type { ContextMenuItem } from "./ContextMenu";
import type { FloatingWindow, TabInstance } from "../types/layout";
import { iconFor } from "../utils/icons";
import { t } from "../i18n";

const FLOATING_WIN_BASE = {
  position: "fixed",
  display: "flex",
  flexDirection: "column",
  backgroundColor: "var(--bg-root)",
  border: "1px solid var(--border-medium)",
  borderRadius: 6,
  boxShadow: "0 8px 32px rgba(0,0,0,0.24), 0 2px 8px rgba(0,0,0,0.12)",
  overflow: "hidden",
} as const;

const FLOATING_TITLE_BAR = {
  display: "flex",
  alignItems: "center",
  height: 32,
  backgroundColor: "var(--bg-hover)",
  borderBottom: "1px solid var(--border-medium)",
  flexShrink: 0,
  cursor: "default",
  userSelect: "none",
} as const;

const FLOATING_DOCK_HANDLE = {
  width: 20, height: 20, display: "flex", alignItems: "center",
  justifyContent: "center", cursor: "grab", borderRadius: 3,
  color: "var(--fg-muted)", fontSize: 14, flexShrink: 0, marginLeft: 4,
  userSelect: "none",
} as const;

const FLOATING_TAB_BASE = {
  display: "flex",
  alignItems: "center",
  padding: "0 10px",
  height: "100%",
  cursor: "grab",
  fontSize: 11,
  fontFamily: "var(--font-sans)",
  gap: 4,
  whiteSpace: "nowrap",
} as const;

const FLOATING_CMP_TAB_BASE = {
  display: "flex", alignItems: "center", padding: "0 8px", height: "100%",
  cursor: "grab", fontSize: 10, fontFamily: "var(--font-sans)",
  gap: 3, userSelect: "none", whiteSpace: "nowrap",
} as const;

const FLOATING_CLOSE_BTN = {
  width: 28, height: 28, display: "flex", alignItems: "center",
  justifyContent: "center", cursor: "pointer", borderRadius: 4,
  fontSize: 14, color: "var(--fg-secondary)", marginRight: 2,
} as const;

const FLOATING_CONTENT = {
  flex: 1, overflow: "auto", minHeight: 0, position: "relative",
} as const;

const FLOATING_NO_CONTENT = {
  display: "flex", alignItems: "center", justifyContent: "center",
  height: "100%", color: "var(--fg-muted)", fontSize: 12,
  fontFamily: "var(--font-sans)",
} as const;

const FLOATING_CMP_BAR = {
  display: "flex", height: 26, backgroundColor: "var(--bg-hover)",
  borderBottom: "1px solid var(--border-medium)", flexShrink: 0, overflow: "hidden",
} as const;

const FLOATING_RESIZE_HANDLE = {
  position: "absolute",
  zIndex: 10,
} as const;

function _FloatingRenderer() {
  const [, setVersion] = useState(0);

  useEventHandler<LayoutFloatingChangedPayload>(Events.LAYOUT_FLOATING_CHANGED, () => setVersion((v) => v + 1));

  useEffect(() => {
    const u2 = subscribeDragState(() => setVersion((v) => v + 1));
    return () => { u2(); };
  }, []);

  const panels = getFloatingPanels();
  if (panels.length === 0) return null;

  return (
    <>
      {panels.map((fp) => (
        <FloatingPanelView key={fp.id} panel={fp} />
      ))}
    </>
  );
}

// ── 浮窗右键菜单 ──

function floatingTabMenu(floatingId: string, tab: TabInstance, compoundParentId?: string): ContextMenuItem[] {
  const fps = getFloatingPanels();
  const fp = fps.find((f) => f.id === floatingId);
  const tabCount = fp?.group.tabs.length ?? 0;

  return [
    {
      label: t("layout.openInNewWindow"),
      action: () => {
        if (compoundParentId) {
          removeChildFromFloatingTab(floatingId, compoundParentId, tab.id);
        } else {
          removeTabFromFloating(floatingId, tab.id);
        }
        createTauriWindowFromTab(tab);
        // Clean up empty floating panel
        if (getFloatingPanels().find((f) => f.id === floatingId)?.group.tabs.length === 0) {
          removeFloatingPanel(floatingId);
        }
      },
      disabled: !!compoundParentId,
    },
    {
      label: t("layout.floatTab"),
      action: () => {
        if (compoundParentId) {
          removeChildFromFloatingTab(floatingId, compoundParentId, tab.id);
        } else {
          removeTabFromFloating(floatingId, tab.id);
        }
        createFloatingFromTab(tab);
      },
      disabled: !compoundParentId && tabCount <= 1,
    },
    {
      label: t("layout.closeTab"),
      action: () => {
        if (compoundParentId) {
          removeChildFromFloatingTab(floatingId, compoundParentId, tab.id);
        } else {
          removeTabFromFloating(floatingId, tab.id);
        }
      },
    },
  ];
}

// ── 悬浮面板视图 ──

function FloatingPanelView({ panel }: { panel: FloatingWindow }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    type: "move" | "resize"; dir?: string;
    sx: number; sy: number;
    ix: number; iy: number;
    iw: number; ih: number;
  } | null>(null);

  const group = panel.group;
  const activeTab = group.tabs.find((t) => t.id === group.activeTabId);

  // 解析内容
  let contentRender: (() => React.ReactNode) | undefined;
  let compoundTabs: TabInstance[] | undefined;

  if (activeTab) {
    if (activeTab.children?.length) {
      compoundTabs = activeTab.children;
    }
    contentRender = resolveTabRender(activeTab);
  }

  // ── 标题栏拖拽移动 ──

  const onTitleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    bringFloatingToFront(panel.id);
    dragRef.current = {
      type: "move",
      sx: e.clientX, sy: e.clientY,
      ix: panel.x, iy: panel.y,
      iw: 0, ih: 0,
    };

    function onMove(ev: MouseEvent) {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.sx;
      const dy = ev.clientY - dragRef.current.sy;
      const el = panelRef.current;
      if (el) {
        el.style.left = `${dragRef.current.ix + dx}px`;
        el.style.top = `${dragRef.current.iy + dy}px`;
      }
    }
    function onUp() {
      if (!dragRef.current) return;
      const el = panelRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        updateFloatingPosition(panel.id, rect.left, rect.top);
      }
      dragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp, { once: true });
  }, [panel.id, panel.x, panel.y]);

  // ── Resize 把手拖拽 ──

  const resizeDirs = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

  const onResizeMouseDown = useCallback((e: React.MouseEvent, dir: string) => {
    e.preventDefault();
    e.stopPropagation();
    bringFloatingToFront(panel.id);
    dragRef.current = {
      type: "resize", dir,
      sx: e.clientX, sy: e.clientY,
      ix: panel.x, iy: panel.y,
      iw: panel.width, ih: panel.height,
    };

    function onMove(ev: MouseEvent) {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.sx;
      const dy = ev.clientY - dragRef.current.sy;
      const el = panelRef.current;
      if (!el) return;

      const d = dragRef.current.dir!;
      let w = dragRef.current.iw;
      let h = dragRef.current.ih;
      let x = dragRef.current.ix;
      let y = dragRef.current.iy;

      if (d.includes("e")) w = Math.max(200, dragRef.current.iw + dx);
      if (d.includes("w")) { w = Math.max(200, dragRef.current.iw - dx); x = dragRef.current.ix + dx; }
      if (d.includes("s")) h = Math.max(150, dragRef.current.ih + dy);
      if (d.includes("n")) { h = Math.max(150, dragRef.current.ih - dy); y = dragRef.current.iy + dy; }

      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
    function onUp() {
      if (!dragRef.current) return;
      const el = panelRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        updateFloatingPosition(panel.id, rect.left, rect.top);
        updateFloatingSize(panel.id, rect.width, rect.height);
      }
      dragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp, { once: true });
  }, [panel.id, panel.x, panel.y, panel.width, panel.height]);

  const cursorMap: Record<string, string> = {
    n: "n-resize", ne: "ne-resize", e: "e-resize", se: "se-resize",
    s: "s-resize", sw: "sw-resize", w: "w-resize", nw: "nw-resize",
  };

  const HANDLE = 6;
  const showTabBar = group.tabs.length > 1;

  return (
    <div
      ref={panelRef}
      data-floating-id={panel.id}
      onMouseDown={() => bringFloatingToFront(panel.id)}
      style={{
        ...FLOATING_WIN_BASE,
        left: panel.x,
        top: panel.y,
        width: panel.width,
        height: panel.height,
        zIndex: panel.zIndex,
      }}
    >
      {/* 标题栏 */}
      <div style={FLOATING_TITLE_BAR} onMouseDown={onTitleMouseDown}>
        {/* Dock handle — 拖拽入坞，与标题栏移动分离 */}
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            ensureGlobalDragListeners();
            const el = panelRef.current;
            if (el) el.style.opacity = "0.4";

            // ghost 提示标签
            const ghost = document.createElement("div");
            ghost.style.cssText =
              "position:fixed;z-index:99999;pointer-events:none;" +
              "background:var(--accent);color:var(--fg-inverse);padding:4px 12px;border-radius:4px;" +
              "font-size:13px;font-family:var(--font-sans);white-space:nowrap;";
            ghost.textContent = `${t("desktop.dockToLayout")} \u2192 ${activeTab?.title ?? "panel"}`;
            ghost.style.left = e.clientX + 14 + "px";
            ghost.style.top = e.clientY - 20 + "px";
            document.body.appendChild(ghost);

            function onMove(ev: MouseEvent) {
              ghost.style.left = ev.clientX + 14 + "px";
              ghost.style.top = ev.clientY - 20 + "px";
            }
            function onUp() {
              ghost.remove();
              if (el) {
                el.style.display = "none";
                const target = computeDropTarget();
                el.style.display = "";
                el.style.opacity = "";
                if (target) {
                  const newTab = (t: TabInstance) => ({
                    ...t,
                    id: `${t.panelId}-${crypto.randomUUID().slice(0, 8)}`,
                    icon: t.icon,
                  });
                  if (target.kind === "root-edge") {
                    const gid = ROOT_EDGE_GROUPS[target.side];
                    ensureGroupVisible(gid);
                    group.tabs.forEach((t) => addTab(gid, newTab(t)));
                  } else {
                    group.tabs.forEach((t) => addTab(target.groupId, newTab(t)));
                  }
                  removeFloatingPanel(panel.id);
                }
              }
              document.removeEventListener("mousemove", onMove);
              document.removeEventListener("mouseup", onUp);
            }
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp, { once: true });
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const newTab = (t: TabInstance) => ({
              ...t,
              id: `${t.panelId}-${crypto.randomUUID().slice(0, 8)}`,
              icon: t.icon,
            });
            showCtxMenu(e.clientX, e.clientY, [
              {
                label: t("desktop.dockToLayout"),
                action: () => {
                  ensureGroupVisible("editor-area");
                  group.tabs.forEach((t) => addTab("editor-area", newTab(t)));
                  removeFloatingPanel(panel.id);
                },
              },
              {
                label: t("layout.closeGroup"),
                action: () => removeFloatingPanel(panel.id),
              },
            ]);
          }}
          style={FLOATING_DOCK_HANDLE}
          title={t("floating.dragToDock")}
        >
          ⠿
        </div>
        {/* Tab bar（嵌入标题栏，支持拖出回 layout） */}
        <div style={{ display: "flex", flex: 1, alignItems: "center", height: "100%", overflow: "hidden" }}>
          {showTabBar ? (
            group.tabs.map((tab) => {
              const isActive = tab.id === group.activeTabId;
              return (
                <div
                  key={tab.id}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    ensureGlobalDragListeners();
                    prepareDrag(group.id, tab, e.clientX, e.clientY, undefined, panel.id);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveTabInFloating(panel.id, tab.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showCtxMenu(e.clientX, e.clientY, floatingTabMenu(panel.id, tab));
                  }}
                  style={{
                    ...FLOATING_TAB_BASE,
                    color: isActive ? "var(--fg-primary)" : "var(--fg-secondary)",
                    backgroundColor: isActive ? "var(--bg-root)" : "transparent",
                    borderBottom: isActive ? "2px solid var(--accent)" : "none",
                  }}
                >
                  <span>{iconFor(tab.icon)}</span>
                  <span>{tab.title}</span>
                </div>
              );
            })
          ) : (
            <div
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (activeTab) showCtxMenu(e.clientX, e.clientY, floatingTabMenu(panel.id, activeTab));
              }}
              style={{
                padding: "0 12px", fontSize: 11, color: "var(--fg-primary)",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                display: "flex", alignItems: "center", gap: 4,
              }}
            >
              {iconFor(activeTab?.icon)}
              <span>{activeTab?.title ?? ""}</span>
            </div>
          )}
        </div>
        {/* 关闭按钮 */}
        <div
          role="button"
          tabIndex={0}
          aria-label={t("floating.close")}
          onClick={(e) => { e.stopPropagation(); removeFloatingPanel(panel.id); }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); removeFloatingPanel(panel.id); } }}
          style={FLOATING_CLOSE_BTN}
          title={t("floating.close")}
        >
          ×
        </div>
      </div>

      {/* 复合 tab bar */}
      {compoundTabs && (
        <div style={FLOATING_CMP_BAR}>
          {compoundTabs.map((ct) => {
            const childActive = ct.id === activeTab!.activeChildId;
            return (
              <div key={ct.id}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  ensureGlobalDragListeners();
                  prepareDrag(group.id, ct, e.clientX, e.clientY, activeTab!.id, panel.id);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  const fp = getFloatingPanels().find((fp) => fp.id === panel.id);
                  if (fp) {
                    const pt = fp.group.tabs.find((t) => t.id === activeTab!.id);
                    if (pt) pt.activeChildId = ct.id;
                  }
                  setActiveTabInFloating(panel.id, activeTab!.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  showCtxMenu(e.clientX, e.clientY, floatingTabMenu(panel.id, ct, activeTab!.id));
                }}
                style={{
                  ...FLOATING_CMP_TAB_BASE,
                  color: childActive ? "var(--fg-primary)" : "var(--fg-secondary)",
                  backgroundColor: childActive ? "var(--bg-root)" : "transparent",
                  borderBottom: childActive ? "2px solid var(--accent)" : "none",
                }}
              >
                <span>{iconFor(ct.icon)}</span>
                <span>{ct.title}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* 内容区 */}
      <div style={FLOATING_CONTENT}>
        {contentRender ? contentRender() : (
          <div style={FLOATING_NO_CONTENT}>
            {t("floatingRenderer.noContent")}
          </div>
        )}
      </div>

      {/* Resize 把手 (8 方向) */}
      {resizeDirs.map((dir) => {
        const isN = dir.includes("n"), isS = dir.includes("s");
        const isE = dir.includes("e"), isW = dir.includes("w");

        const posStyle: React.CSSProperties = {};
        if (dir === "n")  { posStyle.top = 0; posStyle.left = HANDLE; posStyle.right = HANDLE; posStyle.height = HANDLE; }
        else if (dir === "s")  { posStyle.bottom = 0; posStyle.left = HANDLE; posStyle.right = HANDLE; posStyle.height = HANDLE; }
        else if (dir === "e")  { posStyle.right = 0; posStyle.top = HANDLE; posStyle.bottom = HANDLE; posStyle.width = HANDLE; }
        else if (dir === "w")  { posStyle.left = 0; posStyle.top = HANDLE; posStyle.bottom = HANDLE; posStyle.width = HANDLE; }
        else if (dir === "ne") { posStyle.top = 0; posStyle.right = 0; posStyle.width = HANDLE * 2; posStyle.height = HANDLE * 2; }
        else if (dir === "nw") { posStyle.top = 0; posStyle.left = 0; posStyle.width = HANDLE * 2; posStyle.height = HANDLE * 2; }
        else if (dir === "se") { posStyle.bottom = 0; posStyle.right = 0; posStyle.width = HANDLE * 2; posStyle.height = HANDLE * 2; }
        else if (dir === "sw") { posStyle.bottom = 0; posStyle.left = 0; posStyle.width = HANDLE * 2; posStyle.height = HANDLE * 2; }

        return (
          <div
            key={dir}
            style={{
              ...FLOATING_RESIZE_HANDLE,
              ...posStyle,
              cursor: cursorMap[dir],
            }}
            onMouseDown={(e) => onResizeMouseDown(e, dir)}
          />
        );
      })}
    </div>
  );
}
export default memo(_FloatingRenderer);
