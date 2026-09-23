import React, { useState, useEffect, useRef, useMemo } from "react";
import type { ChatMessage } from "../../stores/chatStore";
import { dedupTools } from "../../utils/dedupTools";
import { parseReferences } from "../../utils/referenceParser";
import { ReferenceLink } from "./ReferenceLink";
import { activatePanel } from "../../stores/layoutStore";
import { openPathInEditor } from "../../services/referenceActions";
import { TranslateButton } from "./TranslateButton";
import { getDesktops, addItem, findSmartPlace, panToItem } from "../../stores/desktopStore";
import { setSelection } from "../desktop/selectionStore";
import { isDarkTheme } from "../../utils/themeUtils";
import { t } from "../../i18n";
import { highlightCode } from "../../utils/highlight";
import { formatMessageTime } from "./messageTime";
import { useEvent } from "../../services/useService";
import { Events, type SettingsChangedPayload } from "../../services/events";

interface MessageItemProps {
  message: ChatMessage;
  /** 是否播放挂载淡入动画。虚拟滚动下滚动浏览历史不应重放动画,只有最新消息挂载时淡入。 */
  animateIn?: boolean;
}

const LONG_TEXT_THRESHOLD = 200;

function stripSystemReminder(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
}

/** Collapse long single-line text blocks (e.g. pasted logs) with expand toggle */
function CollapsibleText({ text, isUser }: { text: string; isUser: boolean }) {
  if (text.length <= LONG_TEXT_THRESHOLD) return <>{text}</>;
  const [expanded, setExpanded] = React.useState(false);
  const preview = text.slice(0, 80);
  const linkColor = isUser ? "#e0f0ff" : "var(--accent)";
  return (
    <span>
      {expanded ? (
        <span style={{ whiteSpace: "pre-wrap" }}>{text}</span>
      ) : (
        <span>{preview}…</span>
      )}
      {" "}
      <span
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: "pointer", color: linkColor, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
      >
        {expanded ? t("message.collapse") : t("message.showAll", { count: text.length })}
      </span>
    </span>
  );
}

function ClickableFilePath({ path, style }: { path: string; style?: React.CSSProperties }) {
  return (
    <span
      style={{ ...style, cursor: "pointer", textDecoration: "underline", textDecorationColor: "var(--semantic-info)", textUnderlineOffset: 3 }}
      title={`Click to open: ${path}`}
      onClick={() => void openPathInEditor(path, { silent: true })}
    >
      {path}
    </span>
  );
}

/**
 * 文件路径 → highlight.js 语言名。**空串表示"不高亮"**（走纯转义）。
 *
 * ⚠️ 映射漏了扩展名的代价**极其昂贵**：`highlightCode` 在 lang 为空时会退回
 * `hljs.highlightAuto()`，而那是 highlight.js 最慢的路径 —— 它要对**全部 192 个
 * 已注册语言**各试一遍。实测（2026-09-21）**单次 1026 字符的代码：指定语言 11ms，
 * highlightAuto 322ms（慢 29 倍）**。会话里一篇 135 个 Edit/Write 块，若 22 个
 * 落到 auto 上 → 约 7 秒纯卡在高亮上，表现为"切换会话要等好几秒"。
 * 所以这里宁可**多列常见扩展名**，也不让它们掉进 auto。
 *
 * 查漏方法：拿一个大会话的 jsonl，统计 Edit/Write 的 file_path 扩展名，
 * 看哪些没在这张表里（`scripts/` 下没有现成脚本，临时写个 node 统计即可）。
 */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", cjs: "javascript", mjs: "javascript",
  py: "python", pyi: "python", rs: "rust", go: "go",
  java: "java", kt: "kotlin", scala: "scala", swift: "swift", dart: "dart",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", php: "php", rb: "ruby", lua: "lua", pl: "perl", r: "r",
  css: "css", scss: "scss", less: "less", html: "xml", htm: "xml",
  vue: "xml", svelte: "xml", xml: "xml", svg: "xml",
  json: "json", jsonc: "json", json5: "json",
  yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", conf: "ini", cfg: "ini", env: "ini",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  sql: "sql", graphql: "graphql", gql: "graphql",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  ps1: "powershell", psm1: "powershell",
  bat: "dos", cmd: "dos",
  dockerfile: "dockerfile", makefile: "makefile", mk: "makefile",
  diff: "diff", patch: "diff",
  txt: "",         // 明确"不高亮"——**不要**让它掉进 auto
  log: "", gitignore: "", gitattributes: "", editorconfig: "",
};

