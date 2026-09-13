// ── Settings store — persisted via Rust to %APPDATA%/claude-code-gui/settings.json ──

import { windowBus } from "../services/windowBus";
import { Events } from "../services/events";
import { migrateWorkspaceSeed } from "../migrations";

export interface QuickPrompt {
  id: string;
  title: string;
  prompt: string;
}

export interface AppSettings {
  workDir: string;
  workspaces: string[];
  /** MRU list — most recently bound workspace first (maintained by Rust bind_workspace) */
  recentWorkspaces?: string[];
  /** When enabled, startup auto-enters recentWorkspaces[0] and skips the selector */
  autoEnterRecentWorkspace?: boolean;
  /** When enabled, layout saves also write to the global baseline so workspaces
   *  without their own layout fall back to it (workspace layout still wins). */
  saveLayoutToGlobal?: boolean;
  isFirstLaunch: boolean;
  language: "zh" | "en";
  terminalMaxEntries: number;
  layoutTree?: object;
  showHiddenFiles?: boolean;
  favoriteSkills?: string[];
  quickPrompts?: QuickPrompt[];
  /** Favorite session ids — workspace-scoped, stored in the bound workspace's settings.local.json */
  favoriteSessionIds?: string[];
  editorFontSize?: number;
  editorTabSize?: number;
  editorWordWrap?: boolean;
  chatEnterBehavior?: "send" | "newline";
  fileSortOrder?: "name" | "date" | "type";
  terminalFontSize?: number;
  autoLoadLatestSession?: boolean;
  forceChineseThinking?: boolean;
  permissionMode?: string;
  /** 思考开关/effort 档 — 后端重启会丢内存态, GUI 重连时据此重发 set_thinking_mode */
  thinkingModeEnabled?: boolean;
  effort?: string;
  skillRegistryUrl?: string;
  updateServerUrl?: string;
  /** Main window state persistence */
  windowWidth?: number;
  windowHeight?: number;
  windowX?: number;
  windowY?: number;
  windowMaximized?: boolean;
  _version?: string;
  uiFontSize?: number;
  theme?: string;
  /** 消息队列布局位置: 输入框上方(top, 默认) / 聊天右侧(right) */
  msgQueuePosition?: "top" | "right";
  /** 消息队列上限(默认 20) */
  msgQueueMaxItems?: number;
  /** 消息列表划词弹出层开关(默认开启) */
  msgSelectionToolbar?: boolean;
  /** 会话文件夹开关(默认关, 非默认功能) */
  sessionFolders?: boolean;
  /** 会话文件夹数据(工作区作用域): 嵌套树 folders + sessionId->folderId 归属 */
  sessionFolderTree?: {
    folders: Array<{ id: string; name: string; parentId?: string }>;
    assignments: Record<string, string>;
  };
  /** 消息时间线导航栏开关(默认**开**)。
   *  老用户由启动期迁移 `migrate_message_timeline_default_on` 补写实值；
   *  用户手动关闭后写 false，迁移只补「字段缺失」故不会再翻回。 */
  messageTimeline?: boolean;
  /** 上下文告警开关(默认开): 已用百分比跨过阈值时弹浮动层提示 */
  contextWarningEnabled?: boolean;
  /** 上下文告警阈值百分比(默认 90, 即剩余 10%) */
  contextWarningPercent?: number;
  /** 自定义压缩提示词（gui 键，后端 compactConfig 读取）：text 空 = 不启用 */
  customCompactPrompt?: {
    mode: "append" | "replace";
    text: string;
    /** 预设标识（'none'|'handoff'|'custom'）。识别靠 presetId 不靠 text 字符串相等，
     *  改预设模板后旧设置仍能识别并自动刷新 text。缺省=旧结构，按 text 推导。 */
    presetId?: "none" | "handoff" | "custom";
  };
  /** 压缩时提取脚本路径（默认 handoff 脚本，后端 compactConfig 读取） */
  compactExtractScript?: string;
  /** 流卡死中断后的唤醒提示词：发给 AI 让它检查会话、继续未完成的内容。空=用默认 */
  streamStallWakePrompt?: string;
  /** 禁用的插件(pluginName 列表)：扫描时跳过 → 面板/命令/后台进程全不挂。目录不动。 */
  disabledPlugins?: string[];
}

