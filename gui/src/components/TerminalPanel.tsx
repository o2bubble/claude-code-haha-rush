import { useEffect, useLayoutEffect, useRef, useCallback, useState } from "react";
import { shouldScrollTabBar } from "./terminalTabBar";
import { createRenderScheduler } from "./chat/terminalRender";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Trash2, X } from "lucide-react";
import {
  getEntries, getActiveEntryId, setActiveEntryId,
  clear, removeEntry, type TerminalEntry,
} from "../stores/terminalStore";
import { useEventHandler } from "../services/useService";
import { Events, type TerminalChangedPayload } from "../services/events";
import { getSettings } from "../stores/settingsStore";
import { isDarkTheme } from "../utils/themeUtils";
import { t } from "../i18n";
import "@xterm/xterm/css/xterm.css";

/* ── Build xterm.js theme from CSS tokens ── */
function getTerminalTheme() {
  // Catppuccin Mocha — high contrast, well-tested terminal theme
  const isDark = typeof document !== "undefined" && isDarkTheme(document.documentElement.dataset.theme);
  return isDark ? {
    // Dark: Catppuccin Mocha
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    cursor: "#f5e0dc",
    selectionBackground: "#585b70",
    black:   "#45475a",
    red:     "#f38ba8",
    green:   "#a6e3a1",
    yellow:  "#f9e2af",
    blue:    "#89b4fa",
    magenta: "#cba6f7",
    cyan:    "#94e2d5",
    white:   "#bac2de",
    brightBlack:   "#585b70",
    brightRed:     "#f38ba8",
    brightGreen:   "#a6e3a1",
    brightYellow:  "#f9e2af",
    brightBlue:    "#89b4fa",
    brightMagenta: "#cba6f7",
    brightCyan:    "#94e2d5",
    brightWhite:   "#a6adc8",
  } : {
    // Light: Catppuccin Latte
    background: "#eff1f5",
    foreground: "#4c4f69",
    cursor: "#dc8a78",
    selectionBackground: "#acb0be",
    black:   "#bcc0cc",
    red:     "#d20f39",
    green:   "#40a02b",
    yellow:  "#df8e1d",
    blue:    "#1e66f5",
    magenta: "#8839ef",
    cyan:    "#179299",
    white:   "#5c5f77",
    brightBlack:   "#9ca0b0",
    brightRed:     "#d20f39",
    brightGreen:   "#40a02b",
    brightYellow:  "#df8e1d",
    brightBlue:    "#1e66f5",
    brightMagenta: "#8839ef",
    brightCyan:    "#179299",
    brightWhite:   "#6c6f85",
  };
}

