// ── 无人值守守护: 前端桥 — 状态 + 裁决动作执行 ──
// Rust 裁决(纯函数) → emit "guard-action" → 本模块执行:
//   发验收/继续消息(SendAccept/SendResume)、放行队列(ReleaseNext)、退出/暂停
// 回合结束上报(TurnEnded)由 chatSession 在 streaming→false 钩子调用。
// 为避免与 chatSession 循环依赖, 消息发送/放行经 registerGuardChatApi 注入。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getChatState } from "../stores/chatStore";
import { getActiveQueue } from "../stores/msgQueueStore";
import { addStatusMessage } from "../stores/statusMsgStore";
import { t } from "../i18n";

export type GuardUiStatus = "off" | "watching" | "asking" | "paused";

export interface GuardActionMsg {
  type: "sendAccept" | "sendResume" | "releaseNext" | "exit" | "pause";
  gaps?: string;
  reason?: string;
}

/** chatSession 注入的执行 API（解环） */
export interface GuardChatApi {
  sendMessage: (text: string) => void;
  /** 放行下一条队列消息: 恢复(autoSend)并绕过守卫门发队首 */
  releaseQueue: () => void;
}

let chatApi: GuardChatApi | null = null;

export function registerGuardChatApi(api: GuardChatApi) {
  chatApi = api;
}

let status: GuardUiStatus = "off";
let listeners: Array<() => void> = [];
let subscribing = false;

// 就绪 watcher: 直接轮询 streaming 翻转(= 输入区就绪, 与 UI 同一信号源),
// 兜底任何消息类型(不管后端发不发 result/status:ready)都能感知回合结束,
// 与 dispatch 上报去重(同回合双报会让 Rust 把任务文本误当验收回复解析)。
let watcherTimer: ReturnType<typeof setInterval> | null = null;
let prevStreaming: boolean | undefined;
let dispatchReportedAt = 0;

/** dispatch 路径上报时标记, watcher 2s 内不再补报 */
export function markGuardReported() {
  dispatchReportedAt = Date.now();
}

/** 就绪 watcher 判定(纯函数, 可单测): streaming true→false 翻转且近期无 dispatch 上报 */
export function shouldReportTurnEnded(
  prev: boolean | undefined,
  cur: boolean,
  now: number,
  lastDispatch: number,
): boolean {
  return prev === true && cur === false && now - lastDispatch > 2000;
}

function startGuardWatcher() {
  if (watcherTimer) return;
  watcherTimer = setInterval(() => {
    if (status === "off") return;
    const s = getChatState().streaming;
    // streaming true→false(回合结束/就绪)且 dispatch 未刚上报过 → 补报
    if (shouldReportTurnEnded(prevStreaming, s, Date.now(), dispatchReportedAt)) {
      markGuardReported();
      void reportGuardTurnEnded();
    }
    prevStreaming = s;
  }, 1000);
}

function notify() {
  for (const fn of listeners) fn();
}

export function getGuardStatus(): GuardUiStatus {
  return status;
}

export function guardActive(): boolean {
  return status !== "off";
}

export function subscribeGuard(fn: () => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((x) => x !== fn);
  };
}

export function handleGuardAction(action: GuardActionMsg) {
  switch (action.type) {
    case "sendAccept":
      status = "asking";
      chatApi?.sendMessage(ACCEPT_TEXT);
      break;
    case "sendResume":
      status = "watching";
      chatApi?.sendMessage(RESUME_TEXT(action.gaps ?? ""));
      break;
    case "releaseNext":
      status = "watching";
      // agent 忙(streaming)时不放行 — 等回合结束由郑重 Watching→验收接管,
      // 避免 sendDrain 被 busy-reject 后丢弃队首消息
      if (getChatState().streaming) break;
      chatApi?.releaseQueue();
      break;
    case "exit":
      status = "off";
      addStatusMessage(t("guard.done"), "success");
      break;
    case "pause":
      status = "paused";
      addStatusMessage(action.reason ?? "守护已暂停", "warn");
      break;
  }
  notify();
}

