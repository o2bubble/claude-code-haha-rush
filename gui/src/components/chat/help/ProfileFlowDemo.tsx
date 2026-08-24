import { useState } from "react";
import { t } from "../../../i18n";

/* ── ProfileFlowDemo: carousel explaining profiles / models / API key ── */

const STEPS = [
  { key: "switch", icon: "🔄", title: "flowProfileStep1", desc: "flowProfileStep1Desc" },
  { key: "manage", icon: "⚙️", title: "flowProfileStep2", desc: "flowProfileStep2Desc" },
  { key: "key", icon: "🔑", title: "flowProfileStep3", desc: "flowProfileStep3Desc" },
] as const;

export function ProfileFlowDemo() {
  const [step, setStep] = useState(0);
  const active = STEPS[step];

  return (
    <div style={{
      border: "1px solid var(--border-light)", borderRadius: 8, padding: 14,
      background: "var(--bg-surface)", userSelect: "none",
    }}>
      {/* Illustration: profile list + selection */}
      <div style={{
        minHeight: 90, borderRadius: 6, background: "var(--bg-hover)",
        padding: "10px 14px", marginBottom: 12,
      }}>
        <div style={{ fontSize: 10, color: "var(--fg-muted)", fontWeight: 600, marginBottom: 6 }}>
          Profile 管理
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {["deepseek-v4-flash", "deepseek-v4-pro", "qwen-3.6-plus"].map((name, i) => {
            const isActive = i === step;
            const label = step === 2 && i === 0 ? "🔑 deepseek-v4-flash" : name;
            return (
              <div key={name} style={{
                padding: "4px 10px", borderRadius: 4,
                background: isActive ? "var(--accent-subtle)" : "var(--bg-root)",
                border: isActive ? "1px solid var(--accent)" : "1px solid var(--border-light)",
                fontSize: 10, color: isActive ? "var(--accent)" : "var(--fg-muted)",
                transition: "all 0.3s",
                transform: isActive ? "scale(1.02)" : "scale(1)",
                fontFamily: "var(--font-mono)",
              }}>
                {label} {isActive && <span style={{ marginLeft: 6 }}>← {t(`help.${active.title}`)}</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Step description */}
      <div style={{
        padding: "8px 12px", borderRadius: 6, background: "var(--bg-root)",
        border: "1px solid var(--border-light)",
        fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-primary)",
        lineHeight: 1.6, minHeight: 40, marginBottom: 12,
      }}>
        {active.icon} <span style={{ fontWeight: 600 }}>{t(`help.${active.title}`)}</span> · {t(`help.${active.desc}`)}
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center" }}>
        <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}
          style={{ ...btnStyle, opacity: step === 0 ? 0.4 : 1 }}>← {t("help.flowAgentPrev")}</button>
        <div style={{ display: "flex", gap: 6 }}>
          {STEPS.map((_, i) => (
            <div key={i} onClick={() => setStep(i)} style={{
              width: 8, height: 8, borderRadius: "50%",
              background: i === step ? "var(--accent)" : "var(--border-medium)",
              cursor: "pointer", transition: "background 0.2s",
            }} />
          ))}
        </div>
        {step < STEPS.length - 1 ? (
          <button onClick={() => setStep((s) => s + 1)} style={btnStyle}>{t("help.flowAgentNext")} →</button>
        ) : (
          <button onClick={() => setStep(0)} style={btnStyle}>↻ {t("help.flowAgentRestart")}</button>
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
