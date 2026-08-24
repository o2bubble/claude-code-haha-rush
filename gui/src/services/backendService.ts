// BackendService - unified IDE backend lifecycle management

import { useEffect, useState } from "react";
import { eventBus } from "./serviceBus";
import { Events } from "./events";
import type { BackendStateChangedPayload, BackendPortReadyPayload } from "./events";
import { addStatusMessage } from "../stores/statusMsgStore";

let _tauriInvoke: any = null;
async function tauriInvoke() {
  if (_tauriInvoke) return _tauriInvoke;
  try {
    _tauriInvoke = (await import("@tauri-apps/api/core")).invoke;
  } catch {
    _tauriInvoke = null;
  }
  return _tauriInvoke;
}

export type BackendStatus = "stopped" | "starting" | "running" | "error";

export interface BackendState {
  status: BackendStatus;
  port: number | null;
  workDir: string;
  error?: string;
}

let _state: BackendState = {
  status: "stopped",
  port: null,
  workDir: "",
  error: undefined,
};

let _cancelPoll: (() => void) | null = null;

function notify() {
  eventBus.emit(Events.BACKEND_STATE_CHANGED, { ..._state } satisfies BackendStateChangedPayload);
}

async function pollForPort(timeoutMs = 30_000): Promise<number> {
  const invoke = await tauriInvoke();
  if (!invoke) throw new Error("Tauri IPC not available");

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (_cancelPoll) throw new Error("Cancelled");
    try {
      const p: number = await invoke("get_ide_port");
      return p;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("IDE backend did not start within timeout");
}

async function startInternal(workDir: string): Promise<void> {
  _cancelPoll = null;
  _state = { status: "starting", port: null, workDir, error: undefined };
  addStatusMessage("正在启动 IDE 后端...", "info");
  notify();

  try {
    const invoke = await tauriInvoke();
    if (invoke) {
      try { await invoke("save_app_settings", { settings: { workDir, isFirstLaunch: false } }); } catch {}
    }

    // Quick poll: backend may have been pre-started by Tauri setup().
    // Use a short timeout (3s) — if it fails, restart + full poll.
    let port: number;
    try {
      port = await pollForPort(3000);
    } catch {
      if (_cancelPoll) return;
      if (invoke) {
        await invoke("restart_ide_backend");
      }
      port = await pollForPort();
    }

    if (_cancelPoll) return;

    _state = { status: "running", port, workDir, error: undefined };
    addStatusMessage(`IDE 后端已连接 (端口 ${port})`, "info");
    notify();
    eventBus.emit(Events.BACKEND_PORT_READY, { port } satisfies BackendPortReadyPayload, { sticky: true });
  } catch (e: any) {
    if (_cancelPoll) return;
    _state = { ..._state, status: "error", error: e?.message || String(e) };
    addStatusMessage(`后端启动失败: ${e?.message || String(e)}`, "error");
    notify();
  }
}

export const BackendService = {
  getState(): BackendState {
    return { ..._state };
  },

  /** Bind this instance to a workspace via the Rust bind_workspace command
   *  (init per-workspace DB, register MCP, spawn backend). Returns when the
   *  backend port is known. Idempotent for the already-bound workspace. */
  async bind(workDir: string): Promise<void> {
    if (_state.status === "running" && _state.workDir === workDir && _state.port) {
      eventBus.emit(Events.BACKEND_PORT_READY, { port: _state.port }, { sticky: true });
      return;
    }
    _cancelPoll?.();
    _cancelPoll = null;
    _state = { status: "starting", port: null, workDir, error: undefined };
    addStatusMessage("正在绑定工作区...", "info");
    notify();
    try {
      const invoke = await tauriInvoke();
      if (!invoke) throw new Error("Tauri IPC not available");
      // bind_workspace returns immediately (backend spawns on a background
      // thread); 0 means "spawning, poll get_ide_port". A non-zero value means
      // the workspace was already bound — use it directly.
      const result: number = await invoke("bind_workspace", { path: workDir });
      // Workspace is bound now (settings state + DB switched). Tell the UI it can
      // reload the workspace's settings/layout right away — don't wait for the
      // backend port, that's the slow part.
      eventBus.emit(Events.WORKSPACE_BOUND, { workDir }, { sticky: true });
      const port = result > 0 ? result : await pollForPort();
      if (_cancelPoll) return;
      _state = { status: "running", port, workDir, error: undefined };
      addStatusMessage(`IDE 后端已连接 (端口 ${port})`, "info");
      notify();
      eventBus.emit(Events.BACKEND_PORT_READY, { port }, { sticky: true });
    } catch (e: any) {
      if (_cancelPoll) return;
      _state = { ..._state, status: "error", error: e?.message || String(e) };
      addStatusMessage(`后端启动失败: ${e?.message || String(e)}`, "error");
      notify();
    }
  },

  async start(workDir?: string): Promise<void> {
    _cancelPoll?.();
    _cancelPoll = null;
    await startInternal(workDir || _state.workDir || "");
  },

  async stop(): Promise<void> {
    _cancelPoll?.();
    _cancelPoll = null;
    try {
      const invoke = await tauriInvoke();
      if (invoke) await invoke("restart_ide_backend");
    } catch {}
    _state = { status: "stopped", port: null, workDir: _state.workDir, error: undefined };
    eventBus.clearSticky(Events.BACKEND_PORT_READY);
    notify();
  },

  async restart(workDir?: string): Promise<void> {
    await BackendService.stop();
    await BackendService.start(workDir);
  },

  async init(workDir: string): Promise<void> {
    if (_state.status !== "stopped") return;
    await startInternal(workDir);
  },
};

export function useBackend(): BackendState {
  const [st, setSt] = useState<BackendState>(BackendService.getState());

  useEffect(() => {
    const unsub = eventBus.on(Events.BACKEND_STATE_CHANGED, (data: BackendStateChangedPayload) => {
      setSt({ ...data });
    });
    return unsub;
  }, []);

  return st;
}