/** 无扩展名但有名的文件（`Dockerfile` / `Makefile`）。 */
const NAME_TO_LANG: Record<string, string> = {
  dockerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile",
  ".gitignore": "", ".gitattributes": "", ".editorconfig": "", ".env": "ini",
};

function detectLang(filePath: string): string {
  const name = (filePath.split(/[/\\]/).pop() || "").toLowerCase();
  if (NAME_TO_LANG[name] !== undefined) return NAME_TO_LANG[name];
  const ext = name.includes(".") ? name.split(".").pop() || "" : "";
  // 未收录的扩展名返回 "" —— 与"明确不高亮"同义（见上：绝不能让未知落到 auto）
  return EXT_TO_LANG[ext] ?? "";
}

function FileDiffView({ filePath, oldStr, newStr, writeContent }: {
  filePath: string; oldStr: string; newStr: string; writeContent: string;
}) {
  const lang = detectLang(filePath);

  // Diff backgrounds follow the app theme so the old/new red-green contrast
  // stays visible on both. Dark: medium dark red/green (lighter than the old
  // near-black tones). Light: GitHub-style pale red/green.
  const isDark = typeof document !== "undefined" && isDarkTheme(document.documentElement.dataset.theme);
  const oldBg = isDark ? "#4f3434" : "#ffebe9";
  const newBg = isDark ? "#2f4433" : "#e6ffec";
  const diffText = isDark ? "#cdd6f4" : "#1f2328";
  const headerBg = isDark ? "#252526" : "#ececec";

  const oldHtml = useMemo(() => highlightCode(oldStr, lang), [oldStr, lang]);
  const newHtml = useMemo(() => highlightCode(newStr || writeContent, lang), [newStr, writeContent, lang]);

  const diffStyle = (bg: string): React.CSSProperties => ({
    margin: 0,
    padding: "8px 10px",
    fontSize: 11,
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    lineHeight: 1.5,
    backgroundColor: bg,
    color: diffText,
    borderRadius: 0,
    maxHeight: 250,
    overflow: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  });

  return (
    <div style={{ borderTop: "1px solid var(--border-light)" }}>
      {/* Header */}
      <div style={{
        padding: "3px 10px",
        fontSize: 11,
        fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
        color: "var(--semantic-info)",
        backgroundColor: headerBg,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}>
        <ClickableFilePath path={filePath} />
        {oldStr && newStr ? (
          <span style={{ color: "var(--fg-muted)", fontSize: 10 }}>
            <span style={{ color: "#f48771" }}>-{oldStr.split("\n").length}</span>
            {" "}
            <span style={{ color: "#89d185" }}>+{newStr.split("\n").length}</span>
          </span>
        ) : (
          <span style={{ color: "#89d185", fontSize: 10 }}>+{writeContent ? writeContent.split("\n").length : 0} lines</span>
        )}
      </div>
      {/* Diff body */}
      {oldStr && newStr ? (
        <div>
          <pre style={diffStyle(oldBg)} dangerouslySetInnerHTML={{ __html: oldHtml }} />
          <pre style={diffStyle(newBg)} dangerouslySetInnerHTML={{ __html: newHtml }} />
        </div>
      ) : (
        <pre style={diffStyle("var(--bg-code)")} dangerouslySetInnerHTML={{ __html: newHtml }} />
      )}
    </div>
  );
}

const actionBtnStyle: React.CSSProperties = {
  border: "none", background: "none", cursor: "pointer",
  fontSize: 10, color: "var(--fg-muted)", padding: "1px 6px", borderRadius: 3,
  fontFamily: "var(--font-sans)",
};

function ActionBtn({ label, onClick, children }: { label: string; onClick?: () => void; children?: React.ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const [showKids, setShowKids] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const openDropdown = () => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      // If button is in bottom 40% of viewport, open upward
      setDropUp(rect.bottom > window.innerHeight * 0.6);
    }
    setShowKids(true);
  };

  return (
    <span style={{ position: "relative" }}>
      <button
        ref={btnRef}
        style={{ ...actionBtnStyle, color: hovered ? "var(--fg-primary)" : "var(--fg-muted)", backgroundColor: hovered || showKids ? "var(--border-light)" : "transparent" }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={(e) => {
          e.stopPropagation();
          if (children) { openDropdown(); }
          else if (onClick) onClick();
        }}
      >
        {label}
      </button>
      {showKids && children && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 99998 }} onClick={() => setShowKids(false)} />
          <div style={{
            position: "absolute", right: 0, zIndex: 99999,
            backgroundColor: "var(--bg-root)", border: "1px solid var(--border-medium)",
            borderRadius: 4, boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            padding: "2px 0", minWidth: 120, whiteSpace: "nowrap",
            ...(dropUp
              ? { bottom: "100%", marginBottom: 4 }
              : { top: "100%", marginTop: 2 }),
          }}>
            {React.Children.map(children, (child) =>
              React.isValidElement(child)
                ? React.cloneElement(child as React.ReactElement<{ onClick?: () => void }>, {
                    onClick: () => {
                      (child.props as any).onClick?.();
                      setShowKids(false);
                    },
                  })
                : child
            )}
          </div>
        </>
      )}
    </span>
  );
}

