// ── 事件名称常量 ──

export const Events = {
  // Backend
  BACKEND_STATE_CHANGED: "backend.stateChanged",
  BACKEND_PORT_READY: "backend.portReady",
  /** Fires right after bind_workspace returns (workspace DB/MCP/settings bound),
   *  BEFORE the backend port finishes polling — lets the UI restore the bound
   *  workspace's settings/layout without waiting for the backend to boot. */
  WORKSPACE_BOUND: "workspace.bound",

  // Chat
  CHAT_STATE_CHANGED: "chat.stateChanged",
  CHAT_CONNECTED: "chat.connected",
  CHAT_DISCONNECTED: "chat.disconnected",

  // Session
  SESSION_CHANGED: "session.changed",

  // Settings
  SETTINGS_CHANGED: "settings.changed",
  /** 模型 profile 列表变更（新建/删除/切换后广播，模型下拉据此刷新） */
  PROFILES_CHANGED: "profiles.changed",

  // Tasks
  TASK_UPDATED: "task.updated",

  // Terminal
  TERMINAL_CHANGED: "terminal.changed",

  // Sub-agents
  SUB_AGENTS_CHANGED: "subAgents.changed",

  // Plan
  PLAN_UPDATED: "plan.updated",
  PLAN_HISTORY_CHANGED: "plan.historyChanged",

  // Layout
  LAYOUT_TREE_CHANGED: "layout.treeChanged",
  LAYOUT_FLOATING_CHANGED: "layout.floatingChanged",

  // Editor
  EDITOR_CHANGED: "editor.changed",

  // File system
  FILE_CHANGED: "file.changed",

  // Panel registry
  PANEL_REGISTRY_CHANGED: "panelRegistry.changed",

  // i18n
  LANGUAGE_CHANGED: "language.changed",

  // Window / UI
  WINDOW_TOAST: "window.toast",

  // Chat input
  CHAT_INSERT_TEXT: "chat.insertText",
  CHAT_ADD_REFERENCE: "chat.addReference",

  // Workspace
  WORKSPACE_OPEN_SELECTOR: "workspace.openSelector",

  // Files
  FILE_REVEAL: "file.reveal",

  // Desktop
  DESKTOP_CHANGED: "desktop.changed",
  DESKTOP_ITEM_MOVED: "desktop.itemMoved",
  DESKTOP_ITEM_SELECTED: "desktop.itemSelected",
  // Notes
  NOTES_CHANGED: "notes.changed",
  NOTE_SELECTED: "note.selected",

  // Updates
  UPDATE_AVAILABILITY_CHANGED: "update.availabilityChanged",

  // Command palette
  COMMAND_PALETTE_OPEN: "commandPalette.open",
} as const;

// ── 事件负载类型 ──

export interface SettingsChangedPayload {
  settings: import("../stores/settingsStore").AppSettings;
}

export interface BackendStateChangedPayload {
  status: "stopped" | "starting" | "running" | "error";
  port: number | null;
  workDir: string;
  error?: string;
}

export interface BackendPortReadyPayload {
  port: number;
}

export interface FileRevealPayload {
  /** 要在文件树中定位/选中的绝对路径 */
  path: string;
  /** 工作区根路径；非空时仅在该工作区内的文件才定位目录树 */
  rootPath?: string;
}

export interface ToastPayload {
  message: string;
  type?: "info" | "success" | "error";
}

export interface CommandPaletteOpenPayload {
  context?: "editor" | "global";
  query?: string;
}

export interface SubAgentsChangedPayload {
  state: import("../stores/subAgentStore").SubAgentState;
}

export interface PlanUpdatedPayload {
  tasks: import("../stores/planStore").PlanTask[];
}

export interface PlanHistoryChangedPayload {
  records: import("../stores/planHistoryStore").PlanRecord[];
}

export interface ChatStateChangedPayload {
  state: import("../stores/chatStore").ChatState;
}

export interface TerminalChangedPayload {
  entries: import("../stores/terminalStore").TerminalEntry[];
  activeEntryId: string | null;
}

export interface LayoutTreeChangedPayload {
  tree: import("../types/layout").LayoutNode;
}

export interface LayoutFloatingChangedPayload {
  floatingPanels: import("../types/layout").FloatingWindow[];
}

export interface EditorChangedPayload {
  tabs: import("../stores/editorStore").FileTab[];
  activePath: string | null;
}

export interface FileChangedPayload {
  path: string;
}

export interface PanelRegistryChangedPayload {
  panels: import("../stores/panelRegistry").PanelDefinition[];
}

export interface ChatInsertTextPayload {
  text: string;
  /** 为 true 时插入到输入框最前面（而非光标处），用于命令面板发命令 */
  atStart?: boolean;
  /** 为 true 时追加到输入框末尾（划词/快捷提示多次发送层层追加） */
  appendEnd?: boolean;
  /** 回复引用：插入 text 后再补 suffix（如 《》的半边），光标停在 text 与 suffix 之间（书名号中间） */
  replySuffix?: string;
  /** 回复引用专用：插入前若当前输入框已有内容则先换行，让引用独占一行 */
  newlineBefore?: boolean;
}

export interface ChatAddReferencePayload {
  reference: import("../types/reference").Reference;
}

// ── Desktop payloads ──

export interface DesktopChangedPayload {
  desktops: import("../types/desktop").Desktop[];
  activeDesktopId: string | null;
}

export interface DesktopItemMovedPayload {
  itemId: string;
  x: number;
  y: number;
}

export interface DesktopItemSelectedPayload {
  itemId: string;
}

export interface UpdateAvailabilityPayload {
  hasUpdate: boolean;
  version: string;
}

