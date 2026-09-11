import React, { memo, useEffect, useState } from "react";
import { t } from "../../i18n";
import type { Desktop } from "../../types/desktop";
import { updateDesktopViewport, addItem, clearDesktop, pushHistory, undoHistory, redoHistory, panToItem } from "../../stores/desktopStore";
import { canUndo, canRedo, loadHistory } from "../../stores/desktopHistoryStore";
import { getSelectedIds } from "./selectionStore";
import { MermaidDialog } from "./MermaidDialog";
import { normalizeGraphicContent } from "./graphicContent";

interface Props {
  desktop: Desktop;
  searchQuery?: string;
  onSearch?: (q: string) => void;
}

function CanvasToolbarImpl({ desktop, searchQuery, onSearch }: Props) {
  const [canUndo_, setCanUndo] = useState(false);
  const [canRedo_, setCanRedo] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [showGraphicDialog, setShowGraphicDialog] = useState(false);

  const handleAddGraphic = (text: string) => {
    addItem(desktop.id, {
      x: 50,
      y: 50,
      width: 600,
      height: 400,
      content: { type: "graphic", ...normalizeGraphicContent(text) } as any,
      label: t("desktop.mermaidDialogTitle"),
    });
    setShowGraphicDialog(false);
  };

  // Load persisted history + refresh button states
  useEffect(() => {
    loadHistory(desktop.id);
  }, [desktop.id]);

  const refreshHistory = () => {
    setCanUndo(canUndo(desktop.id));
    setCanRedo(canRedo(desktop.id));
  };

  // Refresh undo/redo state whenever desktop changes (mutations push snapshots)
  useEffect(() => {
    refreshHistory();
  }, [desktop.updatedAt]);

  const addText = () => {
    addItem(desktop.id, {
      x: 50,
      y: 50,
      width: 300,
      height: 200,
      content: { type: "text", format: "plain", text: "" },
      label: t("desktop.textNote"),
    });
  };

  const addForm = () => {
    addItem(desktop.id, {
      x: 50,
      y: 50,
      width: 360,
      height: 300,
      content: { type: "form", fields: [] },
      label: t("desktop.form"),
    });
  };

  const addDraw = () => {
    addItem(desktop.id, {
      x: 50,
      y: 50,
      width: 800,
      height: 540,
      content: { type: "drawing", svg: `<svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg"></svg>`, width: 800, height: 500 },
      label: t("desktop.drawNote"),
    });
  };

  const addTable = () => {
    const colA = crypto.randomUUID(), colB = crypto.randomUUID();
    addItem(desktop.id, {
      x: 50,
      y: 50,
      width: 500,
      height: 300,
      content: {
        type: "table",
        columns: [{ id: colA, name: "列 A" }, { id: colB, name: "列 B" }],
        rows: [
          { id: crypto.randomUUID(), cells: { [colA]: "", [colB]: "" } },
          { id: crypto.randomUUID(), cells: { [colA]: "", [colB]: "" } },
        ],
      },
      label: t("desktop.table"),
    });
  };

  const zoomIn = () => {
    pushHistory(desktop.id);
    updateDesktopViewport(desktop.id, { zoom: Math.min(5, desktop.zoom * 1.2) });
  };
  const zoomOut = () => {
    pushHistory(desktop.id);
    updateDesktopViewport(desktop.id, { zoom: Math.max(0.1, desktop.zoom / 1.2) });
  };
  const zoomReset = () => {
    pushHistory(desktop.id);
    updateDesktopViewport(desktop.id, { zoom: 1, panX: 0, panY: 0 });
  };
  const toggleGrid = () => {
    updateDesktopViewport(desktop.id, { showGrid: !desktop.showGrid });
  };

  const handleSnapToggle = () => {
    updateDesktopViewport(desktop.id, { snapToGrid: !desktop.snapToGrid });
  };

  const handleAutoFit = () => {
    if (desktop.items.length === 0) return;
    pushHistory(desktop.id);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const item of desktop.items) {
      if (item.x < minX) minX = item.x;
      if (item.y < minY) minY = item.y;
      if (item.x + item.width > maxX) maxX = item.x + item.width;
      if (item.y + item.height > maxY) maxY = item.y + item.height;
    }

    const pad = 80;
    const contentW = maxX - minX + pad * 2;
    const contentH = maxY - minY + pad * 2;
    const viewW = 800;
    const viewH = 500;
    const fitZoom = Math.min(viewW / contentW, viewH / contentH, 2);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    updateDesktopViewport(desktop.id, {
      zoom: Math.max(0.1, fitZoom),
      panX: viewW / 2 - centerX * fitZoom,
      panY: viewH / 2 - centerY * fitZoom,
    });
  };

  const handleClear = () => {
    if (!clearConfirm) {
      setClearConfirm(true);
      setTimeout(() => setClearConfirm(false), 3000);
      return;
    }
    clearDesktop(desktop.id);
    setClearConfirm(false);
  };

  const handleUndo = () => {
    const snap = undoHistory(desktop.id);
    if (snap) {
      import("../../stores/desktopStore").then(({ restoreSnapshot }) => {
        restoreSnapshot(desktop.id, snap);
      });
    }
    refreshHistory();
  };

  const handleRedo = () => {
    const snap = redoHistory(desktop.id);
    if (snap) {
      import("../../stores/desktopStore").then(({ restoreSnapshot }) => {
        restoreSnapshot(desktop.id, snap);
      });
    }
    refreshHistory();
  };

  const btn = (active?: boolean): React.CSSProperties => ({
    fontSize: 12,
    padding: "3px 8px",
    border: active ? "1px solid var(--accent)" : "1px solid var(--border-medium)",
    borderRadius: 3,
    background: active ? "var(--accent)" : "var(--bg-root)",
    color: active ? "var(--fg-inverse)" : "var(--fg-primary)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  });

  const sep = <span style={{ margin: "0 4px", color: "var(--fg-muted)" }}>|</span>;

  return (
    <div
      data-canvas-toolbar
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 8px",
        borderBottom: "1px solid var(--border-light)",
        backgroundColor: "var(--bg-surface)",
        flexShrink: 0,
        flexWrap: "wrap",
      }}
    >
      <button onClick={addText} style={btn()}>{t("canvas.addText")}</button>
      <button onClick={addTable} style={btn()}>{t("canvas.addTable")}</button>
      <button onClick={addForm} style={btn()}>{t("canvas.addForm")}</button>
      <button onClick={addDraw} style={btn()}>{t("canvas.addDraw")}</button>
      <button onClick={() => setShowGraphicDialog(true)} style={btn()}>{t("canvas.addGraphic")}</button>

      {showGraphicDialog && (
        <MermaidDialog
          title={t("desktop.mermaidDialogTitle")}
          initial=""
          onConfirm={handleAddGraphic}
          onClose={() => setShowGraphicDialog(false)}
        />
      )}

      {sep}

      <button onClick={zoomOut} style={btn()} title={t("canvas.zoomOut")} aria-label={t("canvas.zoomOut")}>−</button>
      <span style={{ fontSize: 12, color: "var(--fg-secondary)", minWidth: 40, textAlign: "center" }}>
        {Math.round(desktop.zoom * 100)}%
      </span>
      <button onClick={zoomIn} style={btn()} title={t("canvas.zoomIn")} aria-label={t("canvas.zoomIn")}>+</button>
      <button onClick={zoomReset} style={btn()} title={t("canvas.zoomReset")}>{t("canvas.zoomReset")}</button>

      <button onClick={handleAutoFit} style={btn()} title={t("canvas.fitViewTitle")}>{t("canvas.fitView")}</button>

      <button
        onClick={() => {
          const ids = getSelectedIds();
          if (ids.size > 0) panToItem([...ids][0]);
        }}
        style={btn()}
        title={t("canvas.locateSelection")}
      >
        {t("canvas.locateSelection")}
      </button>

      {sep}

      <button onClick={handleSnapToggle} style={btn(desktop.snapToGrid)} title={t("canvas.snapTitle")}>
        {t("canvas.snap")}
      </button>

      <button onClick={toggleGrid} style={btn(desktop.showGrid)}>{t("canvas.grid")}</button>

      {sep}

      <button
        onClick={handleUndo}
        style={{ ...btn(), opacity: canUndo_ ? 1 : 0.4 }}
        disabled={!canUndo_}
        title={t("canvas.undo")}
        aria-label={t("canvas.undo")}
      >
        ↶
      </button>
      <button
        onClick={handleRedo}
        style={{ ...btn(), opacity: canRedo_ ? 1 : 0.4 }}
        disabled={!canRedo_}
        title={t("canvas.redo")}
        aria-label={t("canvas.redo")}
      >
        ↷
      </button>

      {sep}

      <button
        onClick={handleClear}
        style={{
          ...btn(),
          background: clearConfirm ? "var(--semantic-error)" : "var(--bg-root)",
          color: clearConfirm ? "var(--fg-inverse)" : "var(--semantic-error)",
          borderColor: clearConfirm ? "var(--semantic-error)" : "var(--border-medium)",
          fontWeight: clearConfirm ? 700 : 400,
        }}
        title={clearConfirm ? t("canvas.clearConfirmTitle") : t("canvas.clearTitle")}
      >
        {clearConfirm ? t("canvas.clearConfirm") : t("canvas.clear")}
      </button>

      {sep}

      <input
        type="text"
        value={searchQuery ?? ""}
        onChange={(e) => onSearch?.(e.target.value)}
        placeholder={t("canvas.searchPlaceholder")}
        title={t("canvas.searchPlaceholder")}
        style={{
          fontSize: 12,
          padding: "3px 6px",
          border: searchQuery ? "1px solid var(--accent)" : "1px solid var(--border-medium)",
          borderRadius: 3,
          background: "var(--bg-root)",
          outline: "none",
          width: 140,
          color: "var(--fg-primary)",
        }}
      />
      {searchQuery && (
        <button
          onClick={() => onSearch?.("")}
          style={{ ...btn(), fontSize: 11, padding: "2px 5px" }}
          title={t("canvas.clearSearch")}
          aria-label={t("canvas.clearSearch")}
        >
          ×
        </button>
      )}
    </div>
  );
}
export const CanvasToolbar = memo(CanvasToolbarImpl);
