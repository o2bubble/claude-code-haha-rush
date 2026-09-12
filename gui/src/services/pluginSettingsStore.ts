// ── pluginSettingsStore — 插件设置读写（独立于 AppSettings 的 plugins-settings 文件）──
// 存储: 全局 %APPDATA%/com.claudecode.gui/plugins-settings/<plugin>.json
//       工作区 <workdir>/.claude/plugins-settings/<plugin>.json（覆盖全局, Rust 合并）
// 设置面板按插件一组渲染, 值经本 store 读写——插件进程自行读同路径文件（GUI 不经 env 传）。

import { useState, useEffect } from "react";

export type PluginSettingType = "boolean" | "string" | "number" | "select";

export interface PluginSetting {
  type: PluginSettingType;
  title: string;
  description?: string;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
}

export type PluginSettingsDecl = Record<string, PluginSetting>;
export type PluginSettingsValues = Record<string, string | number | boolean>;

async function invokePluginSettings(name: string): Promise<PluginSettingsValues> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<PluginSettingsValues>("get_plugin_settings", { plugin: name })) ?? {};
  } catch {
    return {};
  }
}

/** 读取插件设置（工作区覆盖全局已由 Rust 合并）。非 Tauri 环境返回空。 */
export async function getPluginSettings(pluginName: string): Promise<PluginSettingsValues> {
  return invokePluginSettings(pluginName);
}

/** 写插件设置。scope: "workspace"(缺省) | "global"。patch 逐键合并写入。 */
export async function savePluginSettings(
  pluginName: string,
  patch: PluginSettingsValues,
  scope: "global" | "workspace" = "workspace",
): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_plugin_settings", { plugin: pluginName, patch, scope });
  } catch (e) {
    console.error(`[pluginSettingsStore] save ${pluginName} failed:`, e);
  }
}

// ── React hook (设置面板订阅) ──

const listeners = new Set<() => void>();
const cache = new Map<string, PluginSettingsValues>();

function notify() { for (const fn of listeners) fn(); }

/** 读取 + 缓存（同步快照, hook 用） */
export function getCachedPluginSettings(pluginName: string): PluginSettingsValues {
  return cache.get(pluginName) ?? {};
}

/** 拉取插件设置并进缓存（挂载时调） */
export async function loadPluginSettings(pluginName: string): Promise<PluginSettingsValues> {
  const v = await invokePluginSettings(pluginName);
  cache.set(pluginName, v);
  notify();
  return v;
}

/** 写入并通知订阅者 */
export async function updatePluginSetting(
  pluginName: string,
  key: string,
  value: string | number | boolean,
  scope: "global" | "workspace" = "workspace",
): Promise<void> {
  await savePluginSettings(pluginName, { [key]: value }, scope);
  const cur = cache.get(pluginName) ?? {};
  cache.set(pluginName, { ...cur, [key]: value });
  notify();
}

export function usePluginSettings(pluginName: string): PluginSettingsValues {
  const [v, setV] = useState<PluginSettingsValues>(() => cache.get(pluginName) ?? {});
  useEffect(() => {
    void loadPluginSettings(pluginName).then(setV);
    const fn = () => setV(cache.get(pluginName) ?? {});
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, [pluginName]);
  return v;
}
