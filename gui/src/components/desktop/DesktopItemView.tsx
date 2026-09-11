import React, { useCallback, useRef, useState, memo } from "react";
import { t } from "../../i18n";
import type { DesktopItem } from "../../types/desktop";
import { getDesktops, moveItem, resizeItem, bringItemToFront, updateItem, removeItem, pushHistory } from "../../stores/desktopStore";
import { setSelection, getSelectedIds } from "./selectionStore";
import { renderItemContent } from "../../services/itemTypeRegistry";

interface Props {
  item: DesktopItem;
  scale: number;
  connectionMode?: boolean;
  highlighted?: boolean;
  selected?: boolean;
  suppressOwnDrag?: boolean;
  dimmed?: boolean;
}

const ANCHOR_SIDES = ["top", "right", "bottom", "left"] as const;

// Inject highlight keyframes once
let _highlightStyleInjected = false;
function injectHighlightStyle() {
  if (_highlightStyleInjected) return;
  _highlightStyleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    @keyframes dt-item-flash {
      0%, 100% { box-shadow: 0 0 0 2px var(--accent), 0 0 20px rgba(0,122,204,0.3); }
      50% { box-shadow: 0 0 0 3px var(--accent), 0 0 32px rgba(0,122,204,0.6); }
    }
  `;
  document.head.appendChild(style);
}

export const DesktopItemView = memo(function DesktopItemView({ item, scale, connectionMode, highlighted, selected, suppressOwnDrag, dimmed }: Props) {
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleText, setTitleText] = useState(item.label);
  const dragRef = useRef({ startX: 0, startY: 0, itemX: 0, itemY: 0, itemW: 0, itemH: 0 });

  const handleSize = 8 / scale;

  // ── Drag ──

  const handleTitleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (suppressOwnDrag) return;
      if (e.button !== 0) return;
      e.stopPropagation();
      // Select this item (Ctrl+click for multi-select, otherwise single)
      if (e.ctrlKey) {
        const sel = getSelectedIds();
        const next = new Set(sel);
        if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
        setSelection(next);
      } else if (!getSelectedIds().has(item.id)) {
        setSelection(new Set([item.id]));
      }
      pushHistory(item.desktopId);
      setDragging(true);
      dragRef.current = { startX: e.clientX, startY: e.clientY, itemX: item.x, itemY: item.y, itemW: 0, itemH: 0 };
      bringItemToFront(item.id);
    },
    [item.desktopId, item.id, item.x, item.y, suppressOwnDrag]
  );

  // ── Resize ──

  const handleResizeStart = useCallback(
    (dir: string) => (e: React.MouseEvent) => {
      e.stopPropagation();
      pushHistory(item.desktopId);
      setResizing(dir);
      dragRef.current = { startX: e.clientX, startY: e.clientY, itemX: item.x, itemY: item.y, itemW: item.width, itemH: item.height };
      bringItemToFront(item.id);
    },
    [item.id, item.x, item.y, item.width, item.height]
  );

  // ── Global mouse move/up for drag and resize ──

  const handleGlobalMouseMove = useCallback(
    (e: MouseEvent) => {
      const dx = (e.clientX - dragRef.current.startX) / scale;
      const dy = (e.clientY - dragRef.current.startY) / scale;
      if (dragging) {
        moveItem(item.id, dragRef.current.itemX + dx, dragRef.current.itemY + dy);
      } else if (resizing) {
        const r = dragRef.current;
        let nx = r.itemX, ny = r.itemY, nw = r.itemW, nh = r.itemH;
        const sdx = (e.clientX - r.startX) / scale;
        const sdy = (e.clientY - r.startY) / scale;
        if (resizing.includes("e")) { nw = Math.max(50, r.itemW + sdx); }
        if (resizing.includes("w")) { nw = Math.max(50, r.itemW - sdx); nx = r.itemX + r.itemW - nw; }
        if (resizing.includes("s")) { nh = Math.max(50, r.itemH + sdy); }
        if (resizing.includes("n")) { nh = Math.max(50, r.itemH - sdy); ny = r.itemY + r.itemH - nh; }
        moveItem(item.id, nx, ny);
        resizeItem(item.id, nw, nh);
      }
    },
    [dragging, resizing, item.id, scale]
  );

  const handleGlobalMouseUp = useCallback(() => {
    if (dragging) {
      // Snap to grid on mouseup if enabled
      const d = getDesktops().find((d) => d.items.some((i) => i.id === item.id));
      if (d?.snapToGrid) {
        const currentItem = d.items.find((i) => i.id === item.id);
        if (currentItem) {
          const sx = Math.round(currentItem.x / d.gridSize) * d.gridSize;
          const sy = Math.round(currentItem.y / d.gridSize) * d.gridSize;
          if (sx !== currentItem.x || sy !== currentItem.y) {
            moveItem(item.id, sx, sy);
          }
        }
      }
    }
    setDragging(false);
    setResizing(null);
  }, [dragging, item.id]);

  React.useEffect(() => {
    if (dragging || resizing) {
      window.addEventListener("mousemove", handleGlobalMouseMove);
      window.addEventListener("mouseup", handleGlobalMouseUp);
      return () => {
        window.removeEventListener("mousemove", handleGlobalMouseMove);
        window.removeEventListener("mouseup", handleGlobalMouseUp);
      };
    }
  }, [dragging, resizing, handleGlobalMouseMove, handleGlobalMouseUp]);

  const tooSmall = scale < 0.3;

  // ── Content renderer ──

  const renderContent = () => {
    return renderItemContent(item) ?? (
      <div style={{ padding: 12, color: "var(--fg-muted)" }}>{t("desktop.unknownContentType")}</div>
    );
  };

  // ── Styles ──

  // 卡片底色:有用户自定义色则用之;否则跟随主题(亮色=白,暗色=深surface)
  // 显式白色视为"默认"(暗色下白卡片刺眼), 回退到主题色
  const color = item.color && item.color !== "#ffffff" ? item.color : "var(--bg-surface)";
  const anchorSize = Math.max(6, 6 / scale); // small, subtle connection handle

  // Ensure highlight keyframes are injected
  injectHighlightStyle();

  return (
    <div
      data-desktop-item={item.id}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest('[contenteditable="true"], input, textarea, select, button')) return;
        bringItemToFront(item.id);
      }}
      style={{
        position: "absolute",
        left: item.x,
        top: item.y,
        width: item.width,
        height: item.collapsed ? undefined : item.height,
        minHeight: item.collapsed ? undefined : 50,
        zIndex: item.zIndex,
        backgroundColor: color,
        borderRadius: 6,
        boxShadow: dragging || resizing
          ? "0 4px 16px rgba(0,0,0,0.2)"
          : hovered
            ? "0 2px 8px rgba(0,0,0,0.12)"
            : "0 1px 3px rgba(0,0,0,0.08)",
        border: highlighted || selected ? "2px solid var(--accent)" : "1px solid var(--border-light)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        transition: dragging || resizing ? "none" : "box-shadow 0.15s, border 0.15s",
        animation: highlighted ? "dt-item-flash 0.8s ease-in-out 3" : "none",
        cursor: dragging ? "grabbing" : dimmed ? "default" : "default",
        opacity: dimmed ? 0.25 : undefined,
        pointerEvents: dimmed ? "none" : undefined,
      }}
    >
      {/* Title bar */}
      <div
        onMouseDown={handleTitleMouseDown}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 8px",
          backgroundColor: "var(--bg-hover)",
          borderBottom: "1px solid var(--border-light)",
          cursor: "grab",
          fontSize: 12,
          fontWeight: 500,
          color: "var(--fg-secondary)",
          userSelect: "none",
          flexShrink: 0,
          minHeight: 28,
        }}
      >
        {editingTitle ? (
          <input
            autoFocus
            value={titleText}
            onChange={(e) => setTitleText(e.target.value)}
            onBlur={() => {
              setEditingTitle(false);
              if (titleText.trim()) updateItem(item.id, { label: titleText.trim() });
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                setEditingTitle(false);
                if (titleText.trim()) updateItem(item.id, { label: titleText.trim() });
              }
              if (e.key === "Escape") {
                setEditingTitle(false);
                setTitleText(item.label);
              }
            }}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              flex: 1,
              fontSize: 12,
              fontWeight: 500,
              padding: "1px 4px",
              border: "1px solid var(--accent)",
              borderRadius: 2,
              outline: "none",
              minWidth: 60,
            }}
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditingTitle(true);
              setTitleText(item.label);
            }}
            title={t("desktop.dblclickToEditTitle")}
            style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {item.label}
          </span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); updateItem(item.id, { collapsed: !item.collapsed }); }}
          aria-label={item.collapsed ? t("desktop.expand") : t("desktop.collapse")}
          title={item.collapsed ? t("desktop.expand") : t("desktop.collapse")}
          style={{ border: "none", background: "none", cursor: "pointer", fontSize: 12, color: "var(--fg-muted)", padding: "2px 4px", lineHeight: 1}}
        >
          {item.collapsed ? "⊞" : "⊟"}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); removeItem(item.id); }}
          aria-label={t("desktop.delete")}
          title={t("desktop.delete")}
          style={{ border: "none", background: "none", cursor: "pointer", fontSize: 14, color: "var(--fg-muted)", fontWeight: 700, padding: "2px 4px", lineHeight: 1 }}
        >
          ×
        </button>
      </div>

      {/* Content area */}
      {!item.collapsed && (
        <div style={{ flex: 1, overflow: "auto", minHeight: 0, pointerEvents: tooSmall ? "none" : undefined, opacity: tooSmall ? 0.6 : undefined }}>
          {renderContent()}
        </div>
      )}

      {/* Connection anchors — hidden during drag/resize to avoid intercepting title bar clicks */}
      {(hovered || connectionMode) && !dragging && !resizing && ANCHOR_SIDES.map((side) => {
        const pos = getAnchorPosition(item, side);
        const active = hovered; // full highlight only on direct hover
        return (
          <div
            key={side}
            data-anchor={side}
            title={hovered ? t("desktop.dragToConnectSide", { side }) : t("desktop.dragToConnect")}
            style={{
              position: "absolute",
              left: pos.x - anchorSize / 2,
              top: pos.y - anchorSize / 2,
              width: anchorSize,
              height: anchorSize,
              borderRadius: "50%",
              backgroundColor: "var(--semantic-warning)",
              border: "1px solid rgba(255,255,255,0.8)",
              boxShadow: active
                ? "0 0 0 2px rgba(255,107,53,0.35)"
                : "0 0 0 1px rgba(255,107,53,0.15)",
              cursor: "crosshair",
              zIndex: 15,
              opacity: active ? 0.95 : 0.3,
              transition: "opacity 0.15s, box-shadow 0.15s, transform 0.15s",
              transform: active ? "scale(1.15)" : "scale(1)",
            }}
          />
        );
      })}

      {/* Resize handles */}
      {hovered && !item.collapsed && [
        "n", "s", "e", "w", "ne", "nw", "se", "sw",
      ].map((dir) => (
        <div
          key={`resize-${dir}`}
          onMouseDown={handleResizeStart(dir)}
          style={{
            position: "absolute",
            ...getResizeHandleStyle(dir, handleSize),
            zIndex: 10,
          }}
        />
      ))}
    </div>
  );
}, (prev, next) => prev.item.id === next.item.id && prev.item.updatedAt === next.item.updatedAt && prev.scale === next.scale && prev.connectionMode === next.connectionMode && prev.highlighted === next.highlighted && prev.selected === next.selected && prev.suppressOwnDrag === next.suppressOwnDrag && prev.dimmed === next.dimmed);

// ─── Helpers ───

export function getAnchorPosition(item: DesktopItem, side: string): { x: number; y: number } {
  switch (side) {
    case "top":    return { x: item.width / 2, y: 0 };
    case "bottom": return { x: item.width / 2, y: item.height };
    case "left":   return { x: 0, y: item.height / 2 };
    case "right":  return { x: item.width, y: item.height / 2 };
    case "center": return { x: item.width / 2, y: item.height / 2 };
    default:       return { x: 0, y: 0 };
  }
}

function getResizeHandleStyle(dir: string, size: number): React.CSSProperties {
  const half = size / 2;
  const base: React.CSSProperties = {
    width: size,
    height: size,
    backgroundColor: "var(--accent)",
    border: "1px solid white",
    borderRadius: 1,
  };
  switch (dir) {
    case "n":  return { ...base, top: -half, left: "50%", marginLeft: -half, cursor: "n-resize" };
    case "s":  return { ...base, bottom: -half, left: "50%", marginLeft: -half, cursor: "s-resize" };
    case "e":  return { ...base, right: -half, top: "50%", marginTop: -half, cursor: "e-resize" };
    case "w":  return { ...base, left: -half, top: "50%", marginTop: -half, cursor: "w-resize" };
    case "ne": return { ...base, top: -half, right: -half, cursor: "ne-resize" };
    case "nw": return { ...base, top: -half, left: -half, cursor: "nw-resize" };
    case "se": return { ...base, bottom: -half, right: -half, cursor: "se-resize" };
    case "sw": return { ...base, bottom: -half, left: -half, cursor: "sw-resize" };
    default:   return base;
  }
}
