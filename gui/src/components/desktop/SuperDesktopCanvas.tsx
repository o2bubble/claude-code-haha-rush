import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import type { Desktop, ConnectionAnchor } from "../../types/desktop";
import type { FileGroupContent, ImageContent } from "../../types/desktop";
import { updateDesktopViewport, addConnection, addItem, removeItem, removeConnection, pushHistory, batchMoveItems, shouldAnimateViewport, panToItem, setActiveDesktop } from "../../stores/desktopStore";
import { ErrorBoundary } from "../ErrorBoundary";
import { showCtxMenu } from "../ContextMenu";
import { DesktopItemView, getAnchorPosition } from "./DesktopItemView";
import { ConnectionOverlay } from "./ConnectionOverlay";
import { windowBus } from "../../services/windowBus";
import { Events } from "../../services/events";
import type { DesktopItemSelectedPayload, SettingsChangedPayload } from "../../services/events";
import { saveClipboardItem, isRealFilePath, resolvePaste, collectPaste, defaultReadDir, defaultReadClipboardFiles } from "../../services/clipboardService";
import { useEvent } from "../../services/useService";
import { isSelected, setSelection, clearSelection, getSelectedIds, useSelection } from "./selectionStore";
import { setCurrentViewerItemId } from "../../services/desktopItemViewerRegistry";
import { createFloatingFromTab, createTauriWindowFromTab } from "../../stores/layoutStore";
import { t } from "../../i18n";
import { findSnapAnchor } from "./snapAnchor";

const CANVAS_CONTAINER = {
  flex: 1,
  position: "relative",
  overflow: "hidden",
  backgroundColor: "var(--bg-surface)",
  minHeight: 0,
  outline: "none",
} as const;

const CONN_DRAG_HINT = {
  position: "absolute",
  bottom: 16,
  left: "50%",
  transform: "translateX(-50%)",
  padding: "6px 16px",
  backgroundColor: "rgba(0,0,0,0.7)",
  color: "var(--fg-inverse)",
  borderRadius: 6,
  fontSize: 12,
  zIndex: 100,
  pointerEvents: "none",
} as const;

const CANVAS_RUBBER_BAND = {
  position: "absolute",
  top: 0,
  left: 0,
  pointerEvents: "none",
  zIndex: 2,
} as const;

const GRID_TEMPLATE = (gridSize: number) =>
  `repeating-linear-gradient(0deg, transparent, transparent ${gridSize - 1}px, var(--border-light) ${gridSize}px), repeating-linear-gradient(90deg, transparent, transparent ${gridSize - 1}px, var(--border-light) ${gridSize}px)`;

const CANVAS_TRANSFORM_BASE = {
  transformOrigin: "0 0",
  position: "absolute",
  top: 0,
  left: 0,
  zIndex: 1,
} as const;

interface Props {
  desktop: Desktop;
  searchMatchedIds?: Set<string> | null;
}

/** Convert screen coords to canvas coords accounting for pan/zoom */
function screenToCanvas(
  clientX: number, clientY: number,
  rect: DOMRect, panX: number, panY: number, zoom: number
): { x: number; y: number } {
  return {
    x: (clientX - rect.left - panX) / zoom,
    y: (clientY - rect.top - panY) / zoom,
  };
}

