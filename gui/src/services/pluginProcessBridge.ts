// ── pluginProcessBridge — 插件后台进程状态桥 ──
// T3: 状态模型 stopped|starting|running|error|killed。Rust 经 `plugin-process-status`
// Tauri event 上报 → 这里存 store + 订阅更新 (WorkerPanel / 插件面板同源, 单一真相)。
// WORKSPACE_BOUND 后由调用方 (App) 启动插件进程 (invoke restart_plugin_process_cmd)。

import { useSyncExternalStore, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";

export interface PluginProcessInfo {
  processId: string;
  status: string; // stopped|starting|running|error|killed
  port?: number | null;
  pid?: number | null;
  error?: string | null;
}

let processes: PluginProcessInfo[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

/** 订阅 Rust 的 plugin-process-status 事件（幂等, 一次） */
let _listenStarted = false;
export async function startPluginProcessListener(): Promise<void> {
  if (_listenStarted) return;
  _listenStarted = true;
  try {
    await listen<PluginProcessInfo>("plugin-process-status", (event) => {
      const info = event.payload;
      const idx = processes.findIndex((p) => p.processId === info.processId);
      if (idx === -1) processes = [...processes, info];
      else {
        const next = [...processes];
        next[idx] = info;
        processes = next;
      }
      notify();
    });
  } catch {
    // 非 Tauri 环境 / 命令缺失 —— 状态保持空
  }
}

/** 全量刷新(前端启动/面板挂载时拉一次) */
export async function refreshPluginProcesses(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const list = await invoke<PluginProcessInfo[]>("list_plugin_processes");
    processes = Array.isArray(list) ? list : [];
    notify();
  } catch {
    // 非 Tauri 环境
  }
}

export interface PluginProcessDecl {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  startOn?: "workspace_bound";
}

/** 启动插件声明的工作区级后台进程(WORKSPACE_BOUND 后由 App 调用)。
 *  等待 Rust 侧 spawn→读 PLUGIN_PORT→running, 状态经 plugin-process-status 回流。 */
export async function startPluginProcesses(decls: PluginProcessDecl[]): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  for (const decl of decls) {
    try {
      await invoke("restart_plugin_process_cmd", {
        processId: decl.id,
        command: decl.command,
        args: decl.args ?? [],
        env: decl.env ?? {},
      });
    } catch (e) {
      // 单个进程失败不拖垮其它
      console.warn(`[pluginProcessBridge] spawn ${decl.id} 失败:`, e);
    }
  }
  await refreshPluginProcesses();
}

// ── 纯函数 (可单测) ──

/** 判定进程是否在 Running/Starting (面板据此订阅数据) */
export function isProcessActive(p: PluginProcessInfo): boolean {
  return p.status === "running" || p.status === "starting";
}

/** 归一化状态 label/颜色 (WorkerPanel 行) */
export function processStatusMeta(status: string): { label: string; color: "muted" | "accent" | "success" | "error" } {
  switch (status) {
    case "running": return { label: "running", color: "success" };
    case "starting": return { label: "starting", color: "accent" };
    case "error": return { label: "error", color: "error" };
    case "killed": return { label: "killed", color: "muted" };
    default: return { label: "stopped", color: "muted" };
  }
}

// ── React hook ──

export function usePluginProcesses(): PluginProcessInfo[] {
  const subscribe = useCallback((cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }, []);
  return useSyncExternalStore(subscribe, () => processes, () => processes);
}

export function getPluginProcesses(): PluginProcessInfo[] {
  return processes;
}
