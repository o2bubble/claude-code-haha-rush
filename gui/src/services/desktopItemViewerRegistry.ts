// Lightweight registry for passing desktop item id to DesktopItemViewer panels.
// For same-process floating panels: set itemId before creating the tab.
// For Tauri windows: itemId is encoded in the window label, FloatingApp reads it and calls set.
let currentItemId: string | null = null;

export function setCurrentViewerItemId(itemId: string | null): void {
  currentItemId = itemId;
}

export function getCurrentViewerItemId(): string | null {
  return currentItemId;
}
