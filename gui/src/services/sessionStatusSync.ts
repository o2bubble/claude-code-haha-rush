// ── 跨 GUI 会话状态同步：上报本实例激活会话状态 + 订阅其他实例的状态 ──
// 纯封装：状态推导 + 上报/订阅/快照都经 server 现有通道（session_status_report /
// get_session_statuses / "server:session-status" / "server:client-left"）。
// 只同步会话"状态"，不同步内容；按绑定的 workspace 过滤 influx。

import { eventBus } from "./serviceBus";
import { Events } from "./events";
import { getChatState } from "../stores/chatStore";
import {
  upsertSessionStatus,
  removeClient,
  replaceAllSessionStatus,
  type SessionStatusEntry,
} from "../stores/sessionStatusStore";

let started = false;
let workDirRef = "";
let lastReportedSessionId: string | null = null;
let lastReportedState: "working" | "idle" | null = null;

async function tauriInvoke(cmd: string, args?: Record<string, unknown>) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // invoke returns a promise that can reject async (e.g. no bound workspace) —
    // swallow it so `void tauriInvoke(...)` never leaves an unhandled rejection.
    return invoke(cmd, args).catch(() => undefined);
  } catch {
    return undefined;
  }
}

/** 二进制状态：后端 streaming/busy → working，否则 idle。 */
function deriveState(streaming: boolean): "working" | "idle" {
  return streaming ? "working" : "idle";
}

function reportIfChanged() {
  const st = getChatState();
  const sid = st.sessionId;
  const state = deriveState(st.streaming);
  if (sid === null) {
    lastReportedSessionId = null;
    lastReportedState = null;
    return;
  }
  if (sid === lastReportedSessionId && state === lastReportedState) return;
  lastReportedSessionId = sid;
  lastReportedState = state;
  void tauriInvoke("session_status_report", { sessionId: sid, state });
}

function toEntry(s: any): SessionStatusEntry | null {
  if (!s || typeof s.session_id !== "string") return null;
  return {
    sessionId: s.session_id,
    state: s.state === "working" ? "working" : "idle",
    clientId: s.client_id,
    workspace: s.workspace,
  };
}

function replaceFromSnapshot() {
  void tauriInvoke("get_session_statuses").then((list: unknown) => {
    if (Array.isArray(list)) {
      replaceAllSessionStatus(
        list
          .map(toEntry)
          .filter((e: SessionStatusEntry | null): e is SessionStatusEntry => !!e),
      );
    }
  });
}

/** 绑定工作区后调一次（可在切换工作区时重调）：接订阅 + 取快照 + 监听状态变化上报。 */
export function startSessionStatusSync(workDir: string) {
  workDirRef = workDir;

  if (!started) {
    started = true;
    import("@tauri-apps/api/event")
      .then(({ listen }) => {
        listen("server:session-status", (e: any) => {
          const entry = toEntry(e?.payload);
          if (entry && entry.workspace === workDirRef) upsertSessionStatus(entry);
        });
        listen("server:client-left", (e: any) => {
          if (e?.payload && typeof e.payload === "string") removeClient(e.payload);
        });
      })
      .catch(() => {});

    eventBus.on(Events.CHAT_STATE_CHANGED, reportIfChanged);
  }

  // 初次连接 + 切换工作区都会重拉当前工作区快照（订阅不重复注册）
  replaceFromSnapshot();
  reportIfChanged();
}
