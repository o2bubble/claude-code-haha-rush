/**
 * Compute a lightweight AI-facing summary of desktop state.
 * Excludes ItemContent payloads — agents read the summary first,
 * then query specific items via getDesktopItem(id) on demand.
 */

import type { Desktop, DesktopSummary, DesktopItemSummary } from "../types/desktop";
import { getDesktops, getActiveDesktopId } from "../stores/desktopStore";
import { getSelectedIds } from "../components/desktop/selectionStore";

export interface ComputeOptions {
  /** Viewport width in pixels (container element). Default 800. */
  viewportW?: number;
  /** Viewport height in pixels (container element). Default 600. */
  viewportH?: number;
}

/**
 * Build a summary of all desktops + the active desktop's items.
 * Uses default viewport size if not provided (caller should pass
 * actual container dimensions for accurate screenX/screenY/visible).
 */
export function computeDesktopSummary(options?: ComputeOptions): DesktopSummary {
  const vw = options?.viewportW ?? 800;
  const vh = options?.viewportH ?? 600;
  const desktops = getDesktops();
  const activeId = getActiveDesktopId();
  const active = activeId ? desktops.find((d) => d.id === activeId) : undefined;
  const selectedIds = getSelectedIds();

  const desktopList = desktops.map((d) => ({
    id: d.id,
    name: d.name,
    itemCount: d.items.length,
  }));

  let items: DesktopItemSummary[] = [];
  let connections: Desktop["connections"] = [];

  if (active) {
    for (const item of active.items) {
      const sx = item.x * active.zoom + active.panX;
      const sy = item.y * active.zoom + active.panY;
      const sRight = (item.x + item.width) * active.zoom + active.panX;
      const sBottom = (item.y + item.height) * active.zoom + active.panY;

      let visible: "full" | "partial" | "none";
      const offLeft = sRight < 0;
      const offTop = sBottom < 0;
      const offRight = sx > vw;
      const offBottom = sy > vh;
      if (offLeft || offTop || offRight || offBottom) {
        visible = "none";
      } else if (sx >= 0 && sy >= 0 && sRight <= vw && sBottom <= vh) {
        visible = "full";
      } else {
        visible = "partial";
      }

      items.push({
        id: item.id,
        type: item.content.type,
        label: item.label,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        zIndex: item.zIndex,
        screenX: Math.round(sx),
        screenY: Math.round(sy),
        visible,
        selected: selectedIds.has(item.id),
      });
    }

    connections = active.connections;
  }

  return {
    desktops: desktopList,
    activeId: activeId ?? "",
    activeDesktop: {
      viewport: active
        ? { panX: active.panX, panY: active.panY, zoom: active.zoom }
        : { panX: 0, panY: 0, zoom: 1 },
      items,
      connections,
    },
  };
}
