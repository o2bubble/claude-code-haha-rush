// snapAnchor.ts — 锚点松手命中判定（纯函数，可单测）
import type { DesktopItem, ConnectionAnchor } from "../../types/desktop";
import { getAnchorPosition } from "./DesktopItemView";

export const ANCHOR_SNAP_SIDES: ConnectionAnchor["side"][] = ["top", "right", "bottom", "left"];

/**
 * 松手时寻找最近的可连锚点（canvas 坐标）。命中圈 ≈ 32px 屏幕（除以 zoom 即 canvas 单位），
 * 远大于锚点视觉尺寸(6px)，拖拽轻微偏移也能吸住。
 * 返回 null = 未命中任何锚点（松手即取消）。
 */
export const SNAP_CANVAS_PX = 32;

export function findSnapAnchor(
  items: DesktopItem[],
  fromItemId: string,
  mx: number,
  my: number,
  zoom: number
): { itemId: string; side: ConnectionAnchor["side"] } | null {
  const snap = SNAP_CANVAS_PX / zoom;
  let best: { itemId: string; side: ConnectionAnchor["side"]; dist: number } | null = null;
  for (const item of items) {
    if (item.id === fromItemId) continue;
    for (const side of ANCHOR_SNAP_SIDES) {
      const pos = getAnchorPosition(item, side);
      const ax = item.x + pos.x;
      const ay = item.y + pos.y;
      const dist = Math.hypot(mx - ax, my - ay);
      if (dist < snap && (best === null || dist < best.dist)) {
        best = { itemId: item.id, side, dist };
      }
    }
  }
  return best ? { itemId: best.itemId, side: best.side } : null;
}
