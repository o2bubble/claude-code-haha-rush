import React, { memo, useState, useEffect, useLayoutEffect, useRef } from "react";

/** 视口边缘留白：菜单贴边显得局促，也容易被窗口圆角/滚动条吃掉几个像素。 */
const VIEWPORT_MARGIN = 4;

/**
 * 把弹层钳进视口 —— 优先保持原方向，放不下才翻到另一侧。
 *
 * 为什么必须做：菜单是 `position: fixed` 直接放在鼠标坐标上，而右键往往发生在
 * **屏幕下半部**（长列表点最后几项）。不钳制就整个溢出视口，用户既看不到
 * 也点不到 —— 实测用户反馈「溢出了都没法交互」（2026-10-23）。
 *
 * @param desiredX 期望的左上角 x（通常是鼠标位置）
 * @param size     弹层**实际**尺寸（必须先量再定位，见 measureThenPlace）
 * @param viewport 视口宽高
 */
export function clampMenuPosition(
  desiredX: number,
  desiredY: number,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const { width: vw, height: vh } = viewport;
  const { width: w, height: h } = size;

  // 水平：放得下就保持；放不下先向左翻，仍超出则贴右边缘
  let x = desiredX;
  if (x + w > vw - VIEWPORT_MARGIN) x = desiredX - w;
  x = Math.max(VIEWPORT_MARGIN, Math.min(x, vw - w - VIEWPORT_MARGIN));

  // 垂直：同理，向下 → 向上翻（右键菜单的常见行为）
  let y = desiredY;
  if (y + h > vh - VIEWPORT_MARGIN) y = desiredY - h;
  y = Math.max(VIEWPORT_MARGIN, Math.min(y, vh - h - VIEWPORT_MARGIN));

  return { x, y };
}

/** 菜单项文字颜色：禁用态 muted，破坏性操作 error，其余默认 */
function itemColor(item: ContextMenuItem): string {
  if (item.disabled) return "var(--fg-muted)";
  if (item.danger) return "var(--semantic-error, #e5484d)";
  return "var(--fg-primary)";
}

export interface ContextMenuItem {
  label?: string;           // omit for separator
  action?: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
  children?: ContextMenuItem[];
  separator?: boolean;      // renders as a divider line
  danger?: boolean;         // 破坏性操作（卸载等）→ 红色文字
}

// ── 模块级状态（pub/sub 模式）──

let _ctx: { x: number; y: number; items: ContextMenuItem[] } | null = null;
const _listeners: (() => void)[] = [];

export function showCtxMenu(x: number, y: number, items: ContextMenuItem[]) {
  if (items.length === 0) return;
  _ctx = { x, y, items };
  _listeners.forEach((fn) => fn());
}

export function hideCtxMenu() {
  if (!_ctx) return;
  _ctx = null;
  _listeners.forEach((fn) => fn());
}

function subscribeCtxMenu(fn: () => void) {
  _listeners.push(fn);
  return () => {
    const i = _listeners.indexOf(fn);
    if (i >= 0) _listeners.splice(i, 1);
  };
}

// ── 渲染组件 ──

const menuItemStyle: React.CSSProperties = {
  padding: "4px 12px",
  fontSize: "calc(var(--font-scale, 1) * 12px)",
  fontFamily: "var(--font-sans)",
  cursor: "default",
  whiteSpace: "nowrap",
  color: "var(--fg-primary)",
  borderRadius: 3,
  margin: "1px 4px",
};

