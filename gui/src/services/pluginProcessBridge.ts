// ── pluginProcessBridge — 插件后台进程状态桥 ──
// T3: 状态模型 stopped|starting|running|error|killed。Rust 经 `plugin-process-status`
// Tauri event 上报 → 这里存 store + 订阅更新 (WorkerPanel / 插件面板同源, 单一真相)。
// WORKSPACE_BOUND 后由调用方 (App) 启动插件进程 (invoke restart_plugin_process_cmd)。

import { useSyncExternalStore, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import type { PluginManifest } from "./pluginRegistry";

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

/** 已请求 spawn、状态尚未回流（running/error/killed）的进程 id。
 *  spawn→状态事件到达之间有一个窗口, 期间 store 里看不到该进程——
 *  syncPluginProcesses 若只看 store 会重复请求 restart（restart = kill+respawn,
 *  会打断正在启动的进程)。启动时 WORKSPACE_BOUND 与重扫两条路径都会拉进程,
 *  本集合让它们互不打架。 */
const _spawning = new Set<string>();

/** 每个进程「启动时绑定的工作区」。`${workspace}` 在 spawn 那一刻展开后就固定了，
 *  进程不会自己跟着切——所以切工作区后必须重启，否则插件仍对着旧仓库干活
 *  （git-viewer 曾在无 git 仓库的工作区启动、切到仓库后依旧报
 *  "not a git repository"，因为 syncPluginProcesses 只看进程在不在跑）。 */
const _spawnedWorkspace = new Map<string, string>();

/** 纯函数: 找出「在跑、但绑的是别的工作区」的进程 id——这些需要重启才能跟上。
 *  工作区为 undefined（非 Tauri / 未绑定）时不做判断，避免误杀。 */
export function selectProcessesToRebind(
  current: PluginProcessInfo[],
  spawnedWorkspace: ReadonlyMap<string, string>,
  workspace: string | undefined,
): string[] {
  if (workspace === undefined) return [];
  return current
    .filter((p) => isProcessActive(p) && spawnedWorkspace.has(p.processId))
    .filter((p) => spawnedWorkspace.get(p.processId) !== workspace)
    .map((p) => p.processId);
}

/** 纯函数: 应用一条状态事件到进程列表。
 *  "removed" = 插件已卸载/禁用 → 删行(条目永久消失);
 *  其余状态(含 kill 的 "killed")保留条目——WorkerPanel 显示"已停止"且可 ↻ 重启。 */
export function applyProcessStatus(list: PluginProcessInfo[], info: PluginProcessInfo): PluginProcessInfo[] {
  if (info.status === "removed") {
    return list.filter((p) => p.processId !== info.processId);
  }
  const idx = list.findIndex((p) => p.processId === info.processId);
  if (idx === -1) return [...list, info];
  const next = [...list];
  next[idx] = info;
  return next;
}

/** 订阅 Rust 的 plugin-process-status 事件（幂等, 一次） */
let _listenStarted = false;
export async function startPluginProcessListener(): Promise<void> {
  if (_listenStarted) return;
  _listenStarted = true;
  try {
    await listen<PluginProcessInfo>("plugin-process-status", (event) => {
      const info = event.payload;
      if (info.status !== "starting") _spawning.delete(info.processId);
      processes = applyProcessStatus(processes, info);
      notify();
    });
  } catch {
    // 非 Tauri 环境 / 命令缺失 —— 状态保持空
  }
}

/** 全量刷新(前端启动/面板挂载时拉一次)。
 *  normalize: 兼容 Rust 老版本 snake_case(process_id) —— 新 Rust 已 camelCase,
 *  但防跨版本广播/旧壳, 缺 processId 时兜底 process_id。 */
export async function refreshPluginProcesses(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const list = await invoke<Array<PluginProcessInfo & { process_id?: string }>>("list_plugin_processes");
    processes = Array.isArray(list)
      ? list.map((p) => ({ ...p, processId: p.processId ?? (p as any).process_id ?? "" }))
      : [];
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
  /** 归属插件名 —— 拼进程 cwd(插件目录)用; 缺失则不设 cwd。 */
  pluginName?: string;
}

/** 同步活动插件的后台进程到"应跑即跑"状态——重扫后调用（安装/启用/重启 GUI）。
 *
 *  与 startPluginProcesses 的区别: 本函数**幂等**——只启动「声明了 startOn 但当前
 *  未在 running/starting」的进程, 已在跑的绝不动（重扫不该打断正在服务的进程）。
 *  startOn=workspace_bound 的进程需要工作区上下文（${workspace} 展开 / 相对 cwd）,
 *  故仅在**工作区已绑定**（WORKSPACE_BOUND sticky 存在）时启动; 未绑定则留空, 由
 *  App 的 WORKSPACE_BOUND 处理器统一拉起（那时才是它们该出生的时刻）。
 *
 *  修复: 此前重扫只 refreshPluginProcesses（读列表）从不启动 → 装完插件"面板立即可用
 *  但后台进程要等下次重启 GUI"。与插件文档承诺不一致（pluginDocs 生命周期:
 *  "重扫: ... 注册面板/命令/事件转发 → 启动 startOn=workspace_bound 的进程"）。 */
export async function syncPluginProcesses(): Promise<void> {
  const { windowBus } = await import("./windowBus");
  const { Events } = await import("./events");
  if (!windowBus.hasSticky(Events.WORKSPACE_BOUND)) return; // 未绑定 → 等 WORKSPACE_BOUND

  const workspace = await currentWorkspace();

  // 先让「绑在别的工作区」的进程重启。必须在 selectProcessesToStart 之前做：
  // 否则它们算「已在跑」而被跳过，会一直对着旧仓库服务。
  const stale = selectProcessesToRebind(getPluginProcesses(), _spawnedWorkspace, workspace);
  if (stale.length > 0) {
    const { invoke } = await import("@tauri-apps/api/core");
    for (const id of stale) {
      _spawning.add(id);
      _spawnedWorkspace.delete(id);
      try {
        await invoke("kill_plugin_process_cmd", { processId: id });
      } catch {
        // 非 Tauri / 命令缺失 —— 忽略；下面的 selectProcessesToStart 仍会尝试拉起
        _spawning.delete(id);
      }
    }
    await refreshPluginProcesses();
  }

  const { getActiveManifests } = await import("./pluginRegistry");
  const decls = selectProcessesToStart(getActiveManifests(), getPluginProcesses(), _spawning);
  if (decls.length > 0) await startPluginProcesses(decls);
}

/** 当前绑定的工作区（GUI settings 的 workDir）。非 Tauri 环境返回 undefined。 */
async function currentWorkspace(): Promise<string | undefined> {
  try {
    const { getSettings } = await import("../stores/settingsStore");
    return getSettings().workDir || undefined;
  } catch {
    return undefined;
  }
}

/** 纯函数: 从活动 manifest 选出「该跑但没跑」的进程声明。
 *  排除三类: startOn 非 workspace_bound(别的时机启动) / 已 running|starting /
 *  已请求 spawn 未回流(_spawning, 防重复 restart 打断启动中进程)。导出供单测。 */
export function selectProcessesToStart(
  manifests: PluginManifest[],
  current: PluginProcessInfo[],
  pending: ReadonlySet<string>,
): PluginProcessDecl[] {
  const live = new Set(
    current.filter((p) => isProcessActive(p)).map((p) => p.processId),
  );
  return manifests.flatMap((m) =>
    (m.processes ?? [])
      .filter((p) => p.startOn === "workspace_bound" && !live.has(p.id) && !pending.has(p.id))
      .map((p) => ({ id: p.id, command: p.command, args: p.args, env: p.env, startOn: p.startOn, pluginName: m.pluginName })),
  );
}

/** 启动插件声明的工作区级后台进程(WORKSPACE_BOUND 后由 App 调用)。
 *  等待 Rust 侧 spawn→读 PLUGIN_PORT→running, 状态经 plugin-process-status 回流。
 *  spawn 前把活动插件的 runtime 目录聚合并注入 env(plugin-nodejs-runtime T2)——
 *  聚合失败(非 Tauri 等)按无 runtime 处理, 不阻塞进程启动。 */
export async function startPluginProcesses(decls: PluginProcessDecl[]): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const runtimeDirs = await aggregateRuntimeDirs();
  // 绑定工作区: GUIs settingsStore.workDir —— 展开 ${workspace} 用
  const workspace = await currentWorkspace();
  // 进程 cwd = 插件目录（args 相对路径如 git-viewer-server.cjs 在此解析——
  // 否则 node 以 GUI 安装目录为 cwd 找不到模块, 用户实测 MODULE_NOT_FOUND）。
  // 目标目录约定: <plugins base>/<pluginName>/。未拿到 base/pluginName → 不设(Rust 用默认 cwd)。
  let pluginsBase: string | undefined;
  try {
    pluginsBase = await invoke<string>("get_plugins_base_dir");
  } catch {
    // 非 Tauri: 省略 cwd
  }
  for (const decl of decls) {
    try {
      _spawning.add(decl.id);
      await invoke("restart_plugin_process_cmd", {
        processId: decl.id,
        command: decl.command,
        args: decl.args ?? [],
        env: buildPluginProcessEnv(decl.env, runtimeDirs, workspace),
        cwd: pluginProcessCwd(pluginsBase, decl.pluginName),
      });
      // 记下绑定的工作区：下次 sync 时用它判断进程是否已过期
      if (workspace !== undefined) _spawnedWorkspace.set(decl.id, workspace);
    } catch (e) {
      // 单个进程失败不拖垮其它
      _spawning.delete(decl.id);
      console.warn(`[pluginProcessBridge] spawn ${decl.id} 失败:`, e);
    }
  }
  await refreshPluginProcesses();
}

