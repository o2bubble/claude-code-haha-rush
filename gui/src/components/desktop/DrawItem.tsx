import { useState, useRef, useCallback } from "react";
import { getStroke } from "perfect-freehand";
import type { DesktopItem, DrawingContent, DrawElement } from "../../types/desktop";
import { updateItem } from "../../stores/desktopStore";
import { isSelected } from "./selectionStore";

interface Pt { x: number; y: number; }

type ToolType = "freehand" | "rect" | "circle" | "line" | "arrow" | "text" | "eraser";

let _id = 0;
function uid(): string { return "d" + (++_id).toString(36) + Date.now().toString(36); }

// ── Color presets ──

const COLORS = [
  "#000000", "#e53e3e", "#3182ce", "#38a169", "#dd6b20",
  "#805ad5", "#ffffff", "#718096",
];

// ── SVG serialization ──

function serializeSVG(elements: DrawElement[], w: number, h: number): string {
  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`);
  for (const el of elements) {
    const op = el.opacity < 1 ? ` opacity="${el.opacity}"` : "";
    switch (el.type) {
      case "freehand": {
        const stroke = getStroke(el.points, { size: el.strokeWidth, thinning: 0.5, smoothing: 0.5, streamline: 0.5 });
        const d = getSvgPathFromStroke(stroke);
        parts.push(`<path d="${d}" fill="${el.color}"${op}/>`);
        break;
      }
      case "rect": {
        const fill = el.fillColor ? ` fill="${el.fillColor}" fill-opacity="${el.opacity}"` : ` fill="none"`;
        parts.push(`<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" stroke="${el.color}" stroke-width="${el.strokeWidth}"${fill}${op}/>`);
        break;
      }
      case "circle": {
        const fill = el.fillColor ? ` fill="${el.fillColor}" fill-opacity="${el.opacity}"` : ` fill="none"`;
        parts.push(`<circle cx="${el.cx}" cy="${el.cy}" r="${el.r}" stroke="${el.color}" stroke-width="${el.strokeWidth}"${fill}${op}/>`);
        break;
      }
      case "line":
        parts.push(`<line x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="${el.color}" stroke-width="${el.strokeWidth}"${op}/>`);
        break;
      case "arrow": {
        const angle = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
        const headLen = 10;
        const ax1 = el.x2 - headLen * Math.cos(angle - 0.5);
        const ay1 = el.y2 - headLen * Math.sin(angle - 0.5);
        const ax2 = el.x2 - headLen * Math.cos(angle + 0.5);
        const ay2 = el.y2 - headLen * Math.sin(angle + 0.5);
        parts.push(`<line x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="${el.color}" stroke-width="${el.strokeWidth}"${op}/>`);
        parts.push(`<polygon points="${el.x2},${el.y2} ${ax1},${ay1} ${ax2},${ay2}" fill="${el.color}"${op}/>`);
        break;
      }
      case "text":
        parts.push(`<text x="${el.x}" y="${el.y}" fill="${el.color}" font-size="${el.fontSize}" font-family="sans-serif"${op}>${escapeXml(el.text)}</text>`);
        break;
    }
  }
  parts.push("</svg>");
  return parts.join("\n");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── perfect-freehand helper ──

function getSvgPathFromStroke(stroke: number[][]): string {
  if (!stroke.length) return "";
  const d: string[] = [];
  d.push(`M ${stroke[0][0].toFixed(2)} ${stroke[0][1].toFixed(2)}`);
  for (let i = 1; i < stroke.length; i++) {
    const [x0, y0] = stroke[i - 1];
    const [x1, y1] = stroke[i];
    const mx = ((x0 + x1) / 2).toFixed(2);
    const my = ((y0 + y1) / 2).toFixed(2);
    d.push(`Q ${x0.toFixed(2)} ${y0.toFixed(2)}, ${mx} ${my}`);
  }
  return d.join(" ");
}

// ── Empty SVG ──

const emptySVG = (w: number, h: number) =>
  `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"></svg>`;

