// ── pluginStatusStore — AI 上报的插件环境状态（plugin-nodejs-runtime T4）──
// AI 完成 ai-guided 插件的环境安装/排障后经 MCP plugin_set_status 上报。
// 内存存储（GUI 重启即清空，AI 重新验证即可——状态易变，runtime 目录可能被手删，
// "plugin_list 时现场看一眼"比相信落盘状态可靠）。GUI 不据此改变插件行为——
// 它是 AI 声明的参考状态，非系统真相。

export type PluginAiStatus = "ready" | "not_ready" | "error";

export interface PluginAiStatusEntry {
  status: PluginAiStatus;
  /** 上报时间戳（epoch ms） */
  reportedAt: number;
  /** AI 附带的细节（如 node 版本、验证命令输出、错误原因） */
  detail?: Record<string, unknown>;
}

const statuses = new Map<string, PluginAiStatusEntry>();

/** AI 上报状态。未知 status 拒绝。 */
export function setPluginAiStatus(
  name: string,
  status: PluginAiStatus,
  detail?: Record<string, unknown>,
): void {
  if (!name) throw new Error("plugin name is required");
  if (status !== "ready" && status !== "not_ready" && status !== "error") {
    throw new Error(`invalid status: ${status} (expected ready | not_ready | error)`);
  }
  statuses.set(name, { status, reportedAt: Date.now(), detail });
}

/** 读取单插件状态；无上报记录返回 undefined（plugin_list/get 据此省略字段）。 */
export function getPluginAiStatus(name: string): PluginAiStatusEntry | undefined {
  return statuses.get(name);
}

/** 清空（GUI 重启语义 / 测试用）。 */
export function clearPluginAiStatuses(): void {
  statuses.clear();
}