/** 杀 + 遗忘这些插件声明的后台进程（禁用/卸载后调用——重扫已把它们从活动清单摘除,
 *  syncPluginProcesses 看不到它们, 进程会一直跑到 GUI 退出）。
 *  用 forget 而非 kill: 插件已不存在, 条目留着没意义——WorkerPanel 会残留已卸载
 *  插件的行, 且 commands 表还存着启动声明, 点 ↻ 会从已删目录重新拉起 node。
 *  静默: 单个失败不影响其余。 */
export async function stopPluginProcessesFor(processIds: string[]): Promise<void> {
  if (processIds.length === 0) return;
  const { invoke } = await import("@tauri-apps/api/core");
  for (const id of processIds) _spawning.delete(id);
  try {
    await invoke("forget_plugin_processes_cmd", { processIds });
  } catch {
    // 非 Tauri / 命令缺失 —— 忽略
  }
  await refreshPluginProcesses();
}

/** 聚合当前活动插件的 runtime 目录（T1 纯函数聚合声明 → Tauri 逐个验证存在）。
 *  存在性过滤放调用方：invoke 异步，纯函数保持同步可测；目录数通常 0-2 个。
 *
 *  **返回 null ≠ 返回 []** —— 语义必须区分：
 *   - `[]`  = 聚合成功且确实没有 runtime 目录（用户没装/已禁用）→ 调用方可清空注入
 *   - `null` = **聚合失败**（invoke 抛错/模块不可用）→ 调用方**不得**推送
 *
 *  曾一律 catch 成 `[]`：B 通道把"失败"当"空配置"推给 claude.exe，而
 *  `applyPluginPathPrepend([])` 会 **删除** A 通道（启动自扫）刚写入的正确值 ——
 *  结果是「装了 nodejs 插件、AI 会话里 node 却不在 PATH」。失败必须可区分，
 *  否则它会静默覆盖掉另一条通道的正确结果。 */
