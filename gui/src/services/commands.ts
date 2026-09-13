// ── 命令名称常量 ──

export const Commands = {
  // Layout
  LAYOUT_TOGGLE_LEFT: "layout.toggleLeft",
  LAYOUT_TOGGLE_RIGHT: "layout.toggleRight",
  LAYOUT_TOGGLE_BOTTOM: "layout.toggleBottom",
  LAYOUT_EXPAND: "layout.expand",
  LAYOUT_COLLAPSE: "layout.collapse",
  LAYOUT_FOCUS: "layout.focus",

  // Chat
  CHAT_FOCUS_INPUT: "chat.focusInput",
  CHAT_SEND: "chat.send",
  CHAT_INTERRUPT: "chat.interrupt",

  // Files
  FILES_REVEAL: "files.reveal",

  // Session
  SESSION_SWITCH: "session.switch",
  SESSION_CREATE: "session.create",

  // Settings
  SETTINGS_OPEN: "settings.open",

  // Backend
  BACKEND_RESTART: "backend.restart",
  BACKEND_START: "backend.start",

  // Window
  WINDOW_TOAST: "window.toast",

  // Palette
  PALETTE_OPEN: "palette.open",

  // Desktop
  DESKTOP_CREATE: "desktop.create",
  DESKTOP_SWITCH: "desktop.switch",
  DESKTOP_RENAME: "desktop.rename",
  DESKTOP_DELETE: "desktop.delete",
  DESKTOP_ADD_TEXT: "desktop.addText",
  DESKTOP_ADD_CHART: "desktop.addChart",
  DESKTOP_ADD_GRAPHIC: "desktop.addGraphic",
  DESKTOP_ADD_REF: "desktop.addRef",
  DESKTOP_DELETE_ITEM: "desktop.deleteItem",
  DESKTOP_FOCUS_ITEM: "desktop.focusItem",
  DESKTOP_SEND_TO_AGENT: "desktop.sendToAgent",
  DESKTOP_SET_ZOOM: "desktop.setZoom",
  DESKTOP_QUERY_DATA: "desktop.queryData",
} as const;
