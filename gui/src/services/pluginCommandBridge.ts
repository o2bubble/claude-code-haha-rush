// ── pluginCommandBridge — 插件贡献命令 + 事件订阅桥 ──
// T4: contributes.commands[] → 命令调色板(useCommandPalette 收集) 点按执行：
//   eventBus(主窗内面板) + crossWindowBus(浮窗, plugin.<name>.* 命名空间由 T0 预留)。
// contributes.events[] → Hub 订阅 GUI 生命周期事件(Events 枚举) → 转发到该 topic。
// 不做宿主内拦截(PRD §6)；纯增量广播。单一真相 = pluginRegistry.getActiveManifests()。

import { windowBus, commandRegistry } from "./windowBus";
import { Events } from "./events";
import {
  getActiveManifests,
  pluginCommandId,
  pluginCommandTopic,
  pluginEventTopic,
  type PluginManifest,
} from "./pluginRegistry";
import { crossWindowBus } from "./crossWindowBus";

/** Events 枚举的值集合（manifest 声明的是值，校验用值集合而非键集合） */
const EVENT_VALUE_SET = new Set<string>(Object.values(Events));

// ─── 命令执行 ───

/**
 * 执行一条插件贡献命令：主窗内面板经 eventBus 收；浮窗经 crossWindowBus 收。
 * onInvoke（命令声明里的触发名）随 payload 下发给面板——面板根据它映射动作
 * （如转发到其绑定后台进程的端口端点）；宿主不做进程直达（进程是独立 OS
 * 进程，JS 总线到不了；由面板经 PLUGIN_PORT 触达，见 PRD §5.2）。
 */
export function executePluginCommand(
  pluginName: string,
  commandId: string,
  onInvoke?: string,
  args?: Record<string, unknown>,
): void {
  const topic = pluginCommandTopic(pluginName, commandId);
  const payload = { command: commandId, plugin: pluginName, onInvoke: onInvoke ?? null, args: args ?? null };
  // 非 sticky 的 state 通道不做值去重(仅 sticky topic 按 JSON 去重)——
  // 插件 topic 永不进 STICKY_TOPICS, "同参数点两次"每次都触发。

  // 主窗内面板（同进程，eventBus——插件命名空间走 raw 通道）
  windowBus.emitRaw(topic, payload);
  // 浮窗面板（跨窗口，crossWindowBus）
  crossWindowBus.publish(topic, payload, { origin: "app" });
  // 插件后台进程（HTTP 直达）—— 见下方注释：没有这一步，**面板没打开时命令无人消费**
  void forwardToPluginProcess(pluginName, payload);
}

/**
 * 把命令转发到插件的后台进程（若它有在跑的进程且已上报端口）。
 *
 * **为什么必须有这条路**：上面两条都是"广播给已挂载的面板 iframe"。命令面板点一下
 * 无所谓（用户看着面板），但**快捷键/全局热键**触发的场景下，用户很可能根本没打开
 * 那个面板 —— 于是命令发出去没有任何订阅者，静默丢失。对"按热键截屏"这类
 * 无 UI 前置的操作是致命的。
 *
 * 契约（约定式，插件可选实现）：
 *   POST http://127.0.0.1:<port>/__command
 *   body: { command, plugin, onInvoke, args }
 *   resp: { host?: HostAction[] } —— 进程可借此请求宿主做事（如 open-overlay）
 *
 * 返回的 `host` 数组交给 `dispatchPluginUplink` 执行 —— 于是插件进程也能用上
 * 全部上行能力（投递到聊天/超桌/写文件/开 overlay），不只是被动收命令。
 *
 * 失败静默：插件没实现该端点、进程没起、端口未上报 —— 都属正常情况
 * （面板那条路仍是主路径）。
 */