let settings: AppSettings = {
  workDir: "",
  workspaces: [],
  isFirstLaunch: true,
  language: "zh",
  terminalMaxEntries: 50,
  skillRegistryUrl: "http://192.168.186.96:8765",
  _version: "1.0.0-preview",
  uiFontSize: 100,
};

let loaded = false;

export function getSettings(): AppSettings {
  return settings;
}

export function updateSettings(patch: Partial<AppSettings>) {
  settings = { ...settings, ...patch };
  windowBus.emit(Events.SETTINGS_CHANGED, { settings: { ...settings } }, { sticky: true });
}

/** Direct in-memory set without emitting events or persisting.
 *  Used by Leaf windows to sync settings from Hub via DataBus. */
export function applySettingsFromBus(s: AppSettings) {
  settings = { ...s };
}

function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__;
}

// Load from Rust backend
export async function loadSettings(): Promise<AppSettings> {
  if (loaded) return settings;

  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const s: AppSettings = await invoke("get_app_settings");
      settings = s;
    } catch {
      // First launch or error — use defaults
      const def = await getDefaultWorkDir();
      settings = { workDir: def, workspaces: [], isFirstLaunch: true, language: "zh", terminalMaxEntries: 50 };
    }
  } else {
    // Browser dev: use localStorage
    const raw = localStorage.getItem("claude-code-settings");
    if (raw) {
      try { settings = JSON.parse(raw); } catch {}
    }
    if (!settings.workDir) {
      settings = { workDir: await getDefaultWorkDir(), workspaces: [], isFirstLaunch: true, language: "zh", terminalMaxEntries: 50 };
    }
  }

  // Migrate: if workspaces is empty but workDir is set, seed workspaces
  // （迁移集中到 gui/src/migrations/ —— 全清单见其 MIGRATION_REGISTRY）
  migrateWorkspaceSeed(settings);

  loaded = true;
  windowBus.emit(Events.SETTINGS_CHANGED, { settings: { ...settings } }, { sticky: true });
  return settings;
}

/** Force a re-fetch from Rust (bypasses the `loaded` cache). Must be called
 *  AFTER the backend has bound a workspace — get_app_settings returns the
 *  effective merge for the bound workspace, so a workspace switch would
 *  otherwise keep stale workspace-scoped fields (e.g. favoriteSessionIds)
 *  in memory. */
export async function reloadSettings(): Promise<AppSettings> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const s: AppSettings = await invoke("get_app_settings");
      settings = s;
      loaded = true;
      windowBus.emit(Events.SETTINGS_CHANGED, { settings: { ...settings } }, { sticky: true });
      return settings;
    } catch (e) {
      console.error("reloadSettings failed:", e);
    }
  }
  return settings;
}

// Save to Rust backend. `patch` is a partial set of fields; `scope` chooses the
// target file: "workspace" (default) → the bound workspace's .claude/settings.local.json,
// "global" → ~/.claude/settings.json gui. Callers that manage global-only fields
// (theme, language, …) pass "global" explicitly.
export async function saveSettings(
  patch: Partial<AppSettings>,
  scope?: "global" | "workspace",
): Promise<void> {
  settings = { ...settings, ...patch };
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_app_settings", { patch, scope: scope ?? "workspace" });
      // 跨 GUI 同步：任意设置(收藏/快捷提示/主题/工作区覆盖)保存后广播给其他实例，
      // 对方 reloadSettings 重读共享文件。收藏(workspace)与快捷提示(global)都走这里。
      invoke("notify_settings_changed").catch(() => {});
    } catch (e) {
      console.error("saveSettings failed:", e);
    }
  } else {
    localStorage.setItem("claude-code-settings", JSON.stringify(settings));
  }
  windowBus.emit(Events.SETTINGS_CHANGED, { settings: { ...settings } }, { sticky: true });
}

// Get default work directory via Rust (knows user home)
async function getDefaultWorkDir(): Promise<string> {
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke("get_default_work_dir");
    } catch {}
  }
  // Fallback for browser
  return "claude-code-workspace";
}