// ── Styles ──

const TOOL_COLORS: Record<string, string> = {
  "#ffffff": "#ccc",
};

const S = {
  wrapper: { width: "100%", height: "100%", display: "flex", flexDirection: "column" } as React.CSSProperties,
  svgWrap: { flex: 1, position: "relative", overflow: "hidden", minHeight: 0 } as React.CSSProperties,
  svg: (editing: boolean): React.CSSProperties => ({
    width: "100%", height: "100%", display: "block",
    cursor: editing ? "crosshair" : "default",
    background: "var(--bg-surface)", borderRadius: 2,
  }),
  toolbar: {
    display: "flex", alignItems: "center", gap: 4, padding: "4px 6px",
    borderTop: "1px solid var(--border-light)", backgroundColor: "var(--bg-hover)",
    fontSize: 12, fontFamily: "var(--font-sans)", flexWrap: "wrap",
  } as React.CSSProperties,
  toolBtn: (active: boolean): React.CSSProperties => ({
    padding: "2px 6px", border: active ? "1.5px solid var(--accent)" : "1px solid var(--border-medium)",
    borderRadius: 3, cursor: "pointer", fontSize: 13, background: active ? "var(--accent-subtle)" : "var(--bg-surface)",
    lineHeight: 1,
  }),
  colorSwatch: (color: string, active: boolean): React.CSSProperties => ({
    width: 16, height: 16, borderRadius: 3, cursor: "pointer",
    border: active ? `2px solid var(--accent)` : `1px solid ${TOOL_COLORS[color] || "var(--border-medium)"}`,
    backgroundColor: color, boxSizing: "border-box",
  }),
  slider: { width: 60 } as React.CSSProperties,
  smallBtn: {
    padding: "2px 6px", border: "1px solid var(--border-medium)", borderRadius: 3,
    cursor: "pointer", fontSize: 11, fontFamily: "inherit", background: "var(--bg-surface)",
  } as React.CSSProperties,
};

// ── Tools ──

const TOOLS: { id: ToolType; label: string }[] = [
  { id: "freehand", label: "✏️" },
  { id: "rect", label: "▭" },
  { id: "circle", label: "○" },
  { id: "line", label: "╱" },
  { id: "arrow", label: "→" },
  { id: "text", label: "T" },
  { id: "eraser", label: "⌫" },
];

// ════════════════════════════════════════