async function forwardToPluginProcess(
  pluginName: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const { getPluginProcesses } = await import("./pluginProcessBridge");
    // ⚠️ `PluginProcessInfo.processId` 是**裸 id**（如 `screenshot-server`），
    // **不带** `plugin:<name>:` 前缀 —— 那个前缀只出现在命令 id / 面板 id 上。
    // 所以得先从 manifest 拿到本插件声明的进程 id，再去进程表里找。
    // （曾按前缀匹配，静默不匹配 → 命令永远送不到进程，且没有任何报错。）
    const { getActiveManifests } = await import("./pluginRegistry");
    const declared = new Set(
      (getActiveManifests().find((m) => m.pluginName === pluginName)?.processes ?? [])
        .map((p) => p.id),
    );
    if (declared.size === 0) return;
    const proc = getPluginProcesses().find(
      (p) => declared.has(p.processId) && p.status === "running" && p.port,
    );
    if (!proc?.port) return;
    // 带上该插件的**用户设置** —— 插件进程读不到宿主存储，而它的行为
    // （存到哪、送哪去）恰恰取决于这些设置。宿主本来就有，顺手给它。
    const { getCachedPluginSettings } = await import("./pluginSettingsStore");
    const settings = getCachedPluginSettings(pluginName);
    const res = await fetch(`http://127.0.0.1:${proc.port}/__command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, settings }),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { host?: unknown[] } | null;
    if (!data?.host?.length) return;
    const { dispatchPluginUplink } = await import("./pluginPanelBridge");
    for (const action of data.host) {
      const a = action as { kind?: unknown; payload?: unknown } | null;
      if (!a || typeof a.kind !== "string") continue;
      await dispatchPluginUplink(pluginName, a.kind, a.payload).catch(() => {});
    }
  } catch {
    /* 见上：失败是正常情况（未实现端点 / 进程未起 / 端口未上报） */
  }
}

// ─── 命令注册（让快捷键能触发插件命令）───

let _unregisterCommands: Array<() => void> = [];

/**
 * 把插件命令注册进 `commandRegistry`，使其能被**快捷键**触发。
 *
 * 为什么必须补这一步：命令面板走的是「收集 manifest → 直接调
 * `executePluginCommand`」的路径（见 `useCommandPalette`），**从不经
 * commandRegistry**；而快捷键分发器命中后调的是
 * `commandRegistry.execute(entry.commandId)` —— 对未注册的命令是**静默 no-op**
 * （`windowBus.execute` 对未知命令直接返回）。所以插件命令光有条目还不够，
 * 必须真的注册进来，那个 `ShortcutEntry.commandId` 才有落点。
 *
 * 幂等：先注销旧的再注册（插件重扫/卸载/启用停用都会调）。
 */
export function registerPluginCommands(): void {
  unregisterPluginCommands();
  for (const m of getActiveManifests()) {
    for (const c of m.contributes?.commands ?? []) {
      const id = pluginCommandId(m.pluginName, c.id);
      _unregisterCommands.push(
        commandRegistry.register(id, () => executePluginCommand(m.pluginName, c.id, c.onInvoke)),
      );
    }
  }
}

/** 注销全部插件命令注册（重扫/卸载前先调，防止旧命令残留成幽灵快捷键）。 */
export function unregisterPluginCommands(): void {
  for (const un of _unregisterCommands) un();
  _unregisterCommands = [];
}

// ─── 事件转发 ───

let _stopForwarding: (() => void) | null = null;

/** 启动(或重扫后重订阅)贡献事件转发。基于 pluginRegistry.activeManifests 订阅。 */
export function startPluginEventForwarding(): void {
  if (_stopForwarding) return; // 已启动

  const unsubscribeAll: Array<() => void> = [];
  for (const manifest of getActiveManifests()) {
    for (const evt of manifest.contributes?.events ?? []) {
      if (!EVENT_VALUE_SET.has(evt)) continue; // 不在 Events 枚举值 → 忽略（T0 收窄后事件名受保护）
      const eventName = evt as (typeof Events)[keyof typeof Events];
      const topic = pluginEventTopic(manifest.pluginName, eventName);
      const un = windowBus.on(eventName, (data) => {
        crossWindowBus.publish(topic, data, { sticky: false, origin: "app" });
      });
      unsubscribeAll.push(un);
    }
  }

  _stopForwarding = () => {
    for (const un of unsubscribeAll) un();
    unsubscribeAll.length = 0;
  };
}

/** 停止事件转发并清订阅（重扫/卸载时先 stop 再重新 start） */
export function stopPluginEventForwarding(): void {
  if (_stopForwarding) {
    _stopForwarding();
    _stopForwarding = null;
  }
}
