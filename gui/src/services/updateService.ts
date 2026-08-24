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

/** A "real" update = an installed component whose sha differs from remote.
 *  Components never installed (e.g. newly published like the updater) surface
 *  in the update panel as opt-in but must NOT light the red-dot badge or get
 *  auto-checked — they're a first-time install, not an update. */
export function hasRealUpdate(components: ComponentStatus[]): boolean {
  return components.some((c) => c.needs_update && c.installed);
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

export const updateService = {
  async checkForUpdates(): Promise<UpdateCheckResult> {
    const { invoke } = await import("@tauri-apps/api/core");
    const baseUrl = getBaseUrl();
    return invoke<UpdateCheckResult>("check_for_updates", { baseUrl });
  },

  async downloadAndInstall(componentName: string, version: string, postInstallJson?: string, newSha256?: string, newSize?: number): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/updates/${version}/components/${componentName}/download`;
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
    const url = `${baseUrl}/api/updates/${version}/components/gui/download`;
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