// 验收/继续提示词: 双语固定常量(非 i18n)——Rust 解析白名单认 DONE|完成/NOTDONE|未完成,
// 本地化会导致模型回词的解析歧义, 双语列全并保持原样最为可靠
export const ACCEPT_TEXT = "【守护系统】当前任务验收。请严格回复：DONE|完成  或  NOTDONE|未完成（附剩余说明），不要附加其他内容";
export function RESUME_TEXT(gaps: string) {
  return `【守护系统】任务尚未完成（上轮差项：${gaps}）。请继续完成；完成后回复 DONE|完成。`;
}

/** 最近一次已上报的 assistant 消息 id — 同一回合由 result+status:ready+watcher
 *  多次结束信号时只上报一次, 否则 Rust 把同一回合误当验收回复多次解析 */
let lastReportedMsgId = "";

/** 找最后一条"可上报"的 assistant 消息 — 跳过 chatReduce 把后端 error 广播
 *  push 成的 "Error: ..." 消息。错误内容绝不是验收回复, 上报会让守卫把后端
 *  错误误判成格式异常(连续 2 次即暂停)。纯函数, 便于单测。 */
export function findLastReportableAssistant(messages: Array<{ role?: string; content?: unknown; id?: string }>):
  { id?: string; content?: unknown } | undefined {
  return [...messages].reverse().find(
    (m) => m.role === "assistant" && !String(m.content ?? "").trimStart().startsWith("Error:"),
  );
}

/** 会话切换/重置后清空上报去重(新回合应有新的 assistant id) */
export function resetGuardReported() {
  lastReportedMsgId = "";
  turnByUserInterruption = false;
}

/** 当前回合是否由用户手动插话引起(区别对验收消息的回复)。
 *  chatSession 在用户手动 sendMessage 时置 true; 守卫 force/队列 drain 不置。
 *  Asking 状态下 Rust 收到 userInterruption 回合会忽略, 不当作验收回复解析。 */
let turnByUserInterruption = false;

/** chatSession 标记: 用户手动发消息 → 该回合是插话 */
export function markUserInterruptedTurn() {
  turnByUserInterruption = true;
}

/** 自动回合(守卫控制/队列)结束后复位 — 也可调 resetGuardReported 一并清 */
export function clearUserInterruptedTurn() {
  turnByUserInterruption = false;
}

/** 上报回合结束(Rust 裁决器只在 TurnEnded 推进) */
export async function reportGuardTurnEnded() {
  if (status === "off") return;
  const state = getChatState();
  const last = findLastReportableAssistant(state.messages);
  if (!last) return;
  if (last.id === lastReportedMsgId) return; // 同一 assistant 回合只报一次
  lastReportedMsgId = last.id ?? "";
  const userInterruption = turnByUserInterruption;
  turnByUserInterruption = false; // 每次上报消费一次标记
  const queueLen = getActiveQueue().messages.length;
  const content = last.content ?? "";
  const text = typeof content === "string" ? content : String(content).replace(/[\[\]{}"]/g, "");
  try {
    await invoke("guard_event", {
      event: { type: "turnEnded", lastAssistantText: text, queueLen, userInterruption },
    });
  } catch (e) {
    // 上报失败不致命(心跳兜底), 但留日志便于排障
    console.warn("[guard] turnEnded invoke failed:", e);
  }
}

export async function guardStart() {
  try {
    await invoke("guard_event", { event: { type: "start" } });
    resetGuardReported(); // 清除上一轮残留的 dedup id 与插话标记
    status = "watching";
    prevStreaming = getChatState().streaming;
    startGuardWatcher();
    notify();
    addStatusMessage(t("guard.started"), "info");
    // 无任何任务在途时明确告知用户守卫在等什么
    if (!getChatState().streaming && getActiveQueue().messages.length === 0) {
      addStatusMessage(t("guard.noRound"), "info");
    }
  } catch (e) {
    addStatusMessage(`守卫启动失败: ${e}`, "error");
  }
}

export async function guardStop() {
  try {
    await invoke("guard_event", { event: { type: "stop" } });
  } finally {
    status = "off";
    resetGuardReported();
    notify();
  }
}

/** 订阅 Rust 裁决动作(单例) */
export function subscribeGuardActions(): () => void {
  if (subscribing) return () => {};
  subscribing = true;
  let unlisten: (() => void) | null = null;
  void listen<GuardActionMsg>("guard-action", (e) => {
    handleGuardAction(e.payload);
  }).then((u) => {
    unlisten = u;
  });
  return () => unlisten?.();
}