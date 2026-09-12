/**
 * Shared clipboard utilities — extracted from InputArea.tsx.
 * Used by both chat input and Super Desktop canvas.
 */

import type { ReferenceType } from "../types/reference";

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

// ── Paste decision seam (chat input + Super Desktop share this) ──

/** 单个剪贴板文件对象。**注意：`path` 只有拖放才有** —— `File.path` 是 Electron
 *  的非标准扩展，Tauri 仅对拖放注入；粘贴时一律为空（见 readClipboardFiles）。 */
export interface PasteFile {
  name: string;
  blob: Blob;
  /** 真实文件路径（仅拖放注入）；空表示需靠 readClipboardFiles 补或复制内容。 */
  path?: string;
  type?: string;
}

/** 剪贴板 image/* 条目（截图等，无源路径）。 */
export interface PasteImage {
  blob: Blob;
  mime: string;
}

export type PasteRef = { type: ReferenceType; path: string; label: string };
export type DirEntry = { path: string; name: string; is_dir: boolean };

export interface PasteInput {
  files: PasteFile[];
  images: PasteImage[];
  text: string;
  /** 注入的路径存在性校验（组件用 isRealFilePath，测试传 fake）。 */
  pathExists: (p: string) => Promise<boolean>;
  /** 注入的目录枚举（组件用 defaultReadDir）；缺省则该路径按文件处理。 */
  readDir?: (p: string) => Promise<DirEntry[]>;
  /** 注入的系统剪贴板文件列表读取（组件用 defaultReadClipboardFiles）。
   *  粘贴时 `File.path` 为空，靠它拿源路径，使文件走引用而非复制。 */
  readClipboardFiles?: () => Promise<string[]>;
}

export type PasteDecision =
  | { kind: "refs"; refs: PasteRef[] }
  | { kind: "saveImages"; items: Array<{ blob: Blob; name?: string }> }
  | { kind: "inlineText"; text: string };

const PASTE_CHIP_THRESHOLD = 120; // chars — 长文本折叠成 @ref{paste}
const basename = (p: string) => p.split(/[/\\]/).pop() || p;
const refOf = (e: DirEntry): PasteRef => ({
  type: e.is_dir ? "dir" : "file",
  path: e.path,
  label: e.name,
});

/** 从 ClipboardEvent 提取结构化输入（两个粘贴入口共用，避免重复脚手架）。 */
export function collectPaste(ev: { clipboardData: DataTransfer }): { files: PasteFile[]; images: PasteImage[]; text: string } {
  const items = ev.clipboardData.items;
  const images: PasteImage[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith("image/")) {
      const blob = item.getAsFile();
      if (blob) images.push({ blob, mime: item.type });
    }
  }
  const files: PasteFile[] = Array.from(ev.clipboardData.files).map((f) => ({
    name: f.name,
    blob: f,
    path: (f as File & { path?: string }).path,
    type: f.type,
  }));
  return { files, images, text: ev.clipboardData.getData("text/plain") || "" };
}

/** 默认目录枚举（resolvePaste 的 readDir 注入），组件/测试可换。 */
export async function defaultReadDir(p: string): Promise<DirEntry[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DirEntry[]>("read_dir", { path: p });
}

/** 默认系统剪贴板文件列表读取（resolvePaste 的 readClipboardFiles 注入）。
 *  非 Tauri 环境 / 平台不支持 / 剪贴板里不是文件 → 空数组（调用方回退复制）。 */
export async function defaultReadClipboardFiles(): Promise<string[]> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string[]>("read_clipboard_files");
  } catch {
    return [];
  }
}

/** @ref{paste} 可读标签：先 URI decode（.claude/pasted 内容会百分号编码），再压缩空白取前 40 字符。 */
function pasteLabel(text: string): string {
  let src = text;
  if (text.includes("%") && /%[0-9A-Fa-f]{2}/.test(text)) {
    try { src = decodeURIComponent(text); } catch { /* keep raw */ }
  }
  return src.replace(/\s+/g, " ").slice(0, 40) + "…";
}

