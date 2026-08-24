// Simple open-files state for the editor panel

import { eventBus } from "../services/serviceBus";
import { Events } from "../services/events";
import { activatePanel } from "./layoutStore";

export interface FileTab {
  path: string;
  name: string;
  content: string;
  dirty: boolean;
  externalChanged: boolean;
  /** "text" for Monaco editor, "preview" for image/PDF/SVG viewer */
  tabType?: "text" | "preview";
  /** File was deleted from disk — content preserved for viewing but saving is disabled. */
  deleted?: boolean;
  /** Markdown 渲染预览态（编辑 Monaco ⇄ 预览渲染），按标签持久化 */
  previewMode?: boolean;
}

// Previewable file extensions
const PREVIEW_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "pdf"]);

export function isPreviewable(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return PREVIEW_EXTS.has(ext);
}

let _tabs: FileTab[] = [];
let _activePath: string | null = null;

function notify() {
  eventBus.emit(Events.EDITOR_CHANGED, { tabs: [..._tabs], activePath: _activePath }, { sticky: true });
}

export const editorStore = {
  get tabs() { return _tabs; },
  get activePath() { return _activePath; },
  get activeTab() { return _tabs.find((t) => t.path === _activePath) ?? null; },

  openFile(path: string, name: string, content: string) {
    const existing = _tabs.find((t) => t.path === path);
    if (existing) {
      existing.externalChanged = false;
      existing.tabType = "text";
      _activePath = path;
      notify();
    } else {
      _tabs.push({ path, name, content, dirty: false, externalChanged: false, tabType: "text" });
      _activePath = path;
      notify();
    }
    activatePanel("editor");
  },

  /** Open a non-text file for preview (image/PDF/SVG). */
  openPreview(path: string, name: string) {
    const existing = _tabs.find((t) => t.path === path);
    if (existing) {
      existing.tabType = "preview";
      _activePath = path;
      notify();
    } else {
      // Content is empty — FilePreview component loads via read_bytes
      _tabs.push({ path, name, content: "", dirty: false, externalChanged: false, tabType: "preview" });
      _activePath = path;
      notify();
    }
    activatePanel("editor");
  },

  closeTab(path: string) {
    const idx = _tabs.findIndex((t) => t.path === path);
    if (idx < 0) return;
    _tabs.splice(idx, 1);
    if (_activePath === path) {
      _activePath = _tabs[Math.min(idx, _tabs.length - 1)]?.path ?? null;
    }
    notify();
  },

  setContent(path: string, content: string) {
    const tab = _tabs.find((t) => t.path === path);
    if (!tab || tab.deleted) return;
    tab.content = content;
    tab.dirty = true;
    notify();
  },

  markDeleted(path: string) {
    const tab = _tabs.find((t) => t.path === path);
    if (!tab) return;
    tab.deleted = true;
    tab.dirty = false;
    tab.externalChanged = false;
    notify();
  },

  markClean(path: string) {
    const tab = _tabs.find((t) => t.path === path);
    if (tab) { tab.dirty = false; notify(); }
  },

  setActive(path: string) {
    _activePath = path;
    notify();
  },

  // Mark a tab as having external changes (AI wrote to disk).
  // If the tab is clean, caller should read the file and call reloadContent.
  // If dirty, just show the indicator.
  markExternalChanged(path: string) {
    const tab = _tabs.find((t) => t.path === path);
    if (!tab) return;
    tab.externalChanged = true;
    notify();
    return tab.dirty ? false : true; // true = needs reload, false = dirty (show indicator)
  },

  // Reload tab content from disk (caller provides the content).
  reloadContent(path: string, content: string) {
    const tab = _tabs.find((t) => t.path === path);
    if (!tab) return;
    tab.content = content;
    tab.dirty = false;
    tab.externalChanged = false;
    notify();
  },

  /** 切换 md 标签的 编辑/预览 视图态（按标签持久化） */
  togglePreviewMode(path: string) {
    const tab = _tabs.find((t) => t.path === path);
    if (!tab) return;
    tab.previewMode = !tab.previewMode;
    notify();
  },
};
