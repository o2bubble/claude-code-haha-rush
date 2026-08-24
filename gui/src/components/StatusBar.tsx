// ── StatusBar — 纯历史日志（Toast 已接管前台通知）──

import { memo, useState, useEffect, useRef } from "react";
import { t } from "../i18n";
import { useClickOutside } from "../utils/useClickOutside";
import {
  getStatusMessages,
  subscribeStatusMessages,
  type StatusMessage,
} from "../stores/statusMsgStore";
import { STATUS_LEVEL_COLOR } from "../utils/statusLevels";

const LEVEL_ICON: Record<string, string> = {
  info: "\u2139\uFE0F",   // ℹ️
  warn: "\u26A0\uFE0F",   // ⚠️
  error: "\u274C",        // ❌
  success: "\u2705",      // ✅
};

// LEVEL_COLOR 已由 STATUS_LEVEL_COLOR 统一提供

function _StatusBar() {
  const [expanded, setExpanded] = useState(false);
  const [msgs, setMsgs] = useState<StatusMessage[]>(getStatusMessages());
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return subscribeStatusMessages(() => {
      setMsgs([...getStatusMessages()]);
    });
  }, []);

  useClickOutside(panelRef, expanded, () => setExpanded(false));

  return (
    <div ref={panelRef} style={{ flexShrink: 0 }}>
      {/* Expanded message list */}
      {expanded && (
        <div style={{
          maxHeight: 200, overflow: "auto",
          borderTop: "1px solid var(--border-light)",
          backgroundColor: "var(--bg-surface)",
          fontFamily: "var(--font-sans)", fontSize: "calc(var(--font-scale, 1) * 11px)",
        }}>
          {msgs.length === 0 ? (
            <div style={{
              padding: 12, color: "#bbb", textAlign: "center",
            }}>
              {t("status.noMessages")}
            </div>
          ) : (
            msgs.map((m) => (
              <div key={m.id} style={{
                display: "flex", alignItems: "flex-start", gap: 6,
                padding: "3px 10px", borderBottom: "1px solid var(--border-light)",
                color: STATUS_LEVEL_COLOR[m.level] || "var(--fg-muted)",
              }}>
                <span style={{ flexShrink: 0, fontSize: 10 }}>
                  {LEVEL_ICON[m.level] || ""}
                </span>
                <span style={{ flex: 1, wordBreak: "break-word" }}>
                  {m.text}
                </span>
                <span style={{ flexShrink: 0, color: "var(--fg-muted)", fontSize: 10, opacity: 0.7 }}>
                  {new Date(m.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Entry bar — opens history log */}
      <div
        onClick={() => setExpanded(!expanded)}
        title={t("status.title")}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "0 10px", height: 24,
          borderTop: "1px solid var(--border-light)",
          backgroundColor: "var(--bg-surface)",
          fontFamily: "var(--font-sans)", fontSize: "calc(var(--font-scale, 1) * 11px)",
          color: "var(--fg-muted)", cursor: "pointer", userSelect: "none",
        }}
      >
        <span style={{ fontSize: 10, flexShrink: 0 }}>{"\u25C8"}</span>
        <span style={{ flexShrink: 0 }}>{t("status.title")}</span>
        {msgs.length > 0 && (
          <span style={{ color: "var(--fg-muted)", fontSize: 10, flexShrink: 0 }}>
            ({msgs.length})
          </span>
        )}
        <span style={{ fontSize: 10, color: "var(--fg-muted)", flexShrink: 0, marginLeft: "auto", opacity: 0.7 }}>
          {expanded ? "\u25BC" : "\u25B2"}
        </span>
      </div>
    </div>
  );
}
export default memo(_StatusBar);