export function DrawItem({ item }: { item: DesktopItem }) {
  const content = item.content as DrawingContent;
  const w = content.width || 800;
  const h = content.height || 500;
  const svgRef = useRef<SVGSVGElement>(null);

  // Parse existing elements from SVG or start fresh
  const [elements, setElements] = useState<DrawElement[]>(() => content.elements || []);
  const [tool, setTool] = useState<ToolType>("freehand");
  const [color, setColor] = useState("#000000");
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [fillColor, setFillColor] = useState<string | null>(null);
  const [opacity, setOpacity] = useState(1);
  const [undoStack, setUndoStack] = useState<DrawElement[][]>([]);
  const [redoStack, setRedoStack] = useState<DrawElement[][]>([]);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  // Drawing state
  const drawingRef = useRef<{
    active: boolean;
    startX: number; startY: number;
    points: Pt[];
    previewElement: DrawElement | null;
  }>({ active: false, startX: 0, startY: 0, points: [], previewElement: null });

  // Drawing state ref — accessible from stable window handlers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const brRef = useRef<{ tool: ToolType; color: string; strokeWidth: number; fillColor: string | null; opacity: number; addElement: (el: DrawElement) => void }>(null as any);
  brRef.current = { tool, color, strokeWidth, fillColor, opacity, addElement: () => {} };

  const [, forceR] = useState(0);

  const sel = isSelected(item.id);

  // ── Persist ──

  const persist = useCallback((els: DrawElement[]) => {
    const svg = els.length > 0 ? serializeSVG(els, w, h) : emptySVG(w, h);
    updateItem(item.id, {
      content: { type: "drawing", svg, width: w, height: h, elements: els } as DrawingContent,
    });
  }, [item.id, w, h]);

  // Push undo before mutation
  const pushUndo = useCallback(() => {
    setUndoStack((s) => {
      const next = [...s, elements];
      if (next.length > 50) next.shift();
      return next;
    });
  }, [elements]);

  const addElement = useCallback((el: DrawElement) => {
    pushUndo();
    setElements((els) => {
      const next = [...els, el];
      persist(next);
      return next;
    });
    setRedoStack([]);
  }, [pushUndo, persist]);
  brRef.current.addElement = addElement;

  const removeElement = useCallback((id: string) => {
    pushUndo();
    setElements((els) => {
      const next = els.filter((e) => e.id !== id);
      persist(next);
      return next;
    });
    setRedoStack([]);
  }, [pushUndo, persist]);

  const undo = useCallback(() => {
    setUndoStack((stack) => {
      if (!stack.length) return stack;
      const prev = stack[stack.length - 1];
      setRedoStack((r) => [...r, elements]);
      setElements(prev);
      persist(prev);
      return stack.slice(0, -1);
    });
  }, [elements, persist]);

  const redo = useCallback(() => {
    setRedoStack((stack) => {
      if (!stack.length) return stack;
      const next = stack[stack.length - 1];
      setUndoStack((s) => [...s, elements]);
      setElements(next);
      persist(next);
      return stack.slice(0, -1);
    });
  }, [elements, persist]);

  const clearAll = useCallback(() => {
    if (elements.length === 0) return;
    pushUndo();
    setElements([]);
    persist([]);
    setRedoStack([]);
  }, [elements, pushUndo, persist]);

  // ── Coordinate conversion ──

  const toSvgCoords = useCallback((e: React.MouseEvent): Pt => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (w / r.width),
      y: (e.clientY - r.top) * (h / r.height),
    };
  }, [w, h]);

  // ── Coordinate conversion (clientX/Y variant) ──

  const toSvgCoordsFromClient = useCallback((cx: number, cy: number): Pt => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    return {
      x: (cx - r.left) * (w / r.width),
      y: (cy - r.top) * (h / r.height),
    };
  }, [w, h]);

  // Stable window-level handlers (read all state from refs, no stale closures)

  const winMoveRef = useRef((e: MouseEvent) => {
    const d = drawingRef.current;
    if (!d.active) return;
    const br = brRef.current;
    const pt = toSvgCoordsFromClient(e.clientX, e.clientY);

    if (br.tool === "freehand") {
      d.points.push({ x: pt.x, y: pt.y });
      d.previewElement = {
        id: "_preview", type: "freehand", points: d.points,
        color: br.color, strokeWidth: br.strokeWidth, opacity: br.opacity,
      };
    } else {
      d.previewElement = buildShapePreview(br.tool, d.startX, d.startY, pt.x, pt.y,
        br.color, br.strokeWidth, br.fillColor, br.opacity);
    }
    forceR((n) => n + 1);
  });

  const winUpRef = useRef((e: MouseEvent) => {
    window.removeEventListener("mousemove", winMoveRef.current);
    window.removeEventListener("mouseup", winUpRef.current);

    const d = drawingRef.current;
    if (!d.active) return;
    d.active = false;

    const br = brRef.current;
    const pt = toSvgCoordsFromClient(e.clientX, e.clientY);

    if (br.tool === "freehand") {
      if (d.points.length >= 2) {
        br.addElement({ id: uid(), type: "freehand", points: [...d.points],
          color: br.color, strokeWidth: br.strokeWidth, opacity: br.opacity });
      }
    } else {
      const el = buildShapeElement(br.tool, d.startX, d.startY, pt.x, pt.y,
        br.color, br.strokeWidth, br.fillColor, br.opacity);
      if (el) br.addElement(el);
    }
    d.previewElement = null;
    forceR((n) => n + 1);
  });

  // ── SVG mouse down ──

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!sel) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    const pt = toSvgCoords(e);

    if (tool === "text") {
      const el: DrawElement = {
        id: uid(), type: "text", x: pt.x, y: pt.y + 14,
        text: "", color, fontSize: 16, opacity,
      };
      addElement(el);
      setEditingTextId(el.id);
      return;
    }

    if (tool === "eraser") {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (target) {
        const elId = (target as Element).getAttribute("data-el-id");
        if (elId) removeElement(elId);
      }
      return;
    }

    drawingRef.current = {
      active: true, startX: pt.x, startY: pt.y,
      points: [{ x: pt.x, y: pt.y }], previewElement: null,
    };

    window.addEventListener("mousemove", winMoveRef.current);
    window.addEventListener("mouseup", winUpRef.current);
  };

  // ── Render elements ──

  const renderElement = (el: DrawElement): JSX.Element | null => {
    const op = el.opacity < 1 ? el.opacity : undefined;
    switch (el.type) {
      case "freehand": {
        const stroke = getStroke(el.points, { size: el.strokeWidth, thinning: 0.5, smoothing: 0.5, streamline: 0.5 });
        const d = getSvgPathFromStroke(stroke);
        return <path key={el.id} data-el-id={el.id} d={d} fill={el.color} opacity={op} />;
      }
      case "rect":
        return <rect key={el.id} data-el-id={el.id} x={el.x} y={el.y} width={el.w} height={el.h}
          stroke={el.color} strokeWidth={el.strokeWidth}
          fill={el.fillColor || "none"} fillOpacity={op} opacity={op} />;
      case "circle":
        return <circle key={el.id} data-el-id={el.id} cx={el.cx} cy={el.cy} r={el.r}
          stroke={el.color} strokeWidth={el.strokeWidth}
          fill={el.fillColor || "none"} fillOpacity={op} opacity={op} />;
      case "line":
        return <line key={el.id} data-el-id={el.id} x1={el.x1} y1={el.y1} x2={el.x2} y2={el.y2}
          stroke={el.color} strokeWidth={el.strokeWidth} opacity={op} />;
      case "arrow": {
        const angle = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
        const headLen = 10;
        const ax1 = el.x2 - headLen * Math.cos(angle - 0.5);
        const ay1 = el.y2 - headLen * Math.sin(angle - 0.5);
        const ax2 = el.x2 - headLen * Math.cos(angle + 0.5);
        const ay2 = el.y2 - headLen * Math.sin(angle + 0.5);
        return (
          <g key={el.id} data-el-id={el.id} opacity={op}>
            <line x1={el.x1} y1={el.y1} x2={el.x2} y2={el.y2} stroke={el.color} strokeWidth={el.strokeWidth} />
            <polygon points={`${el.x2},${el.y2} ${ax1},${ay1} ${ax2},${ay2}`} fill={el.color} />
          </g>
        );
      }
      case "text":
        return (
          <text key={el.id} data-el-id={el.id} x={el.x} y={el.y}
            fill={el.color} fontSize={el.fontSize} fontFamily="sans-serif" opacity={op}>
            {el.text || (el.id === editingTextId ? "|" : "")}
          </text>
        );
    }
  };

  const renderPreview = (el: DrawElement): JSX.Element | null => {
    const op = el.opacity < 1 ? el.opacity : undefined;
    switch (el.type) {
      case "freehand": {
        const stroke = getStroke(el.points, { size: el.strokeWidth, thinning: 0.5, smoothing: 0.5, streamline: 0.5 });
        const d = getSvgPathFromStroke(stroke);
        return <path d={d} fill={el.color} opacity={op ? op * 0.6 : 0.6} />;
      }
      case "rect":
        return <rect x={el.x} y={el.y} width={el.w} height={el.h}
          stroke={el.color} strokeWidth={el.strokeWidth} fill={el.fillColor || "none"} opacity={0.6}
          strokeDasharray="4 3" />;
      case "circle":
        return <circle cx={el.cx} cy={el.cy} r={el.r}
          stroke={el.color} strokeWidth={el.strokeWidth} fill={el.fillColor || "none"} opacity={0.6}
          strokeDasharray="4 3" />;
      case "line":
        return <line x1={el.x1} y1={el.y1} x2={el.x2} y2={el.y2}
          stroke={el.color} strokeWidth={el.strokeWidth} opacity={0.6} strokeDasharray="4 3" />;
      case "arrow": {
        const angle = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
        const headLen = 10;
        const ax1 = el.x2 - headLen * Math.cos(angle - 0.5);
        const ay1 = el.y2 - headLen * Math.sin(angle - 0.5);
        const ax2 = el.x2 - headLen * Math.cos(angle + 0.5);
        const ay2 = el.y2 - headLen * Math.sin(angle + 0.5);
        return (
          <g opacity={0.6}>
            <line x1={el.x1} y1={el.y1} x2={el.x2} y2={el.y2} stroke={el.color} strokeWidth={el.strokeWidth} strokeDasharray="4 3" />
            <polygon points={`${el.x2},${el.y2} ${ax1},${ay1} ${ax2},${ay2}`} fill={el.color} />
          </g>
        );
      }
    }
    return null;
  };

  // ── Text editing ──

  const elementsRef = useRef(elements);
  elementsRef.current = elements;

  const handleTextInput = useCallback((e: React.KeyboardEvent) => {
    if (!editingTextId) return;
    e.stopPropagation();
    if (e.key === "Enter" || e.key === "Escape") {
      persist(elementsRef.current);
      setEditingTextId(null);
      return;
    }
    if (e.key === "Backspace") {
      setElements((els) => els.map((el) =>
        el.id === editingTextId && el.type === "text" ? { ...el, text: el.text.slice(0, -1) } : el
      ));
      return;
    }
    if (e.key.length === 1) {
      setElements((els) => els.map((el) =>
        el.id === editingTextId && el.type === "text" ? { ...el, text: el.text + e.key } : el
      ));
    }
  }, [editingTextId, persist]);

  // ── Render ──

  // Show static SVG when not selected, OR when selected but not in edit mode
  if (!sel || (!editing && elements.length === 0)) {
    const svgStr = content.svg || emptySVG(w, h);
    return (
      <div style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}>
        <div dangerouslySetInnerHTML={{ __html: svgStr }}
          style={{ width: "100%", height: "100%" }} />
        {sel && (
          <button
            onClick={() => setEditing(true)}
            style={{
              position: "absolute", bottom: 6, right: 6,
              padding: "4px 10px", borderRadius: 4,
              border: "1px solid var(--border-medium)", background: "var(--bg-root)",
              cursor: "pointer", fontSize: 12, color: "var(--fg-primary)",
              fontFamily: "var(--font-sans)",
            }}
          >✏️ 编辑</button>
        )}
      </div>
    );
  }

  const preview = drawingRef.current.previewElement;

  return (
    <div style={S.wrapper} onKeyDown={editingTextId ? handleTextInput : undefined} tabIndex={0}>
      {/* Drawing area */}
      <div style={S.svgWrap}>
        <svg ref={svgRef}
          viewBox={`0 0 ${w} ${h}`}
          style={S.svg(true)}
          onMouseDown={handleMouseDown}
        >
          {/* White background */}
          <rect x={0} y={0} width={w} height={h} style={{ fill: "var(--bg-surface)" }} />
          {/* Existing elements */}
          {elements.map(renderElement)}
          {/* Preview (while drawing) */}
          {preview && renderPreview(preview)}
        </svg>
      </div>

      {/* Toolbar */}
      <div style={S.toolbar} onMouseDown={(e) => e.stopPropagation()} onMouseUp={(e) => e.stopPropagation()}>
        {/* Tools */}
        {TOOLS.map((t) => (
          <button key={t.id} style={S.toolBtn(tool === t.id)}
            title={t.id} onClick={() => setTool(t.id)}>
            {t.label}
          </button>
        ))}

        <span style={{ width: 1, height: 16, background: "var(--border-medium)", margin: "0 2px" }} />

        {/* Colors */}
        {COLORS.map((c) => (
          <div key={c} style={S.colorSwatch(c, color === c)}
            title={c} onClick={() => setColor(c)} />
        ))}

        <span style={{ width: 1, height: 16, background: "var(--border-medium)", margin: "0 2px" }} />

        {/* Stroke width */}
        <input type="range" min={1} max={12} value={strokeWidth}
          onChange={(e) => setStrokeWidth(parseInt(e.target.value, 10))}
          style={S.slider} title={`Stroke: ${strokeWidth}px`} />

        {/* Fill toggle */}
        <button style={{
          ...S.smallBtn,
          background: fillColor ? "var(--accent-subtle)" : "var(--bg-surface)",
          borderColor: fillColor ? "var(--accent)" : "var(--border-medium)",
        }}
          title="Fill"
          onClick={() => setFillColor(fillColor ? null : (color === "#ffffff" ? "#000000" : color))}>
          ▣
        </button>

        {/* Opacity */}
        <input type="range" min={10} max={100} value={Math.round(opacity * 100)}
          onChange={(e) => setOpacity(parseInt(e.target.value, 10) / 100)}
          style={{ ...S.slider, width: 40 }} title={`Opacity: ${Math.round(opacity * 100)}%`} />

        <span style={{ flex: 1 }} />

        {/* Undo / Redo / Clear */}
        <button style={{ ...S.smallBtn, opacity: undoStack.length > 0 ? 1 : 0.3 }}
          disabled={undoStack.length === 0} onClick={undo}>↩</button>
        <button style={{ ...S.smallBtn, opacity: redoStack.length > 0 ? 1 : 0.3 }}
          disabled={redoStack.length === 0} onClick={redo}>↪</button>
        <button style={S.smallBtn} onClick={clearAll}>✕</button>

        <span style={{ width: 1, height: 16, background: "var(--border-medium)", margin: "0 2px" }} />

        <button style={{ ...S.smallBtn, color: "var(--accent)", fontWeight: 600 }}
          onClick={() => setEditing(false)}>完成</button>
      </div>
    </div>
  );
}

