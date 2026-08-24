import React, { useState, useRef, useCallback } from "react";
import { t } from "../../i18n";
import { useEvent, useEventHandler } from "../../services/useService";
import { Events } from "../../services/events";
import type { ChatInsertTextPayload, ChatAddReferencePayload, SettingsChangedPayload, ChatStateChangedPayload } from "../../services/events";
import { formatReference } from "../../utils/referenceParser";
import { saveClipboardItem } from "../../services/clipboardService";
import { getChatState } from "../../stores/chatStore";
import { getSettings } from "../../stores/settingsStore";
import type { SlashCommand } from "../../stores/chatStore";
import { SlashCommandDropdown } from "./SlashCommandDropdown";

interface InputAreaProps {
  onSend: (content: string) => void;
  onInterrupt: () => void;
  streaming: boolean;
  /** 渲染在输入框边框容器内部顶部的内容(如消息队列), 与输入框共享外框 */
  topSlot?: React.ReactNode;
  /** 渲染在输入框边框容器内部右侧的内容(如消息队列), 与输入框共享外框 */
  rightSlot?: React.ReactNode;
  /** 渲染在输入框底部行(提示文字与发送按钮之间)的内容, 如收起态的队列胶囊 */
  footerSlot?: React.ReactNode;
}

const CHIP_ICONS: Record<string, string> = { file: "📄", dir: "📁", line: "📄", panel: "📋", session: "💬", paste: "📋", desktop: "🖥️", "desktop-item": "📌" };
const PASTE_CHIP_THRESHOLD = 120; // chars — auto-collapse long pastes into chips

/** Walk contenteditable DOM: text nodes → text, chips → @ref{...} or full text, <br> → newline */
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

/** True if the container has any text characters or chips */
function hasContent(container: HTMLElement): boolean {
  const text = extractContent(container);
  return text.length > 0;
}

function insertChipAtCursor(container: HTMLElement, refText: string, label: string) {
  const icon = (() => {
    for (const [type, emoji] of Object.entries(CHIP_ICONS)) {
      if (refText.startsWith(`@ref{${type}:`)) return emoji;
    }
    return "🔗";
  })();

  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.ref = refText;
  chip.textContent = `${icon} ${label}`;
  Object.assign(chip.style, {
    display: "inline-flex", alignItems: "center", gap: "2px",
    padding: "1px 6px", fontSize: "calc(var(--font-scale, 1) * 12px)", fontFamily: "var(--font-sans)",
    backgroundColor: "var(--accent-subtle)", border: "1px solid rgba(0,122,204,0.2)",
    borderRadius: "10px", color: "var(--accent)", cursor: "default", userSelect: "none",
    verticalAlign: "middle", margin: "0 2px",
  });

  // Add click-to-remove
  chip.addEventListener("click", () => chip.remove());

  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && container.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(chip);
    // Place cursor after chip
    range.setStartAfter(chip);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    container.appendChild(chip);
  }
  container.focus();
}

/** Get cursor position as character offset within the container's text */
function getCursorTextOffset(container: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !container.contains(sel.anchorNode)) return -1;
  let offset = 0;
  let found = false;
  const walk = (node: Node) => {
    if (found) return;
    if (node === sel.anchorNode) {
      offset += sel.anchorOffset;
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      offset += (node.textContent || "").length;
    } else if (node instanceof HTMLElement && node.dataset.ref) {
      offset += (node.dataset.ref || "").length;
    } else {
      for (const child of node.childNodes) walk(child);
    }
  };
  for (const child of container.childNodes) walk(child);
  return found ? offset : -1;
}

