import { useEffect, useState } from "react";
import { t } from "../../../i18n";
import { ensureHelpAnimations } from "./helpAnimations";

ensureHelpAnimations();

/* ── LayoutSystemDemo: conceptual layout teaching demo ──
   CSS Grid reflows all panels in sync — no manual percentage math, nothing
   overflows or bleeds. Preset proportions + colors mirror the real
   "布局预设" picker preview (Toolbar PresetMini). Three steps:
     0 · presets: three one-click arrangements, matches the picker popup
     1 · resize: auto-played divider sweep (no real dragging to break)
     2 · layout mode: auto-played drag — the terminal panel flies from the
         bottom to the right column and stacks there */

type LayoutPreset = "default" | "chat" | "dense";

// Real preset proportions (left/center/right from the picker preview, bottom from the actual trees)
const PRESET: Record<LayoutPreset, { cols: string; rows: string; zones: [string, number][] }> = {
  default: { cols: "25% 1fr 30%", rows: "1fr 22%", zones: [["#4f8ef7", 25], ["#34a853", 45], ["#7c5cf0", 30]] },
  chat: { cols: "15% 1fr", rows: "1fr 22%", zones: [["#4f8ef7", 15], ["#7c5cf0", 85]] },
  dense: { cols: "20% 1fr 30%", rows: "1fr 32%", zones: [["#4f8ef7", 20], ["#34a853", 50], ["#7c5cf0", 30]] },
};

// Step 1 auto-loop: drag the divider right → left panel grows, center shrinks; bottom grows
const RESIZE_A = { cols: "25% 1fr 30%", rows: "1fr 22%" };
const RESIZE_B = { cols: "38% 1fr 30%", rows: "1fr 32%" };

const C = { sidebar: "#4f8ef7", editor: "#34a853", chat: "#7c5cf0", bottom: "#607d8b" };
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