function SuperDesktopCanvasImpl({ desktop, searchMatchedIds }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, px: 0, py: 0 });

  // ── Connection drag state ──
  const connDrag = useRef<{
    fromItemId: string;
    fromSide: ConnectionAnchor["side"];
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
  } | null>(null);
  const [, setConnDragTick] = useState(0); // force re-render for rubber band

  // ── Space-hold for pan mode ──
  const [spaceHeld, setSpaceHeld] = useState(false);

  // ── Box-select state ──
  const boxSelect = useRef<{
    startX: number; startY: number;
    currentX: number; currentY: number;
  } | null>(null);
  const [, setBoxSelectTick] = useState(0);

  // ── Multi-item drag state ──
  const multiDrag = useRef<{
    itemStartPositions: Map<string, { x: number; y: number }>;
    mouseStartX: number; mouseStartY: number;
  } | null>(null);
  const [isMultiDragging, setIsMultiDragging] = useState(false);

  // ── Selection (reactive hook) ──
  const selectedIds = useSelection();

  // ── Highlighted item (from reference chip click) ──

  const desktopRef = useRef(desktop);
  desktopRef.current = desktop;

  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);

  useEffect(() => {
    return windowBus.on(Events.DESKTOP_ITEM_SELECTED, (payload: DesktopItemSelectedPayload) => {
      const resolvedId = panToItem(payload.itemId);
      if (!resolvedId) return;
      setHighlightedItemId(resolvedId);
      // Clear highlight after 3s
      setTimeout(() => setHighlightedItemId(null), 3000);
    });
  }, []);

  // ── Pointer event dispatch ──
  // Pointer events + setPointerCapture: once the canvas starts a drag, all
  // subsequent pointermove/pointerup route back here EVEN when the cursor leaves
  // the canvas (mouseup on another panel previously lost the drag → the canvas
  // kept following the mouse).

  const capturePointer = useCallback((e: React.PointerEvent) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  }, []);

  const handleMouseDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;

      // Space-held left drag OR middle mouse button → pan
      if ((spaceHeld && e.button === 0) || e.button === 1) {
        capturePointer(e);
        pushHistory(desktop.id);
        setIsPanning(true);
        panStart.current = { x: e.clientX, y: e.clientY, px: desktop.panX, py: desktop.panY };
        e.preventDefault();
        return;
      }

      if (e.button !== 0) return;

      // Anchor click → start connection drag
      const anchor = target.closest("[data-anchor]") as HTMLElement | null;
      if (anchor) {
        const itemEl = anchor.closest("[data-desktop-item]") as HTMLElement | null;
        if (!itemEl) return;
        const itemId = itemEl.getAttribute("data-desktop-item")!;
        const side = anchor.getAttribute("data-anchor") as ConnectionAnchor["side"];
        const item = desktop.items.find((i) => i.id === itemId);
        if (!item) return;

        capturePointer(e);
        const pos = getAnchorPosition(item, side);
        const ax = item.x + pos.x;
        const ay = item.y + pos.y;

        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const canvas = screenToCanvas(e.clientX, e.clientY, rect, desktop.panX, desktop.panY, desktop.zoom);

        connDrag.current = {
          fromItemId: itemId,
          fromSide: side,
          fromX: ax,
          fromY: ay,
          toX: canvas.x,
          toY: canvas.y,
        };
        setConnDragTick((t) => t + 1);
        e.preventDefault();
        return;
      }

      // Item click in multi-selection → start multi-drag
      const itemEl = target.closest("[data-desktop-item]") as HTMLElement | null;
      if (itemEl) {
        const itemId = itemEl.getAttribute("data-desktop-item")!;
        const sel = getSelectedIds();
        if (sel.size >= 2 && sel.has(itemId)) {
          // Multi-drag: record all selected item positions
          pushHistory(desktop.id);
          const positions = new Map<string, { x: number; y: number }>();
          for (const id of sel) {
            const it = desktop.items.find((i) => i.id === id);
            if (it) positions.set(id, { x: it.x, y: it.y });
          }
          if (positions.size >= 2) {
            capturePointer(e);
            multiDrag.current = {
              itemStartPositions: positions,
              mouseStartX: e.clientX,
              mouseStartY: e.clientY,
            };
            setIsMultiDragging(true);
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
        // Single item or non-selected → let item handle itself (DesktopItemView)
        return;
      }

      // Toolbar click → ignore
      if (target.closest("[data-canvas-toolbar]")) return;

      // Empty area left-drag without space → box-select
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      capturePointer(e);
      const canvas = screenToCanvas(e.clientX, e.clientY, rect, desktop.panX, desktop.panY, desktop.zoom);
      boxSelect.current = {
        startX: canvas.x,
        startY: canvas.y,
        currentX: canvas.x,
        currentY: canvas.y,
      };
      setBoxSelectTick((t) => t + 1);
      e.preventDefault();
    },
    [spaceHeld, capturePointer, desktop.id, desktop.panX, desktop.panY, desktop.zoom, desktop.items]
  );

  const handleMouseMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Connection drag rubber band
      if (connDrag.current) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const canvas = screenToCanvas(e.clientX, e.clientY, rect, desktop.panX, desktop.panY, desktop.zoom);
        connDrag.current.toX = canvas.x;
        connDrag.current.toY = canvas.y;
        setConnDragTick((t) => t + 1);
        return;
      }

      // Box-select rubber band
      if (boxSelect.current) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const canvas = screenToCanvas(e.clientX, e.clientY, rect, desktop.panX, desktop.panY, desktop.zoom);
        boxSelect.current.currentX = canvas.x;
        boxSelect.current.currentY = canvas.y;
        setBoxSelectTick((t) => t + 1);
        return;
      }

      // Multi-item drag
      if (multiDrag.current) {
        const m = multiDrag.current;
        const dx = (e.clientX - m.mouseStartX) / desktop.zoom;
        const dy = (e.clientY - m.mouseStartY) / desktop.zoom;
        const updates = new Map<string, { x: number; y: number }>();
        for (const [id, start] of m.itemStartPositions) {
          updates.set(id, { x: start.x + dx, y: start.y + dy });
        }
        batchMoveItems(updates);
        return;
      }

      // Pan
      if (!isPanning) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      updateDesktopViewport(desktop.id, {
        panX: panStart.current.px + dx,
        panY: panStart.current.py + dy,
      });
    },
    [isPanning, desktop.id, desktop.panX, desktop.panY, desktop.zoom]
  );

  const handleMouseUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Finish connection drag
      if (connDrag.current) {
        const drag = connDrag.current;
        connDrag.current = null;
        // 用 desktopRef.current 而非闭包 desktop —— 拖拽期间 pan/zoom 可能已变化
        //（闭包 deps 不含 panX/panY，留存旧偏移会导致命中坐标偏差 → 锚点"吸不住"）
        const live = desktopRef.current;

        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          const mx = (e.clientX - rect.left - live.panX) / live.zoom;
          const my = (e.clientY - rect.top - live.panY) / live.zoom;
          const hit = findSnapAnchor(live.items, drag.fromItemId, mx, my, live.zoom);

          if (hit) {
            addConnection(live.id, {
              from: { itemId: drag.fromItemId, side: drag.fromSide },
              to: { itemId: hit.itemId, side: hit.side },
            });
          }
        }
        setConnDragTick((t) => t + 1);
        return;
      }

      // Finish box-select
      if (boxSelect.current) {
        const b = boxSelect.current;
        boxSelect.current = null;
        setBoxSelectTick((t) => t + 1);

        const rw = Math.abs(b.currentX - b.startX);
        const rh = Math.abs(b.currentY - b.startY);
        if (rw < 3 && rh < 3) {
          // Tiny drag = click-on-empty → deselect
          clearSelection();
        } else {
          // Compute intersection rect
          const rx = Math.min(b.startX, b.currentX);
          const ry = Math.min(b.startY, b.currentY);
          const rr = rx + rw;
          const rb = ry + rh;

          const hit = new Set<string>();
          for (const item of desktop.items) {
            const itemRight = item.x + item.width;
            const itemBottom = item.y + item.height;
            const intersects = !(rr < item.x || rb < item.y || rx > itemRight || ry > itemBottom);
            if (intersects) hit.add(item.id);
          }
          setSelection(hit);
        }
        return;
      }

      // Finish multi-drag
      if (multiDrag.current) {
        // Snap to grid if enabled
        if (desktop.snapToGrid) {
          const gs = desktop.gridSize;
          const snapUpdates = new Map<string, { x: number; y: number }>();
          for (const [id] of multiDrag.current.itemStartPositions) {
            const item = desktop.items.find((i) => i.id === id);
            if (item) {
              const sx = Math.round(item.x / gs) * gs;
              const sy = Math.round(item.y / gs) * gs;
              if (sx !== item.x || sy !== item.y) {
                snapUpdates.set(id, { x: sx, y: sy });
              }
            }
          }
          if (snapUpdates.size > 0) batchMoveItems(snapUpdates);
        }
        multiDrag.current = null;
        setIsMultiDragging(false);
        return;
      }

      setIsPanning(false);
    },
    [desktop.id, desktop.items, desktop.snapToGrid, desktop.gridSize, desktop.zoom]
  );

  // Pointer capture can be cancelled by the browser (system gesture, window
  // blur, …) without a pointerup — clear every drag state so the canvas never
  // stays stuck following the mouse.
  const handlePointerCancel = useCallback(() => {
    connDrag.current = null;
    boxSelect.current = null;
    multiDrag.current = null;
    setIsPanning(false);
    setIsMultiDragging(false);
    setConnDragTick((t) => t + 1);
    setBoxSelectTick((t) => t + 1);
  }, []);

  // ── Space key global tracking ──

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === " " && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement).isContentEditable)) {
        setSpaceHeld(true);
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " ") setSpaceHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // ── Zoom (centered on cursor) ──

  // Attach wheel listener natively — React's onWheel is passive and can't preventDefault
  const wheelDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelPushed = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      const target = e.target as HTMLElement;

      // 让路规则（与 useContentZoom / 各内容块的分工）：
      //   Ctrl/Cmd+滚轮 → 内容的**内部缩放**（图片/图形标了 data-wheel-zoom）
      //   裸滚轮        → 目标处在**可滚动的内部容器**里时优先滚动它
      //                   （文本块/表格 —— 表格是 AG Grid 自己渲染的滚动容器，
      //                    故用运行时检测而非标记属性）
      // 其余一律缩放画布 —— 包括"悬停在图片上裸滚轮"这种情况（早先对所有 item
      // 无条件让路，导致这些位置滚轮完全没反应）。
      if (e.ctrlKey || e.metaKey) {
        if (target.closest("[data-wheel-zoom]")) return;
      } else {
        let n: HTMLElement | null = target;
        while (n && n !== el) {
          const cs = getComputedStyle(n);
          if ((cs.overflowY === "auto" || cs.overflowY === "scroll")
              && n.scrollHeight > n.clientHeight + 1) return;
          n = n.parentElement;
        }
      }
      e.preventDefault();

      // Push snapshot once at start of zoom sequence
      const d = desktopRef.current;
      if (!wheelPushed.current) {
        pushHistory(d.id);
        wheelPushed.current = true;
      }
      if (wheelDebounce.current) clearTimeout(wheelDebounce.current);
      wheelDebounce.current = setTimeout(() => { wheelPushed.current = false; }, 500);

      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const zoom = d.zoom;
      const newZoom = Math.max(0.1, Math.min(5, zoom * factor));
      const newPanX = cursorX - (cursorX - d.panX) * (newZoom / zoom);
      const newPanY = cursorY - (cursorY - d.panY) * (newZoom / zoom);
      updateDesktopViewport(d.id, { panX: newPanX, panY: newPanY, zoom: newZoom });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // ── Work dir (for saving clipboard files) ──

  const settingsPayload = useEvent<SettingsChangedPayload>(Events.SETTINGS_CHANGED);
  const workDir = settingsPayload?.settings?.workDir ?? "";

  // ── Drop / Paste → FileGroupItem or TextItem ──

  /** Get viewport center in canvas coords */
  const getViewportCenter = useCallback(() => {
    const container = containerRef.current;
    if (!container) return { x: 100, y: 100 };
    const rect = container.getBoundingClientRect();
    return {
      x: (rect.width / 2 - desktop.panX) / desktop.zoom,
      y: (rect.height / 2 - desktop.panY) / desktop.zoom,
    };
  }, [desktop.panX, desktop.panY, desktop.zoom]);

  /** Get drop position in canvas coords */
  const getDropPos = useCallback(
    (e: React.DragEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 100, y: 100 };
      return {
        x: (e.clientX - rect.left - desktop.panX) / desktop.zoom,
        y: (e.clientY - rect.top - desktop.panY) / desktop.zoom,
      };
    },
    [desktop.panX, desktop.panY, desktop.zoom],
  );

  const createFileGroup = useCallback(
    (pos: { x: number; y: number }, files: FileGroupContent["files"]) => {
      addItem(desktop.id, {
        x: pos.x,
        y: pos.y,
        width: 300,
        height: Math.min(300, 44 + files.length * 32),
        content: { type: "file-group", files },
        label: files.length === 1 ? (files[0].label || t("files.file")) : `${files.length} ${t("files.files")}`,
      });
    },
    [desktop.id],
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      // Don't intercept paste inside editable elements (inputs, textareas, contentEditable)
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      e.preventDefault();

      const pos = getViewportCenter();

      const { files, images, text } = collectPaste(e);
      const decision = await resolvePaste({
        files,
        images,
        text,
        pathExists: isRealFilePath,
        readDir: defaultReadDir,
        // 粘贴的文件没有 .path（只有拖放有）→ 从系统剪贴板补源路径，走引用而非复制
        readClipboardFiles: defaultReadClipboardFiles,
      });

      if (decision.kind === "refs") {
        createFileGroup(pos, decision.refs);
        return;
      }
      if (decision.kind === "saveImages") {
        for (const item of decision.items) {
          const filePath = await saveClipboardItem(item.blob, workDir, item.name);
          if (filePath) {
            const name = filePath.split(/[/\\]/).pop() || "image";
            addItem(desktop.id, {
              x: pos.x,
              y: pos.y,
              width: 400,
              height: 300,
              content: { type: "image", path: filePath } as ImageContent,
              label: name,
            });
          }
        }
        return;
      }
      // inlineText → TextItem
      addItem(desktop.id, {
        x: pos.x,
        y: pos.y,
        width: 300,
        height: 200,
        content: { type: "text", format: "plain", text: decision.text },
        label: t("desktop.pastedText"),
      });
    },
    [getViewportCenter, createFileGroup, workDir, desktop.id],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      const pos = getDropPos(e);

      const files = e.dataTransfer.files;
      if (files.length > 0 && workDir) {
        const refs: FileGroupContent["files"] = [];
        for (let i = 0; i < files.length; i++) {
          // Check if the file already exists (it has a path)
          // In Tauri WebView, dropped files have their real paths in files[i].path
          const f = files[i] as File & { path?: string };
          if (f.path) {
            const name = f.name || f.path.split(/[/\\]/).pop() || f.path;
            const isDir = !f.type && !name.includes("."); // rough check — fallback to invocation
            if (isDir) {
              // 目录作为单个树根节点，由 FileGroupItem 懒加载 read_dir 逐级展开子项（不再平铺一级子项）。
              refs.push({ type: "dir", path: f.path, label: name });
              continue;
            }
            // Single image file → ImageItem
            const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"];
            if (imageExts.some((ext) => name.toLowerCase().endsWith(ext))) {
              addItem(desktop.id, {
                x: pos.x + refs.length * 20,
                y: pos.y + refs.length * 20,
                width: 400,
                height: 300,
                content: { type: "image", path: f.path } as ImageContent,
                label: name,
              });
              continue;
            }
            refs.push({ type: "file", path: f.path, label: name });
          } else {
            const isImage = f.type && f.type.startsWith("image/");
            const filePath = await saveClipboardItem(f, workDir, f.name);
            if (filePath) {
              const name = filePath.split(/[/\\]/).pop() || f.name;
              if (isImage) {
                addItem(desktop.id, {
                  x: pos.x + refs.length * 20,
                  y: pos.y + refs.length * 20,
                  width: 400,
                  height: 300,
                  content: { type: "image", path: filePath } as ImageContent,
                  label: name,
                });
              } else {
                refs.push({ type: "file", path: filePath, label: name });
              }
            }
          }
        }
        if (refs.length > 0) createFileGroup(pos, refs);
      }
    },
    [getDropPos, createFileGroup, workDir, desktop.id],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  // ── Escape to cancel connection drag ──

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Delete → delete all selected items
    if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.size > 0) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      pushHistory(desktop.id);
      for (const id of selectedIds) {
        removeItem(id);
      }
      clearSelection();
      return;
    }

    // Escape → cancel connection drag + clear selection
    if (e.key === "Escape") {
      if (connDrag.current) {
        connDrag.current = null;
        setConnDragTick((t) => t + 1);
      }
      clearSelection();
    }
  }, [desktop.id, selectedIds]);

  // ── Context menu ──

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const target = e.target as HTMLElement;

      // Right-click on a connection → connection actions
      const connPath = target.closest("[data-connection]") as HTMLElement | null;
      if (connPath) {
        const connId = connPath.getAttribute("data-connection")!;
        const conn = desktop.connections.find((c) => c.id === connId);
        showCtxMenu(e.clientX, e.clientY, [
          { label: conn?.label ? t("desktop.editLabel", { label: conn.label }) : t("desktop.addLabel"), action: () => {
            // Trigger click to select and edit label
            connPath.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          } },
          { label: t("desktop.deleteConnection"), action: () => removeConnection(connId) },
        ]);
        return;
      }

      // Right-click on an item → item actions
      const itemEl = target.closest("[data-desktop-item]") as HTMLElement | null;
      if (itemEl) {
        const itemId = itemEl.getAttribute("data-desktop-item")!;
        const item = desktop.items.find((i) => i.id === itemId);
        if (!item) return;

        // Multi-selection batch menu (clicked item is part of 2+ selection)
        if (selectedIds.size >= 2 && selectedIds.has(itemId)) {
          showCtxMenu(e.clientX, e.clientY, [
            {
              label: t("desktop.deleteItems", { count: selectedIds.size }),
              action: () => {
                pushHistory(desktop.id);
                for (const id of selectedIds) removeItem(id);
                clearSelection();
              },
            },
            {
              label: t("desktop.sendItemsToAgent", { count: selectedIds.size }),
              action: () => {
                for (const id of selectedIds) {
                  const it = desktop.items.find((i) => i.id === id);
                  if (it) {
                    windowBus.emit(Events.CHAT_ADD_REFERENCE, {
                      reference: { type: "desktop-item", path: `${it.content.type}/${it.id}`, label: it.label },
                    });
                  }
                }
              },
            },
            {
              label: t("desktop.bringToFront"),
              action: () => {
                for (const id of selectedIds) {
                  const it = desktop.items.find((i) => i.id === id);
                  if (it) itemEl.click(); // trigger bringItemToFront via each item's click
                }
              },
            },
          ]);
          return;
        }

        showCtxMenu(e.clientX, e.clientY, [
          {
            label: t("desktop.sendToAgent"),
            action: () => {
              windowBus.emit(Events.CHAT_ADD_REFERENCE, {
                reference: {
                  type: "desktop-item",
                  path: `${item.content.type}/${item.id}`,
                  label: item.label,
                },
              });
            },
          },
          {
            label: t("desktop.openInFloatingTab"),
            action: () => {
              setCurrentViewerItemId(itemId);
              createFloatingFromTab({
                id: `tab-desktop-item-view-${itemId.slice(0, 8)}`,
                panelId: "desktop-item-view",
                title: item.label,
                icon: "default",
              });
            },
          },
          {
            label: t("desktop.openInNewWindow"),
            action: () => {
              setCurrentViewerItemId(itemId);
              const safeId = itemId.replace(/-/g, "");
              const tab: any = {
                id: `tab-desktop-item-view-${safeId.slice(0, 8)}`,
                panelId: "desktop-item-view",
                // Embed itemId in title (passes through URL hash, no encoding restrictions)
                title: `${item.label} [item:${itemId}]`,
                icon: "default",
                // Safe label without special chars (Tauri restriction: [a-zA-Z0-9_-])
                _customLabel: `float-desktop-item-view--item--${safeId}`,
              };
              createTauriWindowFromTab(tab);
            },
          },
          { label: t("desktop.bringToFront"), action: () => { itemEl.click(); } },
          { label: t("desktop.deleteItem"), action: () => removeItem(itemId) },
        ]);
        return;
      }

      // Right-click on empty canvas → add items
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const canvas = screenToCanvas(e.clientX, e.clientY, rect, desktop.panX, desktop.panY, desktop.zoom);
      const cx = canvas.x;
      const cy = canvas.y;

      showCtxMenu(e.clientX, e.clientY, [
        { label: t("desktop.addText"), action: () => addItem(desktop.id, { x: cx, y: cy, width: 300, height: 200, content: { type: "text", format: "plain", text: "" }, label: t("desktop.textNote") }) },
        { label: t("desktop.addForm"), action: () => addItem(desktop.id, { x: cx, y: cy, width: 360, height: 300, content: { type: "form", fields: [] }, label: t("desktop.form") }) },
        { label: t("canvas.addDraw"), action: () => addItem(desktop.id, { x: cx, y: cy, width: 800, height: 540, content: { type: "drawing", svg: `<svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg"></svg>`, width: 800, height: 500 }, label: t("desktop.drawNote") }) },
        { label: t("desktop.resetView"), action: () => updateDesktopViewport(desktop.id, { zoom: 1, panX: 0, panY: 0 }) },
      ]);
    },
    [desktop]
  );

  // ── Styles ──

  const gridStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    backgroundImage: desktop.showGrid ? GRID_TEMPLATE(desktop.gridSize) : "none",
    backgroundSize: `${desktop.gridSize}px ${desktop.gridSize}px`,
    opacity: 0.5,
    zIndex: 0,
  };

  // ── Smooth viewport animation (two-phase: set transition first, then target) ──
  const [animPan, setAnimPan] = useState<{ x: number; y: number } | null>(null);
  const prevPanRef = useRef({ x: desktop.panX, y: desktop.panY });
  useEffect(() => {
    if (shouldAnimateViewport()) {
      // Phase 1: capture old position → render with transition on
      setAnimPan({ x: prevPanRef.current.x, y: prevPanRef.current.y });
      requestAnimationFrame(() => {
        // Phase 2: target new position → CSS transition animates
        setAnimPan(null);
      });
      // Auto-focus canvas after panel is fully mounted
      const el = containerRef.current;
      if (el) el.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop.panX, desktop.panY]);

  const useAnim = animPan !== null;
  // Track current position for animation start point
  if (!useAnim) prevPanRef.current = { x: desktop.panX, y: desktop.panY };
  const transformStyle: React.CSSProperties = {
    ...CANVAS_TRANSFORM_BASE,
    transform: useAnim
      ? `translate(${animPan!.x}px, ${animPan!.y}px) scale(${desktop.zoom})`
      : `translate(${desktop.panX}px, ${desktop.panY}px) scale(${desktop.zoom})`,
    transition: useAnim ? "transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)" : undefined,
  };

  return (
    <ErrorBoundary panelName="SuperDesktopCanvas">
    <div
      ref={containerRef}
      onPointerDown={handleMouseDown}
      onPointerMove={handleMouseMove}
      onPointerUp={handleMouseUp}
      onPointerCancel={handlePointerCancel}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      tabIndex={0}
      onClick={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest('[contenteditable="true"], input, textarea, select, button')) return;
        containerRef.current?.focus();
      }}
      onPaste={handlePaste}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      style={{
        ...CANVAS_CONTAINER,
        cursor: isPanning || isMultiDragging ? "grabbing" : connDrag.current ? "crosshair" : boxSelect.current ? "crosshair" : spaceHeld ? "grab" : "default",
      }}
    >
      <div style={gridStyle} />

      <div style={transformStyle}>
        {desktop.items.map((item) => (
          <DesktopItemView key={item.id} item={item} scale={desktop.zoom} connectionMode={!!connDrag.current} highlighted={highlightedItemId === item.id} selected={selectedIds.has(item.id)} suppressOwnDrag={selectedIds.size >= 2 && selectedIds.has(item.id)} dimmed={!!searchMatchedIds && !searchMatchedIds.has(item.id)} />
        ))}
      </div>

      {/* Connection overlay — rendered OUTSIDE transform to avoid overflow clipping */}
      <ConnectionOverlay
        connections={desktop.connections}
        items={desktop.items}
        panX={desktop.panX}
        panY={desktop.panY}
        zoom={desktop.zoom}
      />

      {/* Rubber band — canvas overlay outside transform */}
      {connDrag.current && (
        <canvas
          ref={(c) => {
            if (!c) return;
            const rect = c.parentElement?.getBoundingClientRect();
            if (!rect) return;
            c.width = rect.width;
            c.height = rect.height;
            c.style.width = rect.width + "px";
            c.style.height = rect.height + "px";
            const ctx = c.getContext("2d");
            if (!ctx) return;
            ctx.clearRect(0, 0, c.width, c.height);
            const d = connDrag.current;
            if (!d) return;
            const sx = d.fromX * desktop.zoom + desktop.panX;
            const sy = d.fromY * desktop.zoom + desktop.panY;
            const ex = d.toX * desktop.zoom + desktop.panX;
            const ey = d.toY * desktop.zoom + desktop.panY;
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            // Control point based on side
            const dist = Math.abs(ex - sx) + Math.abs(ey - sy);
            const ext = Math.max(30, dist * 0.3);
            switch (d.fromSide) {
              case "top": ctx.quadraticCurveTo(sx, sy - ext, ex, ey); break;
              case "bottom": ctx.quadraticCurveTo(sx, sy + ext, ex, ey); break;
              case "left": ctx.quadraticCurveTo(sx - ext, sy, ex, ey); break;
              case "right": ctx.quadraticCurveTo(sx + ext, sy, ex, ey); break;
              default: ctx.lineTo(ex, ey); break;
            }
            ctx.strokeStyle = "#ff6b35";
            ctx.lineWidth = 4;
            ctx.setLineDash([12, 6]);
            ctx.shadowColor = "rgba(255,107,53,0.5)";
            ctx.shadowBlur = 6;
            ctx.stroke();
            ctx.shadowBlur = 0;
          }}
          style={CANVAS_RUBBER_BAND}
        />
      )}

      {connDrag.current && (
        <div style={CONN_DRAG_HINT}>
          {t("desktop.dragHint")}
        </div>
      )}

      {/* Box-select rubber band */}
      {boxSelect.current && (
        <canvas
          ref={(c) => {
            if (!c) return;
            const rect = c.parentElement?.getBoundingClientRect();
            if (!rect) return;
            c.width = rect.width;
            c.height = rect.height;
            c.style.width = rect.width + "px";
            c.style.height = rect.height + "px";
            const ctx = c.getContext("2d");
            if (!ctx) return;
            ctx.clearRect(0, 0, c.width, c.height);
            const b = boxSelect.current;
            if (!b) return;
            const sx = b.startX * desktop.zoom + desktop.panX;
            const sy = b.startY * desktop.zoom + desktop.panY;
            const ex = b.currentX * desktop.zoom + desktop.panX;
            const ey = b.currentY * desktop.zoom + desktop.panY;
            const rx = Math.min(sx, ex);
            const ry = Math.min(sy, ey);
            const rw = Math.abs(ex - sx);
            const rh = Math.abs(ey - sy);
            ctx.fillStyle = "rgba(0, 122, 204, 0.08)";
            ctx.fillRect(rx, ry, rw, rh);
            ctx.strokeStyle = "#007acc";
            ctx.lineWidth = 1;
            ctx.setLineDash([6, 3]);
            ctx.strokeRect(rx, ry, rw, rh);
          }}
          style={CANVAS_RUBBER_BAND}
        />
      )}
    </div>
    </ErrorBoundary>
  );
}
export const SuperDesktopCanvas = memo(SuperDesktopCanvasImpl);

