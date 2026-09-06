// ── pluginCommandBridge — 插件贡献命令 + 事件订阅桥 ──
// T4: contributes.commands[] → 命令调色板(useCommandPalette 收集) 点按执行：
//   eventBus(主窗内面板) + crossWindowBus(浮窗, plugin.<name>.* 命名空间由 T0 预留)。
// contributes.events[] → Hub 订阅 GUI 生命周期事件(Events 枚举) → 转发到该 topic。
// 不做宿主内拦截(PRD §6)；纯增量广播。单一真相 = pluginRegistry.getActiveManifests()。

import { windowBus } from "./windowBus";
import { Events } from "./events";
import {
  getActiveManifests,
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
