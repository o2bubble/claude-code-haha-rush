import { useState, useRef } from "react";
import { t } from "../../i18n";

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface AskQuestionOverlayProps {
  questions: Question[];
  onSubmit: (answers: Record<string, string>, annotations: Record<string, { notes?: string }>) => void;
  onSkip: () => void;
}

/** 自动增高 textarea：内容超过初始高度时随输入增长，不再固定单行。 */
function AutoGrowTextarea({ value, onChange, placeholder, style }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const autoGrow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };
  return (
    <textarea
      ref={ref}
      value={value}
      rows={2}
      placeholder={placeholder}
      onChange={(e) => { onChange(e.target.value); autoGrow(); }}
      onInput={autoGrow}
      style={{
        width: "100%", boxSizing: "border-box", padding: "6px 10px",
        fontSize: 11, borderRadius: 4, marginTop: 6,
        border: "1px solid var(--border-light)", backgroundColor: "var(--bg-surface)",
        color: "var(--fg-secondary)", resize: "none", minHeight: 28, overflow: "hidden",
        lineHeight: 1.5, fontFamily: "inherit",
        ...style,
      }}
    />
  );
}

export function AskQuestionOverlay({ questions, onSubmit, onSkip }: AskQuestionOverlayProps) {
  const [selections, setSelections] = useState<Record<number, string[]>>(() => {
    const init: Record<number, string[]> = {};
    questions.forEach((q, i) => {
      if (!q.multiSelect && q.options.length > 0) {
        init[i] = [q.options[0].label];
      } else {
        init[i] = [];
      }
    });
    return init;
  });
  const [notes, setNotes] = useState<Record<number, string>>({});

  const handleSelect = (qi: number, label: string, multi: boolean) => {
    setSelections((prev) => {
      const cur = prev[qi] || [];
      if (multi) {
        const idx = cur.indexOf(label);
        return { ...prev, [qi]: idx >= 0 ? cur.filter((l) => l !== label) : [...cur, label] };
      }
      return { ...prev, [qi]: [label] };
    });
  };

  const handleSubmit = () => {
    const answers: Record<string, string> = {};
    const annotations: Record<string, { notes?: string }> = {};
    questions.forEach((q, i) => {
      const sel = selections[i] || [];
      if (sel.length > 0) {
        answers[q.question] = sel.join(", ");
      }
      if (notes[i]) {
        annotations[q.question] = { notes: notes[i] };
      }
    });
    onSubmit(answers, annotations);
  };

  const hasAnySelection = questions.some((_, i) => (selections[i] || []).length > 0);

  if (questions.length === 0) return null;

  return (
    <div
      style={{
        height: "100%", display: "flex", flexDirection: "column",
        backgroundColor: "var(--bg-root)", overflow: "hidden",
      }}
      onKeyDown={(e) => { if (e.key === "Escape") onSkip(); }}
    >
      {/* Header */}
      <div style={{
        padding: "10px 16px", borderBottom: "1px solid var(--border-light)",
        fontSize: 13, fontWeight: 600, color: "var(--fg-primary)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexShrink: 0, fontFamily: "var(--font-sans)",
        backgroundColor: "var(--bg-surface)",
      }}>
          {t("askQuestion.header")}
        </div>

        {/* Body */}
        <div style={{
          flex: "1 1 auto", overflowY: "auto",
          padding: "12px 16px", minHeight: 0,
        }}>
          {questions.map((q, qi) => (
            <div key={qi} style={{ marginBottom: qi < questions.length - 1 ? 16 : 4 }}>
              {/* Header chip + question in one line */}
              <div style={{ marginBottom: 8 }}>
                {q.header && (
                  <span style={{
                    display: "inline-block", padding: "1px 6px", fontSize: 10,
                    fontWeight: 600, textTransform: "uppercase",
                    color: "#7c3aed", backgroundColor: "#f3f0ff",
                    borderRadius: 3, marginRight: 6,
                    fontFamily: "var(--font-sans)",
                  }}>
                    {q.header}
                  </span>
                )}
                <span style={{
                  fontSize: 13, fontWeight: 500, color: "var(--fg-primary)",
                  fontFamily: "var(--font-sans)",
                }}>
                  {q.question}
                </span>
              </div>

              {/* Options */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {q.options.map((opt) => {
                  const sel = selections[qi] || [];
                  const isSelected = sel.includes(opt.label);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => handleSelect(qi, opt.label, q.multiSelect)}
                      title={opt.description}
                      style={{
                        display: "flex", alignItems: "center", gap: 6,
                        padding: "6px 12px", cursor: "pointer",
                        borderRadius: 20,
                        border: `1.5px solid ${isSelected ? "#7c3aed" : "var(--border-medium)"}`,
                        backgroundColor: isSelected ? "#f3f0ff" : "var(--bg-root)",
                        fontSize: 12, fontFamily: "var(--font-sans)",
                        color: isSelected ? "#7c3aed" : "var(--fg-primary)",
                        fontWeight: isSelected ? 600 : 400,
                        transition: "all 0.15s",
                      }}
                    >
                      <span style={{ fontSize: 13 }}>
                        {q.multiSelect
                          ? (isSelected ? "\u2611" : "\u2610")
                          : (isSelected ? "\u25CF" : "\u25CB")}
                      </span>
                      {opt.label}
                    </button>
                  );
                })}
              </div>

              {/* Notes — collapsible */}
              {notes[qi] !== undefined || (selections[qi] || []).length > 0 ? (
                <AutoGrowTextarea
                  value={notes[qi] || ""}
                  onChange={(v) => setNotes((prev) => ({ ...prev, [qi]: v }))}
                  placeholder={t("askQuestion.notesPlaceholder")}
                />
              ) : null}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          padding: "10px 16px", borderTop: "1px solid var(--border-light)",
          display: "flex", justifyContent: "flex-end", gap: 8,
          flexShrink: 0,
        }}>
          <button
            type="button"
            onClick={onSkip}
            style={{
              padding: "6px 14px", fontSize: 12,
              border: "1px solid var(--border-medium)", borderRadius: 6,
              backgroundColor: "transparent", color: "var(--fg-secondary)",
              cursor: "pointer", fontFamily: "var(--font-sans)",
            }}
          >
            {t("askQuestion.skip")}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!hasAnySelection}
            style={{
              padding: "6px 18px", fontSize: 12, border: "none",
              borderRadius: 6, color: "var(--fg-inverse)",
              cursor: hasAnySelection ? "pointer" : "default",
              fontFamily: "var(--font-sans)", fontWeight: 600,
              backgroundColor: hasAnySelection ? "#7c3aed" : "var(--border-medium)",
            }}
          >
            {t("askQuestion.submit")}
          </button>
        </div>
    </div>
  );
}