function DropdownItem({ label, onClick }: { label: string; onClick: () => void }) {
  const [h, setH] = useState(false);
  return (
    <div
      style={{ padding: "4px 12px", fontSize: 11, fontFamily: "var(--font-sans)", cursor: "default", color: "var(--fg-primary)", backgroundColor: h ? "var(--bg-hover)" : "transparent" }}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      onClick={onClick}
    >{label}</div>
  );
}

function renderMarkdown(content: string): Promise<string> {
  // Returns a Promise that resolves with HTML-rendered markdown
  return import("marked").then(({ marked }) => {
    return marked.parse(content, { async: false }) as string;
  }).catch(() => {
    // Simple fallback: escape HTML and convert newlines to <br>
    return content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
  });
}

export function MessageItem({ message, animateIn = true }: MessageItemProps) {
  const isDark = typeof document !== "undefined" && isDarkTheme(document.documentElement.dataset.theme);
  const isUser = message.role === "user";
  // 消息时间显示跟随「消息时间线」开关：关闭时连消息块时间也不展示
  const settingsPayload = useEvent<SettingsChangedPayload>(Events.SETTINGS_CHANGED);
  const showMsgTime = settingsPayload?.settings?.messageTimeline ?? true;
  const [html, setHtml] = useState<string | null>(null);
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const outputRefs = useRef<Map<string, HTMLPreElement>>(new Map());
  const mdRef = useRef<HTMLDivElement>(null);
  const text = stripSystemReminder(message.content || "");

  // Parse references for inline rendering in user messages
  const contentSegments = useMemo(() => {
    const refs = parseReferences(text);
    if (refs.length === 0) return null;
    const segs: Array<{ type: "text" | "ref"; content: string; ref?: typeof refs[0] }> = [];
    let lastEnd = 0;
    for (const ref of refs) {
      if (ref.start > lastEnd) segs.push({ type: "text", content: text.slice(lastEnd, ref.start) });
      segs.push({ type: "ref", content: ref.raw, ref });
      lastEnd = ref.end;
    }
    if (lastEnd < text.length) segs.push({ type: "text", content: text.slice(lastEnd) });
    return segs;
  }, [text]);

  // Auto-collapse tool outputs when streaming ends
  const prevStreaming = useRef(message.streaming);
  useEffect(() => {
    if (prevStreaming.current && !message.streaming) {
      // Streaming just ended — collapse all outputs
      setExpandedTools({});
    }
    prevStreaming.current = message.streaming;
  }, [message.streaming]);

  // Auto-scroll inner output area when tool output changes during streaming
  const toolOutputKey = message.toolUses?.map((t: any) => `${t.id}:${t.output?.length}`).join("|");
  useEffect(() => {
    if (!message.toolUses) return;
    for (const t of message.toolUses) {
      const el = outputRefs.current.get(t.id);
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [toolOutputKey]);

  useEffect(() => {
    if (isUser || !text) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    renderMarkdown(text).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => { cancelled = true; };
  }, [message.content, isUser]);

  // 代码块 hover 复制按钮（markdown 是 dangerouslySetInnerHTML，需动态注入）
  useEffect(() => {
    const container = mdRef.current;
    if (!container) return;
    container.querySelectorAll(".md-code-copy").forEach((b) => b.remove());
    for (const pre of container.querySelectorAll<HTMLPreElement>("pre")) {
      const btn = document.createElement("span");
      btn.className = "md-code-copy";
      btn.textContent = t("message.copy");
      btn.style.cssText = `position:absolute;top:4px;right:6px;opacity:0;transition:opacity .15s;cursor:pointer;font-size:10px;padding:1px 7px;border-radius:3px;background:var(--bg-surface);border:1px solid var(--border-medium);color:var(--fg-secondary);z-index:2;font-family:var(--font-sans);user-select:none;`;
      btn.onclick = (e: MouseEvent) => {
        e.stopPropagation();
        // 复制按钮挂在 pre 内, textContent 会带上按钮文字(「复制」/「✓」),
        // 克隆后剔除按钮再取文本
        const clone = pre.cloneNode(true) as HTMLPreElement;
        clone.querySelectorAll(".md-code-copy").forEach((b) => b.remove());
        navigator.clipboard.writeText((clone.textContent ?? "").trimEnd()).catch(() => {});
        btn.textContent = "✓";
        setTimeout(() => { btn.textContent = t("message.copy"); }, 1200);
      };
      pre.style.position = "relative";
      pre.addEventListener("mouseenter", () => { btn.style.opacity = "1"; });
      pre.addEventListener("mouseleave", () => { btn.style.opacity = "0"; });
      pre.appendChild(btn);
    }
  }, [html, isDark]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: isUser ? "flex-end" : "flex-start",
        marginBottom: 12,
        animation: animateIn ? "msg-fade-in var(--transition-normal)" : "none",
      }}
    >
      {/* 消息时间（今天只显示时分，跨天带日期；随「消息时间线」开关控制） */}
      {showMsgTime && message.timestamp != null && (
        <div
          style={{
            fontSize: 10,
            color: "var(--fg-muted)",
            fontFamily: "var(--font-sans)",
            lineHeight: "14px",
            marginBottom: 2,
          }}
        >
          {formatMessageTime(message.timestamp, undefined, t("timeline.yesterday"))}
        </div>
      )}

      {/* Thinking block */}
      {message.thinking && (
        <details
          style={{
            marginBottom: 4,
            maxWidth: "85%",
          }}
        >
          <summary
            style={{
              fontSize: 11,
              color: "var(--fg-muted)",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            {t("message.thinking")}
          </summary>
          <div
            style={{
              fontSize: 12,
              color: "var(--fg-muted)",
              padding: "6px 10px",
              backgroundColor: "var(--bg-code)",
              borderRadius: 6,
              marginTop: 4,
              fontFamily: "var(--font-sans)",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxHeight: 200,
              overflow: "auto",
              border: "1px solid var(--border-light)",
            }}
          >
            {message.thinking}
          </div>
          {/* 翻译按钮放在**内容之后**（不在 summary 里）：summary 上的按钮会被
              <details> 的展开/收起抢占点击，而译文也需要空间展开 */}
          <TranslateButton text={message.thinking} style={{ marginTop: 2 }} />
        </details>
      )}

      {/* Tool use cards */}
      {dedupTools(message.toolUses).map((tool) => {
        const input = tool.input || {};
        const command = input.command || "";
        const description = input.description || "";
        const hasCommand = typeof command === "string" && command.length > 0;
        const hasDescription = typeof description === "string" && description.length > 0;
        const isBash = tool.name.toLowerCase().includes("bash") || tool.name.toLowerCase().includes("powershell");
        const isEdit = tool.name.toLowerCase().includes("edit") || tool.name.toLowerCase().includes("write");
        const isRead = tool.name.toLowerCase().includes("read");

        const nameMap: Record<string, string> = {
          BashTool: t("message.toolBash"),
          AgentTool: t("message.toolAgent"),
          FileEditTool: t("message.toolEdit"),
          FileReadTool: t("message.toolRead"),
          GrepTool: t("message.toolSearch"),
          GlobTool: t("message.toolFind"),
          Write: t("message.toolWrite"),
        };
        const displayName = nameMap[tool.name] || tool.name;

        // File path for edit/write/read tools
        const filePath: string = (input.file_path || input.filePath || "") as string;
        const oldStr: string = stripSystemReminder((input.old_string || input.old_str || "") as string);
        const newStr: string = stripSystemReminder((input.new_string || input.new_str || "") as string);
        const writeContent: string = stripSystemReminder((input.content || "") as string);

        const resultText = stripSystemReminder(tool.output || "");
        const outputLines = resultText ? resultText.split("\n").filter((l: string) => l.length > 0).length : 0;
        const cardExpanded = expandedTools[tool.id] ?? !isBash;

        const headerBg =
          tool.status === "running" ? "var(--semantic-warning-subtle)" :
          tool.status === "error" ? "var(--semantic-error-subtle)" : "var(--semantic-info-subtle)";
        const dimText = "var(--fg-secondary)";

        const cmdSummary = hasCommand
          ? (command.length > 60 ? (command as string).slice(0, 60) + "..." : command)
          : "";

        return (
          <div
            key={tool.id}
            style={{
              marginBottom: 6,
              alignSelf: "stretch",
              fontSize: 12,
              fontFamily: "var(--font-sans)",
              border: "1px solid var(--border-light)",
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            {/* Header — always visible, clickable to toggle expand */}
            <div
              onClick={() => setExpandedTools((prev) => ({ ...prev, [tool.id]: !cardExpanded }))}
              style={{
                padding: "4px 10px",
                backgroundColor: headerBg,
                color: "var(--fg-primary)",
                cursor: "pointer",
                userSelect: "none",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span style={{ fontWeight: 600 }}>{displayName}</span>
              {tool.subagent && (
                <span
                  title={t("message.subagentTooltip")}
                  style={{
                    flexShrink: 0, fontSize: 9, lineHeight: "14px", padding: "0 5px",
                    borderRadius: 3, border: "1px solid var(--border-medium)",
                    color: "var(--fg-secondary)", backgroundColor: "var(--bg-root)",
                    cursor: "help",
                  }}
                >
                  {t("message.subagentBadge")}
                </span>
              )}
              {isBash && cmdSummary && (
                <span style={{ color: dimText, fontSize: 11, fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                  {cmdSummary}
                </span>
              )}
              {hasDescription && !isBash && <span style={{ color: dimText }}>— {description}</span>}
              {tool.status === "running" && !message.streaming && <span style={{ color: isDark ? "#e0c76f" : "#856404", flexShrink: 0 }}>● {t("message.running")}</span>}
              {tool.status === "error" && <span style={{ color: isDark ? "#f2a6a6" : "#721c24", flexShrink: 0 }}>● {t("message.error")}</span>}
              <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--fg-muted)", flexShrink: 0 }}>{cardExpanded ? "▲" : "▶"}</span>
            </div>

            {/* File path for Read/Edit tools — always visible, clickable */}
            {!isBash && filePath && (
              <div style={{ padding: "4px 10px", borderTop: "1px solid var(--border-light)", fontSize: 11, fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace" }}>
                <ClickableFilePath path={filePath} style={{ color: "var(--semantic-info)" }} />
              </div>
            )}

            {/* Expandable body — collapsed by default for bash, always visible for others */}
            {cardExpanded && (
              <>
                {hasCommand && (
                  <div style={{ padding: "6px 10px", borderTop: "1px solid var(--border-light)" }}>
                    <pre
                      style={{
                        margin: 0,
                        fontSize: 11,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
                        backgroundColor: "var(--bg-code)",
                        color: isDark ? "#cdd6f4" : "#1f2328",
                        padding: "8px 10px",
                        borderRadius: 4,
                        maxHeight: 120,
                        overflow: "auto",
                        lineHeight: 1.4,
                      }}
                    >
                      {command}
                    </pre>
                  </div>
                )}

                {/* File diff for Edit/Write tools (path shown above, always visible) */}
                {isEdit && filePath && (
                  <FileDiffView filePath={filePath} oldStr={oldStr} newStr={newStr} writeContent={writeContent} />
                )}

                {resultText ? (
                  <>
                    {!isBash && (
                      <div
                        style={{
                          padding: "4px 10px",
                          borderTop: "1px solid var(--border-light)",
                          backgroundColor: "var(--bg-surface)",
                          color: "var(--fg-muted)",
                          fontSize: 10,
                          userSelect: "none",
                        }}
                      >
                        {t("message.outputLines", { count: outputLines })}
                      </div>
                    )}
                    <pre
                      ref={(el) => { if (el) outputRefs.current.set(tool.id, el); }}
                      style={{
                        margin: 0,
                        padding: "6px 10px",
                        fontSize: 11,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        maxHeight: 300,
                        overflow: "auto",
                        backgroundColor: "var(--bg-hover)",
                        borderTop: "1px solid var(--border-light)",
                      }}
                    >
                      {resultText}
                    </pre>
                  </>
                ) : null}
              </>
            )}
          </div>
        );
      })}

      {/* Message content */}
      {text && (
        <div
          style={{
            padding: "8px 14px",
            borderRadius: isUser ? 18 : 6,
            maxWidth: "85%",
            backgroundColor: isUser ? "var(--accent)" : "var(--bg-hover)",
            color: isUser ? "var(--fg-inverse)" : "var(--fg-primary)",
            fontSize: "calc(var(--font-scale, 1) * 14px)",
            fontFamily: "var(--font-sans)",
            lineHeight: 1.5,
            wordBreak: "break-word",
            overflowWrap: "anywhere",
            minWidth: 0,
          }}
        >
          {isUser ? (
            contentSegments ? (
              contentSegments.map((seg, i) =>
                seg.type === "ref"
                  ? <ReferenceLink key={i} reference={seg.ref!} variant="user" />
                  : seg.content.length > LONG_TEXT_THRESHOLD
                    ? <CollapsibleText key={i} text={seg.content} isUser={true} />
                    : seg.content
              )
            ) : (
              text
            )
          ) : html ? (
            <>
              <div
                ref={mdRef}
                className="md-body"
                dangerouslySetInnerHTML={{ __html: html }}
                style={{ "& code": { backgroundColor: "var(--bg-code)", padding: "2px 4px", borderRadius: 3 } } as any}
              />
              {/* References bar below markdown — skip paste (already visible inline) */}
              {contentSegments && contentSegments.some((s) => s.type === "ref" && s.ref?.type !== "paste") && (
                <div style={{ marginTop: 8, paddingTop: 6, borderTop: "1px solid var(--border-light)", fontSize: "calc(var(--font-scale, 1) * 12px)" }}>
                  {contentSegments
                    .filter((s) => s.type === "ref" && s.ref?.type !== "paste")
                    .map((s, i) => (
                      <span key={i} style={{ marginRight: 8 }}>
                        <ReferenceLink reference={s.ref!} />
                      </span>
                    ))}
                </div>
              )}
              {/* Action buttons（flexWrap: wrap 是给译文块换行用的，见 TranslateButton 的注释） */}
              <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4, justifyContent: "flex-end", borderTop: "1px solid var(--border-light)", paddingTop: 4 }}>
                <ActionBtn label={t("message.copy")} onClick={() => { navigator.clipboard.writeText(text).catch(() => {}); }} />
                <ActionBtn label={t("message.sendToDesktop")}>
                  {getDesktops().map((d) => (
                    <DropdownItem key={d.id} label={d.name} onClick={() => {
                      const place = findSmartPlace(d, 320, 200);
                      const item = addItem(d.id, {
                        x: place.x, y: place.y, width: 320, height: 200,
                        label: text.slice(0, 50),
                        content: { type: "text" as const, format: "markdown", text },
                      });
                      activatePanel("super-desktop");
                      setSelection(new Set([item.id]));
                      setTimeout(() => panToItem(item.id), 200);
                    }} />
                  ))}
                </ActionBtn>
                {/* 翻译按钮**跟复制/→桌面 同一行**（用户反馈：明明放得下，别另起一行）；
                    译文块自己占下一行 —— 靠 TranslateButton 里的 flex-basis:100% */}
                <TranslateButton text={text} />
              </div>
            </>
          ) : (
            text
          )}
        </div>
      )}

      </div>
  );
}
