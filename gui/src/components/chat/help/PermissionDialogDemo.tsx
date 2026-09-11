import { useState } from "react";
import { t } from "../../../i18n";

/* ── PermissionDialogDemo: interactive demo of the permission dialog ── */

export function PermissionDialogDemo() {
  const [choice, setChoice] = useState<"allow" | "deny" | null>(null);

  return (
    <div style={{
      border: "1px solid var(--border-light)",
      borderRadius: 8,
      padding: 14,
      background: "var(--bg-surface)",
      userSelect: "none",
    }}>
      {/* Simulated chat: AI asks to edit a file */}
      <div style={{
        display: "flex", flexDirection: "column", gap: 6, marginBottom: 12,
      }}>
        <div style={{
          alignSelf: "flex-start",
          background: "var(--accent-subtle)", color: "var(--accent)",
          borderRadius: 8, padding: "6px 12px",
          fontSize: "calc(var(--font-scale, 1) * 11px)", maxWidth: "80%",
        }}>
          AI：我找到了登录页的问题，需要修改 src/pages/login.tsx
        </div>
        <div style={{
          alignSelf: "flex-start",
          background: "var(--bg-hover)", color: "var(--fg-muted)",
          borderRadius: 8, padding: "6px 12px",
          fontFamily: "var(--font-mono)", fontSize: "calc(var(--font-scale, 1) * 10px)",
        }}>
          bash -c "curl https://example.com" <span style={{ color: "var(--semantic-warning)" }}>要运行命令</span>
        </div>
      </div>

      {/* Simulated permission dialog */}
      <div style={{
        border: "1px solid var(--border-medium)",
        borderRadius: 8, padding: 12,
        background: "var(--bg-root)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <span style={{ fontSize: 13 }}>🔐</span>
          <span style={{ fontSize: "calc(var(--font-scale, 1) * 12px)", fontWeight: 600, color: "var(--fg-primary)" }}>
            {t("help.flowPermTitle")}
          </span>
        </div>
        <div style={{
          fontSize: "calc(var(--font-scale, 1) * 10px)", color: "var(--fg-muted)", marginBottom: 10,
        }}>
          {choice === "allow" && <span style={{ color: "var(--semantic-success)" }}>✓ {t("help.flowPermAllowDesc")}</span>}
          {choice === "deny" && <span style={{ color: "var(--semantic-error)" }}>✗ {t("help.flowPermDenyDesc")}</span>}
          {!choice && <span>这个操作会影响你的文件或系统，是否允许 AI 执行？</span>}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setChoice("allow")}
            style={{
              ...permBtn, background: "var(--semantic-success)", color: "#fff",
              opacity: choice === "allow" ? 1 : 0.7,
            }}
          >{t("help.flowPermAllow")}</button>
          <button
            onClick={() => setChoice("deny")}
            style={{
              ...permBtn, background: "var(--semantic-error)", color: "#fff",
              opacity: choice === "deny" ? 1 : 0.7,
            }}
          >{t("help.flowPermDeny")}</button>
          {(choice !== null) && (
            <button
              onClick={() => setChoice(null)}
              style={{ ...permBtn, background: "var(--bg-hover)", color: "var(--fg-muted)" }}
            >↻</button>
          )}
        </div>
      </div>

      <div style={{
        fontSize: "calc(var(--font-scale, 1) * 10px)", color: "var(--fg-muted)", marginTop: 10,
        lineHeight: 1.5,
      }}>
        💡 {t("help.flowPermNote")}
      </div>
    </div>
  );
}

const permBtn: React.CSSProperties = {
  padding: "5px 14px", borderRadius: 6,
  border: "none", cursor: "pointer",
  fontSize: "calc(var(--font-scale, 1) * 11px)",
  fontFamily: "inherit", fontWeight: 600,
};
