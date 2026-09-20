import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { iconFor } from "../utils/icons";
import type { IconKey } from "../types/layout";
import { groupPaletteItems, flattenGroups, type PaletteItem } from "../utils/commandPaletteLogic";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  items: PaletteItem[];
  editorFocused?: boolean;
  initialQuery?: string;
}

export default function CommandPalette({ open, onClose, items, editorFocused = false, initialQuery = "" }: CommandPaletteProps) {
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 每次打开时重置查询与选中，聚焦输入框
  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setSelected(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, initialQuery]);

  const groups = useMemo(() => groupPaletteItems(items, query, editorFocused), [items, query, editorFocused]);
  const flat = useMemo(() => flattenGroups(groups), [groups]);

  // Esc 关闭；Enter 执行选中项
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, flat.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        const item = flat[selected];
        if (item) {
          item.run();
          onClose();
        }
        return;
      }
    },
    [flat, selected, onClose],
  );

  if (!open) return null;

  return (
    <div
      data-od-id="command-palette"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100000,
        background: "rgba(0,0,0,0.25)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "12vh",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 560,
          maxWidth: "calc(100vw - 48px)",
          background: "var(--bg-root)",
          border: "1px solid var(--border-medium)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-lg)",
          overflow: "hidden",
          animation: "palette-in var(--transition-normal)",
          transformOrigin: "top center",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 搜索框 */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--border-light)" }}>
          <span style={{ fontSize: 14, color: "var(--fg-muted)", flexShrink: 0 }}>⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
            onKeyDown={handleKeyDown}
            placeholder={t("commandPalette.placeholder")}
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 14,
              fontFamily: "var(--font-sans)",
              color: "var(--fg-primary)",
            }}
          />
          <span style={{ fontSize: 10, color: "var(--fg-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>Esc</span>
        </div>

        {/* 结果列表 */}
        <div style={{ maxHeight: "50vh", overflowY: "auto", padding: "4px 0" }}>
          {flat.length === 0 ? (
            <div style={{ padding: "24px 16px", textAlign: "center", color: "var(--fg-muted)", fontSize: 13, fontFamily: "var(--font-sans)" }}>
              {t("commandPalette.noResults")}
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.kind}>
                <div style={{ padding: "6px 16px 4px", fontSize: 11, fontWeight: 600, color: "var(--fg-muted)", fontFamily: "var(--font-sans)" }}>
                  {group.title}
                </div>
                {group.items.map((item) => {
                  const idx = flat.indexOf(item);
                  const isSelected = idx === selected;
                  return (
                    <div
                      key={item.id}
                      data-od-id={`palette-item-${item.kind}-${item.id}`}
                      role="option"
                      aria-selected={isSelected}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "7px 16px",
                        cursor: "pointer",
                        fontFamily: "var(--font-sans)",
                        background: isSelected ? "var(--bg-active)" : "transparent",
                        color: "var(--fg-primary)",
                      }}
                      onMouseEnter={() => setSelected(idx)}
                      onClick={() => { item.run(); onClose(); }}
                    >
                      <span style={{ width: 18, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-muted)", flexShrink: 0 }}>
                        {iconFor(item.icon as IconKey)}
                      </span>
                      {/* 层级前缀（如会话的文件夹路径）—— 灰色小字，`›` 与标题分离。
                          名字是主体，故前缀可被压缩省略（flexShrink 更大、有 maxWidth）。 */}
                      {item.prefix && (
                        <span
                          style={{
                            flexShrink: 2, minWidth: 0, maxWidth: 220, display: "flex", alignItems: "center", gap: 5,
                            fontSize: 11, color: "var(--fg-muted)", whiteSpace: "nowrap",
                          }}
                        >
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{item.prefix}</span>
                          <span style={{ opacity: 0.45, flexShrink: 0 }}>›</span>
                        </span>
                      )}
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</span>
                      {item.sublabel && (
                        <span style={{
                          flexShrink: 1, minWidth: 0, maxWidth: 200, fontSize: 11, color: "var(--fg-muted)",
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>
                          {item.sublabel}
                        </span>
                      )}
                      {item.active && <span style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600, flexShrink: 0, marginLeft: 6 }}>✓</span>}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>

      {/* 浮层动画 */}
      <style>{`
        @keyframes palette-in {
          from { opacity: 0; transform: translateY(-8px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
