// ── 挂件里的消息列表 ──
//
// 刻意**不用 MessageList**（它带虚拟滚动、时间线栏、划词工具栏、搜索 ——
// 挂件上限 20 条，那些都是负担）。这里只需要：滚动容器 + 贴底跟随 + 空态。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { WidgetMessage } from "./WidgetMessage";
import { t } from "../../i18n";
import type { ChatMessage } from "../../stores/chatStore";

export function WidgetMessageList({ messages, streaming }: {
  messages: ChatMessage[];
  streaming: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // 是否贴底跟随：默认跟随；用户往上翻看时暂停（否则新消息会把他拽回底部）
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      // 距底 24px 内视为"在底部"（留点余量，避免像素级抖动导致判定反复）
      setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // 用 layoutEffect：在浏览器绘制前滚，避免看到"先跳一下再回到底"
  useLayoutEffect(() => {
    if (!follow) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, follow]);

  const lastId = messages.length > 0 ? messages[messages.length - 1].id : null;

  return (
    <div
      ref={ref}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: "10px 12px 4px",
        // 滚动条在这么小的窗里很扎眼，收窄它
        scrollbarWidth: "thin",
      }}
    >
      {messages.length === 0 ? (
        <div style={{
          height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
          // 用 secondary 而非 muted：深底上 muted 太暗（可读性实测反馈）
          color: "var(--fg-secondary)", fontSize: 12, fontFamily: "var(--font-sans)",
        }}>
          {t("widget.empty")}
        </div>
      ) : (
        messages.map((m) => (
          <WidgetMessage
            key={m.id}
            message={m}
            // 只有最后一条且正在流式时才画光标
            streaming={streaming && m.id === lastId && m.role !== "user"}
          />
        ))
      )}
    </div>
  );
}
