import React from "react";
import { t } from "../i18n";

/* ── 统一的加载、空态、错误态组件 ── */

interface LoadingSpinnerProps {
  text?: string;
  size?: number;
}

export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({ text, size = 20 }) => (
  <div style={{
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    color: "var(--fg-muted)",
    fontFamily: "var(--font-sans)",
    gap: "12px",
  }}>
    <div style={{
      width: size,
      height: size,
      border: "2.5px solid var(--border-light)",
      borderTopColor: "var(--accent)",
      borderRadius: "50%",
      animation: "app-spin 0.8s linear infinite",
    }} />
    {text !== undefined && (
      <div style={{ fontSize: "12px" }}>{text || t("common.loading")}</div>
    )}
  </div>
);

interface EmptyStateProps {
  icon?: React.ReactNode;
  text: string;
  action?: { label: string; onClick: () => void };
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon, text, action }) => (
  <div style={{
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "32px 16px",
    color: "var(--fg-muted)",
    fontFamily: "var(--font-sans)",
    gap: "8px",
    textAlign: "center",
  }}>
    {icon && <div style={{ opacity: 0.4, marginBottom: "4px" }}>{icon}</div>}
    <div style={{ fontSize: "13px", maxWidth: "220px" }}>{text}</div>
    {action && (
      <button
        onClick={action.onClick}
        style={{
          marginTop: "4px",
          padding: "4px 14px",
          background: "var(--accent)",
          color: "var(--fg-inverse)",
          border: "none",
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
          fontSize: "12px",
          fontFamily: "var(--font-sans)",
        }}
      >
        {action.label}
      </button>
    )}
  </div>
);

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export const ErrorState: React.FC<ErrorStateProps> = ({ message, onRetry }) => (
  <div style={{
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px 16px",
    color: "var(--fg-secondary)",
    fontFamily: "var(--font-sans)",
    gap: "8px",
    textAlign: "center",
  }}>
    <div style={{
      width: "36px",
      height: "36px",
      borderRadius: "50%",
      background: "var(--semantic-error)",
      color: "white",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: "18px",
      fontWeight: 700,
      marginBottom: "4px",
    }}>
      !
    </div>
    <div style={{ fontSize: "13px", maxWidth: "280px", color: "var(--fg-secondary)" }}>
      {message}
    </div>
    {onRetry && (
      <button
        onClick={onRetry}
        style={{
          marginTop: "4px",
          padding: "4px 14px",
          background: "var(--accent)",
          color: "var(--fg-inverse)",
          border: "none",
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
          fontSize: "12px",
          fontFamily: "var(--font-sans)",
        }}
      >
        {t("common.retry")}
      </button>
    )}
  </div>
);
