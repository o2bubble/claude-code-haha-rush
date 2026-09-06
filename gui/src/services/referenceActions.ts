import type { Reference } from "../types/reference";
import { editorStore, isPreviewable } from "../stores/editorStore";
import { getTree, findTabByPanelId, findGroup, ensureGroupVisible, setActiveTab, setActiveChild } from "../stores/layoutStore";
import { switchSession } from "../components/chat/useChatBridge";
import { addStatusMessage } from "../stores/statusMsgStore";
import { fileService } from "./fileService";

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
      const { eventBus } = await import("./serviceBus");
      const { Events } = await import("./events");
      const itemId = ref.path.includes("/") ? ref.path.split("/").slice(1).join("/") : ref.path;
      eventBus.emit(Events.DESKTOP_ITEM_SELECTED, { itemId });
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
      const { eventBus } = await import("./serviceBus");
      const { Events } = await import("./events");
      eventBus.emit(Events.NOTE_SELECTED, { noteId: ref.path });
      return true;
    }
    default:
      addStatusMessage(`Unknown reference type: ${(ref as any).type}`, "warn");
      return false;
  }
}

async function openFileAtLine(path: string, line?: number): Promise<boolean> {
  if (!path) return false;
  const name = path.split(/[/\\]/).pop() || path;
  if (isPreviewable(path)) {
    editorStore.openPreview(path, name);
    if (line) addStatusMessage(`Opened ${name} (line ${line})`, "info");
    return true;
  }
  try {
    const content = await fileService.readFile(path);
    editorStore.openFile(path, name, content);
    if (line) {
      addStatusMessage(`Opened ${name} (line ${line})`, "info");
    }
    return true;
  } catch {
    // 编辑器打不开（二进制/超大/特殊文件，readFile 失败）→ 回退到资源管理器打开并提示。
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_in_explorer", { path });
      addStatusMessage(`无法在编辑器打开 ${name}，已在资源管理器中打开`, "info");
      return true;
    } catch {
      addStatusMessage(`Cannot open: ${path}`, "error");
      return false;
    }
  }
}
