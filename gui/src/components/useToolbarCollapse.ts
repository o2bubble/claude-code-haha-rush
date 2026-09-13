// ── 工具栏响应式折叠 ──
//
// 窗口变窄时按优先级把低频项折叠进应用菜单（顺序约定见 toolbarItems.ts）。
// **不持久化** —— 响应式适配而非用户偏好，窗口拉宽应自动展开。
//
// ## 测量方式
//
// 内容分两类：
//   · **数组项** —— 由 `items` 渲染，可折叠（带 `data-toolbar-item=<id>`）
//   · **固定项** —— 直接写在 JSX 里的下拉/窗口按钮/分隔线等（带其他
//     `data-toolbar-item` 值，或完全没有该属性），不可折叠
//
// 可用宽度 = 容器宽 - 固定项总宽。然后在数组项里，从**尾部**保留 kept 个，
// 看总宽是否放得下。
//
// 为什么必须实测而不是估算：按钮宽度差异大（图标按钮 ~28px，工作区按钮带
// 文字最多 175px，新实例按钮带标签），按平均值必然算错。
//
// 为什么 `flexShrink: 0` 是前提：见 Toolbar 的 TOOLBAR_BTN_BASE 注释 ——
// 按钮被压缩后测出的宽度是**压缩后**的，会让算法低估需求、该折不折。
//
// 为什么 `overflow: hidden` 是前提：容器 overflow 可见时 clientWidth 仍等于
// 可视宽、但内容会溢出到容器外，`scrollWidth` 才反映真实内容宽。这里用
// 「子元素宽度累加」判断，不依赖 scrollWidth —— 更直接，且对 flex gap 透明。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { computeCollapsed, type ToolbarItem } from "./toolbarItems";

/** resize 防抖（ms）。拖动窗口时每像素都会触发，不防抖会每帧多次强制重排。 */
const RESIZE_DEBOUNCE_MS = 80;
/** 单项之间 gap（与 TOOLBAR_CONTAINER 的 gap 一致）。 */
const ITEM_GAP = 4;
/** 从未渲染过的项（如刚被折叠又拉宽）：保守估计宽度。 */
const FALLBACK_ITEM_WIDTH = 30;

/**
 * 集合内容是否相同 —— 用于避免 setState 产生新引用触发无限重渲染。
 *
 * ⚠️ 这是防「Maximum update depth exceeded」的关键：`new Set()` 每次都是
 * 新引用，若无条件 setState，就会 setState → 重渲染 → 测量 → setState 死循环。
 * 导出供单测（回归防护）。
 */
export function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export function useToolbarCollapse(items: ToolbarItem[]): {
  containerRef: React.RefObject<HTMLDivElement>;
  collapsed: Set<string>;
} {
  const containerRef = useRef<HTMLDivElement>(null!);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 实测宽度缓存：itemId / 固定元素标记 → width(px)。 */
  const widthCache = useRef<Map<string, number>>(new Map());

  const itemsRef = useRef(items);
  itemsRef.current = items;

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    // 1. 量所有已渲染子元素的宽度并缓存。
    //    能折叠的数组项 id 集合，用于区分「固定项」（下拉/窗口按钮/分隔线…）。
    const collapsibleIds = new Set(
      itemsRef.current.filter((it) => !it.inMenuByDefault).map((it) => it.id),
    );
    let fixedWidth = 0;
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const key = child.dataset.toolbarItem;
      const w = child.getBoundingClientRect().width;
      if (key) widthCache.current.set(key, w);
      // 固定项 = 不属于可折叠数组项的渲染结果
      if (!key || !collapsibleIds.has(key)) fixedWidth += w + ITEM_GAP;
    }

    const available = el.clientWidth - fixedWidth;
    const widthOf = (it: ToolbarItem): number =>
      widthCache.current.get(it.id) ?? FALLBACK_ITEM_WIDTH;

    const fits = (kept: number): boolean => {
      const collapsible = itemsRef.current.filter(
        (it) => !it.alwaysVisible && !it.inMenuByDefault,
      );
      // computeCollapsed 的约定：保留数组**尾部**的 kept 个
      const keptItems = collapsible.slice(collapsible.length - kept);
      let need = 0;
      for (const it of keptItems) need += widthOf(it) + ITEM_GAP;
      return need <= available;
    };

    // ⚠️ 只在内容真的变化时 setState（否则死循环，见 sameSet 注释）
    const next = computeCollapsed(itemsRef.current, fits);
    setCollapsed((prev) => (sameSet(prev, next) ? prev : next));
  }, []);

  // 首帧用 layout effect：绘制前完成测量与折叠决策，避免「先溢出再折叠」的闪动。
  useLayoutEffect(() => {
    measure();
  }, [measure, items]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const schedule = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(measure, RESIZE_DEBOUNCE_MS);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [measure]);

  return { containerRef, collapsed };
}