function _ContextMenu() {
  const [ctx, setCtx] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [subMenu, setSubMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [subIdx, setSubIdx] = useState(-1);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 主菜单钳制后的位置。null = 还没量（此时按原坐标渲染但不可见）。 */
  const [placed, setPlaced] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    return subscribeCtxMenu(() => {
      setCtx(_ctx ? { ..._ctx } : null);
      setPlaced(null); // 新菜单 → 重新量
      setSubMenu(null);
      setSubIdx(-1);
    });
  }, []);

  // **先量后定位**：菜单内容/行数决定它的高度，而高度决定要不要向上翻。
  // 在 useLayoutEffect 里量（浏览器绘制前）→ 用户看不到中间态闪烁。
  // 渲染时先以 visibility:hidden 挂在期望位置，量完再切到真实位置并显示。
  useLayoutEffect(() => {
    if (!ctx || placed || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    setPlaced(
      clampMenuPosition(ctx.x, ctx.y, rect, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [ctx, placed]);

  // 窗口尺寸变化 → 已定位的菜单可能又溢出了，重新钳一次。
  useEffect(() => {
    if (!ctx) return;
    const onResize = () => setPlaced(null);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [ctx]);

  // 点击外部关闭
  useEffect(() => {
    if (!ctx && !subMenu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        hideCtxMenu();
      }
    };
    setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => document.removeEventListener("mousedown", onDown);
  }, [ctx, subMenu]);

  // ESC 关闭
  useEffect(() => {
    if (!ctx) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hideCtxMenu();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ctx]);

  if (!ctx) return null;

  const showSub = (idx: number, item: ContextMenuItem) => {
    if (!item.children || item.disabled) { setSubMenu(null); setSubIdx(-1); return; }
    const parentEl = menuRef.current?.children[idx] as HTMLElement | undefined;
    if (parentEl) {
      const rect = parentEl.getBoundingClientRect();
      // 子菜单是悬停时才创建的，来不及量 —— 按行高估算尺寸再钳进视口。
      // 估算偏大一点无害（钳制只会把它往内挪），偏小才会溢出。
      const estW = 200;
      const estH = item.children.reduce(
        (sum, c) => sum + (c.separator ? 7 : 24),
        8,
      );
      const pos = clampMenuPosition(rect.right, rect.top, { width: estW, height: estH }, {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      setSubMenu({ x: pos.x, y: pos.y, items: item.children });
      setSubIdx(idx);
    }
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: "fixed",
        // 未量好前先挂在期望位置但不显示（避免"先画错位置再跳一下"）
        left: placed?.x ?? ctx.x,
        top: placed?.y ?? ctx.y,
        visibility: placed ? "visible" : "hidden",
        zIndex: 99999,
        backgroundColor: "var(--bg-root)",
        opacity: 1,
        transition: "opacity var(--transition-fast)",
        border: "1px solid var(--border-medium)",
        borderRadius: 6,
        boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
        padding: "2px 0",
        minWidth: 140,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {ctx.items.map((item, i) => {
        if (item.separator) {
          return <div key={i} style={{ height: 1, backgroundColor: "var(--border-light)", margin: "3px 8px" }} />;
        }
        return (
        <div
          key={i}
          role="menuitem"
          tabIndex={item.disabled ? undefined : 0}
          style={{
            ...menuItemStyle,
            color: itemColor(item),
            display: "flex",
            alignItems: "center",
            gap: 6,
            backgroundColor: subIdx === i ? "var(--bg-hover)" : "transparent",
          }}
          onMouseEnter={(e) => {
            if (!item.disabled) {
              (e.target as HTMLElement).style.backgroundColor = "var(--bg-hover)";
              showSub(i, item);
            }
          }}
          onMouseLeave={(e) => {
            (e.target as HTMLElement).style.backgroundColor = subIdx === i ? "var(--bg-hover)" : "transparent";
          }}
          onClick={() => {
            if (item.disabled) return;
            if (item.children) return;
            if (item.action) item.action();
            hideCtxMenu();
          }}
        >
          {item.icon && <span style={{ display: "flex", alignItems: "center" }}>{item.icon}</span>}
          <span style={{ flex: 1 }}>{item.label}</span>
          {item.children && <span style={{ fontSize: 10, color: "var(--fg-muted)", marginLeft: 12 }}>▶</span>}
        </div>
        );
      })}

      {/* Submenu */}
      {subMenu && (
        <div
          style={{
            position: "fixed",
            left: subMenu.x,
            top: subMenu.y,
            zIndex: 100000,
            backgroundColor: "var(--bg-root)",
            border: "1px solid var(--border-medium)",
            borderRadius: 6,
            boxShadow: "var(--shadow-md)",
            padding: "2px 0",
            minWidth: 120,
          }}
        >
          {subMenu.items.map((item, j) => (
            <div
              key={j}
              style={{
                ...menuItemStyle,
                color: itemColor(item),
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
              onMouseEnter={(e) => {
                if (!item.disabled) (e.target as HTMLElement).style.backgroundColor = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLElement).style.backgroundColor = "transparent";
              }}
              onClick={() => {
                if (!item.disabled && item.action) {
                  item.action();
                  hideCtxMenu();
                }
              }}
            >
              {item.icon && <span style={{ display: "flex", alignItems: "center" }}>{item.icon}</span>}
              {item.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
export default memo(_ContextMenu);
