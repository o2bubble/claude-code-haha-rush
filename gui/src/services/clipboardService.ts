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
  /** 强制把文本当纯文本（跳过路径探测）—— 粘贴时按住 Alt 的用户意图。
   *  只影响**文本**判定；剪贴板里是真实文件/图片时不受影响。 */
  forceText?: boolean;
}

export type PasteDecision =
  | { kind: "refs"; refs: PasteRef[] }
  | { kind: "saveImages"; items: Array<{ blob: Blob; name?: string }> }
  | { kind: "inlineText"; text: string };

const PASTE_CHIP_THRESHOLD = 120; // chars — 长文本折叠成 @ref{paste}
/** 路径探测的整段长度上限（字符）—— 超过则按普通/长文本处理，不做路径判定。 */
const PATH_PROBE_MAX_CHARS = 200;

/**
 * 路径里**不可能出现**的字符 —— 探测前用它快速排除"明显不是路径"的文本。
 *
 *  - Windows 保留字符 `< > : " | ? *`：NTFS/Win32 层面就没有这种文件名
 *    （CreateFileW 直接失败）。它们出现在文本里 = 这不是一条路径。
 *    实际挡下的典型形态：glob 模式 `src/*.ts`、`a/b?`、带引号的句子、
 *    管道/重定向写法 `a|b/c`。
 *  - 控制字符 `\x00-\x1F`（含换行 / 制表符）：单条路径不可能跨行。
 *
 * ⚠️ **盘符的冒号是唯一例外**（`C:\...`）—— 先剥掉 `^[a-zA-Z]:[/\\]` 再校验，
 * 见 looksLikePathText。
 * ⚠️ 空格与中文**不在**表内 —— 它们是合法路径字符（`C:\Program Files`、中文
 * 目录名），拦了会误伤真实路径。
 *
 * 跨平台：macOS / Linux 的文件名**可以**含部分这些字符（如 `my*file.txt`）。
 * 统一按 Windows 规则拦是保守选择 —— 这类文件名极罕见，且被当纯文本插入对用户
 * 无害（要引用可以拖拽 / 右键「发送到聊天」）。
 */
const IMPOSSIBLE_PATH_CHARS = /[<>:"|?*\x00-\x1F]/;

/** 成对包裹的定界符 —— 首尾一致且成对时剥离（整段都被包住才有意义）。 */
const PAIRED_DELIMS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],           // ASCII 双引号 —— **Windows 右键「复制文件地址」就是这个形态**
  ["'", "'"],           // 单引号 —— shell / 某些编辑器复制路径
  ["\u201C", "\u201D"], // 中文弯引号 —— 从 Word / 微信复制
];

/**
 * 剥掉**整段包裹**的成对定界符：`"a/b"` → `a/b`。
 *
 * 为什么需要：Windows 右键「复制文件地址」拷出来就是 `"C:\path\a.txt"`（带引号），
 * 这是一条**真路径**，不该因为引号被整条拒掉。剥引号**不丢任何内容**
 * （引号只是转录噪音）→ 符合"信息保留率"判据，该转。
 *
 * 只在**成对**时剥（首尾都是同一种定界符）；`a/b "c"` 这种内部引号不动 ——
 * 那不是包裹，剥了会破坏内容。剥完还要过字形闸（内部仍可能含非法字符）。
 */
function stripWrappingQuotes(s: string): string {
  for (const [open, close] of PAIRED_DELIMS) {
    if (s.length > open.length + close.length
        && s.startsWith(open) && s.endsWith(close)) {
      return s.slice(open.length, s.length - close.length).trim();
    }
  }
  return s;
}

/**
 * 这段文本**有没有可能**是一条路径：含分隔符，且除盘符外不含不可能字符。
 * 只做形状排除，不做存在性校验（那是 pathExists 的事）。
 */
function looksLikePathText(s: string): boolean {
  if (!/[/\\]/.test(s)) return false;
  // 剥掉盘符前缀（`C:\` / `C:/`）—— 那里的冒号合法；其余位置的冒号非法
  return !IMPOSSIBLE_PATH_CHARS.test(s.replace(/^[a-zA-Z]:[/\\]/, ""));
}

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

