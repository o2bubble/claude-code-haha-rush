// ── 消息区全文搜索弹窗 — 搜整个会话内容，支持上一个/下一个跳转 ──

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronUp, ChevronDown, X, Search } from "lucide-react";
import { t } from "../../i18n";
import { searchMessages, cycleMatch } from "../../utils/messageSearch";
import type { ChatMessage } from "../../stores/chatStore";

interface Props {
  messages: ChatMessage[];
  onJump: (index: number) => void;
  onClose: () => void;
}

export function MessageSearchDialog({ messages, onJump, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => searchMessages(messages, query), [messages, query]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (current >= results.length) setCurrent(results.length > 0 ? results.length - 1 : 0);
  }, [results.length, current]);

  const go = (delta: 1 | -1) => {
    if (results.length === 0) return;
    const next = cycleMatch(current, results.length, delta);
    setCurrent(next);
    onJump(results[next].index);
  };

  const iconBtn: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "center",
    border: "1px solid var(--border-medium)", background: "var(--bg-root)",
    borderRadius: 4, cursor: "pointer", padding: "3px 6px", color: "var(--fg-secondary)",
  };

  return createPortal(
    <div
      data-od-id="message-search-dialog"
      style={{
        position: "fixed", top: "10vh", left: "50%", transform: "translateX(-50%)",
        zIndex: 100000, width: 480, maxWidth: "calc(100vw - 48px)",
        background: "var(--bg-root)", border: "1px solid var(--border-medium)",
        borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-lg)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {/* 输入行 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border-light)" }}>
        <span style={{ color: "var(--fg-muted)", flexShrink: 0, display: "flex" }}><Search size={14} /></span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setCurrent(0); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") go(e.shiftKey ? -1 : 1);
            if (e.key === "Escape") onClose();
          }}
          placeholder={t("message.searchPlaceholder")}
          style={{
            flex: 1, border: "none", outline: "none", background: "transparent",
            fontSize: 13, fontFamily: "inherit", color: "var(--fg-primary)",
          }}
        />
        {results.length > 0 && (
          <span style={{ fontSize: 11, color: "var(--fg-muted)", flexShrink: 0 }}>
            {current + 1}/{results.length}
          </span>
        )}
        <button type="button" onClick={() => go(-1)} title={t("message.searchPrev")} aria-label={t("message.searchPrev")} style={iconBtn}><ChevronUp size={13} /></button>
        <button type="button" onClick={() => go(1)} title={t("message.searchNext")} aria-label={t("message.searchNext")} style={iconBtn}><ChevronDown size={13} /></button>
        <button type="button" onClick={onClose} title={t("message.close")} aria-label={t("message.close")} style={iconBtn}><X size={13} /></button>
      </div>

      {/* 结果列表：没搜索时为空 */}
      {query.trim() !== "" && (
        <div style={{ maxHeight: 260, overflowY: "auto", padding: "4px 0" }}>
          {results.length === 0 ? (
            <div style={{ padding: "20px 16px", textAlign: "center", color: "var(--fg-muted)", fontSize: 12 }}>
              {t("message.searchNoResults")}
            </div>
          ) : (
            results.map((r, i) => (
              <div
                key={i}
                title={r.snippet}
                onClick={() => { setCurrent(i); onJump(r.index); }}
                style={{
                  padding: "6px 12px", cursor: "pointer", fontSize: 12,
                  color: i === current ? "var(--accent)" : "var(--fg-primary)",
                  background: i === current ? "var(--bg-active)" : "transparent",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}
              >
                <span style={{ color: "var(--fg-muted)", marginRight: 6, fontSize: 10 }}>#{r.index}</span>
                {r.snippet}
              </div>
            ))
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
