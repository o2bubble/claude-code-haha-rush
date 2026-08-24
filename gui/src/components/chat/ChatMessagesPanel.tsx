import React, { memo, useState, useCallback, useMemo } from "react";
import { Search, User } from "lucide-react";
import { getChatState } from "../../stores/chatStore";
import { useChatBridge } from "./useChatBridge";
import { MessageList } from "./MessageList";
import { MessageSearchDialog } from "./MessageSearchDialog";
import { TimeLineBar } from "./TimeLineBar";
import { useBackend } from "../../services/backendService";
import { useEvent } from "../../services/useService";
import { Events, type ChatStateChangedPayload, type SettingsChangedPayload } from "../../services/events";
import { t } from "../../i18n";

function ChatMessagesPanelImpl() {
  const payload = useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED);
  const state = payload?.state ?? getChatState();
  const backend = useBackend();
  const settingsPayload = useEvent<SettingsChangedPayload>(Events.SETTINGS_CHANGED);
  // 时间线导航栏默认关闭，需在设置中手动开启
  const showTimeline = settingsPayload?.settings?.messageTimeline ?? false;
  const [manualPort, setManualPort] = useState(4889);
  const [showSearch, setShowSearch] = useState(false);
  const [userOnly, setUserOnly] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<{ index: number; seq: number } | null>(null);

  const jumpTo = useCallback((index: number) => {
    setScrollTarget((prev) => ({ index, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  // 时间线栏需要递增的消息时间戳（用于时间→索引二分定位）
  const messageTimestamps = useMemo(
    () => state.messages.map((m) => m.timestamp),
    [state.messages]
  );

  useChatBridge(backend.port);

  const showBanner = backend.status === "starting" || backend.status === "stopped";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
      {backend.status === "starting" && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "6px 12px", backgroundColor: "var(--bg-active)",
          borderBottom: "1px solid var(--accent)", fontSize: 12,
          fontFamily: "var(--font-sans)", color: "var(--accent)",
        }}>
          <span>{t("chat.startingBackend")}</span>
          <div style={{
            width: 12, height: 12,
            border: "2px solid var(--accent)", borderTopColor: "transparent",
            borderRadius: "50%", animation: "spin 1s linear infinite",
          }} />
        </div>
      )}

      {backend.status === "error" && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "6px 12px", backgroundColor: "var(--semantic-warning-subtle)",
          borderBottom: "1px solid var(--semantic-warning)", fontSize: 12,
          fontFamily: "var(--font-sans)",
        }}>
          <span>{backend.error || t("chat.backendError")}</span>
        </div>
      )}

      {backend.status === "running" && !!backend.port && !state.connected && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "6px 12px", backgroundColor: "var(--bg-active)",
          borderBottom: "1px solid var(--accent)", fontSize: 12,
          fontFamily: "var(--font-sans)", color: "var(--accent)",
        }}>
          <span>{t("chat.connectingBackend")}</span>
          <div style={{
            width: 12, height: 12,
            border: "2px solid var(--accent)", borderTopColor: "transparent",
            borderRadius: "50%", animation: "spin 1s linear infinite",
          }} />
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {showTimeline && messageTimestamps.length > 0 && (
          <TimeLineBar timestamps={messageTimestamps} onSeek={jumpTo} />
        )}

        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
          <MessageList
            key={`${state.sessionId ?? "no-session"}-${userOnly ? "user" : "all"}`}
            messages={state.messages}
            scrollTarget={scrollTarget}
            onlyUser={userOnly}
          />

          {/* 浮动工具 — 消息区右上角：只看用户消息 toggle + 搜索 */}
          <button
            type="button"
            onClick={() => setUserOnly((v) => !v)}
            title={userOnly ? t("message.showAllMessages") : t("message.onlyUser")}
            aria-label={userOnly ? t("message.showAllMessages") : t("message.onlyUser")}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.7")}
            style={{
              position: "absolute", top: 8, right: 40, zIndex: 10,
              display: "flex", alignItems: "center", justifyContent: "center",
              border: userOnly ? "1px solid var(--accent)" : "1px solid var(--border-medium)",
              background: userOnly ? "var(--accent-subtle)" : "var(--bg-surface)",
              borderRadius: 6, cursor: "pointer", padding: 4,
              color: userOnly ? "var(--accent)" : "var(--fg-secondary)",
              boxShadow: "var(--shadow-sm)", opacity: userOnly ? 1 : 0.7,
              transition: "opacity 0.15s",
            }}
          >
            <User size={13} />
          </button>
          <button
            type="button"
            onClick={() => setShowSearch(true)}
            title={t("message.search")}
            aria-label={t("message.search")}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.7")}
            style={{
              position: "absolute", top: 8, right: 8, zIndex: 10,
              display: "flex", alignItems: "center", justifyContent: "center",
              border: "1px solid var(--border-medium)", background: "var(--bg-surface)",
              borderRadius: 6, cursor: "pointer", padding: 4,
              color: "var(--fg-secondary)", boxShadow: "var(--shadow-sm)",
              opacity: 0.7, transition: "opacity 0.15s",
            }}
          >
            <Search size={13} />
          </button>
        </div>
      </div>

      {showSearch && (
        <MessageSearchDialog
          messages={state.messages}
          onJump={jumpTo}
          onClose={() => setShowSearch(false)}
        />
      )}
    </div>
  );
}
export const ChatMessagesPanel = memo(ChatMessagesPanelImpl);