export function LayoutSystemDemo() {
  const [step, setStep] = useState(0);
  const [preset, setPreset] = useState<LayoutPreset>("default");
  const [tick, setTick] = useState(0);

  // Single 100ms clock drives every auto-played animation
  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 100);
    return () => clearInterval(id);
  }, []);

  // Point at the real toolbar button: preset picker on step 0, layout-mode toggle on step 2
  useEffect(() => {
    const key = step === 0 ? "toolbar.layoutPicker" : step === 2 ? "toolbar.layoutMode" : null;
    let el: HTMLElement | null = null;
    let styleEl: HTMLStyleElement | null = null;
    if (key) {
      el = document.querySelector<HTMLElement>(`[aria-label="${t(key as "toolbar.layoutPicker")}"]`);
      if (el) {
        styleEl = document.createElement("style");
        styleEl.textContent =
          `@keyframes help-tb-spot { 0%,100% { box-shadow: 0 0 0 0 rgba(255,171,0,0.8); } 50% { box-shadow: 0 0 0 8px rgba(255,171,0,0); } }`;
        document.head.appendChild(styleEl);
        el.style.outline = "3px solid #ffab00";
        el.style.outlineOffset = "2px";
        el.style.borderRadius = "8px";
        el.style.animation = "help-tb-spot 1.6s ease-out infinite";
      }
    }
    return () => {
      if (el) {
        el.style.outline = "";
        el.style.outlineOffset = "";
        el.style.borderRadius = "";
        el.style.animation = "";
      }
      if (styleEl) styleEl.remove();
    };
  }, [step]);

  // ── time-derived states ──
  const tickMs = tick * 100;
  const s1 = tickMs % 3000 >= 1500; // step 1: divider sweep alternation
  const ms2 = tickMs % 6000; // step 2: drag timeline (6s loop)

  const grid = PRESET[preset];
  const isChat = preset === "chat";
  const noBottom = step === 0;

  // step 2 drag story
  const gripPulse = ms2 >= 300 && ms2 < 1300; // handle pulses before grabbing
  const ghostVisible = ms2 >= 1300; // grabbed → ghost appears at source
  const progress = Math.min(1, Math.max(0, (ms2 - 2000) / 1400)); // flight 2.0→3.4s
  const ease = 0.5 - 0.5 * Math.cos(progress * Math.PI);
  const dropping = ms2 >= 2000 && ms2 < 3800; // right column drop-zone highlight
  const moved = ms2 >= 3800; // layout re-arranged
  const s2fade = ms2 >= 5600 ? (6000 - ms2) / 400 : 1;
  const ghostX = 50 + (85 - 50) * ease;
  const ghostY = 88 + (80 - 88) * ease;

  const cols = step === 1 ? (s1 ? RESIZE_B.cols : RESIZE_A.cols)
    : step === 2 ? "25% 1fr 30%"
    : grid.cols;
  const rows = step === 1 ? (s1 ? RESIZE_B.rows : RESIZE_A.rows)
    : step === 2 ? (moved ? "1fr 0%" : "1fr 22%")
    : (noBottom ? "1fr" : grid.rows);

  const lmOutline = step === 2 ? "2px solid var(--semantic-success)" : "none";

  const panel: React.CSSProperties = {
    borderRadius: 4, overflow: "hidden", minWidth: 0, minHeight: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 9, fontWeight: 600, userSelect: "none", color: "#fff",
  };

  return (
    <div style={{
      border: "1px solid var(--border-light)", borderRadius: 8, padding: 14,
      background: "var(--bg-surface)", userSelect: "none",
    }}>
      {/* Mini layout canvas */}
      <div style={{
        position: "relative",
        display: "grid",
        gridTemplateColumns: cols,
        gridTemplateRows: rows,
        gap: 4, height: 170, borderRadius: 6,
        background: "var(--bg-hover)", marginBottom: 12,
        transition: `grid-template-columns 0.45s ${EASE}, grid-template-rows 0.45s ${EASE}`,
      }}>
        {/* Left */}
        <div style={{ ...panel, background: C.sidebar, outline: lmOutline, outlineOffset: 1 }}>
          左侧面板
        </div>

        {/* Center */}
        {(!isChat || step !== 0) && (
          <div style={{ ...panel, background: C.editor, outline: lmOutline, outlineOffset: 1 }}>
            中心区域
          </div>
        )}

        {/* Right — becomes a stacked column after the terminal is dragged in */}
        <div style={{ position: "relative", ...panel, background: C.chat, outline: lmOutline, outlineOffset: 1, flexDirection: "column" }}>
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", width: "100%" }}>
            右侧面板
          </div>
          {moved && (
            <div style={{
              flex: "0 0 34%", width: "100%",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 3,
              borderTop: "2px dashed var(--semantic-success)", fontSize: 8,
            }}>
              ⠿ 终端
            </div>
          )}
          {dropping && (
            <div style={{
              position: "absolute", left: 0, right: 0, bottom: 0, height: "40%",
              border: "2px solid var(--semantic-success)", borderRadius: 3,
              animation: "conn-pulse 0.9s ease-in-out infinite",
              pointerEvents: "none",
            }} />
          )}
        </div>

        {/* Bottom — terminal panel that gets dragged out */}
        {!noBottom && (
          <div style={{ position: "relative", ...panel, gridColumn: "1 / -1", background: C.bottom, outline: lmOutline, outlineOffset: 1 }}>
            {step === 2 && moved ? "已移出" : "底部面板（终端）"}
            {step === 2 && !moved && (
              <div style={{
                position: "absolute", top: 4, right: 4,
                display: "flex", alignItems: "center", gap: 3,
                padding: "2px 7px", borderRadius: 4,
                background: "var(--semantic-success)", color: "#fff",
                fontSize: 8, fontWeight: 700, boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
                animation: gripPulse ? "conn-pulse 0.8s ease-in-out infinite" : "none",
              }}>
                ⠿ 拖动
              </div>
            )}
          </div>
        )}

        {/* Step 2: ghost panel flying from bottom to the right column */}
        {step === 2 && ghostVisible && (
          <div style={{
            position: "absolute", left: `${ghostX}%`, top: `${ghostY}%`,
            transform: "translate(-50%,-50%)", zIndex: 8,
            display: "flex", alignItems: "center", gap: 4,
            padding: "4px 9px", borderRadius: 6,
            background: "var(--bg-surface)", border: "2px solid var(--semantic-success)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
            fontSize: 9, fontWeight: 700, color: "var(--semantic-success)",
            whiteSpace: "nowrap", opacity: s2fade,
          }}>
            ⠿ 终端
          </div>
        )}

        {/* Step 1: animated divider sweep — tracks the left/center boundary */}
        {step === 1 && (
          <div style={{
            position: "absolute", top: 4, bottom: 4, width: 5, zIndex: 6,
            background: "#fff", opacity: 0.9, borderRadius: 3,
            boxShadow: "0 0 6px rgba(0,0,0,0.35)",
            pointerEvents: "none",
            left: s1 ? "calc(38% + 2px)" : "calc(25% + 2px)",
            transition: `left 0.45s ${EASE}`,
          }}>
            <div style={{
              position: "absolute", left: -5, top: "50%", transform: "translateY(-50%)",
              width: 15, height: 26, borderRadius: 4,
              background: "#fff", border: "1px solid rgba(0,0,0,0.25)",
              color: "#333", fontSize: 10,
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
            }}>
              ⇔
            </div>
          </div>
        )}
      </div>

      {/* Step controls */}
      <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center", marginBottom: 12 }}>
        <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}
          style={{ ...btnStyle, opacity: step === 0 ? 0.4 : 1 }}>← {t("help.flowAgentPrev")}</button>
        <div style={{ display: "flex", gap: 6 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} onClick={() => setStep(i)} style={{
              width: 8, height: 8, borderRadius: "50%",
              background: i === step ? "var(--accent)" : "var(--border-medium)",
              cursor: "pointer", transition: "background 0.2s",
            }} />
          ))}
        </div>
        {step < 2 ? (
          <button onClick={() => setStep((s) => s + 1)} style={btnStyle}>{t("help.flowAgentNext")} →</button>
        ) : (
          <button onClick={() => setStep(0)} style={btnStyle}>↻ {t("help.flowAgentRestart")}</button>
        )}
      </div>

      {/* Step content */}
      {step === 0 && (
        <div>
          <div style={stepTitle}>{t("help.flowLayoutPresetTitle")}</div>
          <div style={stepDesc}>{t("help.flowLayoutPresetDesc")}</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 8 }}>
            {(["default", "chat", "dense"] as LayoutPreset[]).map((p) => (
              <button key={p} onClick={() => setPreset(p)}
                style={{
                  ...btnStyle,
                  display: "flex", flexDirection: "column", gap: 4, alignItems: "center", padding: "6px 10px",
                  background: preset === p ? "var(--bg-hover)" : "var(--bg-root)",
                  color: "var(--fg-primary)",
                  border: preset === p ? "1px solid var(--accent)" : "1px solid var(--border-medium)",
                }}>
                <span style={{
                  display: "flex", width: 54, height: 14, borderRadius: 3, overflow: "hidden",
                  border: "1px solid rgba(0,0,0,0.15)",
                }}>
                  {PRESET[p].zones.map(([c, w], i) => (
                    <span key={i} style={{ width: `${w}%`, background: c }} />
                  ))}
                </span>
                <span>{p === "default" ? t("help.flowLayoutPresetDefault") : p === "chat" ? t("help.flowLayoutPresetChat") : t("help.flowLayoutPresetDense")}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 1 && (
        <div>
          <div style={stepTitle}>{t("help.flowLayoutResizeTitle")}</div>
          <div style={stepDesc}>{t("help.flowLayoutResizeDesc")}</div>
          <div style={stepHint}>↔ {t("help.flowLayoutResizeHint")}</div>
        </div>
      )}

      {step === 2 && (
        <div>
          <div style={stepTitle}>{t("help.flowLayoutModeTitle")}</div>
          <div style={stepDesc}>{t("help.flowLayoutModeDesc")}</div>
          <div style={stepHint}>⇱ {t("help.flowLayoutModeDragHint")}</div>
        </div>
      )}
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

const stepTitle: React.CSSProperties = {
  fontSize: "calc(var(--font-scale, 1) * 12px)", fontWeight: 600,
  color: "var(--fg-primary)", marginBottom: 4, textAlign: "center",
};

const stepDesc: React.CSSProperties = {
  fontSize: "calc(var(--font-scale, 1) * 10px)", color: "var(--fg-muted)",
  lineHeight: 1.6, textAlign: "center",
};

const stepHint: React.CSSProperties = {
  fontSize: "calc(var(--font-scale, 1) * 10px)", color: "var(--accent)",
  textAlign: "center", marginTop: 6,
};
