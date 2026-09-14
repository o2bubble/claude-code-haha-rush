// ── 下拉弹层横向对齐 ──
//
// 弹层默认贴按钮左缘向右展开（`left: 0`）。按钮靠右时弹层会伸出视口右边界
// 被裁切（实测：布局预设的预览网格 ~500px 宽，按钮在工具栏偏右必然出界）。
//
// 做法：打开时量按钮位置与弹层宽度，放不下就翻到左侧（`right: 0`）。
// 只在**打开的那一刻**算一次 —— 弹层打开期间窗口若被缩放，用 ResizeObserver
// 之外的手段处理不值得（用户很少在弹层开着时拖窗口，且下次打开即修正）。
//
// 为什么不用 `position: fixed` + 手动坐标：现有弹层依赖父级的 `position:
// relative` 定位，改 fixed 要重算 top/left 且窗口滚动/缩放时失效 —— 改动面大
// 且引入新问题。只切 left/right 锚点是最小改动。

import { useCallback, useEffect, useLayoutEffect, useState } from "react";

/** 弹层与视口边缘的最小留白（px）。 */
export const EDGE_MARGIN = 8;

export type DropdownAlign =
  | { left: 0; right?: undefined }
  | { right: 0; left?: undefined };

/**
 * 决定弹层往哪边展开。
 *
 * 优先向右（贴按钮左缘）；右边放不下且左边放得下 → 翻左。
 * **两边都放不下时不翻**（翻也没用，一样裁切）—— 保持向右，靠弹层自身的
 * `maxWidth` 收缩（见 dropdownMaxWidth）。这是布局预设那种宽弹层的情况：
 * 520px 的弹层在窄窗口里无论朝哪边都超界，唯一出路是限宽。
 *
 * @param rectLeft  触发按钮容器左缘（视口坐标）
 * @param rectRight 触发按钮容器右缘
 * @param menuWidth 弹层**估算**宽度。估不准时宁大勿小。
 * @param viewportW 视口宽度
 */
export function pickDropdownAlign(
  rectLeft: number,
  rectRight: number,
  menuWidth: number,
  viewportW: number,
  edgeMargin: number = EDGE_MARGIN,
): DropdownAlign {
  const fitsRight = rectLeft + menuWidth + edgeMargin <= viewportW;
  if (fitsRight) return { left: 0 };
  const fitsLeft = rectRight - menuWidth >= edgeMargin;
  if (fitsLeft) return { right: 0 };
  // 两边都放不下 → 保持向右，由 maxWidth 收缩
  return { left: 0 };
}

/**
 * 弹层的限宽值 —— 无论朝哪边展开，都不许超出视口。
 * 用 `min(估算宽度, 视口宽 - 两侧留白)`：宽弹层在窄窗口里收缩，
 * 而不是被裁切。
 */
export function dropdownMaxWidth(menuWidth: number, viewportW: number): number {
  return Math.min(menuWidth, viewportW - EDGE_MARGIN * 2);
}

/**
 * @param triggerRef 触发按钮的容器（`position: relative` 的那个）
 * @param menuWidth  弹层的**估算**宽度（px）
 * @param open       弹层是否打开（关闭时不测量）
 */
export function useDropdownAlign(
  triggerRef: React.RefObject<HTMLElement | null>,
  menuWidth: number,
  open: boolean,
): { align: DropdownAlign; maxWidth: number } {
  const [state, setState] = useState(() => ({
    align: { left: 0 } as DropdownAlign,
    maxWidth: menuWidth,
  }));

  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const viewportW = typeof window !== "undefined" ? window.innerWidth : 1200;
    const next = {
      align: pickDropdownAlign(rect.left, rect.right, menuWidth, viewportW),
      maxWidth: dropdownMaxWidth(menuWidth, viewportW),
    };
    // 内容相同则保留旧引用，避免 setState → 重渲染 → 测量 的循环
    setState((prev) =>
      prev.align.left === next.align.left && prev.maxWidth === next.maxWidth ? prev : next,
    );
  }, [triggerRef, menuWidth]);

  // layout effect：绘制前定好方向，避免"先向右渲染一帧再翻左"的闪动
  useLayoutEffect(() => {
    if (!open) return;
    measure();
  }, [open, measure]);

  // 窗口缩放时重算（弹层开着时拖窄窗口）
  useEffect(() => {
    if (!open) return;
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, measure]);

  return state;
}
