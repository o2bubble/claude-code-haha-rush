import type { Reference } from "../types/reference";
import { editorStore, isPreviewable } from "../stores/editorStore";
import { getTree, findTabByPanelId, findGroup, ensureGroupVisible, setActiveTab, setActiveChild } from "../stores/layoutStore";
import { switchSession } from "../components/chat/useChatBridge";
import { addStatusMessage } from "../stores/statusMsgStore";
import { fileService } from "./fileService";

/**
 * 在编辑器里打开一个路径 —— **全应用唯一的入口**，按类型分流：
 * - 图片 / PDF（`isPreviewable`）→ `openPreview`（由 FilePreview 用 read_bytes 加载）
 * - 其它（文本）→ 读内容后 `openFile`
 * - 读失败（二进制 / 超大 / 特殊文件）→ **回退到资源管理器**并提示，不让用户"点了没反应"
 *
 * 抽成公开函数是因为这条分流逻辑被多处需要（消息里的路径链接、划词工具栏、
 * 引用跳转…）。各写一份的话，改了一处忘了另一处就会出现"这里能开、那里打不开"
 * 的不一致 —— 之前 MessageItem 就踩过（只走 readFile，图片读出乱码被静默吞掉）。
 *
 * @returns 是否成功打开（回退到资源管理器也算成功）
 */
export async function openPathInEditor(path: string, opts?: {
  /** 需要额外提示的使用场景（默认静默成功 —— 打开本身已是反馈） */
  silent?: boolean;
}): Promise<boolean> {
  if (!path) return false;
  const name = path.split(/[/\\]/).pop() || path;
  if (isPreviewable(path)) {
    editorStore.openPreview(path, name);
    return true;
  }
  try {
    const content = await fileService.readFile(path);
    editorStore.openFile(path, name, content);
    return true;
  } catch {
    // 编辑器打不开 → 回退资源管理器（至少让用户能定位到文件）
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_in_explorer", { path });
      if (!opts?.silent) {
        addStatusMessage(`无法在编辑器打开 ${name}，已在资源管理器中打开`, "info");
      }
      return true;
    } catch {
      addStatusMessage(`Cannot open: ${path}`, "error");
      return false;
    }
  }
}

/**
 * Execute the action for a reference — open file, locate panel, switch session, etc.
 */
export async function openReference(ref: Reference): Promise<boolean> {
  switch (ref.type) {
    case "file":
      return openFileAtLine(ref.path, ref.startLine);
    case "dir":
      // TODO: expand file tree to this directory; for now show status
      addStatusMessage(`Navigate to: ${ref.path}`, "info");
      return true;
    case "line":
      return openFileAtLine(ref.path, ref.startLine);
    case "panel": {
      const tree = getTree();
      const found = findTabByPanelId(tree, ref.path);
      if (found) {
        ensureGroupVisible(found.groupId);
        setActiveTab(found.groupId, found.tabId);
        if (found.childTabId) {
          setActiveChild(found.groupId, found.tabId, found.childTabId);
        }
        return true;
      }
      addStatusMessage(`Panel "${ref.path}" not found`, "warn");
      return false;
    }
    case "session":
      if (ref.path) {
        switchSession(ref.path);
        return true;
      }
      return false;
    case "paste":
      return true; // expand/collapse handled inline in ReferenceLink
    case "desktop": {
      const tree = getTree();
      const found = findTabByPanelId(tree, "super-desktop");
      if (found) {
        ensureGroupVisible(found.groupId);
        setActiveTab(found.groupId, found.tabId);
        return true;
      }
      addStatusMessage("Super Desktop panel not found", "warn");
      return false;
    }
    case "desktop-item": {
      // Activate the desktop panel first
      const tree = getTree();
      const found = findTabByPanelId(tree, "super-desktop");
      if (found) {
        ensureGroupVisible(found.groupId);
        setActiveTab(found.groupId, found.tabId);
      }
      // Emit event to focus the item
      const { windowBus } = await import("./windowBus");
      const { Events } = await import("./events");
      const itemId = ref.path.includes("/") ? ref.path.split("/").slice(1).join("/") : ref.path;
      windowBus.emit(Events.DESKTOP_ITEM_SELECTED, { itemId });
      return true;
    }
    case "note": {
      // Activate Notes panel
      const tree = getTree();
      const found = findTabByPanelId(tree, "notes");
      if (found) {
        ensureGroupVisible(found.groupId);
        setActiveTab(found.groupId, found.tabId);
      }
      // Emit event to load the note
      const { windowBus } = await import("./windowBus");
      const { Events } = await import("./events");
      windowBus.emit(Events.NOTE_SELECTED, { noteId: ref.path });
      return true;
    }
    default:
      addStatusMessage(`Unknown reference type: ${(ref as any).type}`, "warn");
      return false;
  }
}

async function openFileAtLine(path: string, line?: number): Promise<boolean> {
  const ok = await openPathInEditor(path, { silent: !line });
  if (ok && line) {
    const name = path.split(/[/\\]/).pop() || path;
    addStatusMessage(`Opened ${name} (line ${line})`, "info");
  }
  return ok;
}
