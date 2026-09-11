// ── WS 连接诊断: 记录最近连接事件, 供诊断面板展示 ──
// 目的: 复现「IDE后端已ready但前端WS未连接」时, 诊断面板能区分
//   连错端口(port 与 backend 实际端口不符) / 连接被拒(ECONNREFUSED) /
//   中途断开。纯事件记录, 无状态推算, 不干扰任何逻辑。
export type WsDiagEvent =
  | { kind: "connect"; port: number; ts: number }
  | { kind: "open"; port: number; ts: number }
  | { kind: "close"; port: number; code?: number; reason?: string; ts: number }
  | { kind: "error"; port: number; ts: number };

const MAX_EVENTS = 12;
let events: WsDiagEvent[] = [];

export function wsDiagAdd(ev: WsDiagEvent) {
  events.push(ev);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export function wsDiagReset() {
  events = [];
}

/** 诊断面板读取: 最近事件(新→旧) */
export function getWsDiag(): WsDiagEvent[] {
  return [...events].reverse();
}