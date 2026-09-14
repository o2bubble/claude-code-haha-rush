import React, { memo, useState, useCallback, useMemo } from "react";
import { Search, User } from "lucide-react";
import { getChatState } from "../../stores/chatStore";
import { useChatBridge } from "./useChatBridge";
import { MessageList } from "./MessageList";
import { MessageSearchDialog } from "./MessageSearchDialog";
import { TimeLineBar } from "./TimeLineBar";
import { promptPreview, type UserPrompt } from "./timelineMath";
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
  // 默认 true（该功能已完善，默认开启体验）。老用户由启动期迁移写入实值；
  // 用户手动关闭写 false，此后再也不会被翻回（迁移只补「字段缺失」）。
  const showTimeline = settingsPayload?.settings?.messageTimeline ?? true;
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

  // 用户提示刻度：回溯"我在哪儿说过什么"（悬停显示预览）。preview 已折叠空白/截断。
  const userPrompts = useMemo(() => {
    const out: UserPrompt[] = [];
    state.messages.forEach((m, i) => {
      if (m.role !== "user") return;
      out.push({ index: i, time: m.timestamp, preview: promptPreview(m.content) });
    });
    return out;
  }, [state.messages]);

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
          <TimeLineBar timestamps={messageTimestamps} onSeek={jumpTo} userPrompts={userPrompts} />
        )}

        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
          <MessageList
            key={`${state.sessionId ?? "no-session"}-${userOnly ? "user" : "all"}`}
            messages={state.messages}
            scrollTarget={scrollTarget}
            onlyUser={userOnly}
          />

          {/* 浮动工具 — 消息区右上角：只看用户消息 toggle + 搜索。
              按钮会浮在消息之上，必须保证在**任何背景下**都看得见 ——
              尤其开启筛选后满屏都是用户消息，而用户气泡是 `var(--accent)` 实底
              （MessageItem.tsx:578），此前按钮也用 accent 系（描边+accent-subtle）
              就糊在一起、视觉上"消失"（用户实测反馈）。

              修法：背景一律用**不透明的 `var(--bg-root)`**（暗色近黑 / 亮色纯白），
              与蓝气泡形成明暗反差；激活态改用 accent 描边 + accent 图标来
              表达"已开启"，而不是靠填充色（填充色必须留给对比）。
              静止态 0.7 透明度是为了不抢内容，激活态恒为 1。 */}
          <button
            type="button"
            onClick={() => setUserOnly((v) => !v)}
            title={userOnly ? t("message.showAllMessages") : t("message.onlyUser")}
            aria-label={userOnly ? t("message.showAllMessages") : t("message.onlyUser")}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = userOnly ? "1" : "0.7")}
            style={{
              position: "absolute", top: 8, right: 40, zIndex: 10,
              display: "flex", alignItems: "center", justifyContent: "center",
              border: userOnly ? "1px solid var(--accent)" : "1px solid var(--border-medium)",
              background: "var(--bg-root)",
              borderRadius: 6, cursor: "pointer", padding: 4,
              color: userOnly ? "var(--accent)" : "var(--fg-secondary)",
              boxShadow: "var(--shadow-sm)", opacity: userOnly ? 1 : 0.7,
              transition: "opacity 0.15s, border-color 0.15s, color 0.15s",
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
