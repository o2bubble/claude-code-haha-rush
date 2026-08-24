import { useState, useEffect, useRef, useCallback } from "react";
import { t } from "../../i18n";
import { useEventHandler } from "../../services/useService";
import { Events } from "../../services/events";
import type { ChatInsertTextPayload, ChatAddReferencePayload } from "../../services/events";
import { formatReference } from "../../utils/referenceParser";
import type { SlashCommand } from "../../stores/chatStore";

interface Props {
  skill: SlashCommand;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onSend: (text: string) => void;
  onClose: () => void;
}

type I18nMap = Record<string, { title?: string; desc?: string }>;

/** Extract text from contentEditable: text nodes → text, chips → @ref{...}, <br> → newline */
function extractContent(container: HTMLElement): string {
  let result = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      result += (node.textContent || "").replace(/\u00A0/g, " ");
    } else if (node instanceof HTMLElement) {
      if (node.dataset.ref) {
        result += node.dataset.ref;
      } else if (node.tagName === "BR") {
        result += "\n";
      } else {
        for (const child of node.childNodes) walk(child);
      }
    }
  };
  for (const child of container.childNodes) walk(child);
  return result.trim();
}

function insertChipAtCursor(container: HTMLElement, refText: string, label: string) {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.ref = refText;
  chip.textContent = `@${label}`;
  Object.assign(chip.style, {
    display: "inline-flex", alignItems: "center", gap: "2px",
    padding: "1px 5px", fontSize: "12px", fontFamily: "var(--font-sans)",
    backgroundColor: "var(--accent-subtle)", border: "1px solid rgba(0,122,204,0.2)",
    borderRadius: "10px", color: "var(--accent)", cursor: "default", userSelect: "none",
    verticalAlign: "middle", margin: "0 2px",
  });
  chip.addEventListener("click", () => chip.remove());

  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && container.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(chip);
    range.setStartAfter(chip);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    container.appendChild(chip);
  }
  container.focus();
}

export function SkillDialog({ skill, isFavorite, onToggleFavorite, onSend, onClose }: Props) {
  const edRef = useRef<HTMLDivElement>(null);
  const [hasContent, setHasContent] = useState(false);
  const [i18n, setI18n] = useState<I18nMap>({});

  // Load translated skill name/description
  useEffect(() => {
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const json: string = await invoke("load_skills_i18n");
        if (json) setI18n(JSON.parse(json));
      } catch { /* no translations */ }
    })();
  }, [skill.cmd]);

  const tx = i18n[skill.cmd] || i18n["/" + skill.cmd];
  const displayTitle = tx?.title;
  const displayDesc = tx?.desc || skill.desc;

  useEffect(() => {
    edRef.current?.focus();
  }, []);

  const updateHasContent = useCallback(() => {
    if (edRef.current) {
      setHasContent(extractContent(edRef.current).length > 0);
    }
  }, []);

  // Handle @ref reference → chip at cursor (from FileBrowser right-click "发送到聊天")
  useEventHandler<ChatAddReferencePayload>(Events.CHAT_ADD_REFERENCE, ({ reference }) => {
    const el = edRef.current;
    if (!el) return;
    const refText = formatReference(reference);
    const label = reference.label || reference.path.split(/[/\\]/).pop() || reference.path;
    insertChipAtCursor(el, refText, label);
    updateHasContent();
  });

  // Handle plain text insert at cursor
  useEventHandler<ChatInsertTextPayload>(Events.CHAT_INSERT_TEXT, ({ text: insertText }) => {
    const el = edRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(insertText));
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      el.appendChild(document.createTextNode(insertText));
    }
    updateHasContent();
  });

  const handleSend = () => {
    const el = edRef.current;
    if (!el) return;
    const content = extractContent(el);
    const text = content ? `/${skill.cmd} ${content}` : `/${skill.cmd}`;
    onSend(text);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); }
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      onKeyDown={handleKeyDown}
      style={{
        height: "100%", display: "flex", flexDirection: "column",
        backgroundColor: "var(--bg-root)", overflow: "hidden",
        fontFamily: "var(--font-sans)",
      }}
    >
      {/* Header — 描述区限高滚动，避免长描述压扁输入框 */}
      <div style={{ padding: "10px 16px", flexShrink: 0, maxHeight: "35%", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ flexShrink: 0 }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: "var(--fg-primary)" }}>/{skill.cmd}</span>
          {displayTitle && <span style={{ fontWeight: 400, fontSize: 13, color: "var(--fg-muted)", marginLeft: 6 }}>{displayTitle}</span>}
        </div>
        {displayDesc && (
          <div style={{ fontSize: 11, color: "var(--fg-muted)", marginTop: 4, overflowY: "auto", minHeight: 0, lineHeight: 1.5, wordBreak: "break-word" }}>{displayDesc}</div>
        )}
      </div>

      {/* Body — contentEditable */}
      <div style={{ flex: "1 1 auto", padding: "8px 16px", display: "flex", minHeight: 0 }}>
        <div
          ref={edRef}
          contentEditable
          suppressContentEditableWarning
          onInput={updateHasContent}
          data-placeholder={t("skillDialog.paramsPlaceholder")}
          style={{
            flex: 1,
            border: "1px solid var(--border-medium)",
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 13,
            fontFamily: "var(--font-sans)",
            lineHeight: 1.5,
            outline: "none",
            overflow: "auto",
            wordBreak: "break-word",
          }}
        />
        <style>{`
          [data-placeholder]:empty:before {
            content: attr(data-placeholder);
            color: var(--fg-muted);
            pointer-events: none;
          }
        `}</style>
      </div>

      {/* Footer */}
      <div style={{
        padding: "10px 16px", flexShrink: 0,
        borderTop: "1px solid var(--border-light)",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <button
          onClick={onToggleFavorite}
          title={isFavorite ? t("skillDialog.unfavorite") : t("skillDialog.favorite")}
          style={{
            border: "none", background: "none", cursor: "pointer",
            fontSize: 18, padding: "2px 6px", color: isFavorite ? "#f0a500" : "var(--border-medium)",
          }}
        >
          {isFavorite ? "★" : "☆"}
        </button>
        <button
          onClick={handleSend}
          style={{
            padding: "6px 18px", border: "none", borderRadius: 6,
            backgroundColor: "var(--accent)", color: "var(--fg-inverse)",
            fontSize: 13, fontFamily: "var(--font-sans)",
            cursor: "pointer", fontWeight: 600,
          }}
        >
          {t("chat.send")}
        </button>
      </div>
    </div>
  );
}
