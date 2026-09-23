// ── 挂件里的单条消息 ──
//
// 刻意**不复用 MessageItem**（675 行）：它带着挂件没有或不该有的依赖 ——
// TranslateButton（走 askSideQuestion，而回包只由主窗的 dispatch 拦截 →
// 挂件里那个 Promise 永远不 resolve，120s 后超时）、activatePanel / desktopStore /
// openPathInEditor（挂件没有布局树与桌面）。挂件只要"能读就行"。
//
// assistant 用 renderMarkdownPreview（纯函数、已转义裸 HTML，与编辑器预览同一套）；
// user 用纯文本 pre-wrap —— 用户自己打的东西不需要再渲染一遍。

import { useMemo } from "react";
import { renderMarkdownPreview } from "../../utils/markdownPreview";
import type { ChatMessage } from "../../stores/chatStore";

export function WidgetMessage({ message, streaming }: {
  message: ChatMessage;
  /** 这条正在流式输出（末尾跟一个光标） */
  streaming?: boolean;
}) {
  const isUser = message.role === "user";
  const html = useMemo(
    () => (isUser ? "" : renderMarkdownPreview(message.content || "")),
    [isUser, message.content],
  );

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        marginBottom: 8,
      }}
    >
      <div
        style={{
          maxWidth: "86%",
          padding: isUser ? "6px 10px" : "4px 2px",
          borderRadius: isUser ? 10 : 0,
          // 用户气泡给一点底色区分"我说的"；AI 回复直接铺在透明底上（更像聊天软件）
          backgroundColor: isUser ? "rgba(255,255,255,0.12)" : "transparent",
          color: "var(--fg-primary)",
          fontFamily: "var(--font-sans)",
          fontSize: "calc(var(--font-scale, 1) * 13px)",
          lineHeight: 1.55,
          whiteSpace: isUser ? "pre-wrap" : undefined,
          overflowWrap: "anywhere",
        }}
      >
        {isUser ? (
          message.content
        ) : (
          <>
            <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
            {streaming && (
              // 流式光标：让"还在输出"看得见（挂件窗口小，没有状态栏可用）
              <span style={{ opacity: 0.55, animation: "blink 1s step-end infinite" }}>▍</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
