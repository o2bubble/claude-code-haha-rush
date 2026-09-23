// ── 实例自述上报 ──
//
// 每个 GUI 实例把「我绑了哪个工作区、开着哪个会话」写成一份小文件
// （`<app_data>/instances/<pid>.json`，Rust 侧见 src-tauri/src/instances.rs）。
// 升级时会强杀所有实例，升级后的新 GUI 靠这些自述把大家拉回来。
//
// ⚠️ **为什么必须去重**：调用方挂在 `CHAT_STATE_CHANGED` 上，而那个事件**每次
// 消息变化都会发**（流式输出时每秒好几次）。不去重的话每个 token 都要走一次
// 动态 import + IPC + 文件写 —— 会把流式渲染拖垮。
//
// ⚠️ **会话为空时默认保留旧值**（`keepSession`）：调用方每次 CHAT_STATE_CHANGED
// 都上报，而流式期间 `sessionId` 可能短暂为 null（会话刚切、新建中、还没加载完）。
// 照直写空 → 自述里没有会话 → 升级后"只绑工作区、不开会话"（2026-09-22 用户实测）。
// 会话为空几乎总是"还没就绪"，不是"用户不要会话"，所以默认保留；
// 真正要清空（用户新建会话）由调用方明确传 `keepSession: false`。

import { invoke } from "@tauri-apps/api/core";

/** 上一次上报过的值 —— 相同则跳过（见文件头注释）。 */
let lastWorkspace: string | undefined;
let lastSession: string | undefined;
let lastSentAt = 0;

/** 被最小间隔拦下、等待补发的值（见 scheduleFlush 的注释）。 */
let pending: { workspace: string; session: string } | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** 最短上报间隔：即使值一直变，也不高频写盘。
 *  1 秒足够 —— 升级时用到的只是"最后一个稳定值"，晚 1 秒无所谓。 */
const MIN_INTERVAL_MS = 1000;

function doSend(workspace: string, session: string, keepSession: boolean): void {
  lastWorkspace = workspace;
  lastSession = session;
  lastSentAt = Date.now();
  invoke("update_instance_record", { workspace, sessionId: session, keepSession }).catch(() => {
    // 写失败不影响使用（最坏是升级后少恢复一个窗口）——
    // 回滚去重状态，让下次有机会重试
    lastWorkspace = undefined;
    lastSession = undefined;
  });
}

/**
 * 值变了但被最小间隔拦住时，**安排一次延迟补发**。
 *
 * 为什么必须有：调用方只在 `CHAT_STATE_CHANGED` 时上报，而那个事件在**回合结束后
 * 可能不再触发** —— 若这次被拦下的上报不补发，它就永久丢失了（自述停留在旧值）。
 * 实测场景：会话加载完成的那次上报正好落在流式密集期内 → 被拦 → 之后再无事件
 * → 自述里始终没有会话。
 */
function scheduleFlush(workspace: string, session: string, keepSession: boolean): void {
  pending = { workspace, session };
  if (flushTimer) return; // 已有定时器，它的回调会读到最新的 pending
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastSentAt));
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const p = pending;
    pending = null;
    if (!p) return;
    if (p.workspace === (lastWorkspace ?? "") && p.session === (lastSession ?? "")) return;
    doSend(p.workspace, p.session, keepSession);
  }, wait + 10);
}

export interface ReportOptions {
  /**
   * 会话为空时是否保留自述里已有的会话。
   * - `true`（默认）：保留 —— 用于"切工作区/会话尚未就绪"等过渡态
   * - `false`：照实写空 —— 用于用户**新建会话**（确实不该再恢复到旧会话）
   */
  keepSession?: boolean;
}

/**
 * 上报本实例状态。
 *
 * - `workspace`：传则更新工作区（切工作区时用）
 * - `sessionId`：当前会话；空值 + `keepSession` 时由 Rust 侧保留旧值
 *
 * 值完全没变时**跳过**（见文件头注释：这个函数调用得极其频繁）。
 */
export function reportInstanceState(
  workspace?: string,
  sessionId?: string,
  opts?: ReportOptions,
): void {
  const keepSession = opts?.keepSession ?? true;
  const nextWs = workspace !== undefined ? workspace : (lastWorkspace ?? "");
  // ⚠️ **切了工作区 → 会话不再沿用旧值，一律传空**。
  // 不这么做会写出"工作区 B + 工作区 A 的会话 id"这种**不一致组合** ——
  // 下次升级恢复时拿着 A 的会话 id 去 B 里找，必然打不开（比"没会话"更糟）。
  // 传空之后由 Rust 侧的 keepSession 决定保留还是清空：保留 = 过渡（等新会话覆盖），
  // 清空 = 用户新建会话。两种情况都比传旧 id 正确。
  const wsChanged = workspace !== undefined && workspace !== (lastWorkspace ?? "");
  const nextSess = wsChanged
    ? (sessionId ?? "")
    : (sessionId !== undefined ? sessionId : (lastSession ?? ""));

  if (nextWs === (lastWorkspace ?? "") && nextSess === (lastSession ?? "")) {
    return; // 值没变 —— 最常见的路径（每次消息变化都会走到这）
  }
  if (Date.now() - lastSentAt < MIN_INTERVAL_MS) {
    scheduleFlush(nextWs, nextSess, keepSession); // 太频繁 → 排一次补发
    return;
  }
  doSend(nextWs, nextSess, keepSession);
}

/** 仅测试用：重置去重状态。 */
export function __resetInstanceRegistryCache(): void {
  lastWorkspace = undefined;
  lastSession = undefined;
  lastSentAt = 0;
  pending = null;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