/**
 * 粘贴内容 → 引用 / 保存 / 文本 的纯决策函数，所有粘贴入口共用同一 seam。
 * 组件负责从其 ClipboardEvent 提取结构化输入、并按决策落地（插入 chip / saveClipboardItem）。
 * 只做决策、不做 I/O（目录枚举/路径校验由注入函数承载，便于测试 mock）。
 */
export async function resolvePaste(input: PasteInput): Promise<PasteDecision> {
  const { files, images, text, pathExists, readDir, readClipboardFiles } = input;
  const refs: PasteRef[] = [];
  const toSave: Array<{ blob: Blob; name?: string }> = [];

  // 粘贴来的文件没有 .path（只有拖放有，见 PasteFile 注释）→ 从系统剪贴板补源路径，
  // 让文件走引用而非复制内容。仅在**数量精确匹配**时按序配对：混合粘贴（文件+截图）
  // 会让两侧数量不符，此时宁可回退复制，也不要错配成引用别的文件。
  const needPathFor = (f: PasteFile) => !f.path && !f.type?.startsWith("image/");
  let clipboardPaths: string[] | null = null;
  if (readClipboardFiles && files.some(needPathFor)) {
    const list = await readClipboardFiles().catch(() => [] as string[]);
    if (list.length === files.length) clipboardPaths = list;
  }

  // 文件对象：有真实路径 → 引用原路径；目录 → 枚举 refs；无路径 → 保存（保留名字）。
  for (const [i, f] of files.entries()) {
    // 无源路径的图片交给 images 数组统一处理。剪贴板里同一张图会同时出现在
    // items(image/*) 和 files(无 .path 的 File) 两处，若都进 toSave 会产出两个 clip。
    // 图片**不走**上面的剪贴板补路径：粘贴图片的预期是"变成图片块/发送二进制"，
    // 补上路径反而会把它变成文件引用（用户明确要的语义：只有图片二进制才该被粘贴）。
    if (!f.path && f.type?.startsWith("image/")) continue;
    const path = f.path ?? (needPathFor(f) ? clipboardPaths?.[i] : undefined);
    if (path) {
      if (readDir) {
        try {
          const entries = await readDir(path);
          if (entries.length > 0) {
            // 目录只引用目录本身，不展开子项（与文本路径一致）——避免粘贴/拖入文件夹产生一堆子路径 chip。
            refs.push({ type: "dir", path, label: f.name || basename(path) });
            continue;
          }
        } catch {
          // not a directory — fall through to file ref
        }
      }
      refs.push({ type: "file", path, label: f.name || basename(path) });
    } else {
      toSave.push({ blob: f.blob, name: f.name });
    }
  }

  for (const img of images) toSave.push({ blob: img.blob, name: undefined });

  if (refs.length > 0) return { kind: "refs", refs };
  if (toSave.length > 0) return { kind: "saveImages", items: toSave };

  // 文本：真实路径 → file/{dir} ref；长文本 → paste ref；短文本 → inline。
  if (text) {
    const trimmed = text.trim();
    if (trimmed && (await pathExists(trimmed))) {
      if (readDir) {
        try {
          const entries = await readDir(trimmed);
          if (entries.length > 0) {
            // 目录路径只引用目录本身，不展开子项——否则粘贴一个目录路径会把其下所有子路径都变成 chip。
            return { kind: "refs", refs: [{ type: "dir", path: trimmed, label: basename(trimmed) }] };
          }
        } catch {
          // not a directory — treat as file
        }
      }
      return { kind: "refs", refs: [{ type: "file", path: trimmed, label: basename(trimmed) }] };
    }
    if (text.length > PASTE_CHIP_THRESHOLD) {
      return { kind: "refs", refs: [{ type: "paste", path: text, label: pasteLabel(text) }] };
    }
    return { kind: "inlineText", text };
  }

  return { kind: "refs", refs };
}