export default function TerminalPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);

  const renderActive = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    term.reset();
    const activeId = getActiveEntryId();
    if (!activeId) return;
    const entry = getEntries().find((e) => e.id === activeId);
    if (!entry) return;
    renderEntry(term, entry);
    try { term.scrollToBottom(); } catch {}
  }, []);

  const renderActiveRef = useRef(renderActive);
  renderActiveRef.current = renderActive;

  // xterm 的 write 是异步的、reset 是同步的 —— 流式输出时每个事件都直接重绘，
  // 会让内部队列堆积多份「reset + 全文」，画面出现重复（切标签即恢复，因为那时
  // 输出已停）。改为合并重绘：同一帧内多次事件只渲染一次。见 terminalRender.ts。
  const schedulerRef = useRef<ReturnType<typeof createRenderScheduler> | null>(null);
  if (!schedulerRef.current) {
    schedulerRef.current = createRenderScheduler(() => renderActiveRef.current());
  }

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      fontSize: getSettings().terminalFontSize ?? 13,
      fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, 'Courier New', monospace",
      theme: getTerminalTheme(),
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    schedulerRef.current?.flush(); // 挂载首帧立即渲染

    const observer = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch {}
    });
    observer.observe(containerRef.current);

    // Watch for theme changes and update terminal colors
    const themeObserver = new MutationObserver(() => {
      term.options.theme = getTerminalTheme();
      try { term.refresh(0, term.rows - 1); } catch {}
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      schedulerRef.current?.cancel(); // 卸载后别再往已 dispose 的 term 上写
      themeObserver.disconnect();
      observer.disconnect();
      term.dispose();
    };
  }, []);

  useEventHandler<TerminalChangedPayload>(Events.TERMINAL_CHANGED, () => {
    setTick((t) => t + 1);
    schedulerRef.current?.request(); // 合并重绘（见上）
  });

  const handleClear = () => {
    const term = termRef.current;
    if (term) term.reset();
    clear();
    setTick((t) => t + 1);
  };

  const entries = getEntries();
  const activeId = getActiveEntryId();

  // Auto-scroll the tab bar to the newest tab when a terminal tab is added —
  // without it, accumulated tabs overflow out of view (overflow-x was hidden)
  // and the user can't reach the later ones. Also scroll on first mount when
  // tabs already exist (they can accumulate while the panel is hidden), and
  // use layout effect so no left-aligned flash before paint.
  const prevTabCount = useRef(entries.length);
  const hasMountedRef = useRef(false);
  useLayoutEffect(() => {
    const el = tabBarRef.current;
    if (!el) return;
    const should = shouldScrollTabBar(prevTabCount.current, entries.length, hasMountedRef.current);
    prevTabCount.current = entries.length;
    hasMountedRef.current = true;
    if (should) el.scrollLeft = el.scrollWidth;
  }, [entries.length]);

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Tab bar */}
      {entries.length > 0 && (
        <div style={{
          display: "flex",
          alignItems: "center",
          height: 28,
          backgroundColor: "var(--bg-surface)",
          borderBottom: "1px solid var(--border-medium)",
          flexShrink: 0,
          gap: 0,
        }}>
          {/* Scrollable tabs */}
          <div
            ref={tabBarRef}
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              overflowX: "auto",
              overflowY: "hidden",
              height: "100%",
            }}
          >
            {entries.map((entry) => {
              const isActive = entry.id === activeId;
              const cmd = entry.command.length > 25 ? entry.command.slice(0, 25) + "..." : entry.command;
              const isRunning = entry.exitCode === null;
              const dotColor = isRunning ? "#e5e510" : entry.exitCode === 0 ? "#0dbc79" : "#cd3131";
              return (
                <div
                  key={entry.id}
                  onClick={() => { setActiveEntryId(entry.id); }}
                  title={entry.command}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    height: "100%",
                    padding: "0 6px 0 10px",
                    cursor: "pointer",
                    userSelect: "none",
                    backgroundColor: isActive ? "var(--bg-root)" : "transparent",
                    borderBottom: isActive ? "2px solid var(--accent)" : "none",
                    borderRight: "1px solid var(--border-light)",
                    gap: 5,
                    fontSize: 11,
                    fontFamily: "var(--font-sans)",
                    color: isActive ? "var(--fg-primary)" : "var(--fg-muted)",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                    maxWidth: 200,
                  }}
                >
                  <span style={{
                    width: 6, height: 6, borderRadius: "50%",
                    backgroundColor: dotColor, flexShrink: 0,
                  }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{cmd}</span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeEntry(entry.id); }}
                    style={{
                      border: "none", background: "none", cursor: "pointer",
                      padding: 0, display: "flex", alignItems: "center",
                      color: "var(--fg-secondary)", flexShrink: 0,
                    }}
                    title={t("terminal.closeTab")}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
          {/* Clear all — fixed, always visible */}
          <button
            type="button"
            onClick={handleClear}
            title={t("terminal.clearAll")}
            style={{
              marginRight: 4,
              marginLeft: 4,
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              background: "var(--bg-hover)",
              color: "var(--fg-muted)",
              width: 22,
              height: 22,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}
      {/* Terminal */}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <div
          ref={containerRef}
          style={{
            width: "100%",
            height: "100%",
            backgroundColor: "var(--bg-root)",
          }}
        />
        {/* Empty state overlay */}
        {entries.length === 0 && (
          <div style={{
            position: "absolute",
            inset: 0,
            backgroundColor: "var(--bg-root)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            color: "var(--fg-secondary)",
            fontSize: 12,
            fontFamily: "var(--font-sans)",
            userSelect: "none",
            pointerEvents: "none",
            zIndex: 1,
          }}>
            <span style={{ fontSize: 28, opacity: 0.2 }}>▸</span>
            <span style={{ opacity: 0.4 }}>{t("terminal.waitingForAgent")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function renderEntry(term: Terminal, entry: TerminalEntry) {
  term.writeln(`\x1b[1;36m$\x1b[0m \x1b[1;33m${entry.command}\x1b[0m`);
  if (entry.output) {
    const raw = entry.output.split("\n");
    const lines = raw.length > 1 && raw[raw.length - 1] === "" ? raw.slice(0, -1) : raw;
    for (const line of lines) {
      term.writeln(`  ${line}`);
    }
  }
  if (entry.exitCode !== null) {
    const color = entry.exitCode === 0 ? "\x1b[32m" : "\x1b[31m";
    term.writeln(`${color}[exit: ${entry.exitCode}]\x1b[0m`);
  }
  term.writeln("");
}
