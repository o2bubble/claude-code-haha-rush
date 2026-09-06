import React, { useRef, useCallback, useState, useEffect, useLayoutEffect } from "react";
import { GripVertical, Split as SplitIcon, PictureInPicture2, X, MoreHorizontal, ChevronsLeftRight, ChevronsUpDown, Check } from "lucide-react";
import type { LayoutNode, SplitNode, TabGroup as TabGroupType, FloatingWindow } from "../types/layout";
import type { ContextMenuItem } from "./ContextMenu";
import { showCtxMenu } from "./ContextMenu";
import { t } from "../i18n";
import { getPanel, resolveTabRender } from "../stores/panelRegistry";
import { getTree, updateSizes, setActiveTab, addTab, removeTab, splitGroup, setActiveChild, mergeIntoTab, removeChildFromCompound, ensureGroupVisible, moveTab, moveChild, moveChildBetweenTabs, findGroup, setTabIcon, splitGroupEmpty, closeGroup, hideGroup, toggleGroupCollapse, PINNED_GROUPS, getFloatingPanels, removeTabFromFloating, removeChildFromFloatingTab, createFloatingFromTab, createTauriWindowFromTab, dissolveCompoundGroup } from "../stores/layoutStore";
import { useEventHandler } from "../services/useService";
import { Events, type LayoutTreeChangedPayload, type PanelRegistryChangedPayload } from "../services/events";
import type { Visibility } from "../types/layout";
import type { TabInstance } from "../types/layout";
import { GROUP_ICON_POOL, iconFor } from "../utils/icons";
import { layoutMode } from "../stores/layoutMode";

// ── 布局模式样式（绿色身份色，组件内一次性注入，不改 tokens.css） ──

