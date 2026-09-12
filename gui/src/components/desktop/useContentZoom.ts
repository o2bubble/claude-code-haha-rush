// ── 内容内部缩放（Ctrl/Cmd + 滚轮）—— 图片 / 图形块共用 ──
//
// 与画布缩放的分工（配合 SuperDesktopCanvas 的 wheel 守卫）：
//   裸滚轮         → 画布缩放（内容不接管）
//   Ctrl/Cmd+滚轮  → 内容内部缩放（画布对 [data-wheel-zoom] 让路）
// 这样"缩放画布"的手势在哪儿都一致，内容缩放用一个显式修饰键区分，
// 不需要"进入编辑模式"之类的额外状态。
//
// 用**原生监听**而非 React onWheel：React 把 wheel 挂在 root 上做被动监听，
// preventDefault 无效（画布侧同因，见 SuperDesktopCanvas 注释）——拦不住
// webview 自身的 Ctrl+滚轮页面缩放。
//
// 两条易错点：
//  1. ref 必须挂在**未被 transform 的元素**上 —— getBoundingClientRect 含变换，
//     挂在被缩放的节点上会让光标锚点换算随缩放漂移。
//  2. 平移用内容区拖拽：item 拖拽只从标题栏触发（DesktopItemView 的
//     handleTitleMouseDown），内容区是自由的，不会打架。
//
// 复位：双击（外加消费方可显示角标）。

import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";

export interface ContentZoom {
  zoom: number;
  pan: { x: number; y: number };
  isZoomed: boolean;
  cursor: "default" | "grab" | "grabbing";
  /** **callback ref**：绑到内容容器（`<div ref={cz.ref}>`；SVG 需与自有 ref 组合）。
   *  不用 RefObject 是因为容器常**条件渲染/异步出现**（如图片先显示"加载中"，
   *  dataUrl 到位后才渲染真正的容器）——RefObject + useEffect(依赖 ref) 会在首次
   *  渲染时空跑，之后永不重绑，缩放静默失效。callback ref 在挂载/卸载时自动重跑。 */
  ref: (el: Element | null) => void;
  /** 绑到容器的 onMouseDown（放大后才平移） */
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  reset: () => void;
  /** 直接设定缩放并清空平移（供 Fit / 1:1 这类按钮用）。
   *  清平移是因为这两个动作都期望"居中看整图"，保留旧偏移会让人找不着图。 */
  zoomTo: (z: number) => void;
  /** div 用：transform + 原点 */
  style: React.CSSProperties;
  /** SVG `<g>` 用：transform 属性值 */
  svgTransform: string;
}

export function useContentZoom(
  opts: {
    min?: number;
    max?: number;
    /** 未放大时也允许拖拽平移。结构化图形需要（内容可能超出固定视口）；
     *  图片/Mermaid 不需要（内容自适应缩放，1x 时没有可平移的余量）。 */
    panAlways?: boolean;
    /** 需要修饰键才缩放（默认 true）。true = Ctrl/Cmd+滚轮，用于**画布内嵌内容**
     *  （裸滚轮要留给画布）；false = 裸滚轮直接缩放，用于**独立的查看器面板**——
     *  那里没有外层画布，裸滚轮才符合图片查看器的习惯。 */
    requireCtrl?: boolean;
  } = {},
): ContentZoom {
  const min = opts.min ?? 0.2;
  const max = opts.max ?? 8;
  const panAlways = opts.panAlways ?? false;
  const requireCtrl = opts.requireCtrl ?? true;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  // 容器元素（callback ref 写入）——state 而非 ref：挂载后要触发下面的 effect 绑定
  const [el, setEl] = useState<Element | null>(null);

  // 事件回调里读最新值（避免把它们塞进依赖导致监听反复重建）
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const panRef = useRef(pan); panRef.current = pan;
  const dragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);

  useEffect(() => {
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (requireCtrl && !(e.ctrlKey || e.metaKey)) return; // 裸滚轮留给画布
      e.preventDefault();                    // 拦 webview 页面缩放
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setZoom((z) => {
        const nz = Math.min(max, Math.max(min, z * factor));
        if (nz === z) return z;
        // 光标锚定：让光标下的点在缩放前后停在原地
        setPan((p) => ({ x: mx - (mx - p.x) * (nz / z), y: my - (my - p.y) * (nz / z) }));
        return nz;
      });
    };
    // el 可能是 HTMLElement 或 SVGSVGElement（结构化图形），两者都支持 wheel；
    // Element 的事件表类型不含 wheel，故显式断言 EventListener
    const listener = onWheel as EventListener;
    el.addEventListener("wheel", listener, { passive: false });
    return () => el.removeEventListener("wheel", listener);
  }, [el, min, max, requireCtrl]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // 未放大时默认不平移（图片/Mermaid 没有可平移余量，且会吃掉点击）
    if (e.button !== 0 || (!panAlways && zoomRef.current === 1)) return;
    e.preventDefault();
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: panRef.current.x, py: panRef.current.y };
    setDragging(true);
  }, [panAlways]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPan({ x: d.px + (e.clientX - d.sx), y: d.py + (e.clientY - d.sy) });
    };
    const onUp = () => { dragRef.current = null; setDragging(false); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  const reset = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);
  const zoomTo = useCallback((z: number) => {
    setZoom(Math.min(max, Math.max(min, z)));
    setPan({ x: 0, y: 0 });
  }, [min, max]);

  return {
    zoom,
    pan,
    isZoomed: zoom !== 1,
    cursor: dragging ? "grabbing" : (zoom !== 1 || panAlways) ? "grab" : "default",
    ref: setEl,
    onMouseDown,
    onDoubleClick: reset,
    reset,
    zoomTo,
    style: { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" },
    svgTransform: `translate(${pan.x},${pan.y}) scale(${zoom})`,
  };
}