// ── Shift 键按住状态（"Ctrl+Shift+V = 强制纯文本"用）──
//
// 为什么需要单独跟踪：`ClipboardEvent` 继承 `Event`，**没有修饰键信息**
// （altKey/shiftKey 是 KeyboardEvent / MouseEvent 的属性）—— 在 paste 事件里
// 直接读 `e.shiftKey` 拿到的是 undefined。只能靠键盘事件自己记录。
//
// 为什么是 Shift 而不是 Alt：Chromium 的粘贴快捷键是**精确匹配**的 ——
// 实测（Playwright + CDP 真实按键）`Ctrl+Alt+V` **根本不派发 paste 事件**
// （按了毫无反应），而 `Ctrl+Shift+V` 是浏览器原生的「粘贴为纯文本」，实测正常
// 触发。Ctrl+Shift+V 的通用语义本来就是"粘成纯文本"，与我们这里的意图一致。
//
// 时序：keydown 先于 paste —— 但组件**挂载时**就要开始跟踪（粘贴那一刻才装就晚了）。

let shiftHeld = false;
let trackingStarted = false;

/** 安装 Shift 状态跟踪（幂等）。粘贴入口组件挂载时调用；随窗口存活，无需卸载。 */
export function ensurePlainPasteTracking(): void {
  if (trackingStarted || typeof window === "undefined") return;
  trackingStarted = true;
  // keydown / keyup 用同一个赋值：Shift 释放的 keyup 里 shiftKey 即为 false，自洽。
  const sync = (e: KeyboardEvent) => { shiftHeld = e.shiftKey; };
  // Alt+Tab 切走时收不到 Shift 的 keyup → 不清会把状态卡在"按下"
  const clear = () => { shiftHeld = false; };
  // capture: 即使某处 stopPropagation 了 keydown，这里也能收到
  window.addEventListener("keydown", sync, true);
  window.addEventListener("keyup", sync, true);
  window.addEventListener("blur", clear);
}

/** 此刻是否按着 Shift（粘贴入口用它决定 forceText；Shift+Insert 粘纯文本一并覆盖）。 */
export function isPlainPasteHeld(): boolean {
  return shiftHeld;
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
  const { files, images, text, pathExists, readDir, readClipboardFiles, forceText } = input;
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
  //
  // 路径探测的三道闸（2026-09-20：用户反馈"普通文字被当成路径转 chip"后加）：
  //   ⓪ **剥掉整段包裹的成对引号**（`stripWrappingQuotes`）—— Windows 右键
  //      「复制文件地址」拷出来就是 `"C:\path\a.txt"`，那是**真路径**。剥引号
  //      不丢内容（引号只是转录噪音）→ 保留率 100% → 该转。
  //   ① **字形得像个路径**（`looksLikePathText`）：含分隔符 + 除盘符外无
  //      不可能字符 —— 挡单词撞名（src/docs/temp）与 glob/多行这类"一眼不是
  //      路径"的文本，也省掉无谓的文件系统往返。
  //   ② **整段不超过 PATH_PROBE_MAX_CHARS** —— 长文本里"列出"一串路径是常见内容，
  //      那是叙述不是引用意图。
  //   ③ （仍保留的）**真实存在** —— 不存在的文本一律按纯文本处理。
  //
  // 探测仍然是**整段判定**（不是从文本里抠路径）：只有"整段文本恰好等价于这个路径"
  // 才转，被转的文本不会丢任何内容（信息保留率 100%）。⚠️ 将来若想放宽成"从一段话
  // 里提取路径"，必须先答：转 chip 后原文还剩多少？以文本为主的（如"看看 a/b 目录"）
  // 必然大量丢内容 —— 那就不是引用，不要转。
  if (text) {
    const trimmed = text.trim();
    const candidate = stripWrappingQuotes(trimmed);
    const probeable =
      !forceText &&
      candidate.length <= PATH_PROBE_MAX_CHARS &&
      looksLikePathText(candidate);
    if (probeable && (await pathExists(candidate))) {
      if (readDir) {
        try {
          const entries = await readDir(candidate);
          if (entries.length > 0) {
            // 目录路径只引用目录本身，不展开子项——否则粘贴一个目录路径会把其下所有子路径都变成 chip。
            return { kind: "refs", refs: [{ type: "dir", path: candidate, label: basename(candidate) }] };
          }
        } catch {
          // not a directory — treat as file
        }
      }
      // 引用里存**剥引号后的干净路径**（引号是转录噪音，不是路径的一部分）
      return { kind: "refs", refs: [{ type: "file", path: candidate, label: basename(candidate) }] };
    }
    // Alt 粘贴 = 完全不强加任何转换（含长文本折叠）—— 用户的意图就是"所见即所得"。
    if (!forceText && text.length > PASTE_CHIP_THRESHOLD) {
      return { kind: "refs", refs: [{ type: "paste", path: text, label: pasteLabel(text) }] };
    }
    return { kind: "inlineText", text };
  }

  return { kind: "refs", refs };
}
