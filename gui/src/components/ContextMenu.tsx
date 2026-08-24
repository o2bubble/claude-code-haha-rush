import React, { memo, useState, useEffect, useRef } from "react";

export interface ContextMenuItem {
  label?: string;           // omit for separator
  action?: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
  children?: ContextMenuItem[];
  separator?: boolean;      // renders as a divider line
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

  useEffect(() => {
    return subscribeCtxMenu(() => {
      setCtx(_ctx ? { ..._ctx } : null);
      setSubMenu(null);
      setSubIdx(-1);
    });
  }, []);

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
      // Flip to left if submenu would overflow viewport right edge
      const subW = 160;
      const x = rect.right + subW > window.innerWidth ? rect.left - subW : rect.right;
      setSubMenu({ x, y: rect.top, items: item.children });
      setSubIdx(idx);
    }
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: "fixed",
        left: ctx.x,
        top: ctx.y,
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
            color: item.disabled ? "var(--fg-muted)" : "var(--fg-primary)",
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
                color: item.disabled ? "var(--fg-muted)" : "var(--fg-primary)",
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
