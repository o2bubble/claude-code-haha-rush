import React from "react";
import { t } from "../i18n";

interface Props {
  children: React.ReactNode;
  fallback?: (error: Error, retry: () => void) => React.ReactNode;
  panelName?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const label = this.props.panelName ? ` [${this.props.panelName}]` : "";
    console.error(`[ErrorBoundary${label}]`, error, info.componentStack);
  }

  handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.handleRetry);
      }
      return (
        <div
          style={{
            padding: "16px",
            color: "var(--fg-secondary)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-light)",
            borderRadius: "var(--radius-md)",
            margin: "8px",
            fontFamily: "var(--font-sans)",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: "4px", color: "var(--fg-primary)", fontSize: "14px" }}>
            {this.props.panelName ? t("errorBoundary.panelFailed", { name: this.props.panelName }) : t("errorBoundary.componentFailed")}
          </div>
          <div style={{ fontSize: "12px", marginBottom: "8px", color: "var(--fg-muted)" }}>
            {this.state.error.message}
          </div>
          <button
            onClick={this.handleRetry}
            style={{
              padding: "4px 12px",
              background: "var(--accent)",
              color: "var(--fg-inverse)",
              border: "none",
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
              fontSize: "12px",
              fontFamily: "var(--font-sans)",
            }}
          >
            {t("errorBoundary.retry")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
