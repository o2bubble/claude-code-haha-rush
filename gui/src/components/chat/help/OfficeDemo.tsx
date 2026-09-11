import { useEffect, useState } from "react";
import { t } from "../../../i18n";
import { ensureHelpAnimations } from "./helpAnimations";

ensureHelpAnimations();

/* ── OfficeDemo: AI opens Excel via plain language ──
   Pure timed loop, zero interaction. Timeline:
     0.4s  · user types the request (typewriter)
     2.3s  · AI tool chip appears (Office bridge, generating…)
     3.2s  · tool done ✓
     3.8s  · an Excel window scales in, table rows fill one by one
     4.7s  · "已生成表格" badge pops
     5.4s  · fade, loop restarts */

const LOOP_MS = 7400;

const ROWS = [
  { a: "Q1", b: "128", c: "+12%" },
  { a: "Q2", b: "156", c: "+22%" },
  { a: "Q3", b: "143", c: "-8%" },
];

const APPS = [
  { key: "help.officeWord", icon: "📄", active: false },
  { key: "help.officeExcel", icon: "📊", active: true },
  { key: "help.officePpt", icon: "📽️", active: false },
];

export function OfficeDemo() {
  const MSG = t("help.officeUserMsg");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 100);
    return () => clearInterval(id);
  }, []);

  const ms = (tick * 100) % LOOP_MS;

  const typing = ms >= 400 && ms < 2300;
  const chars = Math.max(0, Math.floor(((ms - 400) / 1900) * MSG.length));
  const shown = MSG.slice(0, Math.min(chars, MSG.length));

  const toolDone = ms >= 3200;
  const winIn = ms >= 3800 ? Math.min(1, (ms - 3800) / 500) : 0;
  const winVisible = ms >= 3800;
  const rowVisible = (i: number) => winVisible && ms >= 3800 + i * 260;
  const badgeVisible = ms >= 4700;
  const opacity = ms >= 5400 ? Math.max(0, (LOOP_MS - ms) / 2000) : 1;

  return (
    <div style={{
      border: "1px solid var(--border-light)", borderRadius: 8, padding: 14,
      background: "var(--bg-surface)", userSelect: "none",
    }}>
      {/* Office app tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 8, opacity }}>
        {APPS.map((app) => (
          <div key={app.key} style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            padding: "3px 10px", borderRadius: 6, fontSize: 9,
            background: app.active ? "var(--accent)" : "var(--bg-root)",
            color: app.active ? "#fff" : "var(--fg-muted)",
            border: app.active ? "none" : "1px solid var(--border-light)",
            fontWeight: 600,
          }}>
            <span>{app.icon}</span>
            {t(app.key as any)}
          </div>
        ))}
      </div>

      {/* Excel window mock */}
      <div style={{
        borderRadius: 8, overflow: "hidden", marginBottom: 10,
        background: "var(--bg-root)", border: "1px solid var(--border-light)",
        opacity: opacity,
      }}>
        {/* window title bar */}
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "5px 8px", background: "var(--bg-hover)",
          borderBottom: "1px solid var(--border-light)", fontSize: 9, color: "var(--fg-secondary)",
        }}>
          <span style={{ display: "flex", gap: 3 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#e05b4c" }} />
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#e0b94c" }} />
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#4cb04c" }} />
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 8, opacity: 0.8 }}>📊 {t("help.officeFileName")}</span>
        </div>
        {/* spreadsheet */}
        <div style={{ padding: 6, transform: `scale(${winIn})`, transformOrigin: "top center" }}>
          <div style={{ display: "flex", fontSize: 9, fontWeight: 700 }}>
            <div style={{ flex: 1, padding: "3px 6px", background: "var(--bg-hover)", color: "var(--fg-secondary)", borderRadius: "3px 0 0 3px" }}>{t("help.officeColA")}</div>
            <div style={{ flex: 1, padding: "3px 6px", background: "var(--bg-hover)", color: "var(--fg-secondary)" }}>{t("help.officeColB")}</div>
            <div style={{ flex: 1, padding: "3px 6px", background: "var(--bg-hover)", color: "var(--fg-secondary)", borderRadius: "0 3px 3px 0" }}>{t("help.officeColC")}</div>
          </div>
          {ROWS.map((row, i) => (
            <div key={row.a} style={{
              display: "flex", fontSize: 9,
              opacity: rowVisible(i) ? 1 : 0, transition: "opacity 0.25s",
            }}>
              <div style={{ flex: 1, padding: "3px 6px", color: "var(--fg-primary)", borderBottom: "1px solid var(--border-light)" }}>{row.a}</div>
              <div style={{ flex: 1, padding: "3px 6px", color: "var(--fg-primary)", borderBottom: "1px solid var(--border-light)" }}>{row.b}</div>
              <div style={{ flex: 1, padding: "3px 6px", color: "var(--semantic-success)", borderBottom: "1px solid var(--border-light)" }}>{row.c}</div>
            </div>
          ))}
          <div style={{ display: "flex", fontSize: 9, opacity: winVisible ? winIn : 0 }}>
            <div style={{ flex: 1, padding: "3px 6px", color: "var(--fg-secondary)", fontWeight: 700 }}>{t("help.officeTotal")}</div>
            <div style={{ flex: 1, padding: "3px 6px", color: "var(--fg-primary)", fontWeight: 700 }}>427</div>
            <div style={{ flex: 1, padding: "3px 6px", color: "var(--semantic-success)", fontWeight: 700 }}>+26%</div>
          </div>
        </div>
        {/* badge */}
        {badgeVisible && (
          <div style={{
            position: "relative", display: "inline-block", margin: "0 6px 6px",
            fontSize: 8, fontWeight: 700, color: "#fff",
            background: "var(--semantic-success)", borderRadius: 10,
            padding: "1px 7px", boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
          }}>
            ✓ {t("help.officeGenerated")}
          </div>
        )}
      </div>

      {/* Conversation strip */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
        {/* user bubble */}
        <div style={{ display: "flex", justifyContent: "flex-end", opacity: ms >= 400 ? opacity : 0, transition: "opacity 0.2s" }}>
          <div style={{
            maxWidth: "90%", background: "var(--accent)", color: "#fff",
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
            <span style={{ color: "var(--fg-secondary)", fontWeight: 600 }}>{t("help.officeToolLabel")}</span>
            <span style={{
              fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--accent)",
              background: "var(--accent-subtle)", borderRadius: 4, padding: "1px 5px",
            }}>
              {t("help.officeToolName")}
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
        {t("help.officeHint")}
      </div>
    </div>
  );
}
