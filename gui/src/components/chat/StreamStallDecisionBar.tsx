import React from "react";
import { useT } from "../../i18n";

/**
 * 流静默决策条：模型流长时间无响应时，让用户选择「继续等」还是「中断」。
 * 仿 PermissionPrompt 的 absolute 底部浮动条 + warning 语义色。
 */
export function StreamStallDecisionBar({
  onWait,
  onWake,
  onInterrupt,
}: {
  onWait: () => void;
  onWake: () => void;
  onInterrupt: () => void;
}) {
  const t = useT();
  return (
    <div
      style={{
        position: "absolute",
        left: 12,
        right: 12,
        // 悬浮在输入区上方、避让打字/发送按钮，不遮挡输入框主体
        bottom: 64,
        backgroundColor: "var(--semantic-warning-subtle)",
        border: "1px solid var(--semantic-warning)",
        color: "var(--fg-primary)",
        borderRadius: 8,
        boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
        padding: "8px 10px",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontFamily: "var(--font-sans)",
        fontSize: "calc(var(--font-scale, 1) * 12px)",
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <strong>{t("chat.stallDecisionTitle")}</strong>{" "}
        {t("chat.stallDecisionBody")}
      </span>
      <button type="button" onClick={onWait} style={btn(false)}>
        {t("chat.stallDecisionWait")}
      </button>
      <button
        type="button"
        onClick={onWake}
        style={{ ...btn(false), border: "none", backgroundColor: "var(--accent)", color: "var(--fg-inverse)" }}
      >
        {t("chat.stallDecisionWake")}
      </button>
      <button
        type="button"
        onClick={onInterrupt}
        style={{ ...btn(true), border: "none", backgroundColor: "var(--semantic-error)", color: "var(--fg-inverse)" }}
      >
        {t("chat.stallDecisionInterrupt")}
      </button>
    </div>
  );
}

const btn = (danger: boolean): React.CSSProperties => ({
  padding: "4px 12px",
  border: "1px solid var(--border-medium)",
  borderRadius: 4,
  backgroundColor: "var(--bg-root)",
  cursor: "pointer",
  fontSize: "calc(var(--font-scale, 1) * 12px)",
  fontFamily: "var(--font-sans)",
  flexShrink: 0,
  color: danger ? "var(--semantic-error)" : "var(--fg-primary)",
});
