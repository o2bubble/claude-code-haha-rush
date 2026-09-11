import { useEffect, useState } from "react";
import { t } from "../../../i18n";
import { ensureHelpAnimations } from "./helpAnimations";

ensureHelpAnimations();

/* ── NotesDemo: AI-creates-a-note scenario storyboard ──
   Pure timed loop, zero interaction. Timeline:
     0.4s  · user types the request (typewriter)
     2.3s  · AI tool chip appears (MCP note_create, generating…)
     3.2s  · tool done ✓
     3.8s  · the note appears in the notes panel — list item + markdown lines
     4.7s  · "已保存到笔记" badge pops
     5.4s  · everything fades, loop restarts */

const LOOP_MS = 7400;

const LINES: { key: string; type: "title" | "exp" | "pit" }[] = [
  { key: "help.notesTitle", type: "title" },
  { key: "help.notesExp", type: "exp" },
  { key: "help.notesExp1", type: "exp" },
  { key: "help.notesExp2", type: "exp" },
  { key: "help.notesPit", type: "pit" },
  { key: "help.notesPit1", type: "pit" },
  { key: "help.notesPit2", type: "pit" },
];

export function NotesDemo() {
  const MSG = t("help.notesUserMsg");
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
  const noteIn = ms >= 3800 ? Math.min(1, (ms - 3800) / 500) : 0;
  const noteVisible = ms >= 3800;
  const savedBadge = ms >= 4700;
  const opacity = ms >= 5400 ? Math.max(0, (LOOP_MS - ms) / 2000) : 1;

  const lineVisible = (i: number) => noteVisible && ms >= 3800 + i * 160;

  return (
    <div style={{
      border: "1px solid var(--border-light)", borderRadius: 8, padding: 14,
      background: "var(--bg-surface)", userSelect: "none",
    }}>
      {/* Mini notes panel: list + markdown editor */}
      <div style={{
        display: "flex", height: 158, borderRadius: 6, overflow: "hidden",
        background: "var(--bg-hover)", border: "1px solid var(--border-light)", marginBottom: 10,
        opacity,
      }}>
        {/* note list */}
        <div style={{
          width: 104, flexShrink: 0,
          background: "var(--bg-root)", borderRight: "1px solid var(--border-light)",
          padding: 6, display: "flex", flexDirection: "column", gap: 4,
        }}>
          <div style={{ fontSize: 8, color: "var(--fg-muted)", fontWeight: 600, marginBottom: 2 }}>笔记列表</div>
          <div style={{
            fontSize: 9, color: "var(--fg-secondary)", padding: "4px 6px",
            borderRadius: 4, background: "var(--bg-hover)", opacity: 0.7,
          }}>
            📝 技术笔记
          </div>
          {noteVisible && (
            <div style={{
              fontSize: 9, color: "var(--fg-primary)", padding: "4px 6px",
              borderRadius: 4, background: "var(--accent-subtle)",
              borderLeft: "2px solid var(--accent)",
              opacity: noteIn, whiteSpace: "nowrap", overflow: "hidden",
            }}>
              📌 {t("help.notesTitle")}
            </div>
          )}
        </div>
        {/* markdown content */}
        <div style={{
          flex: 1, padding: "8px 10px", overflow: "hidden",
          background: "var(--bg-surface)",
        }}>
          {LINES.map((l, i) => (
            <div key={l.key} style={{
              fontSize: l.type === "title" ? 11 : 9.5,
              fontWeight: l.type === "title" ? 700 : l.type === "exp" || l.type === "pit" ? 700 : 400,
              color: l.type === "title" ? "var(--fg-primary)"
                : l.type === "exp" ? "var(--semantic-success)"
                : l.type === "pit" ? "#e08a00"
                : "var(--fg-secondary)",
              lineHeight: 1.6,
              opacity: lineVisible(i) ? 1 : 0,
              transition: "opacity 0.25s",
              whiteSpace: "nowrap",
            }}>
              {l.type === "title" ? "# " : l.type === "exp" ? "• " : l.type === "pit" ? "• " : "• "}
              {t(l.key as any)}
            </div>
          ))}
          {savedBadge && (
            <div style={{
              display: "inline-block", marginTop: 6, fontSize: 8, fontWeight: 700,
              color: "#fff", background: "var(--semantic-success)", borderRadius: 10,
              padding: "1px 7px", boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
              opacity: opacity,
            }}>
              ✓ {t("help.notesSaved")}
            </div>
          )}
        </div>
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
            <span style={{ color: "var(--fg-secondary)", fontWeight: 600 }}>{t("help.sdToolLabel")}</span>
            <span style={{
              fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--accent)",
              background: "var(--accent-subtle)", borderRadius: 4, padding: "1px 5px",
            }}>
              {t("help.notesToolName")}
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
        {t("help.notesHint")}
      </div>
    </div>
  );
}
