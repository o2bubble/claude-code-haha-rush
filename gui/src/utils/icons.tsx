import type { ReactNode } from "react";
import { FolderOpen, Search, ListTree, Code2, Layers, FolderKanban, Package, Grid3X3, LayoutGrid, Combine, File, Box, Settings, Terminal, ClipboardList, Wrench, Bot, MessageSquare, Pencil, History, Zap, Sparkles, LayoutDashboard, HelpCircle, Monitor, UserCog, User, Folder, Bug, StickyNote, Download, Stethoscope } from "lucide-react";
import type { IconKey } from "../types/layout";

const SIZE = 18;

/** IconKey → ReactNode 映射 — 布局里只存键，渲染时才取组件 */
export const Icons: Record<IconKey, ReactNode> = {
  // Panels
  editor: <Code2 size={SIZE} />,
  workers: <Wrench size={SIZE} />,
  plan: <ClipboardList size={SIZE} />,
  subagents: <Bot size={SIZE} />,
  messages: <MessageSquare size={SIZE} />,
  input: <Pencil size={SIZE} />,
  sessions: <History size={SIZE} />,
  skills: <Sparkles size={SIZE} />,
  files: <Folder size={SIZE} />,
  settings: <Settings size={SIZE} />,
  terminal: <Terminal size={SIZE} />,
  superDesktop: <LayoutDashboard size={SIZE} />,
  askQuestion: <HelpCircle size={SIZE} />,
  desktopItemView: <Monitor size={SIZE} />,
  profileManager: <UserCog size={SIZE} />,
  feedback: <Bug size={SIZE} />,
  update: <Download size={SIZE} />,
  // Misc
  explorer: <FolderOpen size={SIZE} />,
  search: <Search size={SIZE} />,
  outline: <ListTree size={SIZE} />,
  compoundGroup: <Layers size={SIZE} />,
  file: <File size={SIZE} />,
  notes: <StickyNote size={SIZE} />,
  quickPrompts: <Zap size={SIZE} />,
  help: <HelpCircle size={SIZE} />,
  diagnostics: <Stethoscope size={SIZE} />,
  // 复合组图标候选池用
  folderKanban: <FolderKanban size={SIZE} />,
  package: <Package size={SIZE} />,
  grid3x3: <Grid3X3 size={SIZE} />,
  layoutGrid: <LayoutGrid size={SIZE} />,
  combine: <Combine size={SIZE} />,
  user: <User size={SIZE} />,
  default: <Box size={SIZE} />,
};

/** 复合组图标候选池，右键循环切换 */
export const GROUP_ICON_POOL: IconKey[] = ["compoundGroup", "folderKanban", "package", "grid3x3", "layoutGrid", "combine"];

/** IconKey → ReactNode，未知/缺失回退 default */
export function iconFor(key?: IconKey | null): ReactNode {
  return (key && Icons[key]) ? Icons[key] : Icons.default;
}
