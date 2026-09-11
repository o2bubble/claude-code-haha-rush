// 检查是否在 Tauri 环境（浏览器直开则优雅降级）
function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__;
}

export const fileService = {
  async pickFile(): Promise<string | null> {
    if (!isTauri()) {
      console.warn("fileService.pickFile: not running in Tauri");
      return null;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({
      multiple: false,
      filters: [{ name: "All Files", extensions: ["*"] }],
    });
    return (result as string) ?? null;
  },

  async readFile(path: string): Promise<string> {
    if (!isTauri()) {
      console.warn("fileService.readFile: not running in Tauri");
      return "";
    }
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke("read_file", { path });
  },

  async saveFile(path: string, content: string): Promise<void> {
    if (!isTauri()) {
      console.warn("fileService.saveFile: not running in Tauri");
      return;
    }
    // 使用自定义 Rust 命令，有完善的错误处理，不会 panic
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_file", { path, content });
  },

  async pickFolder(): Promise<string | null> {
    if (!isTauri()) {
      console.warn("fileService.pickFolder: not running in Tauri");
      return null;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({
      directory: true,
      multiple: false,
    });
    return (result as string) ?? null;
  },

  async readDir(path: string, showHiddenFiles?: boolean): Promise<{ name: string; path: string; isDir: boolean }[]> {
    if (!isTauri()) {
      console.warn("fileService.readDir: not running in Tauri");
      return [];
    }
    const { invoke } = await import("@tauri-apps/api/core");
    const entries: any[] = await invoke("read_dir", { path, showHiddenFiles: showHiddenFiles ?? false });
    return entries.map((e: any) => ({ name: e.name, path: e.path, isDir: e.is_dir }));
  },

  async createPath(path: string, isDir: boolean): Promise<void> {
    if (!isTauri()) {
      console.warn("fileService.createPath: not running in Tauri");
      return;
    }
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("create_path", { path, isDir });
  },

  async deletePath(path: string): Promise<void> {
    if (!isTauri()) {
      console.warn("fileService.deletePath: not running in Tauri");
      return;
    }
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("delete_path", { path });
  },

  async renamePath(path: string, newName: string): Promise<string> {
    if (!isTauri()) {
      console.warn("fileService.renamePath: not running in Tauri");
      return path;
    }
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke("rename_path", { path, newName });
  },

  async saveAs(content: string): Promise<string | null> {
    if (!isTauri()) {
      console.warn("fileService.saveAs: not running in Tauri");
      return null;
    }
    const [{ save }, { writeTextFile }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"),
      import("@tauri-apps/plugin-fs"),
    ]);
    const path = await save({
      filters: [{ name: "All Files", extensions: ["*"] }],
    });
    if (path) {
      await writeTextFile(path as string, content);
    }
    return (path as string) ?? null;
  },
};