// ── Shape helpers ──

function buildShapePreview(
  tool: ToolType, x1: number, y1: number, x2: number, y2: number,
  color: string, strokeWidth: number, fillColor: string | null, opacity: number,
): DrawElement | null {
  switch (tool) {
    case "rect": return {
      id: "_preview", type: "rect",
      x: Math.min(x1, x2), y: Math.min(y1, y2),
      w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
      color, strokeWidth, fillColor, opacity,
    };
    case "circle": {
      const r = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
      return { id: "_preview", type: "circle", cx: x1, cy: y1, r, color, strokeWidth, fillColor, opacity };
    }
    case "line": return { id: "_preview", type: "line", x1, y1, x2, y2, color, strokeWidth, opacity };
    case "arrow": return { id: "_preview", type: "arrow", x1, y1, x2, y2, color, strokeWidth, opacity };
  }
  return null;
}

function buildShapeElement(
  tool: ToolType, x1: number, y1: number, x2: number, y2: number,
  color: string, strokeWidth: number, fillColor: string | null, opacity: number,
): DrawElement | null {
  switch (tool) {
    case "rect": return {
      id: uid(), type: "rect",
      x: Math.min(x1, x2), y: Math.min(y1, y2),
      w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
      color, strokeWidth, fillColor, opacity,
    };
    case "circle": {
      const r = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
      return { id: uid(), type: "circle", cx: x1, cy: y1, r, color, strokeWidth, fillColor, opacity };
    }
    case "line": return { id: uid(), type: "line", x1, y1, x2, y2, color, strokeWidth, opacity };
    case "arrow": return { id: uid(), type: "arrow", x1, y1, x2, y2, color, strokeWidth, opacity };
  }
  return null;
}
