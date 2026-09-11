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
  // 一次性自动重试：懒加载/异步竞态导致的"临时渲染错"重试即恢复(如编辑器 Monaco 加载时序)。
  // 每次错误周期仅自动重试一次；失败后靠手动重试(重置此标记)再允许一次自动重试，避免死循环。
  autoRetried = false;
  // 瞬时 hydration 错(#300/#310, 如 Monaco 重挂/重渲染竞态)的静默重试次数——这类错误
  // 高发但重试即恢复, 不应每次都弹"面板加载失败"打扰用户; 超过上限才落手动 fallback。
  transientRetries = 0;

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const label = this.props.panelName ? ` [${this.props.panelName}]` : "";
    console.error(`[ErrorBoundary${label}]`, error, info.componentStack);
    const isTransientHydration = /does not match server-rendered HTML|Hydration failed|Text content did not match/.test(
      String(error?.message || ""),
    );
    if (isTransientHydration) {
      // 高发瞬时错: 静默重试, 每次隔一点延迟避免风暴; 试 2 次仍失败才落手动 fallback。
      if (this.transientRetries < 2) {
        this.transientRetries++;
        setTimeout(() => this.setState({ error: null }), 120 * this.transientRetries);
        return;
      }
    } else if (!this.autoRetried) {
      this.autoRetried = true;
      // 让错误先记录，下一帧重置重渲染——transient 竞态此时通常已恢复
      setTimeout(() => this.setState({ error: null }), 0);
      return;
    }
  }

  handleRetry = () => {
    this.autoRetried = false;
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
