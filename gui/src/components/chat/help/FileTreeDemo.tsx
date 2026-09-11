import { useEffect, useState } from "react";
import { t } from "../../../i18n";
import { ensureHelpAnimations } from "./helpAnimations";

ensureHelpAnimations();

/* ── FileTreeDemo: right-click → send file to chat ──
   Pure timed loop, zero interaction. Timeline:
     0.3s  · App.tsx gets a hover highlight
     1.2s  · a right-click context menu pops up near it
     1.8s  · "发送到聊天" menu item pulses
     2.6s  · an @App.tsx reference chip flies from the file to the chat input
     3.8s  · the chip lands in the input box
     5.4s  · fade, loop restarts */

const LOOP_MS = 6800;

const TREE_ROWS = [
  { text: "📁 src/", pad: 0, dir: true },
  { text: "📁 components/", pad: 16, dir: true },
  { text: "📄 App.tsx", pad: 32, target: true },
  { text: "📄 Toolbar.tsx", pad: 32 },
  { text: "📄 index.ts", pad: 0 },
  { text: "📄 package.json", pad: 0 },
];

const MENU_ITEMS = [
  { icon: "📄", key: "files.newFile" },
  { icon: "✏️", key: "files.rename" },
  { icon: "➤", key: "files.sendToChat", send: true },
  { icon: "🗑️", key: "files.delete" },
];

export function FileTreeDemo() {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 100);
    return () => clearInterval(id);
  }, []);

  const ms = (tick * 100) % LOOP_MS;

  const hover = ms >= 300 && ms < 1600;
  const menuVisible = ms >= 1200 && ms < 5200;
  const sendPulse = ms >= 1800 && ms < 2800;
  const flight = Math.min(1, Math.max(0, (ms - 2600) / 1200));
  const ease = 0.5 - 0.5 * Math.cos(flight * Math.PI);
  const landed = ms >= 3800;
  const chipVisible = ms >= 2600;
  const fade = ms >= 5400 ? (LOOP_MS - ms) / 1400 : 1;

  const chipX = 30 + (42 - 30) * ease;
  const chipY = 34 + (82 - 34) * ease;

  return (
    <div style={{
      border: "1px solid var(--border-light)", borderRadius: 8, padding: 14,
      background: "var(--bg-surface)", userSelect: "none", position: "relative",
    }}>
      {/* File tree mock */}
      <div style={{
        position: "relative", borderRadius: 6, overflow: "hidden",
        background: "var(--bg-hover)", padding: "8px 10px",
      }}>
        {TREE_ROWS.map((row) => (
          <div key={row.text} style={{
            fontFamily: "var(--font-mono)", fontSize: 10, lineHeight: 1.9, whiteSpace: "nowrap",
            paddingLeft: row.pad, borderRadius: 3,
            color: row.dir ? "#e8a840" : "var(--fg-secondary)",
            background: row.target && hover ? "var(--accent-subtle)" : "transparent",
            transition: "background 0.2s",
          }}>
            {row.text}
          </div>
        ))}

        {/* Right-click context menu */}
        {menuVisible && (
          <div style={{
            position: "absolute", left: 30, top: 42, width: 150, zIndex: 7,
            background: "var(--bg-surface)", border: "1px solid var(--border-light)",
            borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            padding: 4, opacity: fade,
          }}>
            {MENU_ITEMS.map((item) => (
              <div key={item.key} style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "5px 8px", borderRadius: 4, fontSize: 9,
                color: item.send && sendPulse ? "var(--accent)" : "var(--fg-primary)",
                background: item.send && sendPulse ? "var(--accent-subtle)" : "transparent",
                fontWeight: item.send ? 600 : 400,
                transition: "background 0.2s",
              }}>
                <span>{item.icon}</span>
                {t(item.key as any)}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Chat input mock */}
      <div style={{
        marginTop: 8, height: 32, display: "flex", alignItems: "center", gap: 6,
        padding: "0 10px",
        background: "var(--bg-root)", border: "1px solid var(--border-light)", borderRadius: 6,
        opacity: fade,
      }}>
        {landed && (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 3,
            padding: "2px 7px", borderRadius: 4,
            background: "var(--accent)", color: "#fff",
            fontSize: 9, fontWeight: 700, fontFamily: "var(--font-mono)",
          }}>
            @App.tsx
          </div>
        )}
        <div style={{ fontSize: 9, color: "var(--fg-muted)" }}>{t("help.fileInputPlaceholder")}</div>
      </div>

      {/* Hint */}
      <div style={{
        fontSize: "calc(var(--font-scale, 1) * 10px)", color: "var(--fg-muted)",
        textAlign: "center", lineHeight: 1.5, marginTop: 8, opacity: fade,
      }}>
        {t("help.fileRefHint")}
      </div>

      {/* Flying @reference chip */}
      {chipVisible && (
        <div style={{
          position: "absolute", left: `${chipX}%`, top: `${chipY}%`,
          transform: "translate(-50%,-50%)", zIndex: 8,
          display: "inline-flex", alignItems: "center", gap: 3,
          padding: "3px 8px", borderRadius: 6,
          background: "var(--accent)", color: "#fff",
          fontSize: 9, fontWeight: 700, fontFamily: "var(--font-mono)",
          boxShadow: "0 3px 10px rgba(0,0,0,0.25)",
          whiteSpace: "nowrap", opacity: fade,
        }}>
          @App.tsx
        </div>
      )}
    </div>
  );
}
