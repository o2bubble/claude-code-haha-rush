// updateService.ts — Update check + download API (delegates HTTP to Rust backend)

import { getSettings } from "../stores/settingsStore";
import { eventBus } from "./serviceBus";
import { Events } from "./events";

// Latest known update availability — drives the toolbar red-dot badge.
// Updated by both the startup background check and the manual UpdatePanel check.
let _hasUpdate = false;
let _updateVersion = "";

export function getUpdateAvailability(): { hasUpdate: boolean; version: string } {
  return { hasUpdate: _hasUpdate, version: _updateVersion };
}

/** 组件即使"从未安装"也属必需项（升级新版 GUI 就必须带，否则功能降级/缺失）。
 *  目前只有 server：新 GUI 依赖其 publish/claim/ack RPC。这类组件不得落入可忽略的
 *  opt-in —— 必须进 updates 语义（亮红点 + 默认勾选 + 优先更新）。 */
export const REQUIRED_COMPONENTS = ["server"] as const;

/** A "real" update = an installed component whose sha differs from remote,
 *  OR a never-installed component that is REQUIRED (e.g. server on first upgrade
 *  to a GUI version that depends on it). Required-but-uninstalled components must
 *  light the red-dot badge and get auto-checked — unlike pure opt-in components
 *  (e.g. updater) which are a first-time install the user may skip. */
export function hasRealUpdate(components: ComponentStatus[]): boolean {
  return components.some(
    (c) => c.needs_update && (c.installed || REQUIRED_COMPONENTS.includes(c.name as any)),
  );
}

export function setUpdateAvailability(hasUpdate: boolean, version: string): void {
  _hasUpdate = hasUpdate;
  _updateVersion = hasUpdate ? version : "";
  eventBus.emit(Events.UPDATE_AVAILABILITY_CHANGED, { hasUpdate: _hasUpdate, version: _updateVersion }, { sticky: true });
}

export interface ComponentStatus {
  name: string;
  installed: boolean;
  needs_update: boolean;
  remote_sha256?: string;
  local_sha256?: string;
  remote_updated_at?: string;
  local_updated_at?: string;
  size?: number;
  /** Human-readable hook description, e.g. "Run database migration" */
  post_install_description?: string;
  /** Full hook payload — passed back to download_and_install_component */
  post_install_json?: string;
}

export interface UpdateCheckResult {
  version: string;
  release_notes: string;
  published_at: string;
  components: ComponentStatus[];
}

export interface LocalManifest {
  version: string;
  components: Record<string, { sha256?: string; updated_at?: string; size?: number }>;
}

function getBaseUrl(): string {
  return getSettings().skillRegistryUrl ?? "http://192.168.186.96:8765";
}

// 平台化下载：mac 走 ?platform=macos（服务器按平台分目录存 manifest + 组件 zip）。
// check_for_updates 由 Rust 端按 target_os 加参数，这里只管组件下载 URL。
function platformQuery(): string {
  return /mac/i.test(navigator.platform || "") ? "?platform=macos" : "";
}

export const updateService = {
  async checkForUpdates(): Promise<UpdateCheckResult> {
    const { invoke } = await import("@tauri-apps/api/core");
    const baseUrl = getBaseUrl();
    return invoke<UpdateCheckResult>("check_for_updates", { baseUrl });
  },

  async downloadAndInstall(componentName: string, version: string, postInstallJson?: string, newSha256?: string, newSize?: number): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/updates/${version}/components/${componentName}/download${platformQuery()}`;
    return invoke("download_and_install_component", {
      componentName,
      downloadUrl: url,
      postInstallJson: postInstallJson ?? null,
      newSha256: newSha256 ?? null,
      newSize: newSize ?? null,
    });
  },

  async prepareGuiUpdate(version: string, newSha256?: string, newSize?: number): Promise<string> {
    const { invoke } = await import("@tauri-apps/api/core");
    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/updates/${version}/components/gui/download${platformQuery()}`;
    return invoke<string>("prepare_gui_update", {
      downloadUrl: url,
      newSha256: newSha256 ?? null,
      newSize: newSize ?? null,
    });
  },

  async launchUpdater(updaterPath: string): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("launch_updater_and_exit", { updaterPath });
  },

  async getLocalManifest(): Promise<LocalManifest | null> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<LocalManifest | null>("get_local_manifest");
  },

  async getInstallDir(): Promise<string> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("get_install_dir_path");
  },
};
