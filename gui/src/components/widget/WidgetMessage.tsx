// ── 挂件里的单条消息 ──
//
// 刻意**不复用 MessageItem**（675 行）：它带着挂件没有或不该有的依赖 ——
// TranslateButton（走 askSideQuestion，而回包只由主窗的 dispatch 拦截 →
// 挂件里那个 Promise 永远不 resolve，120s 后超时）、activatePanel / desktopStore /
// openPathInEditor（挂件没有布局树与桌面）。挂件只要"能读就行"。
//
// assistant 用 renderMarkdownPreview（纯函数、已转义裸 HTML，与编辑器预览同一套）；
// user 用纯文本 pre-wrap —— 用户自己打的东西不需要再渲染一遍。
//
// 🔴 **工具块是精简版**（2026-10-26 加）：
// 之前挂件只渲染 `message.content` 文本，`toolUses` 完全没画 ——
// 用户看到 AI 说"我来执行一下"然后就**没了**，不知道 Bash 跑了什么、
// MCP 工具调了什么。现在每条工具显示「名称 + 一句话摘要 + 状态点」，
// 不展开、不可点（挂件就 400 宽，详情回主窗看）。

import { useMemo } from "react";
import { renderMarkdownPreview } from "../../utils/markdownPreview";
import type { ChatMessage, ToolUse } from "../../stores/chatStore";
import { prettyToolName, toolSummary } from "./widgetToolSummary";

/** 单条工具的紧凑行 —— 名称 + 摘要 + 状态点 */
function ToolRow({ tool }: { tool: ToolUse }) {
  const name = prettyToolName(tool.name);
  const summary = toolSummary(tool);
  const running = tool.status === "running" || tool.status === "pending";
  const error = tool.status === "error";

  // 用主题变量，跟挂件其它部分一致（挂件会随主窗主题切换）
  const dotColor = error
    ? "var(--semantic-error)"
    : running
      ? "var(--semantic-warning)"
      : "var(--fg-muted)";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 6,
        padding: "3px 8px",
        marginBottom: 3,
        borderLeft: `2px solid ${dotColor}`,
        backgroundColor: "rgba(127,127,127,0.08)",
        borderRadius: 3,
        fontSize: "calc(var(--font-scale, 1) * 11.5px)",
        lineHeight: 1.45,
        overflow: "hidden",
      }}
      title={summary || name}
    >
      {/* 状态点：running 时轻微闪烁，让"还在跑"看得见 */}
      <span
        style={{
          color: dotColor,
          flexShrink: 0,
          fontSize: 9,
          // `app-blink` 是 tokens.css 里真实存在的 keyframes。
          // （原来写的是 `blink` —— 那个名字从来没定义过，光标其实一直不闪。）
          ...(running ? { animation: "app-blink 1.2s ease-in-out infinite" } : null),
        }}
      >
        {running ? "●" : error ? "✕" : "·"}
      </span>
      <span style={{ fontWeight: 600, flexShrink: 0, color: "var(--fg-primary)" }}>{name}</span>
      {summary && (
        <span
          style={{
            color: "var(--fg-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
            fontSize: "calc(var(--font-scale, 1) * 10.5px)",
          }}
        >
          {summary}
        </span>
      )}
    </div>
  );
}

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

  // 同一 id 可能重复出现（流式增量），按 id 去重保留最后一条
  const tools = useMemo(() => {
    const list = message.toolUses ?? [];
    if (!list.length) return [];
    const seen = new Map<string, ToolUse>();
    for (const t of list) seen.set(t.id || `${t.name}-${t.index}`, t);
    return Array.from(seen.values());
  }, [message.toolUses]);

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
          // 工具行有左边框，容器要能撑满
          minWidth: 0,
        }}
      >
        {isUser ? (
          message.content
        ) : (
          <>
            {/* 工具块放在正文**前面** —— 和真实发生的顺序一致：
                AI 通常先说一句 → 调工具 → 再说结论。文字在下面更自然。 */}
            {tools.length > 0 && (
              <div style={{ marginBottom: message.content ? 6 : 2, alignSelf: "stretch" }}>
                {tools.map((t) => (
                  <ToolRow key={t.id || `${t.name}-${t.index}`} tool={t} />
                ))}
              </div>
            )}
            {message.content ? (
              <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
            ) : null}
            {streaming && (
              // 流式光标：让"还在输出"看得见（挂件窗口小，没有状态栏可用）
              <span style={{ opacity: 0.55, animation: "app-blink 1s step-end infinite" }}>▍</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
