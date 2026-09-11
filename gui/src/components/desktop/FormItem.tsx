import React, { memo, useCallback, useRef, useState } from "react";
import type { DesktopItem, FormContent, FormField, FormFieldType } from "../../types/desktop";
import { updateItem } from "../../stores/desktopStore";
import { t } from "../../i18n";

interface Props {
  item: DesktopItem;
}

// labelKey: 渲染时经 t() 取值，跟随当前语言
const FIELD_TYPES: { value: FormFieldType; labelKey: string }[] = [
  { value: "text", labelKey: "desktop.formItem.typeText" },
  { value: "textarea", labelKey: "desktop.formItem.typeTextarea" },
  { value: "number", labelKey: "desktop.formItem.typeNumber" },
  { value: "checkbox", labelKey: "desktop.formItem.typeCheckbox" },
  { value: "select", labelKey: "desktop.formItem.typeSelect" },
  { value: "date", labelKey: "desktop.formItem.typeDate" },
  { value: "switch", labelKey: "desktop.formItem.typeSwitch" },
  { value: "radio", labelKey: "desktop.formItem.typeRadio" },
  { value: "color", labelKey: "desktop.formItem.typeColor" },
  { value: "slider", labelKey: "desktop.formItem.typeSlider" },
];

const DEFAULT_VALUES: Record<FormFieldType, unknown> = {
  text: "", textarea: "", number: 0, checkbox: false,
  select: "", date: "", switch: false, radio: "",
  color: "#000000", slider: 50,
};

