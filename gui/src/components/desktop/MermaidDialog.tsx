// MermaidDialog — 输入/编辑 Mermaid 文本的模态弹窗（新建图形 + 双击编辑共用）

import React, { useEffect, useState } from "react";
import { t } from "../../i18n";

interface MermaidDialogProps {
  title: string;
  initial: string;
  onConfirm: (text: string) => void;
  onClose: () => void;
}

export function MermaidDialog({ title, initial, onConfirm, onClose }: MermaidDialogProps) {
  const [text, setText] = useState(initial);
  useEffect(() => { setText(initial); }, [initial]);

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: 560, maxWidth: "90vw", background: "var(--bg-surface)",
        border: "1px solid var(--border-medium)", borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-lg)", padding: 16, fontFamily: "var(--font-sans)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <b style={{ fontSize: 13, color: "var(--fg-primary)" }}>{title}</b>
          <button onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--fg-muted)", fontSize: 14 }}>×</button>
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
          spellCheck={false}
          placeholder={t("desktop.mermaidPlaceholder")}
          style={{
            width: "100%", minHeight: 180, resize: "vertical", boxSizing: "border-box",
            padding: 8, border: "1px solid var(--border-medium)", borderRadius: 6,
            fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace", fontSize: 12,
            background: "var(--bg-root)", color: "var(--fg-primary)",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
          <button
            onClick={onClose}
            style={{ border: "1px solid var(--border-medium)", borderRadius: 6, padding: "4px 12px", cursor: "pointer", background: "var(--bg-root)", color: "var(--fg-primary)", fontFamily: "var(--font-sans)", fontSize: 12 }}
          >
            {t("desktop.cancel")}
          </button>
          <button
            onClick={() => onConfirm(text)}
            style={{ border: "1px solid var(--accent)", borderRadius: 6, padding: "4px 12px", cursor: "pointer", background: "var(--accent)", color: "var(--fg-inverse)", fontFamily: "var(--font-sans)", fontSize: 12 }}
          >
            {t("desktop.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
