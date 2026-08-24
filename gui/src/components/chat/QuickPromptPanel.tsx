import { useState } from "react";
import { Plus, Send, Trash2, Edit3, X, Check } from "lucide-react";
import { getSettings, updateSettings, saveSettings, type QuickPrompt } from "../../stores/settingsStore";
import { useEvent } from "../../services/useService";
import { Events, type SettingsChangedPayload } from "../../services/events";
import { commands, eventBus } from "../../services/serviceBus";
import { showCtxMenu } from "../ContextMenu";
import { t } from "../../i18n";

export default function QuickPromptPanel() {
  const payload = useEvent<SettingsChangedPayload>(Events.SETTINGS_CHANGED);
  const prompts: QuickPrompt[] = payload?.settings?.quickPrompts ?? getSettings().quickPrompts ?? [];

  const [editing, setEditing] = useState<string | null>(null); // "new" or prompt.id
  const [editTitle, setEditTitle] = useState("");
  const [editPrompt, setEditPrompt] = useState("");

  const persist = (list: QuickPrompt[]) => {
    updateSettings({ quickPrompts: list });
    // Save only the quickPrompts field, not the whole settings object — a full
    // save from a stale copy (multi-instance) would clobber other fields.
    // Global scope: quick prompts are shared across workspaces, not per-workspace.
    saveSettings({ quickPrompts: list }, "global");
  };

  const startNew = () => {
    setEditing("new");
    setEditTitle("");
    setEditPrompt("");
  };

  const startEdit = (p: QuickPrompt, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing(p.id);
    setEditTitle(p.title);
    setEditPrompt(p.prompt);
  };

  const cancelEdit = () => setEditing(null);

  const saveEdit = () => {
    if (!editTitle.trim() || !editPrompt.trim()) return;
    const list = [...prompts];
    if (editing === "new") {
      list.push({ id: crypto.randomUUID(), title: editTitle.trim(), prompt: editPrompt.trim() });
    } else {
      const idx = list.findIndex((p) => p.id === editing);
      if (idx >= 0) list[idx] = { ...list[idx], title: editTitle.trim(), prompt: editPrompt.trim() };
    }
    persist(list);
    setEditing(null);
  };

  const deletePrompt = (id: string) => {
    persist(prompts.filter((p) => p.id !== id));
  };

  const sendPrompt = (promptText: string) => {
    commands.execute("SEND_MESSAGE", promptText);
  };

  const insertToInput = (promptText: string) => {
    eventBus.emit(Events.CHAT_INSERT_TEXT, { text: promptText, appendEnd: true });
  };

  const onContextMenu = (e: React.MouseEvent, p: QuickPrompt) => {
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, [
      { label: t("quickPrompts.send"), action: () => sendPrompt(p.prompt) },
      { label: t("quickPrompts.insertToInput"), action: () => insertToInput(p.prompt) },
      { separator: true as any },
      { label: t("quickPrompts.edit"), action: () => { setEditing(p.id); setEditTitle(p.title); setEditPrompt(p.prompt); } },
      { label: t("quickPrompts.delete"), action: () => deletePrompt(p.id) },
    ]);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", fontFamily: "var(--font-sans)" }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center",
        padding: "8px 12px", borderBottom: "1px solid var(--border-light)", gap: 8,
      }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-primary)", flex: 1 }}>
          {t("quickPrompts.title")}
        </span>
        <button
          type="button"
          onClick={startNew}
          style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            border: "none", borderRadius: 4, padding: "4px 10px",
            fontSize: 12, cursor: "pointer", fontFamily: "var(--font-sans)",
            background: "var(--accent)", color: "var(--fg-inverse)",
          }}
        >
          <Plus size={14} /> {t("quickPrompts.newPrompt")}
        </button>
      </div>

      {/* Inline edit form */}
      {editing && (
        <div style={{
          padding: "10px 12px", borderBottom: "1px solid var(--border-light)",
          background: "var(--bg-surface)",
        }}>
          <input
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            placeholder={t("quickPrompts.titlePlaceholder")}
            style={{
              width: "100%", boxSizing: "border-box",
              border: "1px solid var(--border-medium)", borderRadius: 4,
              padding: "6px 8px", fontSize: 13,
              fontFamily: "var(--font-sans)", outline: "none",
            }}
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }}
          />
          <textarea
            value={editPrompt}
            onChange={(e) => setEditPrompt(e.target.value)}
            placeholder={t("quickPrompts.promptPlaceholder")}
            rows={3}
            style={{
              width: "100%", boxSizing: "border-box",
              border: "1px solid var(--border-medium)", borderRadius: 4,
              padding: "6px 8px", fontSize: 13, marginTop: 6,
              fontFamily: "var(--font-sans)", outline: "none",
              resize: "vertical",
            }}
            onKeyDown={(e) => { if (e.key === "Escape") cancelEdit(); }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={cancelEdit}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                border: "none", borderRadius: 4, padding: "4px 10px",
                fontSize: 12, cursor: "pointer", fontFamily: "var(--font-sans)",
                background: "var(--border-light)", color: "var(--fg-secondary)",
              }}
            >
              <X size={14} /> {t("quickPrompts.cancel")}
            </button>
            <button
              type="button"
              onClick={saveEdit}
              disabled={!editTitle.trim() || !editPrompt.trim()}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                border: "none", borderRadius: 4, padding: "4px 10px",
                fontSize: 12, cursor: "pointer", fontFamily: "var(--font-sans)",
                background: "var(--accent)", color: "var(--fg-inverse)",
                opacity: (!editTitle.trim() || !editPrompt.trim()) ? 0.5 : 1,
              }}
            >
              <Check size={14} /> {t("quickPrompts.save")}
            </button>
          </div>
        </div>
      )}

      {/* Prompt list */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {prompts.length === 0 && !editing && (
          <div style={{
            padding: "24px 12px", textAlign: "center",
            color: "var(--fg-muted)", fontSize: 12,
          }}>
            {t("quickPrompts.empty")}
          </div>
        )}
        {prompts.map((p) => (
          <div
            key={p.id}
            onClick={() => sendPrompt(p.prompt)}
            onContextMenu={(e) => onContextMenu(e, p)}
            style={{
              display: "flex", alignItems: "center",
              padding: "8px 12px", cursor: "pointer",
              borderBottom: "1px solid var(--border-light)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--accent-subtle)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
            title={p.prompt}
          >
            <Send size={13} style={{ color: "var(--accent)", marginRight: 8, flexShrink: 0 }} />
            <span style={{
              flex: 1, fontSize: 13, color: "var(--fg-primary)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {p.title}
            </span>
            <span style={{
              fontSize: 11, color: "var(--fg-muted)", maxWidth: 120,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              marginLeft: 8,
            }}>
              {p.prompt}
            </span>
            <button
              type="button"
              onClick={(e) => startEdit(p, e)}
              title={t("quickPrompts.edit")}
              style={{
                border: "none", background: "none", cursor: "pointer",
                padding: 2, marginLeft: 4, color: "var(--fg-muted)",
                display: "flex", alignItems: "center", flexShrink: 0,
              }}
            >
              <Edit3 size={12} />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); deletePrompt(p.id); }}
              title={t("quickPrompts.delete")}
              style={{
                border: "none", background: "none", cursor: "pointer",
                padding: 2, marginLeft: 2, color: "var(--fg-muted)",
                display: "flex", alignItems: "center", flexShrink: 0,
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