function FormItemImpl({ item }: Props) {
  const content = item.content as FormContent;
  const fields = content.fields;

  const [editMode, setEditMode] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newType, setNewType] = useState<FormFieldType>("text");
  const [newName, setNewName] = useState("");
  const [editFieldId, setEditFieldId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  // ── Options editor state ──

  const [pendingOption, setPendingOption] = useState<Record<string, string>>({});

  // ── Drag reorder ──

  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const commitFields = useCallback(
    (newFields: FormField[]) => {
      updateItem(item.id, { content: { type: "form", fields: newFields } });
    },
    [item.id],
  );

  const updateField = (fieldId: string, patch: Partial<FormField>) => {
    commitFields(fields.map((f) => f.id === fieldId ? { ...f, ...patch } : f));
  };

  const addField = () => {
    if (!newName.trim()) return;
    const field: FormField = {
      id: crypto.randomUUID(),
      name: newName.trim(),
      type: newType,
      value: DEFAULT_VALUES[newType],
      ...(newType === "select" || newType === "radio" ? { options: [] } : {}),
    };
    commitFields([...fields, field]);
    setNewName("");
    setShowAdd(false);
  };

  const removeField = (fieldId: string) => {
    commitFields(fields.filter((f) => f.id !== fieldId));
  };

  const resetAll = () => {
    commitFields(fields.map((f) => ({ ...f, value: DEFAULT_VALUES[f.type] })));
  };

  // ── Options helpers ──

  const addOption = (field: FormField) => {
    const val = (pendingOption[field.id] || "").trim();
    if (!val) return;
    const current = field.options || [];
    if (current.includes(val)) return;
    updateField(field.id, { options: [...current, val] });
    setPendingOption((p) => ({ ...p, [field.id]: "" }));
  };

  const removeOption = (field: FormField, idx: number) => {
    const current = field.options || [];
    updateField(field.id, { options: current.filter((_, i) => i !== idx) });
  };

  // ── Drag handlers ──

  const handleDragMouseDown = useCallback((e: React.MouseEvent, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    setDragIndex(idx);
    const handleMove = (ev: MouseEvent) => {
      let targetIdx: number | null = null;
      rowRefs.current.forEach((el, id) => {
        const rect = el.getBoundingClientRect();
        if (ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
          const found = fields.findIndex((f) => f.id === id);
          if (found >= 0) targetIdx = found;
        }
      });
      setDropIndex(targetIdx);
    };
    const handleUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = "";
      let targetIdx: number | null = null;
      rowRefs.current.forEach((el, id) => {
        const rect = el.getBoundingClientRect();
        if (ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
          const found = fields.findIndex((f) => f.id === id);
          if (found >= 0) targetIdx = found;
        }
      });
      if (targetIdx !== null && targetIdx !== idx) {
        const reordered = [...fields];
        const [moved] = reordered.splice(idx, 1);
        reordered.splice(targetIdx, 0, moved);
        commitFields(reordered);
      }
      setDragIndex(null);
      setDropIndex(null);
    };
    document.body.style.cursor = "grabbing";
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }, [fields, commitFields]);

  // ── Render view-mode control ──

  const renderControl = (field: FormField) => {
    switch (field.type) {
      case "text":
        return <input type="text" value={field.value as string} placeholder={field.placeholder}
          onChange={(e) => updateField(field.id, { value: e.target.value })} style={ctrlS} />;
      case "textarea":
        return <textarea value={field.value as string} placeholder={field.placeholder}
          onChange={(e) => updateField(field.id, { value: e.target.value })}
          style={{ ...ctrlS, resize: "vertical", minHeight: 40 }} rows={field.rows || 2} />;
      case "number":
        return <input type="number" value={field.value as number} placeholder={field.placeholder}
          min={field.min} max={field.max} step={field.step}
          onChange={(e) => updateField(field.id, { value: parseFloat(e.target.value) || 0 })} style={ctrlS} />;
      case "checkbox":
        return (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
            <input type="checkbox" checked={!!field.value}
              onChange={(e) => updateField(field.id, { value: e.target.checked })} />
            <span style={{ color: "var(--fg-secondary)" }}>{field.value ? `✓ ${t("desktop.formItem.yes")}` : `✗ ${t("desktop.formItem.no")}`}</span>
          </label>
        );
      case "select":
        return (
          <select value={field.value as string}
            onChange={(e) => updateField(field.id, { value: e.target.value })} style={{ ...ctrlS, flex: 1 }}>
            <option value="">{field.placeholder || t("desktop.formItem.selectPlaceholder")}</option>
            {(field.options || []).map((opt, i) => <option key={i} value={opt}>{opt}</option>)}
          </select>
        );
      case "date":
        return <input type="date" value={field.value as string}
          onChange={(e) => updateField(field.id, { value: e.target.value })} style={ctrlS} />;
      case "switch":
        return (
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
            onClick={() => updateField(field.id, { value: !field.value })}>
            <span style={{
              width: 32, height: 18, borderRadius: 9, flexShrink: 0,
              backgroundColor: field.value ? "var(--accent)" : "var(--border-medium)", position: "relative", transition: "background-color 0.2s",
            }}>
              <span style={{
                position: "absolute", top: 2, left: field.value ? 16 : 2,
                width: 14, height: 14, borderRadius: "50%", backgroundColor: "var(--bg-root)",
                transition: "left 0.2s", boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
              }} />
            </span>
            <span style={{ fontSize: 12, color: "var(--fg-secondary)" }}>{field.value ? t("desktop.formItem.on") : t("desktop.formItem.off")}</span>
          </label>
        );
      case "radio":
        return (
          <div style={{ flex: 1, display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
            {(field.options || []).map((opt, i) => (
              <label key={i} style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 12, cursor: "pointer" }}>
                <input type="radio" name={`radio-${field.id}`} value={opt}
                  checked={field.value === opt}
                  onChange={() => updateField(field.id, { value: opt })} />{opt}
              </label>
            ))}
          </div>
        );
      case "color":
        return (
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="color" value={field.value as string}
              onChange={(e) => updateField(field.id, { value: e.target.value })}
              style={{ width: 28, height: 22, border: "none", cursor: "pointer", padding: 0 }} />
            <span style={{ fontSize: 11, color: "var(--fg-secondary)" }}>{field.value as string}</span>
          </label>
        );
      case "slider":
        return (
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
            <input type="range" min={field.min ?? 0} max={field.max ?? 100} step={field.step ?? 1}
              value={field.value as number}
              onChange={(e) => updateField(field.id, { value: parseInt(e.target.value, 10) })} style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: "var(--fg-secondary)", minWidth: 24, textAlign: "right" }}>{field.value as number}</span>
          </div>
        );
      default:
        return <span style={{ color: "var(--fg-muted)", fontSize: 11 }}>{t("desktop.formItem.unknownType")}</span>;
    }
  };

  // ── Render edit-mode config (replaces control area entirely) ──

  const renderEditConfig = (field: FormField) => {
    switch (field.type) {
      case "text":
        return renderEditRowCommon(field, [
          { label: t("desktop.formItem.maxLength"), el: <input type="number" value={field.maxlength || ""} placeholder={t("desktop.formItem.unlimited")}
            onChange={(e) => updateField(field.id, { maxlength: parseInt(e.target.value) || undefined })} style={cfgI} /> },
        ]);
      case "textarea":
        return renderEditRowCommon(field, [
          { label: t("desktop.formItem.rows"), el: <input type="number" value={field.rows || 2} min={1} max={20}
            onChange={(e) => updateField(field.id, { rows: parseInt(e.target.value) || 2 })} style={cfgI} /> },
        ]);
      case "number":
        return renderEditRowCommon(field, [
          { label: t("desktop.formItem.min"), el: <input type="number" value={field.min ?? ""} placeholder={t("desktop.formItem.unlimited")}
            onChange={(e) => updateField(field.id, { min: e.target.value !== "" ? parseFloat(e.target.value) : undefined })} style={cfgI} /> },
          { label: t("desktop.formItem.max"), el: <input type="number" value={field.max ?? ""} placeholder={t("desktop.formItem.unlimited")}
            onChange={(e) => updateField(field.id, { max: e.target.value !== "" ? parseFloat(e.target.value) : undefined })} style={cfgI} /> },
          { label: t("desktop.formItem.step"), el: <input type="number" value={field.step ?? ""} placeholder="1"
            onChange={(e) => updateField(field.id, { step: e.target.value !== "" ? parseFloat(e.target.value) : undefined })} style={cfgI} /> },
        ]);
      case "select":
        return renderEditRowCommon(field, [
          { label: t("desktop.formItem.options"), el: renderOptionsEditor(field) },
        ]);
      case "radio":
        return renderEditRowCommon(field, [
          { label: t("desktop.formItem.options"), el: renderOptionsEditor(field) },
        ]);
      case "slider":
        return renderEditRowCommon(field, [
          { label: t("desktop.formItem.min"), el: <input type="number" value={field.min ?? ""} placeholder="0"
            onChange={(e) => updateField(field.id, { min: e.target.value !== "" ? parseFloat(e.target.value) : undefined })} style={cfgI} /> },
          { label: t("desktop.formItem.max"), el: <input type="number" value={field.max ?? ""} placeholder="100"
            onChange={(e) => updateField(field.id, { max: e.target.value !== "" ? parseFloat(e.target.value) : undefined })} style={cfgI} /> },
          { label: t("desktop.formItem.step"), el: <input type="number" value={field.step ?? ""} placeholder="1"
            onChange={(e) => updateField(field.id, { step: e.target.value !== "" ? parseFloat(e.target.value) : undefined })} style={cfgI} /> },
        ]);
      default:
        // checkbox, date, switch, color
        return renderEditRowCommon(field, []);
    }
  };

  const renderEditRowCommon = (field: FormField, extras: { label: string; el: React.ReactNode }[]) => {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={cfgL}>{t("desktop.formItem.hint")}</span>
        <input type="text" value={field.placeholder || ""} placeholder={t("desktop.formItem.hint")}
          onChange={(e) => updateField(field.id, { placeholder: e.target.value || undefined })}
          style={{ ...cfgI, width: 80 }} />
        <label style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 10, color: "var(--fg-muted)", cursor: "pointer", whiteSpace: "nowrap" }}>
          <input type="checkbox" checked={!!field.required}
            onChange={(e) => updateField(field.id, { required: e.target.checked || undefined })}
            style={{ width: 12, height: 12, margin: 0, cursor: "pointer" }} />
          {t("desktop.formItem.required")}
        </label>
        {extras.map((x, i) => (
          <React.Fragment key={i}>
            <span style={{ width: 1, height: 14, background: "var(--border-light)", flexShrink: 0 }} />
            <span style={cfgL}>{x.label}</span>
            {x.el}
          </React.Fragment>
        ))}
      </div>
    );
  };

  // ── Options chips editor ──

  const renderOptionsEditor = (field: FormField) => {
    const options = field.options || [];
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
        {options.map((opt, i) => (
          <span key={i} style={OPTION_CHIP}>
            {opt}
            <button onClick={() => removeOption(field, i)} style={OPTION_CHIP_DEL}>
              ×
            </button>
          </span>
        ))}
        <input type="text" value={pendingOption[field.id] || ""}
          placeholder={options.length === 0 ? t("desktop.formItem.inputOption") : t("desktop.formItem.addOption")}
          onChange={(e) => setPendingOption((p) => ({ ...p, [field.id]: e.target.value }))}
          onKeyDown={(e) => { if (e.key === "Enter") addOption(field); }}
          style={{ ...cfgI, width: 70 }} />
        <button onClick={() => addOption(field)}
          style={{ ...btnS, color: "var(--accent)", fontSize: 10, fontWeight: 600 }}>+</button>
      </div>
    );
  };

  // ── Empty state ──

  if (fields.length === 0) {
    return (
      <div style={EMPTY_STATE}>
        <div style={EMPTY_HINT}>{t("desktop.formItem.blankForm")}</div>
        {editMode ? (
          showAdd ? renderAddPopover() : (
            <div>
              <button onClick={() => setShowAdd(true)} style={PRIMARY_BTN}>+ {t("desktop.formItem.addField")}</button>
              <div style={{ marginTop: 8 }}>
                <button onClick={() => setEditMode(false)} style={{ ...btnS, fontSize: 11, color: "var(--accent)" }}>← {t("desktop.formItem.back")}</button>
              </div>
            </div>
          )
        ) : (
          <button onClick={() => setEditMode(true)} style={PRIMARY_BTN}>{t("desktop.formItem.configureForm")}</button>
        )}
      </div>
    );
  }

  function renderAddPopover() {
    return (
      <div style={{ ...rowS, backgroundColor: "var(--bg-surface)", gap: 4, flexWrap: "wrap", justifyContent: "center" }}>
        <select value={newType} onChange={(e) => setNewType(e.target.value as FormFieldType)}
          style={{ ...ctrlS, width: "auto", flexShrink: 0 }}>
          {FIELD_TYPES.map((ft) => <option key={ft.value} value={ft.value}>{t(ft.labelKey)}</option>)}
        </select>
        <input autoFocus type="text" value={newName} placeholder={t("desktop.formItem.fieldName")}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addField(); if (e.key === "Escape") setShowAdd(false); }}
          style={{ ...ctrlS, flex: 1, minWidth: 80 }} />
        <button onClick={addField} style={{ ...btnS, color: "var(--accent)", fontWeight: 600, fontSize: 11 }}>{t("desktop.formItem.confirm")}</button>
        <button onClick={() => setShowAdd(false)} style={{ ...btnS, fontSize: 11 }}>{t("desktop.formItem.cancel")}</button>
      </div>
    );
  }

  return (
    <div style={{ padding: "0", fontSize: 12, fontFamily: "var(--font-sans)", userSelect: "none" }}>
      {fields.map((field, idx) => (
        <div
          key={field.id}
          ref={(el) => { if (el) rowRefs.current.set(field.id, el); else rowRefs.current.delete(field.id); }}
          style={{
            ...rowS,
            minHeight: 32,
            opacity: dragIndex === idx ? 0.35 : 1,
            borderTop: dropIndex === idx && dragIndex !== idx ? "2px solid var(--accent)" : "1px solid var(--border-light)",
          }}
        >
          {editMode && (
            <span onMouseDown={(e) => handleDragMouseDown(e, idx)}
              style={{ cursor: "grab", color: "var(--fg-muted)", fontSize: 14, flexShrink: 0, lineHeight: 1 }}
              title={t("desktop.formItem.dragSort")}>⠿</span>
          )}

          {/* Label */}
          {editMode && editFieldId === field.id ? (
            <input autoFocus value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={() => { setEditFieldId(null); if (editName.trim()) updateField(field.id, { name: editName.trim() }); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { setEditFieldId(null); if (editName.trim()) updateField(field.id, { name: editName.trim() }); }
                if (e.key === "Escape") { setEditFieldId(null); setEditName(field.name); }
              }}
              style={{ ...lblS, border: "1px solid var(--accent)", borderRadius: 2, padding: "1px 4px", outline: "none" }} />
          ) : (
            <span style={lblS} title={editMode ? t("desktop.formItem.dblclickRename") : undefined}
              onDoubleClick={() => { if (editMode) { setEditFieldId(field.id); setEditName(field.name); } }}>
              {field.name}
            </span>
          )}

          {/* Edit mode: config only  /  View mode: control only */}
          {editMode ? renderEditConfig(field) : renderControl(field)}

          {editMode && (
            <button onClick={() => removeField(field.id)} style={btnS} title={t("desktop.formItem.deleteField")}>×</button>
          )}
        </div>
      ))}

      {/* Add field (edit mode only) */}
      {editMode && (
        showAdd ? renderAddPopover() : (
          <div style={{ padding: "4px 8px" }}>
            <button onClick={() => setShowAdd(true)} style={DASHED_BTN}>
              + {t("desktop.formItem.addField")}
            </button>
          </div>
        )
      )}

      {/* Bottom bar */}
      <div style={BOTTOM_BAR}>
        <button onClick={() => { setEditMode(!editMode); setShowAdd(false); setEditFieldId(null); }}
          style={{
            ...EDIT_TOGGLE_BTN_BASE,
            border: editMode ? "1px solid var(--accent)" : "1px solid var(--border-medium)",
            background: editMode ? "var(--accent)" : "var(--bg-root)",
            color: editMode ? "var(--fg-inverse)" : "var(--fg-secondary)",
          }}>
          {editMode ? `✓ ${t("desktop.formItem.done")}` : `⚙ ${t("desktop.formItem.config")}`}
        </button>
        <button onClick={resetAll} style={RESET_BTN}>
          {t("desktop.formItem.reset")}
        </button>
      </div>
    </div>
  );
}
export const FormItem = memo(FormItemImpl);