let lmStylesInjected = false;
function ensureLayoutModeStyles() {
  if (lmStylesInjected) return;
  lmStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.lm-root { --lm-accent: oklch(0.56 0.15 150); --lm-accent-strong: oklch(0.48 0.17 150); --lm-accent-soft: oklch(0.56 0.15 150 / 0.14); --lm-bar-bg: oklch(0.56 0.15 150 / 0.08); }
[data-theme="dark"] .lm-root { --lm-accent: oklch(0.72 0.14 150); --lm-accent-strong: oklch(0.78 0.12 150); --lm-accent-soft: oklch(0.72 0.14 150 / 0.18); --lm-bar-bg: oklch(0.72 0.14 150 / 0.12); }

.lm-root.lm-on .lm-block { outline: 1.5px solid var(--lm-accent-soft); outline-offset: -1.5px; }
.lm-root.lm-on .lm-block.dragging { outline: 2px solid var(--lm-accent); box-shadow: var(--shadow-lg); z-index: 30; }

.lm-chip { position: absolute; top: 6px; right: 6px; z-index: 40; display: flex; align-items: center; gap: 1px; padding: 2px; background: var(--lm-accent); border-radius: 7px; box-shadow: var(--shadow-md); }
.lm-chip-btn { width: 24px; height: 24px; border: none; background: transparent; color: var(--fg-inverse); cursor: pointer; display: grid; place-items: center; border-radius: 4px; padding: 0; }
.lm-chip-btn:hover { background: rgba(255, 255, 255, 0.22); }
.lm-chip-btn svg { width: 13px; height: 13px; }
.lm-pop { position: absolute; top: calc(100% + 4px); left: 6px; z-index: 45; min-width: 140px; background: var(--bg-surface); border: 1px solid var(--border-light); border-radius: 8px; box-shadow: var(--shadow-md); padding: 4px; display: flex; flex-direction: column; }
.lm-pop-right { left: auto; right: 6px; }
.lm-pop-it { display: flex; align-items: center; gap: 6px; padding: 6px 9px; border: none; background: transparent; font-family: inherit; font-size: 11.5px; color: var(--fg-primary); cursor: pointer; border-radius: 5px; text-align: left; white-space: nowrap; }
.lm-pop-it:hover { background: var(--lm-accent-soft); color: var(--lm-accent); }
.lm-pop-it:disabled { opacity: 0.5; cursor: default; }

.lm-divider { position: relative; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.lm-divider.v { width: 8px; height: 100%; cursor: col-resize; }
.lm-divider.h { height: 8px; width: 100%; cursor: row-resize; }
.lm-divider .lm-line { display: block; background: var(--border-light); border-radius: 2px; transition: background-color .15s ease; }
.lm-divider.v .lm-line { width: 3px; height: 100%; }
.lm-divider.h .lm-line { height: 3px; width: 100%; }
.lm-divider:hover .lm-line { background: var(--border-focus); }
.lm-grip { display: none; position: absolute; background: var(--bg-surface); border: 1px solid var(--border-light); color: var(--lm-accent); align-items: center; justify-content: center; box-shadow: var(--shadow-sm); z-index: 12; }
.lm-divider.v .lm-grip { width: 14px; height: 34px; border-radius: 6px; }
.lm-divider.h .lm-grip { width: 34px; height: 14px; border-radius: 6px; }
.lm-grip svg { width: 12px; height: 12px; }
.lm-root.lm-on .lm-divider.v { width: 12px; }
.lm-root.lm-on .lm-divider.h { height: 12px; }
.lm-root.lm-on .lm-divider .lm-line { background: var(--lm-accent-soft); }
.lm-root.lm-on .lm-divider:hover .lm-line { background: var(--lm-accent); }
.lm-root.lm-on .lm-grip { display: flex; }
.lm-root.lm-on .lm-divider:hover .lm-grip { border-color: var(--lm-accent); box-shadow: var(--shadow-md); }

.lm-banner { display: none; align-items: center; gap: 8px; padding: 6px 12px; background: var(--lm-bar-bg); border-bottom: 1px solid var(--lm-accent-soft); color: var(--lm-accent); font-size: 12px; font-weight: 600; flex-shrink: 0; }
.lm-root.lm-on .lm-banner { display: flex; }
.lm-banner .hint { font-weight: 400; color: var(--fg-secondary); }
.lm-banner .key { font-family: var(--font-mono); font-size: 10px; border: 1px solid var(--lm-accent-soft); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; }

.lm-exit { display: none; position: fixed; right: 24px; bottom: 24px; z-index: 1000; align-items: center; gap: 8px; height: 40px; padding: 0 18px; border: none; border-radius: 20px; background: var(--lm-accent); color: var(--fg-inverse); font-family: inherit; font-size: 13px; font-weight: 650; cursor: pointer; box-shadow: var(--shadow-lg); transition: filter .14s ease, transform .14s ease; }
.lm-root.lm-on .lm-exit { display: inline-flex; }
.lm-exit:hover { filter: brightness(1.08); transform: translateY(-1px); }
.lm-exit svg { width: 15px; height: 15px; }

@media (prefers-reduced-motion: reduce) { .lm-exit, .lm-chip, .lm-divider .lm-line, .lm-grip { transition: none; } }
`;
  document.head.appendChild(style);
}

// ── Module-level static styles ──

const TAB_BAR = {
  display: "flex",
  alignItems: "center",
  height: 28,
  borderBottom: "1px solid var(--border-medium)",
  flexShrink: 0,
  overflow: "hidden",
  transition: "background-color 0.1s",
} as const;

const TAB_ITEM_BASE = {
  display: "flex",
  alignItems: "center",
  padding: "0 10px",
  height: "100%",
  cursor: "grab",
  fontSize: 11,
  fontFamily: "var(--font-sans)",
  gap: 4,
  userSelect: "none",
  whiteSpace: "nowrap",
} as const;

const CMP_TAB_ITEM_BASE = {
  display: "flex", alignItems: "center", padding: "0 10px", height: "100%",
  cursor: "grab", fontSize: 11, fontFamily: "var(--font-sans)",
  gap: 4, userSelect: "none", whiteSpace: "nowrap",
} as const;

const CMP_TAB_BAR = {
  display: "flex", height: 28,
  borderBottom: "1px solid var(--border-medium)", flexShrink: 0, overflow: "hidden",
  transition: "background-color 0.15s",
} as const;

const CONTENT_AREA = {
  flex: 1, overflow: "auto", minHeight: 0, position: "relative",
} as const;

const EMPTY_GROUP = {
  display: "flex", alignItems: "center", justifyContent: "center",
  height: "100%", color: "var(--fg-muted)", fontSize: 12,
  fontFamily: "var(--font-sans)",
} as const;

const SPLIT_CONTAINER = {
  display: "flex",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
} as const;

const ICON_BTN_BASE = {
  width: 36, height: 36, display: "flex", alignItems: "center",
  justifyContent: "center", cursor: "grab", borderRadius: 4, position: "relative",
  flexShrink: 0, // 空间不足时缩小自身，不压缩间距（溢出交给 … 菜单）
} as const;

const ROOT_EDGE_BADGE_BASE = {
  position: "absolute",
  width: 40,
  height: 40,
  borderRadius: "50%",
  backgroundColor: "rgba(0,122,204,0.18)",
  boxShadow: "0 0 18px rgba(0,122,204,0.25), 0 0 4px rgba(0,122,204,0.35)",
  zIndex: 9998,
  pointerEvents: "none",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
} as const;

const ROOT_EDGE_ARROW = {
  color: "rgba(0,122,204,0.9)",
  fontSize: 20,
  fontFamily: "var(--font-sans)",
  fontWeight: 700,
  pointerEvents: "none",
  lineHeight: 1,
} as const;

const WRAPPER_STYLE = {
  display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", minWidth: 0, minHeight: 0, position: "relative",
} as const;

const GROUP_DEFAULT = {
  display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0,
  position: "relative",
} as const;

const ICON_BAR_BASE = {
  display: "flex", alignItems: "center", paddingTop: 4, gap: 2,
  flexShrink: 0,
  transition: "background-color 0.1s",
} as const;

// (props intentionally empty — the renderer reads layout/panel state from stores)

// ── Resize hook（DOM 直写 + RAF，松手同步，保证 60fps） ──

function useSplitResize(
  splitId: string,
  dividerIndex: number,
  containerRef: React.RefObject<HTMLDivElement | null>,
  direction: "horizontal" | "vertical",
  childRefs: React.MutableRefObject<(HTMLDivElement | null)[]>,
) {
  const stateRef = useRef({
    totalSize: 0,
    startPos: 0,
    initialPx: [] as number[],
    rafId: 0,
  });

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const container = containerRef.current;
    if (!container) return;

    const totalSize = direction === "horizontal" ? container.offsetWidth : container.offsetHeight;
    if (totalSize <= 0) return;

    const tree = getTree();
    const findSplit = (n: LayoutNode): SplitNode | null => {
      if (n.type === "split" && n.id === splitId) return n;
      if (n.type === "split") {
        for (const c of n.children) { const f = findSplit(c); if (f) return f; }
      }
      return null;
    };
    const split = findSplit(tree);
    if (!split) return;

    const elA = childRefs.current[dividerIndex];
    const elB = childRefs.current[dividerIndex + 1];
    if (!elA || !elB) return;

    // 从 DOM 实际尺寸算初始值（比 store 百分比反算更准）
    const allEls = childRefs.current.filter(Boolean) as HTMLDivElement[];
    const initialPx = allEls.map((el) =>
      direction === "horizontal" ? el.offsetWidth : el.offsetHeight
    );

    const st = stateRef.current;
    st.totalSize = initialPx.reduce((a, b) => a + b, 0);
    st.startPos = direction === "horizontal" ? e.clientX : e.clientY;
    st.initialPx = initialPx;

    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    // 保存原始 sizes（包含隐藏节点），用于松手时恢复完整数组
    const originalSizes = split.sizes;

    function onMove(ev: MouseEvent) {
      if (st.rafId) return;
      st.rafId = requestAnimationFrame(() => {
        st.rafId = 0;
        const currentPos = direction === "horizontal" ? ev.clientX : ev.clientY;
        const delta = currentPos - st.startPos;

        const px = [...st.initialPx];
        px[dividerIndex] = Math.max(80, px[dividerIndex] + delta);
        px[dividerIndex + 1] = Math.max(80, px[dividerIndex + 1] - delta);

        const newTotal = px.reduce((a, b) => a + b, 0);
        allEls.forEach((el, i) => {
          el.style.flex = `0 0 ${((px[i] / newTotal) * 100).toFixed(2)}%`;
        });
      });
    }

    function onUp() {
      if (st.rafId) {
        cancelAnimationFrame(st.rafId);
        st.rafId = 0;
      }
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = prevUserSelect;

      // 用 DOM 最终尺寸反算百分比，填充回完整的 sizes（含隐藏节点）
      const finalPx = allEls.map((el) =>
        direction === "horizontal" ? el.offsetWidth : el.offsetHeight
      );
      const total = finalPx.reduce((a, b) => a + b, 0);
      if (total > 0) {
        let vi = 0;
        const fullSizes = originalSizes.map((orig) => {
          if (orig <= 0) return 0;
          return (finalPx[vi++] / total) * 100;
        });
        updateSizes(splitId, fullSizes);
      }
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp, { once: true });
  }, [splitId, dividerIndex, containerRef, direction]);

  return { onMouseDown };
}

// ── Split 节点 ──

function getVis(child: LayoutNode): Visibility {
  if (child.type !== "group") return "expanded";
  return child.visibility || "expanded";
}

function SplitView({ node }: { node: SplitNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const childRefs = useRef<(HTMLDivElement | null)[]>([]);
  const isHoriz = node.direction === "horizontal";

  childRefs.current = node.children.map((_, i) => childRefs.current[i] ?? null);

  return (
    <div
      ref={containerRef}
      style={{
        ...SPLIT_CONTAINER,
        flexDirection: isHoriz ? "row" : "column",
      }}
    >
      {(() => {
      const anyCollapsed = node.children.some(c => getVis(c) === "collapsed");
      // Find the "center" panel (largest) to give freed space when collapsed
      let centerIdx = 0;
      if (anyCollapsed) {
        let maxS = 0;
        node.children.forEach((c, i) => {
          if (getVis(c) !== "collapsed" && node.sizes[i] > maxS) { maxS = node.sizes[i]; centerIdx = i; }
        });
      }
      // Normalize visible sizes to 100% when some children are hidden
      const visibleTotal = node.children.reduce((sum, c, i) =>
        getVis(c) !== "hidden" ? sum + node.sizes[i] : sum, 0
      );
      return node.children.map((child, i) => {
        const size = node.sizes[i];
        const isLast = i === node.children.length - 1;
        const vis = getVis(child);
        const collapsed = vis === "collapsed";

        if (vis === "hidden") return null;

        const nextSize = node.sizes[i + 1] ?? 0;
        // 折叠组后面仍渲染分隔条（可拖），不再因 collapsed 隐藏——否则折叠后兄弟面板
        // 在该 split 内失去唯一可拖手柄（如 sidebar-left 折叠后快捷提示无法调整）。
        // 隐藏(display:none)由上方 vis==="hidden" return null 处理。
        const showDivider = !isLast && size > 0 && nextSize > 0;
        const normPct = visibleTotal > 0 ? (size / visibleTotal * 100) : size;

        return (
          <React.Fragment key={child.type === "group" ? child.id : (child as SplitNode).id}>
            <div
              ref={(el) => { childRefs.current[i] = el; }}
              style={collapsed
                ? { flex: "0 0 auto", overflow: "hidden", display: "flex" }
                : (size <= 0
                    ? { display: "none" }
                    : {
                        // Only the center panel grows to fill freed space when collapsed
                        flex: anyCollapsed && i === centerIdx
                          ? `1 1 ${normPct.toFixed(1)}%`
                          : `0 1 ${normPct.toFixed(1)}%`,
                        overflow: "hidden",
                        display: "flex",
                        minWidth: 0,
                        minHeight: 0,
                      })
              }
            >
              <LayoutNodeView node={child} />
            </div>
            {showDivider && (
              <ResizeDivider
                splitId={node.id}
                dividerIndex={i}
                containerRef={containerRef}
                direction={node.direction}
                childRefs={childRefs}
              />
            )}
          </React.Fragment>
        );
      });
      })()}
    </div>
  );
}

// ── 分割线 ──

function ResizeDivider({
  splitId,
  dividerIndex,
  containerRef,
  direction,
  childRefs,
}: {
  splitId: string;
  dividerIndex: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  direction: "horizontal" | "vertical";
  childRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
}) {
  const resize = useSplitResize(splitId, dividerIndex, containerRef, direction, childRefs);
  const isHoriz = direction === "horizontal";

  return (
    <div
      className={"lm-divider " + (isHoriz ? "v" : "h")}
      style={{ zIndex: 10 }}
      {...resize}
    >
      <span className="lm-line" />
      <span className="lm-grip">{isHoriz ? <ChevronsLeftRight size={12} /> : <ChevronsUpDown size={12} />}</span>
    </div>
  );
}

// ── 拖拽状态（模块级，5px 阈值 + 全局 mousemove 启动） ──

interface DragState {
  active: boolean;
  sourceGroupId: string;
  sourceFloatingId: string | null; // 从浮窗拖拽时的浮窗 id
  tab: TabInstance | null;
  ghostEl: HTMLDivElement | null;
  startX: number;
  startY: number;
  compoundParentId: string | null; // 复合组子标签拖拽时的父 tab id
}
const DRAG_THRESHOLD = 5;
const dragState: DragState = { active: false, sourceGroupId: "", sourceFloatingId: null, tab: null, ghostEl: null, startX: 0, startY: 0, compoundParentId: null };

// 拖拽状态订阅（供 LayoutRenderer 响应 hiddenDuringDrag）
const dragStateListeners = new Set<() => void>();
function notifyDragStateChange() { dragStateListeners.forEach(fn => fn()); }
export function subscribeDragState(fn: () => void) { dragStateListeners.add(fn); return () => { dragStateListeners.delete(fn); }; }

export function prepareDrag(groupId: string, tab: TabInstance, x: number, y: number, compoundParentId?: string, sourceFloatingId?: string) {
  dragDidStart = false;
  dragState.sourceGroupId = groupId;
  dragState.sourceFloatingId = sourceFloatingId ?? null;
  dragState.tab = tab;
  dragState.startX = x;
  dragState.startY = y;
  dragState.compoundParentId = compoundParentId ?? null;
}

let dragDidStart = false; // onClick 用，防止拖拽误触发 tab 切换
const dragDisabledElements: HTMLElement[] = []; // 拖拽时暂禁用的元素，endDrag 时精确恢复

function startDragIfMoved(x: number, y: number) {
  if (dragState.active) return;
  if (!dragState.tab) return;
  const dx = Math.abs(x - dragState.startX);
  const dy = Math.abs(y - dragState.startY);
  if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return;
  dragState.active = true;
  dragDidStart = true;
  notifyDragStateChange();

  // 全局禁用选中 + 交互
  const root = document.getElementById("root");
  if (root) {
    root.style.userSelect = "none";
    const panels = root.querySelectorAll('[style*="overflow: auto"]');
    panels.forEach((el) => {
      (el as HTMLElement).style.pointerEvents = "none";
      dragDisabledElements.push(el as HTMLElement);
    });
    // 也禁用浮窗 pointer-events，让 elementFromPoint 穿透
    const floatings = document.querySelectorAll('[data-floating-id]');
    floatings.forEach((el) => {
      (el as HTMLElement).style.pointerEvents = "none";
      dragDisabledElements.push(el as HTMLElement);
    });
  }
  const ghost = document.createElement("div");
  ghost.style.cssText =
    "position:fixed;z-index:99999;pointer-events:none;" +
    "background:var(--accent);color:var(--fg-inverse);padding:4px 12px;border-radius:4px;" +
    "font-size:13px;font-family:var(--font-sans);white-space:nowrap;";
  ghost.textContent = dragState.tab!.title;
  ghost.style.left = x + 10 + "px";
  ghost.style.top = y - 20 + "px";
  document.body.appendChild(ghost);
  dragState.ghostEl = ghost;
}

function endDrag() {
  const wasActive = dragState.active;
  dragState.active = false;
  dragState.sourceGroupId = "";
  dragState.sourceFloatingId = null;
  dragState.tab = null;
  dragState.startX = 0;
  dragState.startY = 0;
  dragState.compoundParentId = null;
  if (dragState.ghostEl) {
    dragState.ghostEl.remove();
    dragState.ghostEl = null;
  }
  if (!wasActive) return false;
  notifyDragStateChange();
  // 恢复交互（精确恢复被禁用的元素，不用字符串匹配）
  const root = document.getElementById("root");
  if (root) {
    root.style.userSelect = "";
  }
  dragDisabledElements.forEach((el) => { el.style.pointerEvents = ""; });
  dragDisabledElements.length = 0;
  return true;
}

// ═══════════════════════════════════════════════════════════
// 统一 DropTarget 系统 — 单次 compute → 单一结果 → 视觉+执行
// ═══════════════════════════════════════════════════════════

type DropTarget =
  | { kind: "root-edge"; side: "left" | "right" | "top" | "bottom" }
  | { kind: "group"; groupId: string; zone: ZoneType; targetTabId?: string; reorderBeforeTabId?: string; isReorder?: boolean; compoundBar?: boolean }
  | null;

const lastMousePos = { x: 0, y: 0 };
let currentTarget: DropTarget = null;
let targetListeners: (() => void)[] = [];
let layoutRef: { current: HTMLDivElement | null } = { current: null };

function subscribeTarget(fn: () => void) {
  targetListeners.push(fn);
  return () => { targetListeners = targetListeners.filter(l => l !== fn); };
}

function setDropTarget(t: DropTarget) {
  if (t === null && currentTarget === null) return;
  if (t !== null && currentTarget !== null &&
      t.kind === currentTarget.kind &&
      (t.kind === "root-edge" ? t.side === (currentTarget as any).side
       : t.groupId === (currentTarget as any).groupId && t.zone === (currentTarget as any).zone && t.targetTabId === (currentTarget as any).targetTabId && t.reorderBeforeTabId === (currentTarget as any).reorderBeforeTabId && t.isReorder === (currentTarget as any).isReorder && t.compoundBar === (currentTarget as any).compoundBar)) return;
  currentTarget = t;
  targetListeners.forEach(fn => fn());
}

interface IconTarget { getRect: () => DOMRect | null; groupId: string; tabId: string; }
const iconTargets: IconTarget[] = [];
function registerIconTarget(t: IconTarget) { iconTargets.push(t); return () => { const i = iconTargets.indexOf(t); if (i >= 0) iconTargets.splice(i, 1); }; }

interface ReorderTarget { getRect: () => DOMRect | null; groupId: string; beforeTabId: string | null; }
const reorderTargets: ReorderTarget[] = [];
function registerReorderTarget(t: ReorderTarget) { reorderTargets.push(t); return () => { const i = reorderTargets.indexOf(t); if (i >= 0) reorderTargets.splice(i, 1); }; }

// ── group 注册（供 compute 遍历）──

interface GroupReg {
  getRect: () => DOMRect | null;
  tabStyle: string | undefined;
  getFilterCtx: () => ZoneFilterCtx;
}

const groupRegs = new Map<string, GroupReg>();

function registerGroup(id: string, reg: GroupReg) {
  groupRegs.set(id, reg);
  return () => { groupRegs.delete(id); };
}

// ── root-edge 指示器判定 ──

export const ROOT_EDGE_GROUPS: Record<string, string> = {
  left: "sidebar-left", right: "chat-messages-group", bottom: "bottom-panel", top: "editor-area",
};

function isOverRootIndicator(mx: number, my: number): "left" | "right" | "top" | "bottom" | null {
  const el = layoutRef.current;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const badgeSize = 40, offset = 6, half = badgeSize / 2, thick = offset + badgeSize;
  if (my >= rect.top && my <= rect.top + thick &&
      mx >= rect.left + rect.width / 2 - half && mx <= rect.left + rect.width / 2 + half) return "top";
  if (my <= rect.bottom && my >= rect.bottom - thick &&
      mx >= rect.left + rect.width / 2 - half && mx <= rect.left + rect.width / 2 + half) return "bottom";
  if (mx >= rect.left && mx <= rect.left + thick &&
      my >= rect.top + rect.height / 2 - half && my <= rect.top + rect.height / 2 + half) return "left";
  if (mx <= rect.right && mx >= rect.right - thick &&
      my >= rect.top + rect.height / 2 - half && my <= rect.top + rect.height / 2 + half) return "right";
  return null;
}

// ── 统一 compute（mousemove / mouseup 双调）──

export function computeDropTarget(): DropTarget {
  const mx = lastMousePos.x, my = lastMousePos.y;

  // 1) root-edge
  const indicator = isOverRootIndicator(mx, my);
  if (indicator) return { kind: "root-edge", side: indicator };

  // 2) 排序把手
  for (const rt of reorderTargets) {
    const r = rt.getRect();
    if (r && mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom) {
      return { kind: "group", groupId: rt.groupId, zone: "bar", isReorder: true, reorderBeforeTabId: rt.beforeTabId ?? undefined };
    }
  }

  // 3) 图标子目标
  for (const it of iconTargets) {
    const r = it.getRect();
    if (r && mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom) {
      return { kind: "group", groupId: it.groupId, zone: "bar", targetTabId: it.tabId };
    }
  }

  // 4) elementFromPoint 定位 group
  const el = document.elementFromPoint(mx, my);
  if (el) {
    // 跳过浮窗内部元素 — v1 不支持拖入浮窗
    if (el.closest('[data-floating-id]')) return null;
    const groupEl = el.closest('[data-group-id]') as HTMLElement | null;
    if (groupEl) {
      const groupId = groupEl.getAttribute('data-group-id')!;
      const reg = groupRegs.get(groupId);
      if (reg) {
        // 4a) 复合 tab 栏 → bar zone（优先级高于几何 zone，保证栏内元素不会被 content 吞掉）
        if (el.closest('[data-compound-bar]')) {
          const filtered = filterZone("bar", reg.getFilterCtx());
          if (filtered) return { kind: "group", groupId, zone: "bar", compoundBar: true };
        }
        // 4b) 几何 zone 检测
        const rect = groupEl.getBoundingClientRect();
        const xPct = ((mx - rect.left) / rect.width) * 100;
        const yPct = ((my - rect.top) / rect.height) * 100;
        const zone = detectZone(xPct, yPct, reg.tabStyle);
        const filtered = filterZone(zone, reg.getFilterCtx());
        if (filtered) return { kind: "group", groupId, zone: filtered };
      }
    }
  }

  return null;
}

// ── 统一执行（mouseup 调用）──

function executeDrop(explicitTarget?: DropTarget) {
  const target = explicitTarget ?? currentTarget;
  const tab = dragState.tab;

  // ── null target: tree tab → 创建浮窗 ──
  if (!target) {
    if (tab && !dragState.sourceFloatingId) {
      if (dragState.compoundParentId) {
        removeChildFromCompound(dragState.sourceGroupId, dragState.compoundParentId, tab.id);
      } else {
        removeTab(dragState.sourceGroupId, tab.id);
      }
      createFloatingFromTab(tab, lastMousePos.x - 300, lastMousePos.y - 50);
    }
    dragState.tab = null;
    return;
  }

  if (!tab) return;

  // ── cleanSource: 区分 tree 和 floating 源 ──
  const cleanSource = () => {
    if (dragState.sourceFloatingId) {
      if (dragState.compoundParentId) {
        removeChildFromFloatingTab(dragState.sourceFloatingId, dragState.compoundParentId, tab.id);
      } else {
        removeTabFromFloating(dragState.sourceFloatingId, tab.id);
      }
    } else {
      if (dragState.compoundParentId) {
        removeChildFromCompound(dragState.sourceGroupId, dragState.compoundParentId, tab.id);
      } else {
        removeTab(dragState.sourceGroupId, tab.id);
      }
    }
  };
  const newTab = () => ({
    ...tab,
    id: `${tab.panelId}-${crypto.randomUUID().slice(0, 8)}`,
    icon: tab.icon ?? getPanel(tab.panelId)?.icon ?? "default",
    children: tab.children ? tab.children.map((c) => ({ ...c })) : undefined,
  });

  if (target.kind === "root-edge") {
    const gid = ROOT_EDGE_GROUPS[target.side];
    ensureGroupVisible(gid);
    addTab(gid, newTab());
    cleanSource();
    dragState.tab = null;
    return;
  }

  const { groupId, zone } = target;
  // floating source 永远不能是 sameGroup
  const sameGroup = !dragState.sourceFloatingId && dragState.sourceGroupId === groupId;

  if (zone === "bar") {
    if (sameGroup) {
      if (target.isReorder && dragState.compoundParentId) {
        moveChild(groupId, dragState.compoundParentId, tab.id, target.reorderBeforeTabId ?? null);
      }
      else if (dragState.compoundParentId && target.targetTabId && target.targetTabId !== dragState.compoundParentId) {
        moveChildBetweenTabs(groupId, dragState.compoundParentId, tab.id, target.targetTabId);
      }
      else if (dragState.compoundParentId) { cleanSource(); }
      else if (target.isReorder) {
        moveTab(groupId, tab.id, target.reorderBeforeTabId ?? null);
      }
      else if (target.targetTabId && target.targetTabId !== tab.id) {
        mergeIntoTab(groupId, target.targetTabId, dragState.sourceGroupId, tab.id);
      }
    } else {
      addTab(groupId, newTab());
      cleanSource();
    }
    dragState.tab = null;
    return;
  }
  if (zone === "content") {
    if (sameGroup) {
      if (dragState.compoundParentId) {
        cleanSource();
      } else {
        const liveActiveTabId = findGroup(getTree(), groupId)?.activeTabId;
        if (tab.id !== (liveActiveTabId ?? "") && liveActiveTabId) {
          mergeIntoTab(groupId, liveActiveTabId, dragState.sourceGroupId, tab.id);
        }
      }
    } else {
      addTab(groupId, newTab());
      cleanSource();
    }
    dragState.tab = null;
    return;
  }
  if (zone.startsWith("edge-")) {
    if (sameGroup) { dragState.tab = null; return; }
    const side = zone.replace("edge-", "") as "left" | "right" | "top" | "bottom";
    splitGroup(groupId, side, newTab());
    cleanSource();
    dragState.tab = null;
    return;
  }
}

// 全局 mousemove / mouseup（挂载一次）
let globalListenersInstalled = false;
export function ensureGlobalDragListeners() {
  if (globalListenersInstalled) return;
  globalListenersInstalled = true;
  document.addEventListener("mousemove", (e) => {
    lastMousePos.x = e.clientX;
    lastMousePos.y = e.clientY;
    startDragIfMoved(e.clientX, e.clientY);
    if (dragState.active) {
      if (dragState.ghostEl) {
        dragState.ghostEl.style.left = e.clientX + 10 + "px";
        dragState.ghostEl.style.top = e.clientY - 20 + "px";
      }
      setDropTarget(computeDropTarget());
    }
  });
  document.addEventListener("mouseup", (e) => {
    if (!dragState.active) { endDrag(); return; }
    lastMousePos.x = e.clientX;
    lastMousePos.y = e.clientY;
    const finalTarget = computeDropTarget();
    setDropTarget(finalTarget);
    executeDrop(finalTarget);
    const wasDrag = endDrag();
    if (wasDrag) setDropTarget(null);
  });
}


// ═══════════════════════════════════════════════════════════
// Zone 系统 — 位置 → Zone 类型 → 视觉 / 动作 三层解耦
// ═══════════════════════════════════════════════════════════

/** Zone 类型：对鼠标位置区域的语义描述，不与具体动作绑定 */
type ZoneType = "bar" | "content" | "edge-left" | "edge-right" | "edge-top" | "edge-bottom";

const EDGE = 3;

// ── Layer 1: Zone 检测规则（按 GroupStyle 分组，优先级从上到下）──

interface ZoneRule {
  zone: ZoneType;
  /** xPct / yPct 为鼠标在容器内的百分比位置 */
  match: (xPct: number, yPct: number) => boolean;
}

const ZONE_RULES: Record<string, ZoneRule[]> = {
  tabs: [
    { zone: "edge-top",    match: (_x, y) => y < EDGE },
    { zone: "bar",         match: (_x, y) => y < 10 },
    { zone: "edge-left",   match: (x, _y) => x < EDGE },
    { zone: "edge-right",  match: (x, _y) => x > 100 - EDGE },
    { zone: "edge-bottom", match: (_x, y) => y > 100 - EDGE },
    { zone: "content",     match: () => true },
  ],
  activity: [
    { zone: "bar",         match: (x, _y) => x < 12 },
    { zone: "edge-right",  match: (x, _y) => x > 100 - EDGE },
    { zone: "content",     match: () => true },
  ],
  "activity-right": [
    { zone: "bar",         match: (x, _y) => x > 88 },
    { zone: "edge-left",   match: (x, _y) => x < EDGE },
    { zone: "content",     match: () => true },
  ],
  "activity-bottom": [
    { zone: "bar",         match: (_x, y) => y < 10 },
    { zone: "edge-bottom", match: (_x, y) => y > 100 - EDGE },
    { zone: "content",     match: () => true },
  ],
};

/** 纯几何判定：位置 + 风格 → Zone */
function detectZone(xPct: number, yPct: number, tabStyle: string | undefined): ZoneType {
  const rules = ZONE_RULES[tabStyle ?? "tabs"] ?? ZONE_RULES.tabs;
  for (const rule of rules) {
    if (rule.match(xPct, yPct)) return rule.zone;
  }
  return "content";
}

// ── Layer 2: 上下文过滤（拖拽元信息滤掉无意义的 zone）──

interface ZoneFilterCtx {
  groupId: string;
  sourceGroupId: string;
  compoundParentId: string | null;
}

function filterZone(zone: ZoneType, ctx: ZoneFilterCtx): ZoneType | null {
  if (ctx.sourceGroupId !== ctx.groupId) return zone; // 跨组：全部允许

  const isCompoundChild = !!ctx.compoundParentId;

  // bar → 始终显示（合并自判由 executeDrop 处理）
  if (zone === "bar") { return zone; }

  // content → 始终显示（同组切换 tab / 复合子拆出由 executeDrop 处理）
  if (zone === "content") { return zone; }

  // edge-* → 同组不可拆分自己
  return null;
}

// ── Layer 3: 统一入口（位置 → 有效 zone）──

function resolveDropZone(
  rect: DOMRect,
  mx: number,
  my: number,
  tabStyle: string | undefined,
  filterCtx: ZoneFilterCtx,
): ZoneType | null {
  if (mx < rect.left || mx > rect.right || my < rect.top || my > rect.bottom) return null;
  const xPct = ((mx - rect.left) / rect.width) * 100;
  const yPct = ((my - rect.top) / rect.height) * 100;
  const zone = detectZone(xPct, yPct, tabStyle);
  return filterZone(zone, filterCtx);
}

// ── Layer 4: Zone → 视觉样式映射 ──

interface ZoneVisual {
  border?: { side: "left" | "right" | "top" | "bottom"; active: boolean };
  barHighlight?: boolean;
  contentOverlay?: boolean;
}

function getZoneVisual(zone: ZoneType | null): ZoneVisual {
  if (!zone) return {};
  return {
    border: zone.startsWith("edge-")
      ? { side: zone.replace("edge-", "") as "left" | "right" | "top" | "bottom", active: true }
      : undefined,
    barHighlight: zone === "bar",
    contentOverlay: zone === "content",
  };
}

// ── 排序把手（图标间的间隔条，专门触发排序）──

function ReorderHandle({ groupId, beforeTabId, isActive, direction }: {
  groupId: string; beforeTabId: string | null; isActive: boolean; direction?: "horizontal" | "vertical";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const globalDrag = dragState.active;
  const isH = direction === "horizontal";

  useLayoutEffect(() => {
    const t: ReorderTarget = { getRect: () => ref.current?.getBoundingClientRect() ?? null, groupId, beforeTabId };
    return registerReorderTarget(t);
  }, [groupId, beforeTabId]);

  const dim = isActive ? 6 : globalDrag ? 3 : 2;
  const bg = isActive ? "var(--accent)" : globalDrag ? "rgba(0,122,204,0.2)" : "transparent";

  return (
    <div ref={ref} style={{
      width: isH ? dim : "100%",
      height: isH ? "100%" : dim,
      flexShrink: 0,
      backgroundColor: bg,
      borderRadius: 1.5,
      transition: "background-color 0.15s, width 0.15s, height 0.15s",
    }} />
  );
}

// ── Tauri 原生窗口 — 由 layoutStore 统一管理（移除 tab + 创建 TauriWindow + 生成窗口） ──

// ── 右键菜单构建 ──

function buildTabMenu(groupId: string, tab: TabInstance, compoundParentId?: string): ContextMenuItem[] {
  const group = findGroup(getTree(), groupId);
  const tabCount = group?.tabs.length ?? 0;
  const isPinned = PINNED_GROUPS.has(groupId);
  const isCompoundChild = !!compoundParentId;

  return [
    {
      label: t("layout.floatTab"),
      action: () => {
        if (isCompoundChild && compoundParentId) {
          removeChildFromCompound(groupId, compoundParentId, tab.id);
        } else {
          removeTab(groupId, tab.id);
        }
        createFloatingFromTab(tab);
      },
    },
    {
      label: t("layout.openInNewWindow"),
      action: () => {
        if (isCompoundChild && compoundParentId) {
          removeChildFromCompound(groupId, compoundParentId, tab.id);
        } else {
          removeTab(groupId, tab.id);
        }
        createTauriWindowFromTab(tab);
      },
      disabled: isCompoundChild,
    },
    {
      label: t("layout.closeTab"),
      action: () => {
        if (isCompoundChild && compoundParentId) {
          removeChildFromCompound(groupId, compoundParentId, tab.id);
        } else {
          removeTab(groupId, tab.id);
        }
      },
      disabled: isPinned && tabCount <= 1 && !isCompoundChild,
    },
  ];
}

function buildCompoundGroupMenu(groupId: string, tab: TabInstance): ContextMenuItem[] {
  const group = findGroup(getTree(), groupId);
  const tabCount = group?.tabs.length ?? 0;
  const isPinned = PINNED_GROUPS.has(groupId);

  return [
    {
      label: t("layout.floatTab"),
      action: () => {
        removeTab(groupId, tab.id);
        createFloatingFromTab(tab);
      },
    },
    {
      label: t("layout.openInNewWindow"),
      action: () => {
        removeTab(groupId, tab.id);
        createTauriWindowFromTab(tab);
      },
      disabled: true,
    },
    {
      label: t("layout.dissolveGroup"),
      action: () => dissolveCompoundGroup(groupId, tab.id),
      disabled: (tab.children?.length ?? 0) < 2,
    },
    {
      label: t("layout.changeIcon"),
      action: () => {
        // 非候选池图标(undefined/"default"/面板键)→ idx -1 → 回到池首(旧逻辑 displayName 不在池中也一样)
        const currentIdx = GROUP_ICON_POOL.indexOf(tab.icon ?? "default");
        const next = GROUP_ICON_POOL[(currentIdx + 1) % GROUP_ICON_POOL.length];
        setTabIcon(groupId, tab.id, next);
      },
    },
    {
      label: t("layout.closeTab"),
      action: () => {
        removeTab(groupId, tab.id);
      },
      disabled: isPinned && tabCount <= 1,
    },
  ];
}

// ── 图标按钮（模块级，icon rect 注册）──

function IconBtn({ groupId, tab, indicatorStyle, isDropIcon, isActiveTab }: {
  groupId: string; tab: TabInstance; indicatorStyle: React.CSSProperties;
  isDropIcon: boolean; isActiveTab: boolean;
}) {
  const iconRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const t: IconTarget = { getRect: () => iconRef.current?.getBoundingClientRect() ?? null, groupId, tabId: tab.id };
    return registerIconTarget(t);
  }, [groupId, tab.id]);

  return (
    <div ref={iconRef} title={tab.title}
      onMouseDown={(e) => { ensureGlobalDragListeners(); prepareDrag(groupId, tab, e.clientX, e.clientY); }}
      onClick={() => {
        if (dragDidStart) return;
        if (isActiveTab) {
          toggleGroupCollapse(groupId);
        } else {
          setActiveTab(groupId, tab.id);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        showCtxMenu(e.clientX, e.clientY,
          tab.children?.length
            ? buildCompoundGroupMenu(groupId, tab)
            : buildTabMenu(groupId, tab));
      }}
      style={{
        ...ICON_BTN_BASE,
        backgroundColor: isDropIcon ? "rgba(0,122,204,0.3)" : isActiveTab ? "var(--border-light)" : "transparent",
        outline: isDropIcon ? "2px solid var(--accent)" : "none", outlineOffset: -2,
      }}
    >
      {isActiveTab && !isDropIcon && (
        <div style={{ position: "absolute", ...indicatorStyle, backgroundColor: "var(--accent)", borderRadius: 1 }} />
      )}
      {iconFor(tab.icon)}
    </div>
  );
}

// ── Activity bar 图标溢出 ──
// 图标不再因空间不足而压缩间距(flexShrink:0)；放不下的 tab 收进末尾"…"菜单(点击切过去)。
function IconOverflowBar({ node, barStyle, indicator, isActivityBottom, iconDropTabId, dropIsReorder, dropReorderBeforeTabId }: {
  node: TabGroupType;
  barStyle: React.CSSProperties;
  indicator: React.CSSProperties;
  isActivityBottom: boolean;
  iconDropTabId?: string;
  dropIsReorder: boolean;
  dropReorderBeforeTabId?: string;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [vis, setVis] = useState<{ n: number; over: boolean }>({ n: node.tabs.length, over: false });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const slot = 36 + 2; // IconBtn 36 + gap 2
    const compute = () => {
      const available = isActivityBottom ? el.clientWidth : el.clientHeight;
      const raw = Math.max(1, Math.floor(available / slot));
      if (node.tabs.length <= raw) setVis({ n: node.tabs.length, over: false });
      else setVis({ n: Math.max(1, raw - 1), over: true }); // 留一个槽位给 "…"
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [node.tabs.length, isActivityBottom]);

  const hidden = node.tabs.slice(vis.n);
  const showMore = vis.over && hidden.length > 0;
  const rhDir = isActivityBottom ? "horizontal" : undefined;

  return (
    <div ref={barRef} style={{ ...ICON_BAR_BASE, position: "relative", ...barStyle } as React.CSSProperties}>
      {node.tabs.slice(0, vis.n).map((tab) => [
        <ReorderHandle key={`rh-before-${tab.id}`} groupId={node.id} beforeTabId={tab.id}
          isActive={dropIsReorder && dropReorderBeforeTabId === tab.id} direction={rhDir} />,
        <IconBtn key={tab.id} groupId={node.id} tab={tab} indicatorStyle={indicator}
          isDropIcon={iconDropTabId === tab.id} isActiveTab={tab.id === node.activeTabId} />,
      ])}
      <ReorderHandle key="rh-end" groupId={node.id} beforeTabId={null}
        isActive={dropIsReorder && dropReorderBeforeTabId === undefined} direction={rhDir} />
      {showMore && (
        <div title={t("layout.tabOverflow")} onClick={() => setOpen(v => !v)}
          style={{ width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", borderRadius: 4, flexShrink: 0, color: open ? "var(--fg-primary)" : "var(--fg-muted)", background: open ? "var(--border-light)" : "transparent" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-ellipsis"><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></svg>
        </div>
      )}
      {showMore && open && (
        <div style={{
          position: "absolute", zIndex: 60, minWidth: 150, maxHeight: 300, overflow: "auto",
          background: "var(--bg-surface)", border: "1px solid var(--border-medium)",
          borderRadius: 8, boxShadow: "var(--shadow-md)", padding: 4, display: "flex", flexDirection: "column", gap: 2,
          ...(isActivityBottom ? { bottom: 40, right: 4 } : { left: 52, top: Math.min(200, vis.n * 38 + 4) }),
        } as React.CSSProperties}>
          {hidden.map((tab) => (
            <button key={tab.id} type="button"
              onClick={() => { setActiveTab(node.id, tab.id); setOpen(false); }}
              onMouseEnter={(e) => { (e.currentTarget.style.background = "var(--bg-hover)"); }}
              onMouseLeave={(e) => { (e.currentTarget.style.background = "transparent"); }}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 9px", background: "transparent", border: "none", borderRadius: 5, cursor: "pointer", textAlign: "left", whiteSpace: "nowrap", fontFamily: "inherit", fontSize: "calc(var(--font-scale,1)*11.5px)", color: "var(--fg-primary)" }}>
              <span style={{ display: "inline-flex", color: "var(--fg-muted)" }}>{iconFor(tab.icon)}</span>
              <span>{tab.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 分割按钮（模块级，group 右上角 ⊕ → 选择方向）──

function LayoutChip({ nodeId, groupId, singleTab, activeTab }: {
  nodeId: string;
  groupId: string;
  singleTab?: TabInstance;
  activeTab?: TabInstance;
}) {
  const [splitOpen, setSplitOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [, forceRender] = useState(0);
  const layoutModeActive = layoutMode.enabled;

  useEffect(() => { const unsub = layoutMode.subscribe(() => forceRender((v) => v + 1)); return () => { unsub(); }; }, []);

  // 点击 chip 外部关闭弹层
  useEffect(() => {
    if (!splitOpen && !moreOpen) return;
    const h = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest(".lm-chip")) { setSplitOpen(false); setMoreOpen(false); }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [splitOpen, moreOpen]);

  const dragTab = singleTab ?? activeTab;
  const isPinned = PINNED_GROUPS.has(nodeId);

  const closeAction = () => { isPinned ? hideGroup(nodeId) : closeGroup(nodeId); };
  const floatAction = () => {
    if (!dragTab) return;
    removeTab(groupId, dragTab.id);
    createFloatingFromTab(dragTab);
  };
  const moreItems: ContextMenuItem[] = [
    {
      label: t("layout.changeIcon"),
      action: () => {
        if (!dragTab) return;
        const currentIdx = GROUP_ICON_POOL.indexOf(dragTab.icon ?? "default");
        setTabIcon(groupId, dragTab.id, GROUP_ICON_POOL[(currentIdx + 1) % GROUP_ICON_POOL.length]);
      },
    },
    {
      label: t("layout.openInNewWindow"),
      action: () => { if (dragTab) { removeTab(groupId, dragTab.id); createTauriWindowFromTab(dragTab); } },
      disabled: !dragTab,
    },
    {
      label: t("layout.closeTab"),
      action: () => { if (dragTab) removeTab(groupId, dragTab.id); },
      disabled: !dragTab || (isPinned && !!singleTab),
    },
  ];

  return (
    <div className="lm-chip" style={{ display: layoutModeActive ? "flex" : "none" }} data-od-id="lm-chip">
      <button
        type="button"
        className="lm-chip-btn"
        title={t("layout.dragPanel")}
        onMouseDown={(e) => {
          if (!dragTab) return;
          ensureGlobalDragListeners();
          prepareDrag(groupId, dragTab, e.clientX, e.clientY);
        }}
      >
        <GripVertical size={13} />
      </button>
      <button
        type="button"
        className="lm-chip-btn"
        title={t("layout.splitPanel")}
        onClick={(e) => { e.stopPropagation(); setSplitOpen(!splitOpen); setMoreOpen(false); }}
      >
        <SplitIcon size={13} />
      </button>
      <button type="button" className="lm-chip-btn" title={t("layout.floatPanel")} onClick={floatAction}>
        <PictureInPicture2 size={13} />
      </button>
      <button type="button" className="lm-chip-btn" title={isPinned ? t("layout.hide") : t("layout.closeGroup")} onClick={closeAction}>
        <X size={13} />
      </button>
      <button
        type="button"
        className="lm-chip-btn"
        title={t("layout.morePanel")}
        onClick={(e) => { e.stopPropagation(); setMoreOpen(!moreOpen); setSplitOpen(false); }}
      >
        <MoreHorizontal size={13} />
      </button>

      {splitOpen && (
        <div className="lm-pop" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="lm-pop-it" onClick={() => { splitGroupEmpty(nodeId, "right"); setSplitOpen(false); }}>{t("layout.splitRight")} →</button>
          <button type="button" className="lm-pop-it" onClick={() => { splitGroupEmpty(nodeId, "bottom"); setSplitOpen(false); }}>{t("layout.splitBottom")} ↓</button>
          <button type="button" className="lm-pop-it" onClick={() => { splitGroupEmpty(nodeId, "left"); setSplitOpen(false); }}>{t("layout.splitLeft")} ←</button>
          <button type="button" className="lm-pop-it" onClick={() => { splitGroupEmpty(nodeId, "top"); setSplitOpen(false); }}>{t("layout.splitTop")} ↑</button>
        </div>
      )}
      {moreOpen && (
        <div className="lm-pop lm-pop-right" onClick={(e) => e.stopPropagation()}>
          {moreItems.map((it, i) => (
            <button
              key={i}
              type="button"
              className="lm-pop-it"
              disabled={it.disabled}
              onClick={() => { it.action?.(); setMoreOpen(false); }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── TabGroup 节点 ──

function TabGroupView({ node }: { node: TabGroupType }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dropZone, setDropZone] = useState<ZoneType | null>(null);
  const [dropTargetTabId, setDropTargetTabId] = useState<string | undefined>(undefined);
  const [dropReorderBeforeTabId, setDropReorderBeforeTabId] = useState<string | undefined>(undefined);
  const [dropIsReorder, setDropIsReorder] = useState(false);
  const [dropCompoundBar, setDropCompoundBar] = useState(false);
  const activeTab = node.tabs.find((t) => t.id === node.activeTabId);

  // 解析要渲染的内容：单 panel 或复合组
  let contentRender: (() => React.ReactNode) | undefined;
  let compoundTabs: TabInstance[] | undefined;

  if (activeTab) {
    if (activeTab.children?.length) {
      compoundTabs = activeTab.children;
    }
    contentRender = resolveTabRender(activeTab);
  }

  const isEmpty = node.tabs.length === 0;
  const isActivity = node.tabStyle?.startsWith("activity") ?? false;
  const isActivityRight = node.tabStyle === "activity-right";
  const isActivityBottom = node.tabStyle === "activity-bottom";

  // ── 注册到统一 DropTarget 系统 ──

  useEffect(() => {
    const unreg = registerGroup(node.id, {
      getRect: () => containerRef.current?.getBoundingClientRect() ?? null,
      tabStyle: node.tabStyle,
      getFilterCtx: () => ({
        groupId: node.id,
        sourceGroupId: dragState.sourceGroupId,
        compoundParentId: dragState.compoundParentId,
      }),
    });
    const unsub = subscribeTarget(() => {
      if (currentTarget?.kind === "group" && currentTarget.groupId === node.id) {
        setDropZone(currentTarget.zone);
        setDropTargetTabId(currentTarget.targetTabId);
        setDropReorderBeforeTabId(currentTarget.reorderBeforeTabId);
        setDropIsReorder(currentTarget.isReorder ?? false);
        setDropCompoundBar(currentTarget.compoundBar ?? false);
      } else {
        setDropZone(null);
        setDropTargetTabId(undefined);
        setDropReorderBeforeTabId(undefined);
        setDropIsReorder(false);
        setDropCompoundBar(false);
      }
    });
    return () => { unreg(); unsub(); };
  }, [node.id, node.tabStyle]);

  // ── Zone → 视觉样式 ──

  const visual = getZoneVisual(dropZone);

  const hintBorder = (dir: string): React.CSSProperties | null => {
    if (!visual.border || visual.border.side !== dir) return null;
    const color = "3px solid var(--accent)";
    const boxShadowMap: Record<string, string> = {
      left: "inset 4px 0 8px rgba(0,122,204,0.15)",
      right: "inset -4px 0 8px rgba(0,122,204,0.15)",
      top: "inset 0 4px 8px rgba(0,122,204,0.15)",
      bottom: "inset 0 -4px 8px rgba(0,122,204,0.15)",
    };
    if (dir === "left") return { borderLeft: color, boxShadow: boxShadowMap.left };
    if (dir === "right") return { borderRight: color, boxShadow: boxShadowMap.right };
    if (dir === "top") return { borderTop: color, boxShadow: boxShadowMap.top };
    if (dir === "bottom") return { borderBottom: color, boxShadow: boxShadowMap.bottom };
    return null;
  };

  // 图标命中时只高亮单个图标，不亮整条 bar 背景
  const iconDropTabId = (dropZone === "bar") ? dropTargetTabId : undefined;
  const iconBarHighlight = (visual.barHighlight && !iconDropTabId && !dropIsReorder && !dropCompoundBar) ? "rgba(0,122,204,0.3)" : undefined;
  const compoundBarBg = dropCompoundBar ? "rgba(0,122,204,0.3)" : "var(--bg-hover)";
  const centerOverlay: React.CSSProperties | null = visual.contentOverlay
    ? {
        position: "absolute", inset: 0,
        backgroundColor: "rgba(0,122,204,0.08)",
        zIndex: 9, pointerEvents: "none",
      }
    : null;

  // ── Activity Bar 风格 ──

  if (isActivity) {
    const collapsed = (node.visibility || "expanded") === "collapsed";
    const showIconBar = collapsed || node.tabs.length > 1 || dragState.active;

    const iconBar: React.CSSProperties = isActivityBottom
      ? { width: "100%", height: 35, flexDirection: "row", borderRight: "none", borderBottom: "1px solid var(--border-medium)" }
      : { width: 48, flexDirection: "column", borderRight: isActivityRight ? "none" : "1px solid var(--border-medium)", borderLeft: isActivityRight ? "1px solid var(--border-medium)" : "none" };

    const indicator: React.CSSProperties = isActivityBottom
      ? { top: 0, left: 6, right: 6, height: 2 }
      : isActivityRight
        ? { right: 0, top: 6, bottom: 6, width: 2 }
        : { left: 0, top: 6, bottom: 6, width: 2 };

    return (
      <div
        ref={containerRef}
        data-group-id={node.id}
        className={"lm-block" + (dragState.active && dragState.sourceGroupId === node.id ? " dragging" : "")}
        style={{
          display: "flex",
          flexDirection: isActivityBottom ? "column" : "row",
          flex: collapsed ? undefined : 1,
          ...(collapsed
            ? isActivityBottom
              ? { height: 35, flexShrink: 0 }
              : { width: 48, flexShrink: 0 }
            : { minWidth: 0, minHeight: 0 }),
          position: "relative",
          ...hintBorder("left"), ...hintBorder("right"),
          ...hintBorder("top"), ...hintBorder("bottom"),
        }}
      >
        {isActivityRight ? null : showIconBar && (
          <IconOverflowBar node={node}
            barStyle={{ ...ICON_BAR_BASE, backgroundColor: iconBarHighlight ?? "var(--bg-hover)", ...iconBar }}
            indicator={indicator} isActivityBottom={isActivityBottom}
            iconDropTabId={iconDropTabId} dropIsReorder={dropIsReorder} dropReorderBeforeTabId={dropReorderBeforeTabId} />
        )}
        {!collapsed && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, position: "relative" }}>
          {centerOverlay && <div style={centerOverlay} />}
          {compoundTabs && (
            <div data-compound-bar="" style={{ ...CMP_TAB_BAR, backgroundColor: compoundBarBg }}>
              {compoundTabs.flatMap((ct, i) => [
                <ReorderHandle key={`rh-cmp-${ct.id}`} groupId={node.id} beforeTabId={ct.id}
                  isActive={dropIsReorder && dropReorderBeforeTabId === ct.id} direction="horizontal" />,
                (() => {
                  const childActive = ct.id === activeTab!.activeChildId;
                  return (
                    <div key={ct.id}
                      onMouseDown={(e) => {
                        ensureGlobalDragListeners();
                        prepareDrag(node.id, ct, e.clientX, e.clientY, activeTab!.id);
                      }}
                      onClick={(e) => {
                        if (!dragDidStart) setActiveChild(node.id, activeTab!.id, ct.id);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        showCtxMenu(e.clientX, e.clientY, buildTabMenu(node.id, ct, activeTab!.id));
                      }}
                      style={{
                        ...CMP_TAB_ITEM_BASE,
                        color: childActive ? "var(--fg-primary)" : "var(--fg-secondary)",
                        backgroundColor: childActive ? "var(--bg-root)" : "transparent",
                        borderBottom: childActive ? "2px solid var(--accent)" : "none",
                      }}
                    >
                      <span>{iconFor(ct.icon)}</span>
                      <span>{ct.title}</span>
                    </div>
                  );
                })(),
              ])}
              <ReorderHandle key="rh-cmp-end" groupId={node.id} beforeTabId={null}
                isActive={dropIsReorder && dropReorderBeforeTabId === undefined} direction="horizontal" />
            </div>
          )}
          {isEmpty
            ? <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, color: "var(--fg-muted)", fontSize: 12, fontFamily: "var(--font-sans)" }}>{t("layout.emptyGroup")}</div>
            : contentRender ? contentRender() : null}
          <LayoutChip nodeId={node.id} groupId={node.id} singleTab={node.tabs.length === 1 ? node.tabs[0] : undefined} activeTab={node.tabs.find((tb) => tb.id === node.activeTabId)} />
        </div>
        )}
        {isActivityRight && showIconBar && (
          <div style={{
            ...ICON_BAR_BASE,
            backgroundColor: iconBarHighlight ?? "var(--bg-hover)",
            ...iconBar,
          } as React.CSSProperties}>
            {node.tabs.flatMap((tab, i) => [
              <ReorderHandle key={`rh-before-${tab.id}`} groupId={node.id} beforeTabId={tab.id}
                isActive={dropIsReorder && dropReorderBeforeTabId === tab.id} />,
              <IconBtn key={tab.id} groupId={node.id} tab={tab} indicatorStyle={indicator} isDropIcon={iconDropTabId === tab.id} isActiveTab={tab.id === node.activeTabId} />,
            ])}
            <ReorderHandle key="rh-end" groupId={node.id} beforeTabId={null}
              isActive={dropIsReorder && dropReorderBeforeTabId === undefined} />
          </div>
        )}
      </div>
    );
  }

  // ── 默认 tabs 风格 ──

  const showTabBar = node.tabs.length > 1 || dragState.active;

  return (
    <div
      ref={containerRef}
      data-group-id={node.id}
      className={"lm-block" + (dragState.active && dragState.sourceGroupId === node.id ? " dragging" : "")}
      style={{
        ...GROUP_DEFAULT,
        ...hintBorder("left"), ...hintBorder("right"),
        ...hintBorder("top"), ...hintBorder("bottom"),
      }}
    >
      {showTabBar ? (
        <div style={{ ...TAB_BAR, backgroundColor: iconBarHighlight ?? "var(--bg-hover)" }}>
          {node.tabs.flatMap((tab, i) => [
            <ReorderHandle key={`rh-before-${tab.id}`} groupId={node.id} beforeTabId={tab.id}
              isActive={dropIsReorder && dropReorderBeforeTabId === tab.id} direction="horizontal" />,
            (() => {
              const isActive = tab.id === node.activeTabId;
              return (
                <div
                  key={tab.id}
                  onMouseDown={(e) => {
                    ensureGlobalDragListeners();
                    prepareDrag(node.id, tab, e.clientX, e.clientY);
                  }}
                  onClick={() => {
                    if (!dragDidStart) setActiveTab(node.id, tab.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showCtxMenu(e.clientX, e.clientY,
                      tab.children?.length
                        ? buildCompoundGroupMenu(node.id, tab)
                        : buildTabMenu(node.id, tab));
                  }}
                  style={{
                    ...TAB_ITEM_BASE,
                    color: isActive ? "var(--fg-primary)" : "var(--fg-secondary)",
                    backgroundColor: isActive ? "var(--bg-root)" : "transparent",
                    borderBottom: isActive ? "2px solid var(--accent)" : "none",
                  }}
                >
                  <span>{iconFor(tab.icon)}</span>
                  <span>{tab.title}</span>
                </div>
              );
            })(),
          ])}
          <ReorderHandle key="rh-end" groupId={node.id} beforeTabId={null}
            isActive={dropIsReorder && dropReorderBeforeTabId === undefined} direction="horizontal" />
        </div>
      ) : dropZone === "bar" ? (
        <div style={{
          height: 3,
          backgroundColor: "var(--accent)",
          flexShrink: 0,
          transition: "opacity 0.1s",
        }} />
      ) : null}
      {compoundTabs && (
        <div data-compound-bar="" style={{ ...CMP_TAB_BAR, backgroundColor: compoundBarBg }}>
          {compoundTabs.flatMap((ct, i) => [
            <ReorderHandle key={`rh-cmp-${ct.id}`} groupId={node.id} beforeTabId={ct.id}
              isActive={dropIsReorder && dropReorderBeforeTabId === ct.id} direction="horizontal" />,
            (() => {
              const childActive = ct.id === activeTab!.activeChildId;
              return (
                <div key={ct.id}
                  onMouseDown={(e) => {
                    ensureGlobalDragListeners();
                    prepareDrag(node.id, ct, e.clientX, e.clientY, activeTab!.id);
                  }}
                  onClick={() => {
                    if (!dragDidStart) setActiveChild(node.id, activeTab!.id, ct.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showCtxMenu(e.clientX, e.clientY, buildTabMenu(node.id, ct, activeTab!.id));
                  }}
                  style={{
                    ...CMP_TAB_ITEM_BASE,
                    color: childActive ? "var(--fg-primary)" : "var(--fg-secondary)",
                    backgroundColor: childActive ? "var(--bg-root)" : "transparent",
                    borderBottom: childActive ? "2px solid var(--accent)" : "none",
                  }}
                >
                  {ct.icon && <span>{ct.icon}</span>}
                  <span>{ct.title}</span>
                </div>
              );
            })(),
          ])}
          <ReorderHandle key="rh-cmp-end" groupId={node.id} beforeTabId={null}
            isActive={dropIsReorder && dropReorderBeforeTabId === undefined} direction="horizontal" />
        </div>
      )}
      <div style={CONTENT_AREA}>
        {centerOverlay && <div style={centerOverlay} />}
        {isEmpty
          ? <div style={EMPTY_GROUP}>{t("layout.emptyGroup")}</div>
          : contentRender ? contentRender() : null}
        <LayoutChip nodeId={node.id} groupId={node.id} singleTab={node.tabs.length === 1 ? node.tabs[0] : undefined} activeTab={node.tabs.find((tb) => tb.id === node.activeTabId)} />
      </div>
    </div>
  );
}

// ── 递归分发 ──

function LayoutNodeView({ node }: { node: LayoutNode }) {
  if (node.type === "split") {
    return <SplitView node={node} />;
  }
  return <TabGroupView node={node} />;
}

// ── 根边缘悬浮覆盖层 ──

function RootEdgeOverlay({ side }: { side: "left" | "right" | "top" | "bottom" }) {
  const badgeSize = 40;
  const arrowMap: Record<string, string> = { bottom: "↓", top: "↑", left: "←", right: "→" };

  const baseStyle: React.CSSProperties = { ...ROOT_EDGE_BADGE_BASE };
  const arrowStyle: React.CSSProperties = { ...ROOT_EDGE_ARROW };

  const offset = 6;
  switch (side) {
    case "left":   return <div style={{ ...baseStyle, left: offset, top: "50%", marginTop: -badgeSize / 2 }}><span style={arrowStyle}>{arrowMap.left}</span></div>;
    case "right":  return <div style={{ ...baseStyle, right: offset, top: "50%", marginTop: -badgeSize / 2 }}><span style={arrowStyle}>{arrowMap.right}</span></div>;
    case "top":    return <div style={{ ...baseStyle, top: offset, left: "50%", marginLeft: -badgeSize / 2 }}><span style={arrowStyle}>{arrowMap.top}</span></div>;
    case "bottom": return <div style={{ ...baseStyle, bottom: offset, left: "50%", marginLeft: -badgeSize / 2 }}><span style={arrowStyle}>{arrowMap.bottom}</span></div>;
  }
}

// ── 顶层 ──

export default function LayoutRenderer() {
  const [, setVersion] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => { ensureLayoutModeStyles(); }, []);

  useEffect(() => {
    layoutRef.current = wrapperRef.current;
  });

  useEventHandler<LayoutTreeChangedPayload>(Events.LAYOUT_TREE_CHANGED, () => setVersion((v) => v + 1));
  useEventHandler<PanelRegistryChangedPayload>(Events.PANEL_REGISTRY_CHANGED, () => setVersion((v) => v + 1));

  useEffect(() => {
    const u3 = subscribeDragState(() => setVersion((v) => v + 1));
    const u4 = layoutMode.subscribe(() => setVersion((v) => v + 1));
    return () => { u3(); u4(); };
  }, []);

  // Esc 退出布局模式
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && layoutMode.enabled) layoutMode.set(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // root-edge 视觉
  const [rootVisual, setRootVisual] = useState<DropTarget | null>(null);
  useEffect(() => subscribeTarget(() => {
    setRootVisual(currentTarget?.kind === "root-edge" ? currentTarget : null);
  }), []);

  const tree = getTree();
  const lm = layoutMode.enabled;

  return (
    <div ref={wrapperRef} className={"lm-root" + (lm ? " lm-on" : "")} style={WRAPPER_STYLE}>
      <div className="lm-banner" data-od-id="lm-banner">
        <span>{t("layout.layoutModeTitle")}</span>
        <span className="hint">{t("layout.lmBannerHint")}</span>
        <span style={{ flex: 1 }} />
        <span className="key">Esc</span>
        <span className="hint">{t("layout.lmEscHint")}</span>
      </div>
      <LayoutNodeView node={tree} />
      {rootVisual && rootVisual.kind === "root-edge" && <RootEdgeOverlay side={rootVisual.side} />}
      <button type="button" className="lm-exit" onClick={() => layoutMode.set(false)} data-od-id="lm-exit">
        <Check size={15} /> {t("layout.exitLayout")}
      </button>
    </div>
  );
}
