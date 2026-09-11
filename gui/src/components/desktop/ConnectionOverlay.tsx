import React, { memo, useState, useCallback } from "react";
import type { Connection, DesktopItem } from "../../types/desktop";
import { getAnchorPosition } from "./DesktopItemView";
import { removeConnection, updateConnection } from "../../stores/desktopStore";

interface Props {
  connections: Connection[];
  items: DesktopItem[];
  panX: number;
  panY: number;
  zoom: number;
}

/** Convert canvas coords → screen coords (matches rubber band canvas logic) */
function toScreen(x: number, y: number, panX: number, panY: number, zoom: number) {
  return { sx: x * zoom + panX, sy: y * zoom + panY };
}

function ConnectionOverlayImpl({ connections, items, panX, panY, zoom }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [labelEditing, setLabelEditing] = useState(false);

  // Find item by id
  const findItem = (id: string) => items.find((i) => i.id === id);

  // Compute bezier path in SCREEN coordinates
  const computePath = (conn: Connection): string | null => {
    const fromItem = findItem(conn.from.itemId);
    const toItem = findItem(conn.to.itemId);
    if (!fromItem || !toItem) return null;

    const fromPos = getAnchorPosition(fromItem, conn.from.side);
    const toPos = getAnchorPosition(toItem, conn.to.side);

    // Canvas coords
    const cx1 = fromItem.x + fromPos.x;
    const cy1 = fromItem.y + fromPos.y;
    const cx2 = toItem.x + toPos.x;
    const cy2 = toItem.y + toPos.y;

    // Control points (perpendicular to anchor side, same logic as store)
    const dist = Math.abs(cx2 - cx1) + Math.abs(cy2 - cy1);
    const ext = Math.max(30, dist * 0.3);

    let cp1x = cx1, cp1y = cy1, cp2x = cx2, cp2y = cy2;
    switch (conn.from.side) {
      case "top": cp1y -= ext; break;
      case "bottom": cp1y += ext; break;
      case "left": cp1x -= ext; break;
      case "right": cp1x += ext; break;
      default: break;
    }
    switch (conn.to.side) {
      case "top": cp2y -= ext; break;
      case "bottom": cp2y += ext; break;
      case "left": cp2x -= ext; break;
      case "right": cp2x += ext; break;
      default: break;
    }

    // Convert ALL points to screen coords
    const s1 = toScreen(cx1, cy1, panX, panY, zoom);
    const sc1 = toScreen(cp1x, cp1y, panX, panY, zoom);
    const sc2 = toScreen(cp2x, cp2y, panX, panY, zoom);
    const s2 = toScreen(cx2, cy2, panX, panY, zoom);

    return `M ${s1.sx} ${s1.sy} C ${sc1.sx} ${sc1.sy}, ${sc2.sx} ${sc2.sy}, ${s2.sx} ${s2.sy}`;
  };

  const handleClick = useCallback(
    (conn: Connection, e: React.MouseEvent) => {
      e.stopPropagation();
      setSelectedId(conn.id === selectedId ? null : conn.id);
    },
    [selectedId]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Delete" && selectedId) {
        removeConnection(selectedId);
        setSelectedId(null);
      }
      if (e.key === "Escape") {
        setSelectedId(null);
        setLabelEditing(false);
      }
    },
    [selectedId]
  );

  const startLabelEdit = (conn: Connection) => {
    setEditLabel(conn.label || "");
    setLabelEditing(true);
  };

  const commitLabelEdit = () => {
    if (selectedId) {
      updateConnection(selectedId, { label: editLabel || undefined });
    }
    setLabelEditing(false);
  };

  return (
    <svg
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 1,
        outline: "none",
      }}
    >
      {connections.map((conn) => {
        const d = computePath(conn);
        if (!d) return null;
        const isSelected = conn.id === selectedId;
        const color = conn.strokeColor || "#ff6b35";
        const width = conn.strokeWidth || 2.5;
        const dash = conn.strokeDasharray || "none";

        // Midpoint in screen coords
        const fromItem = findItem(conn.from.itemId);
        const toItem = findItem(conn.to.itemId);
        let midSx = 0, midSy = 0;
        if (fromItem && toItem) {
          const fp = getAnchorPosition(fromItem, conn.from.side);
          const tp = getAnchorPosition(toItem, conn.to.side);
          const mcx = (fromItem.x + fp.x + toItem.x + tp.x) / 2;
          const mcy = (fromItem.y + fp.y + toItem.y + tp.y) / 2;
          const ms = toScreen(mcx, mcy, panX, panY, zoom);
          midSx = ms.sx;
          midSy = ms.sy;
        }

        return (
          <g key={conn.id} data-connection={conn.id} style={{ pointerEvents: "auto" }}>
            {/* Invisible wider path for easier clicking */}
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={16}
              onClick={(e) => handleClick(conn, e)}
              style={{ cursor: "pointer" }}
            />
            {/* Visible path */}
            <path
              d={d}
              fill="none"
              stroke={isSelected ? "var(--accent)" : color}
              strokeWidth={isSelected ? width + 1 : width}
              strokeDasharray={isSelected ? "none" : dash}
              onClick={(e) => handleClick(conn, e)}
              style={{
                cursor: "pointer",
                transition: "stroke 0.15s, stroke-width 0.15s",
              }}
            />
            {/* Label at midpoint */}
            {labelEditing && isSelected ? (
              <foreignObject x={midSx - 50} y={midSy - 19} width={100} height={22}>
                <input
                  autoFocus
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  onBlur={commitLabelEdit}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") commitLabelEdit();
                    if (e.key === "Escape") { setLabelEditing(false); setSelectedId(null); }
                  }}
                  style={{ fontSize: 10, padding: "1px 4px", width: "100%", border: "1px solid var(--accent)" }}
                />
              </foreignObject>
            ) : (conn.label || isSelected) ? (
              <text
                x={midSx}
                y={midSy - 6}
                textAnchor="middle"
                fontSize={10}
                fill={isSelected ? "var(--accent)" : "var(--fg-muted)"}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isSelected) startLabelEdit(conn);
                }}
                style={{
                  cursor: isSelected ? "pointer" : "default",
                  userSelect: "none",
                  pointerEvents: isSelected ? "auto" : "none",
                }}
              >
                {conn.label || (isSelected ? "点击编辑标签" : "")}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
export const ConnectionOverlay = memo(ConnectionOverlayImpl);