// ── Shared styles ──

const rowS: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6,
  padding: "4px 8px", fontSize: 12, fontFamily: "var(--font-sans)",
};

const lblS: React.CSSProperties = {
  width: 72, flexShrink: 0, color: "var(--fg-secondary)", fontWeight: 500,
  fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};

const ctrlS: React.CSSProperties = {
  flex: 1, fontSize: 12, fontFamily: "inherit",
  padding: "2px 6px", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)",
  outline: "none", minWidth: 0, color: "var(--fg-primary)", background: "var(--bg-root)",
};

const btnS: React.CSSProperties = {
  border: "none", background: "none", cursor: "pointer",
  fontSize: 12, color: "var(--fg-muted)", padding: "2px 4px", lineHeight: 1,
};

const cfgI: React.CSSProperties = {
  width: 48, fontSize: 10, fontFamily: "inherit",
  padding: "1px 4px", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)",
  outline: "none", color: "var(--fg-primary)", background: "var(--bg-root)",
};

const cfgL: React.CSSProperties = {
  fontSize: 10, color: "var(--fg-muted)", whiteSpace: "nowrap",
};

const EMPTY_STATE = {
  padding: 16, textAlign: "center",
} as const;

const EMPTY_HINT = {
  color: "var(--fg-muted)", fontSize: 12, marginBottom: 8,
} as const;

