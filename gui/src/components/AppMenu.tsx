// ── 应用菜单（AppMark 点击弹出）──
//
// 低频功能的家：布局模式、硬刷新、主题、Profile、帮助、诊断、反馈…
// 以及**窗口变窄时被响应式折叠下来的项**（见 useToolbarCollapse）。
//
// 交互约定（与现有 dropdown 一致的视觉，补上它们缺的点外部关闭）：
//   · 点击图标切换；点外部 / Esc / 选中某项 都关闭
//   · 快捷键以右对齐灰字显示（数据来自 ToolbarItem.shortcut）
//   · 有 badge 的项（如「有新版本」）在项右侧显示红点

import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { useClickOutside } from "../utils/useClickOutside";
import { AppMark } from "./TitleBar";
import type { ToolbarItem } from "./toolbarItems";

const MENU_MIN_WIDTH = 220;

export function AppMenu({
  items,
  hasBadge,
}: {
  /** 菜单里显示的项（已折叠的 + 固定低频的） */
  items: ToolbarItem[];
  /** 是否在入口图标上显示红点（如「有新版本」） */
  hasBadge?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        title={t("toolbar.appMenu")}
        aria-label={t("toolbar.appMenu")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 26, height: 26, border: "none", borderRadius: 5,
          background: open ? "var(--bg-active)" : "transparent",
          cursor: "pointer", padding: 0, position: "relative",
        }}
        onMouseEnter={(e) => { if (!open) e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = "transparent"; }}
      >
        <AppMark />
        {hasBadge && <BadgeDot absolute />}
      </button>

      {open && (
        <div
          role="menu"
          // 阻止祖先的 data-tauri-drag-region="deep"（工具栏容器）把菜单项的
          // 点击 preventDefault 掉 —— 菜单项是 button，但父链上的 deep 仍会
          // 在遍历中被命中；false 命中即返回，保住点击。
          data-tauri-drag-region="false"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 4,
            zIndex: 200,
            minWidth: MENU_MIN_WIDTH,
            maxHeight: "70vh",
            overflowY: "auto",
            background: "var(--bg-root)",
            border: "1px solid var(--border-medium)",
            borderRadius: 8,
            boxShadow: "var(--shadow-md, 0 8px 32px rgba(0,0,0,0.2))",
            padding: 4,
            fontFamily: "var(--font-sans)",
          }}
        >
          {items.length === 0 && (
            <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--fg-muted)" }}>
              {t("toolbar.noMenuItems")}
            </div>
          )}
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                width: "100%", border: "none", borderRadius: 5,
                padding: "6px 8px", background: "transparent",
                color: it.disabled
                  ? "var(--fg-muted)"
                  : it.danger ? "var(--semantic-error)" : "var(--fg-primary)",
                cursor: it.disabled ? "default" : "pointer",
                fontSize: 12, textAlign: "left",
              }}
              onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <span style={{ display: "flex", flexShrink: 0, width: 15, justifyContent: "center" }}>
                {it.icon}
              </span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {it.label}
              </span>
              {it.shortcut && (
                <span style={{ flexShrink: 0, fontSize: 10, color: "var(--fg-muted)", fontVariantNumeric: "tabular-nums" }}>
                  {it.shortcut}
                </span>
              )}
              {it.hasBadge && <BadgeDot />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 红点 —— 入口图标与菜单项共用同一视觉。
 * `absolute`：贴在图标按钮右上角（入口用）；否则作行内标记（菜单项用）。
 */
function BadgeDot({ absolute = false }: { absolute?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 7, height: 7, borderRadius: "50%",
        backgroundColor: "var(--semantic-error)",
        flexShrink: 0,
        ...(absolute ? { position: "absolute", top: 3, right: 3 } : {}),
      }}
    />
  );
}