export async function aggregateRuntimeDirs(): Promise<string[] | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const { getActiveManifests, aggregateRuntimePaths } = await import("./pluginRegistry");
    const { getSettings } = await import("../stores/settingsStore");
    const base = await invoke<string>("get_plugins_base_dir");
    const candidates = aggregateRuntimePaths(
      getActiveManifests(),
      new Set(getSettings().disabledPlugins ?? []),
      () => true, // 声明级聚合; 存在性在下面逐个验证
      base,
    );
    const out: string[] = [];
    for (const dir of candidates) {
      const ok = await invoke<boolean>("path_exists", { path: dir }).catch(() => false);
      if (ok) out.push(dir);
    }
    return out;
  } catch (e) {
    console.warn("[pluginRuntime] aggregateRuntimeDirs 失败（不推送, 保留启动自扫结果）:", e);
    return null;
  }
}

// ── 纯函数 (可单测) ──

/**
 * 组装插件进程的 env：① 展开 `${workspace}` 占位符 → 绑定工作区（GV-T2,
 * 插件声明 env 如 CLAUDE_PLUGIN_WORKSPACE 用此占位符, 进程据此知道操作哪个 repo）；
 * ② 把 runtime 目录段放进 CLAUDE_PLUGIN_PATH_PREPEND 交给 Rust（plugin-nodejs-runtime
 * T2, Rust spawn 前 prepend 到继承的 PATH——继承语义留在 Rust, 避免 webview 拿不到
 * 系统 PATH 拼丢它）。段分隔符 `;`。无 runtime 段时不加该变量（旧插件零回归）。
 * 不修改调用方对象。
 */
export function buildPluginProcessEnv(
  declEnv: Record<string, string> | undefined,
  runtimeDirs: string[] | null,
  workspace?: string,
): Record<string, string> {
  const env = { ...(declEnv ?? {}) };
  // ${workspace} 展开: 声明 env 值内的占位符仅此一个, 未绑定工作区时空串(进程自找 cwd)
  if (workspace !== undefined) {
    for (const k of Object.keys(env)) {
      if (env[k].includes("${workspace}")) {
        env[k] = env[k].replaceAll("${workspace}", workspace);
      }
    }
  }
  // null（聚合失败）与 []（确实没有）在此等价：都不注入，进程下次 spawn 再试
  if (runtimeDirs && runtimeDirs.length > 0) {
    env.CLAUDE_PLUGIN_PATH_PREPEND = runtimeDirs.join(";");
  }
  return env;
}

/** 进程 cwd 纯函数: <plugins base>/<pluginName>/。缺任一 → undefined(Rust 用 GUI cwd,
 *  防 cwd = plugins 根——pluginName 缺失时不能把整个插件根当插件目录)。导出供单测。 */
export function pluginProcessCwd(pluginsBase: string | undefined, pluginName: string | undefined): string | undefined {
  if (!pluginsBase || !pluginName) return undefined;
  return `${pluginsBase}/${pluginName}`;
}

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