const BOTTOM_BAR = {
  padding: "4px 8px", borderTop: "1px solid var(--border-light)", display: "flex",
  justifyContent: "space-between", alignItems: "center",
} as const;

const OPTION_CHIP = {
  display: "inline-flex", alignItems: "center", gap: 2,
  padding: "0 6px", fontSize: 10, background: "var(--accent-subtle)",
  border: "1px solid var(--border-light)", borderRadius: 999, color: "var(--accent)",
} as const;

const OPTION_CHIP_DEL = {
  border: "none", background: "none", cursor: "pointer",
  fontSize: 12, color: "var(--fg-muted)", padding: 0, lineHeight: 1,
} as const;

const PRIMARY_BTN = {
  fontSize: 12, padding: "4px 14px", border: "1px solid var(--accent)",
  borderRadius: "var(--radius-sm)", background: "var(--accent)", color: "var(--fg-inverse)", cursor: "pointer",
} as const;

const DASHED_BTN = {
  fontSize: 11, padding: "2px 10px", border: "1px dashed var(--border-medium)",
  borderRadius: "var(--radius-sm)", background: "var(--bg-root)", color: "var(--fg-muted)", cursor: "pointer",
} as const;

const EDIT_TOGGLE_BTN_BASE = {
  fontSize: 11, padding: "2px 8px",
  border: "1px solid var(--border-medium)", borderRadius: "var(--radius-sm)",
  cursor: "pointer",
} as const;

const RESET_BTN = {
  fontSize: 11, padding: "2px 10px", border: "1px solid var(--border-medium)",
  borderRadius: "var(--radius-sm)", background: "var(--bg-root)", color: "var(--fg-secondary)", cursor: "pointer",
} as const;
