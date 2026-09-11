// ── 消息划词工具栏 · 定位纯函数 ──
// 无 DOM 依赖，纯几何计算：选区 rect + 视口 → 工具栏 {top, left}（viewport 坐标）。
// 规则：横向右对齐选区末尾并夹紧到视口；纵向优先选区下方，放不下翻到上方，再夹紧。

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
  bottom: number;
  right: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  top: number;
  left: number;
}

/** 工具栏外廓（用于夹紧/翻转估算），与 SelectionToolbar 实际尺寸相近即可 */
export const POPUP_SIZE: Size = { width: 180, height: 36 };

const MARGIN = 8;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function computeToolbarPosition(sel: Rect, viewport: Size, popup: Size = POPUP_SIZE): Point {
  let left = sel.right - popup.width;
  left = clamp(left, MARGIN, Math.max(MARGIN, viewport.width - popup.width - MARGIN));

  let top = sel.bottom + MARGIN;
  const belowSpace = viewport.height - (sel.bottom + MARGIN);
  if (belowSpace < popup.height + MARGIN) {
    top = sel.top - popup.height - MARGIN;
  }
  top = clamp(top, MARGIN, Math.max(MARGIN, viewport.height - popup.height - MARGIN));

  return { top, left };
}
