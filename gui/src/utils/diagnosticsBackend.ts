// diagnosticsBackend.ts — 后端服务分类纯函数（前端可测接缝）。
// 后端进程/端口/WS 状态来自运行时前端状态，分类逻辑与 Rust 检查同构。

import type { CheckStatus } from "../services/diagnosticsService";
import type { BackendStatus } from "../services/backendService";

export interface BackendClassification {
  status: CheckStatus;
  detail: string;
}

export function classifyBackendStatus(
  status: BackendStatus,
  port: number | null,
  error?: string,
): BackendClassification {
  switch (status) {
    case "running":
      return port
        ? { status: "pass", detail: `运行中（端口 ${port}）` }
        : { status: "warn", detail: "运行中但未获取到端口" };
    case "starting":
      return { status: "warn", detail: "启动中..." };
    case "stopped":
      return { status: "warn", detail: "未启动" };
    case "error":
      return { status: "fail", detail: error || "后端启动失败" };
  }
}

export function classifyWsConnected(connected: boolean): BackendClassification {
  return connected
    ? { status: "pass", detail: "已连接" }
    : { status: "warn", detail: "未连接/重连中" };
}

/** 后端端口：有端口 → 通过；后端 error → 失败；否则（未启动/启动中）→ 警告。 */
export function classifyBackendPort(port: number | null, status: BackendStatus): BackendClassification {
  if (port) return { status: "pass", detail: `端口 ${port}` };
  if (status === "error") return { status: "fail", detail: "后端启动失败，无端口" };
  return { status: "warn", detail: "未获取到端口" };
}
