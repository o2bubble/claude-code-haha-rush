// Minimal AppState for the GUI — we don't use file editing,
// but LayoutRenderer needs the type for its appRef prop.
export interface AppState {
  tabs: any[];
  activeTab: string | null;
  activeFile: any | null;
  setActiveTab: (id: string | null) => void;
  handleCloseTab: (id: string) => void;
  handleContentChange: (content: string) => void;
  handleSave: () => void;
  handleSaveAs: () => void;
  handleOpenShortcut: () => void;
  handleCloseCurrent: () => void;
  handleCursorChange: (line: number, col: number) => void;
  handlePickFolder: () => void;
  handlePickAndOpen: () => void;
  handleOpenFile: (path: string, content?: string) => void;
  rootPath: string | null;
  editorInstance: any | null;
  setEditorInstance: (editor: any) => void;
}
