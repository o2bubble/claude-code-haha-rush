import { useEffect, useState } from "react";
import { t } from "../../../i18n";
import { ensureHelpAnimations } from "./helpAnimations";

ensureHelpAnimations();

/* ── DesktopConnectDemo: AI-generates-on-desktop scenario storyboard ──
   Pure timed loop, zero interaction. Timeline:
     0.4s  · user types the request (typewriter)
     2.3s  · AI tool chip appears (MCP create_item, generating…)
     3.2s  · tool done ✓
     3.8s  · chart card scales into the desktop canvas
     4.7s  · "AI 已生成" badge pops
     5.2s  · everything fades, loop restarts */

const LOOP_MS = 7600;
const BARS = [30, 48, 42, 66, 55];

export function DesktopConnectDemo() {
  const MSG = t("help.sdUserMsg");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 100);
    return () => clearInterval(id);
  }, []);

  const ms = (tick * 100) % LOOP_MS;

  // Typewriter reveal of the user's message (400 → 2300 ms)
  const typing = ms >= 400 && ms < 2300;
  const chars = Math.max(0, Math.floor(((ms - 400) / 1900) * MSG.length));
  const shown = MSG.slice(0, Math.min(chars, MSG.length));

  const thinking = ms >= 2300 && ms < 3200;
  const toolDone = ms >= 3200;
  const chartIn = ms >= 3800 ? Math.min(1, (ms - 3800) / 600) : 0;
  const chartVisible = ms >= 3800;
  const badgeVisible = ms >= 4700;
  const opacity = ms >= 5200 ? Math.max(0, (LOOP_MS - ms) / 2400) : 1;

  return (
    <div style={{
      border: "1px solid var(--border-light)", borderRadius: 8, padding: 14,
      background: "var(--bg-surface)", userSelect: "none",
    }}>
      {/* Mini desktop canvas */}
      <div style={{
        position: "relative", height: 130, borderRadius: 6,
        background: "var(--bg-hover)", marginBottom: 10, overflow: "hidden",
      }}>
        {/* dot grid */}
        <div style={{
          position: "absolute", inset: 0,
          backgroundImage: "radial-gradient(var(--border-medium) 1px, transparent 1px)",
          backgroundSize: "14px 14px", opacity: 0.45,
        }} />

        {/* generating placeholder (before chart lands) */}
        {(thinking || (toolDone && !chartVisible)) && (
          <div style={{
            position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
            display: "flex", alignItems: "center", gap: 6,
            fontSize: 10, color: "var(--fg-muted)",
            animation: "conn-pulse 1s ease-in-out infinite",
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />
            {t("help.sdGenerating")}
          </div>
        )}

        {/* chart card scales in */}
        {chartVisible && (
          <div style={{
            position: "absolute", left: "50%", top: "50%",
            transform: `translate(-50%,-50%) scale(${chartIn})`,
            width: 180, height: 98, borderRadius: 8,
            background: "var(--bg-surface)", border: "1px solid var(--border-light)",
            boxShadow: "0 4px 14px rgba(0,0,0,0.14)",
            padding: 8, opacity: chartIn * opacity,
          }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: "var(--fg-primary)", marginBottom: 4 }}>
              📊 {t("help.sdChartTitle")}
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 5, height: 54 }}>
              {BARS.map((h, i) => (
                <div key={i} style={{
                  flex: 1,
                  height: `${(h / 100) * 54 * chartIn}px`,
                  borderRadius: "3px 3px 0 0",
                  background: i % 2 ? "var(--accent)" : "var(--semantic-success)",
                  opacity: 0.9,
                }} />
              ))}
            </div>
            {badgeVisible && (
              <div style={{
                position: "absolute", top: 4, right: 4,
                fontSize: 8, fontWeight: 700, color: "#fff",
                background: "var(--semantic-success)", borderRadius: 10,
                padding: "1px 6px", boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
              }}>
                ✓ {t("help.sdBadge")}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Conversation strip */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
        {/* user bubble */}
        <div style={{ display: "flex", justifyContent: "flex-end", opacity: ms >= 400 ? opacity : 0, transition: "opacity 0.2s" }}>
          <div style={{
            maxWidth: "88%", background: "var(--accent)", color: "#fff",
            borderRadius: "10px 10px 2px 10px", padding: "6px 10px",
            fontSize: "calc(var(--font-scale, 1) * 10px)", lineHeight: 1.5, fontWeight: 500,
          }}>
            {shown}
            {typing && <span style={{ opacity: 0.8 }}>▊</span>}
          </div>
        </div>
        {/* AI tool call chip */}
        <div style={{ display: "flex", justifyContent: "flex-start", opacity: ms >= 2300 ? opacity : 0, transition: "opacity 0.2s" }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
            background: "var(--bg-root)", border: "1px solid var(--border-light)",
            borderRadius: 10, padding: "5px 9px",
            fontSize: "calc(var(--font-scale, 1) * 10px)",
          }}>
            <span style={{ fontSize: 10 }}>🤖</span>
            <span style={{ color: "var(--fg-secondary)", fontWeight: 600 }}>{t("help.sdToolLabel")}</span>
            <span style={{
              fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--accent)",
              background: "var(--accent-subtle)", borderRadius: 4, padding: "1px 5px",
            }}>
              {t("help.sdToolName")}
            </span>
            {toolDone ? (
              <span style={{ color: "var(--semantic-success)", fontWeight: 700, fontSize: 9 }}>✓ {t("help.sdDone")}</span>
            ) : (
              <span style={{ color: "var(--fg-muted)", fontSize: 9, display: "flex", alignItems: "center", gap: 3, animation: "conn-pulse 0.8s ease-in-out infinite" }}>
                ● {t("help.sdGenerating")}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Hint */}
      <div style={{
        fontSize: "calc(var(--font-scale, 1) * 10px)", color: "var(--fg-muted)",
        textAlign: "center", lineHeight: 1.5, opacity,
      }}>
        {t("help.sdHint")}
      </div>
    </div>
  );
}