/** Check if container text has a / at a word boundary before the cursor */
function findSlashContext(container: HTMLElement): { trigger: boolean; filter: string; slashPos: number; cursor: number } | null {
  const text = extractContent(container);
  const cursor = getCursorTextOffset(container);
  if (cursor < 0) return null;
  // Look for the closest / before cursor that is at a word boundary
  let slashPos = -1;
  for (let i = cursor - 1; i >= 0; i--) {
    if (text[i] === "/") {
      // Must be at start of input or preceded by space/newline
      if (i === 0 || text[i - 1] === " " || text[i - 1] === "\n") {
        slashPos = i;
        break;
      }
      if (text[i - 1] === "/") continue;
    }
  }
  if (slashPos < 0) return null;
  const filter = text.slice(slashPos + 1, cursor);
  if (filter.includes(" ")) return null;
  return { trigger: true, filter, slashPos, cursor };
}

function getCaretRect(container: HTMLElement): { top: number; left: number } | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rect = range.getClientRects()[0];
  if (rect) return { top: rect.bottom + 4, left: rect.left };
  // Fallback: use container rect
  const cr = container.getBoundingClientRect();
  return { top: cr.bottom + 4, left: cr.left };
}

export function InputArea({ onSend, onInterrupt, streaming, topSlot, rightSlot, footerSlot }: InputAreaProps) {
  const divRef = useRef<HTMLDivElement>(null);
  const slashPosRef = useRef<number>(-1);
  const slashCursorRef = useRef<number>(-1);
  const [hasText, setHasText] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashAnchor, setSlashAnchor] = useState({ top: 0, left: 0 });
  const [slashHighlight, setSlashHighlight] = useState(0);

  // Reactive slash commands from chatStore
  const chatPayload = useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED);
  const rawCommands: SlashCommand[] = chatPayload?.state?.slashCommands ?? getChatState().slashCommands ?? [];
  const slashCommands = rawCommands.filter((c) => c && c.cmd);
  const slashFiltered = slashCommands.filter((c) => {
    const f = slashFilter.toLowerCase();
    return c.cmd.includes(slashFilter) || (c.desc && c.desc.toLowerCase().includes(f));
  });

  const updateHasText = useCallback(() => {
    if (divRef.current) setHasText(hasContent(divRef.current));
  }, []);

  // Handle plain-text insert (命令面板 atStart → 最前；其他 → 光标处)
  useEventHandler<ChatInsertTextPayload>(Events.CHAT_INSERT_TEXT, ({ text: insertText, atStart, appendEnd }) => {
    const el = divRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (atStart) {
      // 插到最前面，光标移到插入文本末尾（便于继续输入参数）
      const node = document.createTextNode(insertText);
      el.insertBefore(node, el.firstChild);
      const range = document.createRange();
      range.setStart(node, node.length);
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
    } else if (appendEnd) {
      // 追加到末尾（划词/快捷提示多次发送层层追加）；focus() 会把选区塌缩到开头，
      // 若走光标分支会插到最前面造成倒序
      const node = document.createTextNode(insertText);
      el.appendChild(node);
      const range = document.createRange();
      range.setStart(node, node.length);
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
    } else if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(insertText));
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      el.appendChild(document.createTextNode(insertText));
    }
    updateHasText();
  });

  // Handle reference → chip at cursor (skip if SkillDialog is open)
  useEventHandler<ChatAddReferencePayload>(Events.CHAT_ADD_REFERENCE, ({ reference }) => {
    if (getChatState().activeSkillDialog) return;
    const el = divRef.current;
    if (!el) return;
    const refText = formatReference(reference);
    const label = reference.label || reference.path.split(/[/\\]/).pop() || reference.path;
    insertChipAtCursor(el, refText, label);
    updateHasText();
  });

  const handleSend = useCallback(() => {
    if (getChatState().inputBlockedReason) return;
    const el = divRef.current;
    if (!el) return;
    const content = extractContent(el);
    if (!content) return;
    onSend(content);
    el.innerHTML = "";
    setHasText(false);
  }, [onSend]);

  const handleSlashSelect = useCallback((cmd: string) => {
    if (!cmd) return;
    setSlashOpen(false);
    setSlashHighlight(0);
    const el = divRef.current;
    if (!el) return;
    const slashPos = slashPosRef.current;
    const cursor = slashCursorRef.current;
    if (slashPos < 0 || cursor <= slashPos) { el.focus(); return; }
    // Replace from slashPos to cursor with /cmd
    const text = extractContent(el);
    const before = text.slice(0, slashPos);
    const after = text.slice(cursor);
    el.innerHTML = "";
    const newText = before + "/" + cmd + " " + after;
    el.appendChild(document.createTextNode(newText));
    // Place cursor after "/cmd "
    const newCursor = before.length + cmd.length + 2; // +2 for "/" + space
    const tn = el.firstChild;
    if (tn && tn.nodeType === Node.TEXT_NODE) {
      const r = document.createRange();
      r.setStart(tn, Math.min(newCursor, (tn.textContent || "").length));
      r.collapse(true);
      const s = window.getSelection();
      if (s) { s.removeAllRanges(); s.addRange(r); }
    }
    el.focus();
    updateHasText();
  }, [updateHasText]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (slashOpen && slashFiltered.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashHighlight((i) => Math.min(i + 1, slashFiltered.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashHighlight((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          handleSlashSelect(slashFiltered[slashHighlight]?.cmd ?? "");
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashOpen(false);
          return;
        }
        // Any other non-nav key: keep typing, filter updates via onInput
        return;
      }
      const enterBehavior = getSettings().chatEnterBehavior ?? "send";
      if (enterBehavior === "send") {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      } else {
        if (e.key === "Enter" && e.ctrlKey) {
          e.preventDefault();
          handleSend();
        }
      }
    },
    [handleSend, slashOpen, slashFiltered, slashHighlight, handleSlashSelect],
  );

  const handleInput = useCallback(() => {
    updateHasText();
    const el = divRef.current;
    if (!el) return;
    const ctx = findSlashContext(el);
    if (ctx && ctx.trigger) {
      slashPosRef.current = ctx.slashPos;
      slashCursorRef.current = ctx.cursor;
      setSlashHighlight(0);
      const rect = getCaretRect(el);
      if (rect) {
        setSlashFilter(ctx.filter);
        setSlashAnchor(rect);
        setSlashOpen(true);
        return;
      }
    }
    setSlashOpen(false);
  }, [updateHasText]);

  // Work dir for saving pasted images/files
  const settingsPayload = useEvent<SettingsChangedPayload>(Events.SETTINGS_CHANGED);
  const workDir = settingsPayload?.settings?.workDir ?? "";

  // Strip formatting on paste; auto-chip long text; handle images/files
  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      e.preventDefault();
      const el = divRef.current;
      if (!el) return;
      el.focus();

      // ── Images from clipboard (screenshot, copy image) ──
      const items = e.clipboardData.items;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith("image/")) {
          const blob = item.getAsFile();
          if (blob) {
            const filePath = await saveClipboardItem(blob, workDir);
            if (filePath) {
              const name = filePath.split(/[/\\]/).pop() || "image";
              const refText = formatReference({ type: "file", path: filePath, label: name });
              insertChipAtCursor(el, refText, name);
              updateHasText();
            }
            return;
          }
        }
      }

      // ── Files from clipboard (copy from explorer) ──
      const files = e.clipboardData.files;
      if (files.length > 0) {
        let anySaved = false;
        for (let i = 0; i < files.length; i++) {
          const filePath = await saveClipboardItem(files[i], workDir, files[i].name);
          if (filePath) {
            const name = filePath.split(/[/\\]/).pop() || files[i].name;
            const refText = formatReference({ type: "file", path: filePath, label: name });
            insertChipAtCursor(el, refText, name);
            anySaved = true;
          }
        }
        if (anySaved) { updateHasText(); return; }
      }

      // ── Text paste ──
      const plain = e.clipboardData.getData("text/plain");
      if (!plain) return;

      if (plain.length > PASTE_CHIP_THRESHOLD) {
        // Decode only for readable chip label; raw text stays in ref path
        let labelSrc = plain;
        if (plain.includes("%") && /%[0-9A-Fa-f]{2}/.test(plain)) {
          try { labelSrc = decodeURIComponent(plain); } catch { /* keep raw */ }
        }
        const preview = labelSrc.replace(/\s+/g, " ").slice(0, 40);
        const refText = formatReference({ type: "paste", path: plain, label: `${preview}…` });
        insertChipAtCursor(el, refText, `${preview}…`);
      } else {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(document.createTextNode(plain));
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          el.appendChild(document.createTextNode(plain));
        }
      }
      updateHasText();
    },
    [updateHasText, workDir],
  );

  return (
    <div
      style={{
        borderTop: "1px solid var(--border-light)",
        padding: "12px 16px",
        backgroundColor: "var(--bg-root)",
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          border: hasText ? "2px solid var(--accent)" : "2px solid var(--border-light)",
          borderRadius: 12,
          overflow: "hidden",
          transition: "border-color 0.2s",
          backgroundColor: "var(--bg-surface)",
          minHeight: 44,
        }}
      >
        {topSlot && (
          <div style={{ flexShrink: 0, borderBottom: "1px solid var(--border-light)", background: "var(--bg-surface)" }}>
            {topSlot}
          </div>
        )}
        <div style={{ display: "flex", flex: 1, minHeight: 0, padding: "10px 6px 4px 12px" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div
          ref={divRef}
          contentEditable
          suppressContentEditableWarning
          data-placeholder={t("chat.placeholder")}
          onInput={handleInput}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          style={{
            flex: 1,
            outline: "none",
            fontSize: "calc(var(--font-scale, 1) * 14px)",
            fontFamily: "var(--font-sans)",
            lineHeight: 1.6,
            overflow: "auto",
            minHeight: 22,
            wordBreak: "break-word",
          }}
        />
        <style>{`
          [data-placeholder]:empty:before {
            content: attr(data-placeholder);
            color: #aaa;
            pointer-events: none;
          }
        `}</style>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingTop: 2,
          }}
        >
          {getChatState().inputBlockedReason ? (
            <span style={{
              fontSize: 10, color: "#7c3aed",
              fontFamily: "var(--font-sans)", fontWeight: 500,
            }}>
              {getChatState().inputBlockedReason}
            </span>
          ) : (
            <span style={{
              fontSize: 10, color: "var(--fg-muted)",
              fontFamily: "var(--font-sans)",
            }}>
              {t("chat.enterShortcut")}
            </span>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {footerSlot}
          {streaming ? (
            <button
              onClick={onInterrupt}
              style={{
                padding: "6px 14px",
                border: "none",
                borderRadius: 8,
                backgroundColor: "var(--semantic-error)",
                color: "var(--fg-inverse)",
                fontSize: 13,
                fontFamily: "var(--font-sans)",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              {t("chat.stop")}
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!hasText}
              style={{
                padding: "6px 14px",
                border: "none",
                borderRadius: 8,
                backgroundColor: hasText ? "var(--accent)" : "#ccc",
                color: "var(--fg-inverse)",
                fontSize: 13,
                fontFamily: "var(--font-sans)",
                cursor: hasText ? "pointer" : "default",
                fontWeight: 600,
              }}
            >
              {t("chat.send")}
            </button>
          )}
          </div>
        </div>
        </div>
        {rightSlot && (
          <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
            {rightSlot}
          </div>
        )}
        </div>
      </div>

      {/* Slash command autocomplete */}
      {slashOpen && (
        <SlashCommandDropdown
          commands={slashCommands}
          filter={slashFilter}
          highlightIndex={slashHighlight}
          onHighlight={setSlashHighlight}
          onSelect={handleSlashSelect}
          onClose={() => setSlashOpen(false)}
          anchorTop={slashAnchor.top}
          anchorLeft={slashAnchor.left}
        />
      )}
    </div>
  );
}
