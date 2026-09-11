import { useState } from "react";
import { t } from "../../../i18n";

/* ── AgentLoopDemo: interactive carousel showing the agent work loop ── */

const STEPS = [
  { key: "user", icon: "💬", color: "var(--accent)" },
  { key: "read", icon: "📖", color: "var(--semantic-warning)" },
  { key: "perm", icon: "🔐", color: "var(--semantic-error)" },
  { key: "edit", icon: "✏️", color: "var(--accent)" },
  { key: "result", icon: "✅", color: "var(--semantic-success)" },
] as const;

const stepDesc = (key: string): string => {
  const map: Record<string, [string, string]> = {
    user: ["agentStepUser", "agentStepUserDesc"],
    read: ["agentStepRead", "agentStepReadDesc"],
    perm: ["agentStepPerm", "agentStepPermDesc"],
    edit: ["agentStepEdit", "agentStepEditDesc"],
    result: ["agentStepResult", "agentStepResultDesc"],
  };
  const [title, desc] = map[key];
  return `${t("help." + title)} · ${t("help." + desc)}`;
};

export function AgentLoopDemo() {
  const [step, setStep] = useState(0);
  const max = STEPS.length;
  const active = STEPS[step];

  return (
    <div style={{
      border: "1px solid var(--border-light)",
      borderRadius: 8,
      padding: 14,
      background: "var(--bg-surface)",
      userSelect: "none",
    }}>
      {/* Stage: concept visualization */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        minHeight: 72,
        padding: "10px 6px",
        borderRadius: 6,
        background: "var(--bg-hover)",
        marginBottom: 12,
        flexWrap: "wrap",
      }}>
        {STEPS.map((s, i) => {
          const isActive = i === step;
          const isDone = i < step;
          return (
            <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                  padding: "8px 12px",
                  borderRadius: 8,
                  background: isActive ? "var(--accent-subtle)" : isDone ? "var(--bg-root)" : "transparent",
                  border: isActive ? "2px solid var(--accent)" : isDone ? "1px solid var(--border-light)" : "1px dashed var(--border-medium)",
                  opacity: isActive || isDone ? 1 : 0.45,
                  transition: "all 0.25s",
                  minWidth: 84,
                  transform: isActive ? "scale(1.05)" : "scale(1)",
                }}
              >
                <div style={{ fontSize: 20 }}>{s.icon}</div>
                <div style={{ fontSize: 10, color: "var(--fg-primary)", fontWeight: isActive ? 600 : 400 }}>
                  {t(`help.agentStep${s.key[0].toUpperCase()}${s.key.slice(1)}` as any)}
                </div>
              </div>
              {i < max - 1 && (
                <div style={{
                  width: 18, height: 2,
                  background: isDone ? "var(--accent)" : "var(--border-medium)",
                  transition: "background 0.3s",
                }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Current step description */}
      <div style={{
        padding: "8px 12px",
        borderRadius: 6,
        background: "var(--bg-root)",
        border: "1px solid var(--border-light)",
        fontSize: "calc(var(--font-scale, 1) * 11px)",
        color: "var(--fg-primary)",
        lineHeight: 1.6,
        minHeight: 40,
        marginBottom: 12,
      }}>
        {stepDesc(active.key)}
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center" }}>
        <button
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0}
          style={{
            ...btnStyle, opacity: step === 0 ? 0.4 : 1,
          }}
        >← {t("help.flowAgentPrev")}</button>

        {/* Step dots */}
        <div style={{ display: "flex", gap: 6 }}>
          {STEPS.map((_, i) => (
            <div
              key={i}
              onClick={() => setStep(i)}
              style={{
                width: 8, height: 8, borderRadius: "50%",
                background: i === step ? "var(--accent)" : "var(--border-medium)",
                cursor: "pointer",
                transition: "background 0.2s",
              }}
            />
          ))}
        </div>

        {step < max - 1 ? (
          <button
            onClick={() => setStep((s) => Math.min(max - 1, s + 1))}
            style={btnStyle}
          >{t("help.flowAgentNext")} →</button>
        ) : (
          <button
            onClick={() => setStep(0)}
            style={btnStyle}
          >↻ {t("help.flowAgentRestart")}</button>
        )}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "5px 14px", borderRadius: 6,
  border: "1px solid var(--border-medium)",
  background: "var(--bg-root)", color: "var(--fg-primary)",
  cursor: "pointer", fontSize: "calc(var(--font-scale, 1) * 11px)",
  fontFamily: "inherit",
};
