import React, { memo, useRef, useCallback, useEffect, useState } from "react";
import type { DesktopItem } from "../../types/desktop";
import type { TextContent } from "../../types/desktop";
import { updateItem } from "../../stores/desktopStore";
import { registerDataSource, unloadDataSource } from "../../services/dataRegistry";
import { t } from "../../i18n";
import hljs from "highlight.js";
import "highlight.js/styles/github.css";

// ── Language list ──

const FORMAT_OPTIONS = [
  { value: "plain", label: "Plain" },
  { value: "markdown", label: "Markdown" },
];
const CODE_LANGUAGES = [
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "python", label: "Python" },
  { value: "rust", label: "Rust" },
  { value: "go", label: "Go" },
  { value: "css", label: "CSS" },
  { value: "html", label: "HTML / XML" },
  { value: "json", label: "JSON" },
  { value: "bash", label: "Bash" },
  { value: "sql", label: "SQL" },
  { value: "yaml", label: "YAML" },
  { value: "java", label: "Java" },
  { value: "cpp", label: "C++" },
  { value: "csharp", label: "C#" },
  { value: "toml", label: "TOML" },
  { value: "ini", label: "INI" },
  { value: "diff", label: "Diff / Patch" },
  { value: "makefile", label: "Makefile" },
  { value: "nginx", label: "Nginx" },
  { value: "powershell", label: "PowerShell" },
  { value: "ruby", label: "Ruby" },
  { value: "php", label: "PHP" },
  { value: "lua", label: "Lua" },
  { value: "c", label: "C" },
  { value: "kotlin", label: "Kotlin" },
  { value: "swift", label: "Swift" },
  { value: "scala", label: "Scala" },
  { value: "dart", label: "Dart" },
];

const isCodeFormat = (f: string) => f !== "plain" && f !== "markdown";

interface Props {
  item: DesktopItem;
}

