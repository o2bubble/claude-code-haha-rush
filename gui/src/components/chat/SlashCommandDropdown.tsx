import { useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n";
import { windowBus } from "../../services/windowBus";
import { Events } from "../../services/events";
import type { SlashCommand } from "../../stores/chatStore";

interface Props {
  commands: SlashCommand[];
  filter: string;
  highlightIndex: number;
  onHighlight: (index: number) => void;
  onSelect: (cmd: string) => void;
  onClose: () => void;
  anchorTop: number;
  anchorLeft: number;
}

export function SlashCommandDropdown({ commands, filter, highlightIndex, onHighlight, onSelect, onClose, anchorTop, anchorLeft }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  const list = (commands ?? []).filter((c) => c && c.cmd);
  const lowerFilter = filter.toLowerCase();
  const filtered = list.filter(
    (c) => c.cmd.includes(filter) || (c.desc && c.desc.toLowerCase().includes(lowerFilter))
  );

  const select = useCallback((cmd: string) => {
    onSelect(cmd);
    onClose();
  }, [onSelect, onClose]);

  // Auto-scroll highlighted item into view
  useEffect(() => {
    if (listRef.current) {
      const items = listRef.current.children;
      if (items[highlightIndex]) {
        (items[highlightIndex] as HTMLElement).scrollIntoView({ block: "nearest" });
      }
    }
  }, [highlightIndex]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const t = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  if (filtered.length === 0) return null;

  const top = Math.min(anchorTop, window.innerHeight - 320);
  const left = Math.max(8, Math.min(anchorLeft, window.innerWidth - 320));

  return createPortal(
    <div
      ref={listRef}
      style={{
        position: "fixed",
        top,
        left,
        width: 300,
        maxHeight: 300,
        overflow: "auto",
        backgroundColor: "var(--bg-root)",
        border: "1px solid var(--border-medium)",
        borderRadius: 6,
        boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
        zIndex: 10000,
        padding: "4px 0",
        outline: "none",
      }}
    >
      {filtered.map((cmd, i) => (
        <div
          key={cmd.cmd}
          onMouseEnter={() => onHighlight(i)}
          onClick={() => select(cmd.cmd)}
          style={{
            padding: "5px 12px",
            cursor: "pointer",
            fontSize: 12,
            fontFamily: "var(--font-sans)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            backgroundColor: i === highlightIndex ? "var(--accent-subtle)" : "transparent",
            color: i === highlightIndex ? "var(--accent)" : "var(--fg-primary)",
          }}
        >
          <span style={{ fontWeight: 600, flexShrink: 0 }}>/{cmd.cmd}</span>
          <span style={{ color: "var(--fg-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {cmd.desc}
          </span>
        </div>
      ))}

      {/* 升级入口 — 在命令面板中搜索更多 */}
      <div
        onClick={() => {
          windowBus.emit(Events.COMMAND_PALETTE_OPEN, { query: filter });
          onClose();
        }}
        style={{
          marginTop: 4,
          padding: "6px 12px",
          cursor: "pointer",
          fontSize: 11,
          fontFamily: "var(--font-sans)",
          color: "var(--fg-muted)",
          borderTop: "1px solid var(--border-light)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span style={{ opacity: 0.7 }}>⌕</span>
        <span>{t("commandPalette.searchMore")}</span>
      </div>
    </div>,
    document.body,
  );
}
