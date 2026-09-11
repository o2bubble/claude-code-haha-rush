import { useState } from "react";
import { t } from "../../../i18n";
import { ensureHelpAnimations } from "./helpAnimations";

ensureHelpAnimations();

/* ── WorkspaceSessionDemo: carousel explaining workspace + sessions ── */

const STEPS = [
  { key: "ws", icon: "📁", title: "flowWsStep1", desc: "flowWsStep1Desc" },
  { key: "session", icon: "💬", title: "flowWsStep2", desc: "flowWsStep2Desc" },
  { key: "persist", icon: "💾", title: "flowWsStep3", desc: "flowWsStep3Desc" },
] as const;

export function WorkspaceSessionDemo() {
  const [step, setStep] = useState(0);
  const active = STEPS[step];

  return (
    <div style={{
      border: "1px solid var(--border-light)", borderRadius: 8, padding: 14,
      background: "var(--bg-surface)", userSelect: "none",
    }}>
      {/* Animated illustration */}
      <div style={{
        minHeight: 90, borderRadius: 6, background: "var(--bg-hover)",
        padding: "10px 14px", marginBottom: 12, position: "relative", overflow: "hidden",
      }}>
        {/* Workspace frame */}
        <div style={{
          border: "2px dashed var(--border-medium)", borderRadius: 6,
          padding: 10, height: 70, position: "relative",
          transition: "all 0.3s",
        }}>
          <div style={{
            fontSize: 10, color: "var(--fg-muted)", fontWeight: 600, marginBottom: 6,
          }}>📁 my-project/</div>
          <div style={{ display: "flex", gap: 6 }}>
            {/* Session cards */}
            {[0, 1, 2].map((i) => (
              <div key={i} style={{
                padding: "4px 10px", borderRadius: 4,
                background: i === step ? "var(--accent-subtle)" : "var(--bg-root)",
                border: i === step ? "1px solid var(--accent)" : "1px solid var(--border-light)",
                fontSize: 9, color: i === step ? "var(--accent)" : "var(--fg-muted)",
                transition: "all 0.3s",
                transform: i === step ? "scale(1.05)" : "scale(1)",
                opacity: i > step ? 0.4 : 1,
              }}>
                {i === 0 ? "会话 1" : i === 1 ? "会话 2" : "会话 3"}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Step description */}
      <div style={{
        padding: "8px 12px", borderRadius: 6, background: "var(--bg-root)",
        border: "1px solid var(--border-light)",
        fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-primary)",
        lineHeight: 1.6, minHeight: 40, marginBottom: 12,
      }}>
        <span style={{ fontWeight: 600 }}>{active.icon} {t(`help.${active.title}`)}</span> · {t(`help.${active.desc}`)}
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
