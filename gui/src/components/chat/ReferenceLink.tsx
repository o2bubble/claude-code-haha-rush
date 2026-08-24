import { useState } from "react";
import type { ParsedReference } from "../../types/reference";
import { openReference } from "../../services/referenceActions";

const TYPE_ICONS: Record<string, string> = {
  file: "📄", dir: "📁", line: "📄", panel: "📋",
  session: "💬", paste: "📋", desktop: "🖥️", note: "📝",
};

const DESKTOP_ITEM_ICONS: Record<string, string> = {
  text: "📝", table: "📊", chart: "📈", graphic: "🧩",
  drawing: "🎨", form: "📋", ref: "🔗", image: "🖼️", "file-group": "📦",
};

function getIcon(ref: ParsedReference): string {
  if (ref.type !== "desktop-item") return TYPE_ICONS[ref.type] || "🔗";
  const slash = ref.path.indexOf("/");
  const contentType = slash >= 0 ? ref.path.slice(0, slash) : "";
  return DESKTOP_ITEM_ICONS[contentType] || "📌";
}

function displayLabel(ref: ParsedReference): string {
  if (ref.label) return ref.label;
  const basename = ref.path.split(/[/\\]/).pop() || ref.path;
  if (ref.startLine !== undefined) {
    const r = ref.endLine && ref.endLine !== ref.startLine
      ? `${ref.startLine}-${ref.endLine}`
      : `${ref.startLine}`;
    return `${basename}:${r}`;
  }
  return basename;
}

export function ReferenceLink({ reference, variant }: { reference: ParsedReference; variant?: "user" | "assistant" }) {
  const icon = getIcon(reference);
  const label = displayLabel(reference);
  const isUser = variant === "user";
  const isPaste = reference.type === "paste";
  const [expanded, setExpanded] = useState(false);

  // 用户气泡背景是 accent(蓝), chip 文字须用气泡文本同色 fg-inverse 才可读;
  // accent-subtle 是背景色 token, 当文本色在蓝底上不可见(主题 token 重构时的回归)
  const linkColor = isUser ? "var(--fg-inverse)" : "var(--accent)";

  if (isPaste && expanded) {
    return (
      <span style={{ display: "block" }}>
        <pre style={{
          margin: "4px 0", padding: "6px 10px", fontSize: 12,
          backgroundColor: isUser ? "rgba(255,255,255,0.1)" : "var(--bg-hover)",
          border: isUser ? "1px solid rgba(255,255,255,0.15)" : "1px solid var(--border-light)",
          borderRadius: 6, color: isUser ? "var(--fg-inverse)" : "var(--fg-primary)",
          fontFamily: "'Cascadia Code','Fira Code',Consolas,monospace",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
          maxHeight: 300, overflow: "auto", lineHeight: 1.4,
        }}>
          {reference.path}
        </pre>
        <span
          onClick={() => setExpanded(false)}
          style={{ cursor: "pointer", color: linkColor, fontSize: 11, fontWeight: 600 }}
        >
          ▲ Collapse
        </span>
      </span>
    );
  }

  return (
    <span
      title={isPaste ? "Click to expand" : reference.path}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isPaste) {
          setExpanded(true);
        } else {
          openReference(reference);
        }
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        padding: "0 2px",
        cursor: "pointer",
        color: linkColor,
        fontWeight: 500,
        textDecoration: "underline",
        textUnderlineOffset: 2,
        fontFamily: "var(--font-sans)",
        fontSize: "inherit",
        lineHeight: "inherit",
        borderRadius: 2,
      }}
      onMouseEnter={(e) => {
        (e.target as HTMLElement).style.backgroundColor = isUser ? "rgba(255,255,255,0.15)" : "var(--accent-subtle)";
      }}
      onMouseLeave={(e) => {
        (e.target as HTMLElement).style.backgroundColor = "transparent";
      }}
    >
      <span style={{ fontSize: "0.85em" }}>{icon}</span>
      {label}
    </span>
  );
}
