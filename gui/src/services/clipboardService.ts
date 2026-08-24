/**
 * Shared clipboard utilities — extracted from InputArea.tsx.
 * Used by both chat input and Super Desktop canvas.
 */

/**
 * Save a clipboard blob (image/file) to <workDir>/.claude/pasted/.
 * Returns the saved file path, or null on failure.
 */
export async function saveClipboardItem(
  blob: Blob,
  workDir: string,
  baseName?: string,
): Promise<string | null> {
  if (!workDir) return null;
  try {
    const ext = baseName
      ? (baseName.split(".").pop() || "bin")
      : (blob.type.split("/")[1] || "png");
    const name = baseName || `pasted-${Date.now()}.${ext}`;
    const pastedDir = `${workDir}/.claude/pasted`;
    const filePath = `${pastedDir}/${name}`;

    const base64 = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(",")[1]);
      reader.readAsDataURL(blob);
    });

    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_bytes", { path: filePath, base64Data: base64 });
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Check whether the given text is a path to an existing file/directory.
 * Returns false after `timeoutMs` (default 1000ms) if no response.
 */
export async function isRealFilePath(path: string, timeoutMs = 1000): Promise<boolean> {
  try {
    const result = await Promise.race([
      (async () => {
        const { invoke } = await import("@tauri-apps/api/core");
        return invoke<boolean>("path_exists", { path });
      })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
    return result;
  } catch {
    return false;
  }
}