function TextItemImpl({ item }: Props) {
  const content = item.content as TextContent;
  const codeLang = isCodeFormat(content.format);
  const canPreview = content.format === "markdown" || codeLang;
  const edRef = useRef<HTMLDivElement>(null);
  const [htmlContent, setHtmlContent] = useState("");
  // Viewing is the common case — start in preview when the format supports it.
  const [showPreview, setShowPreview] = useState<boolean>(
    () => canPreview,
  );

  // ── Sync contentEditable from store → DOM (only when NOT focused, to avoid overwriting user edits) ──

  useEffect(() => {
    const el = edRef.current;
    if (!el) return;
    // Skip sync while user is actively editing (focused)
    if (document.activeElement === el) return;
    // Only update DOM if text actually differs from store
    const domText = extractDomText(el);
    if (domText !== content.text) {
      setContentEditableText(el, content.text);
    }
    // showPreview: the contentEditable div unmounts in preview mode, so it
    // mounts EMPTY when toggling back to edit — re-run to refill it.
  }, [content.text, showPreview]);

  // ── Extract text from contentEditable DOM ──

  const extractDomText = useCallback((el: HTMLElement): string => {
    let result = "";
    const lineBreakTags = new Set(["BR", "DIV", "P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE"]);
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        result += (node.textContent || "").replace(/\u00A0/g, " ").replace(/\u200B/g, "");
      } else if (node instanceof HTMLElement) {
        if (lineBreakTags.has(node.tagName)) {
          if (result.length > 0 && !result.endsWith("\n")) result += "\n";
        }
        for (const child of node.childNodes) walk(child);
      }
    };
    for (const child of el.childNodes) walk(child);
    return result.trim();
  }, []);

  const extractText = useCallback((): string => {
    if (!edRef.current) return content.text;
    return extractDomText(edRef.current);
  }, [content.text, extractDomText]);

  // ── Force <br> on Enter (WebView2 inserts <div> by default, which breaks line extraction) ──

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const br = document.createElement("br");
        // Insert zero-width char after <br> so the new line has visible height
        const zws = document.createTextNode("\u200B");
        range.insertNode(zws);
        range.insertNode(br);
        range.setStartAfter(zws);
        range.setEndAfter(zws);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }, []);

  // ── Save (blur = immediate, input = debounced 600ms) ──

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSave = useCallback(() => {
    const text = extractText();
    updateItem(item.id, {
      content: { ...content, text },
      label: text.slice(0, 50) || item.label,
    } as any);
  }, [item.id, content, extractText, item.label]);

  const handleBlur = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    doSave();
  }, [doSave]);

  const handleInput = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      doSave();
    }, 600);
  }, [doSave]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // ── Data registry ──

  useEffect(() => {
    registerDataSource({
      itemId: item.id,
      desktopId: item.desktopId,
      label: item.label,
      contentType: "text",
      dataKeys: ["text", "wordCount", "lines"],
      queryHandler: (key: string) => {
        // text 缺失时（块数据不完整，如 AI 经 MCP 创建时漏 text 字段）按空串处理。
        // 不能直接 split —— 这条链路是 AI 查询桌面数据时**同步**走到的
        // （chatSession → queryData → 本 handler），抛错会穿透到调用方，
        // 表现为一堆 "Cannot read properties of undefined (reading 'split')"。
        const current = typeof content.text === "string" ? content.text : "";
        switch (key) {
          case "text": return { keys: ["text"], value: current };
          case "wordCount": return { keys: ["wordCount"], value: current.split(/\s+/).filter(Boolean).length };
          case "lines": return { keys: ["lines"], value: content.text == null ? 0 : current.split("\n").length };
          default: return undefined;
        }
      },
    });
    return () => unloadDataSource(item.id);
  }, [item.id, item.desktopId, item.label, content.text]);

  // ── Preview rendering ──

  // A format switch to one that can't preview (e.g. markdown → plain) must drop
  // back to edit mode, otherwise the stale markdown HTML keeps rendering.
  useEffect(() => {
    if (!canPreview && showPreview) setShowPreview(false);
  }, [canPreview, showPreview]);

  useEffect(() => {
    if (!showPreview) return;

    if (content.format === "markdown") {
      import("marked").then(({ marked }) => {
        const renderer = new marked.Renderer();
        renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
          if (lang && hljs.getLanguage(lang)) {
            const highlighted = hljs.highlight(text, { language: lang }).value;
            return `<pre><code class="hljs language-${lang}">${highlighted}</code></pre>`;
          }
          const auto = hljs.highlightAuto(text).value;
          return `<pre><code class="hljs">${auto}</code></pre>`;
        };
        setHtmlContent(marked.parse(content.text, { renderer }) as string);
      }).catch(() => setHtmlContent(`<pre>${escapeHtml(content.text)}</pre>`));
    } else if (isCodeFormat(content.format)) {
      if (hljs.getLanguage(content.format)) {
        const result = hljs.highlight(content.text, { language: content.format });
        setHtmlContent(result.value);
      } else {
        setHtmlContent(hljs.highlightAuto(content.text).value);
      }
    }
  }, [showPreview, content.text, content.format]);




  // ── Render ──

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--bg-root)",
      }}
    >
      {/* ── 顶栏: format 胶囊 + 预览切换 ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
          borderBottom: "1px solid var(--border-light)",
          backgroundColor: "var(--bg-surface)",
          flexShrink: 0,
        }}
      >
        <FormatPicker value={content.format} onChange={(f) => updateItem(item.id, { content: { ...content, format: f } } as any)} />
        <div style={{ flex: 1 }} />
        {canPreview && (
          <button
            onClick={() => setShowPreview((p) => !p)}
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: "3px 10px",
              border: "1px solid var(--border-medium)",
              borderRadius: 999,
              background: showPreview ? "var(--accent)" : "var(--bg-root)",
              color: showPreview ? "var(--fg-inverse)" : "var(--fg-secondary)",
              cursor: "pointer",
              transition: "background var(--transition-fast), color var(--transition-fast)",
            }}
          >
            {showPreview ? t("desktop.edit") : t("desktop.preview")}
          </button>
        )}
      </div>

      {/* ── Content ── */}
      <div style={{ flex: 1, minHeight: 0, backgroundColor: "var(--bg-root)" }}>
        {showPreview ? (
          codeLang ? (
            <div style={{ height: "100%", overflow: "auto", padding: 12, backgroundColor: "var(--bg-code)" }}>
              <code
                className={`hljs language-${content.format}`}
                style={{ fontFamily: "var(--font-mono)", fontSize: "calc(var(--font-scale, 1) * 13px)", lineHeight: 1.6, whiteSpace: "pre", display: "block", minWidth: "max-content" }}
                dangerouslySetInnerHTML={{ __html: htmlContent }}
              />
            </div>
          ) : (
            <div
              className="md-body"
              style={{
                height: "100%",
                overflow: "auto",
                maxWidth: 820,
                margin: "0 auto",
                padding: "12px 24px",
                color: "var(--fg-primary)",
                fontFamily: "var(--font-sans)",
                fontSize: "calc(var(--font-scale, 1) * 14px)",
                lineHeight: 1.6,
              }}
              dangerouslySetInnerHTML={{ __html: htmlContent }}
            />
          )
        ) : (
          <div
            ref={edRef}
            contentEditable
            suppressContentEditableWarning
            onBlur={handleBlur}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            data-placeholder="输入文本..."
            style={{
              height: "100%",
              outline: "none",
              padding: "12px 16px",
              fontFamily: "var(--font-sans)",
              fontSize: "calc(var(--font-scale, 1) * 14px)",
              lineHeight: 1.6,
              color: "var(--fg-primary)",
              whiteSpace: "pre-wrap",
              overflowY: "auto",
              minHeight: 30,
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── Format pill picker (custom dropdown, aligned with design system) ──
function FormatPicker({ value, onChange }: { value: string; onChange: (f: string) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape — dropdown otherwise lingers after choosing.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (f: string) => {
    onChange(f);
    setOpen(false);
  };

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={t("desktop.format")}
        style={{
          fontSize: 11,
          fontWeight: 600,
          padding: "2px 10px",
          border: "1px solid var(--border-medium)",
          borderRadius: 999,
          background: "var(--bg-root)",
          color: "var(--fg-secondary)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <span>{formatLabel(value)}</span>
        <span style={{ fontSize: 9, color: "var(--fg-muted)" }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 4,
            background: "var(--bg-surface)",
            border: "1px solid var(--border-medium)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-md)",
            padding: 4,
            zIndex: 20,
            minWidth: 160,
            maxHeight: 260,
            overflowY: "auto",
          }}
        >
          {FORMAT_OPTIONS.map((o) => (
            <FormatOption key={o.value} active={value === o.value} label={o.label} onClick={() => pick(o.value)} />
          ))}
          <div style={{ fontSize: 10, color: "var(--fg-muted)", padding: "4px 8px 2px", fontWeight: 600 }}>Code</div>
          {CODE_LANGUAGES.map((o) => (
            <FormatOption key={o.value} active={value === o.value} label={o.label} onClick={() => pick(o.value)} />
          ))}
        </div>
      )}
    </div>
  );
}

function FormatOption({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: "4px 8px",
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
        fontSize: 12,
        color: active ? "var(--accent)" : "var(--fg-primary)",
        background: active ? "var(--accent-subtle)" : "transparent",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </div>
  );
}

function formatLabel(f: string): string {
  const all = [...FORMAT_OPTIONS, ...CODE_LANGUAGES];
  return all.find((o) => o.value === f)?.label ?? f;
}
export const TextItem = memo(TextItemImpl);

function setContentEditableText(el: HTMLElement, text: string) {
  el.innerHTML = text.split("\n").map((line) => escapeHtml(line)).join("<br>");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
