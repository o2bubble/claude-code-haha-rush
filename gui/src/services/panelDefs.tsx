import type { PanelDefinition } from "../stores/panelRegistry";
import { t } from "../i18n";
import { ErrorBoundary } from "../components/ErrorBoundary";

/* ── Panel content imports ── */
import { EditorPanel } from "../components/EditorPanel";
import { WorkerPanel } from "../components/chat/WorkerPanel";
import PlanPanel from "../components/chat/PlanPanel";
import { SubAgentPanel } from "../components/chat/SubAgentPanel";
import { ChatMessagesPanel } from "../components/chat/ChatMessagesPanel";
import { ChatInputPanel } from "../components/chat/ChatInputPanel";
import SkillsPanel from "../components/chat/SkillsPanel";
import { SessionPanel } from "../components/chat/SessionPanel";
import { FileBrowserPanel } from "../components/FileBrowserPanel";
import { SettingsPanel } from "../components/chat/SettingsPanel";
import TerminalPanel from "../components/TerminalPanel";
import { SkillDialogFloating } from "../components/chat/SkillDialogFloating";
import { AskQuestionFloating } from "../components/chat/AskQuestionFloating";
import { SuperDesktopPanel } from "../components/desktop/SuperDesktopPanel";
import { DesktopItemViewer } from "../components/desktop/DesktopItemViewer";
import QuickPromptPanel from "../components/chat/QuickPromptPanel";
import ProfileDialog from "../components/chat/ProfileDialog";
import FeedbackDialog from "../components/chat/FeedbackDialog";
import NotesPanel from "../components/chat/NotesPanel";
import HelpPanel from "../components/chat/HelpPanel";
import { UpdatePanel } from "../components/chat/UpdatePanel";
import { DiagnosticPanel } from "../components/chat/DiagnosticPanel";

/* ── Helper: wrap component in ErrorBoundary ── */
function withError(name: string, el: JSX.Element) {
  return <ErrorBoundary panelName={name}>{el}</ErrorBoundary>;
}

/**
 * 所有 17 个 Panel 的统一定义 —— 单一数据源。
 * App.tsx（Hub 主窗口）和 FloatingApp.tsx（Leaf 子窗口）各自遍历调用 registerPanel()。
 */
export const ALL_PANEL_DEFS: PanelDefinition[] = [
  {
    id: "editor", title: t("panel.editor"), icon: "editor", defaultView: "main",
    views: [{ id: "main", title: t("panel.editor"), render: () => withError("Editor", <EditorPanel />) }],
  },
  {
    id: "workers", title: t("panel.workers"), icon: "workers", defaultView: "main",
    views: [{ id: "main", title: t("panel.workers"), render: () => withError("Workers", <WorkerPanel />) }],
  },
  {
    id: "plan", title: t("panel.plan"), icon: "plan", defaultView: "main",
    views: [{ id: "main", title: t("panel.plan"), render: () => withError("Plan", <PlanPanel />) }],
  },
  {
    id: "subagents", title: t("panel.subagents"), icon: "subagents", defaultView: "main",
    views: [{ id: "main", title: t("panel.subagents"), render: () => withError("Sub-Agents", <SubAgentPanel />) }],
  },
  {
    id: "chat-messages", title: t("panel.messages"), icon: "messages", defaultView: "main",
    views: [{ id: "main", title: t("panel.messages"), render: () => withError("Messages", <ChatMessagesPanel />) }],
  },
  {
    id: "chat-input", title: t("panel.input"), icon: "input", defaultView: "main",
    views: [{ id: "main", title: t("panel.input"), render: () => withError("Input", <ChatInputPanel />) }],
  },
  {
    id: "skills", title: t("panel.skills"), icon: "skills", defaultView: "main",
    views: [{ id: "main", title: t("panel.skills"), render: () => withError("Skills", <SkillsPanel />) }],
  },
  {
    id: "sessions", title: t("panel.sessions"), icon: "sessions", defaultView: "list",
    views: [{ id: "list", title: t("panel.sessions"), render: () => withError("Sessions", <SessionPanel />) }],
  },
  {
    id: "files", title: t("panel.files"), icon: "files", defaultView: "browse",
    views: [{ id: "browse", title: t("panel.files"), render: () => withError("Files", <FileBrowserPanel />) }],
  },
  {
    id: "notes", title: t("panel.notes"), icon: "notes", defaultView: "main",
    views: [{ id: "main", title: t("panel.notes"), render: () => withError("Notes", <NotesPanel />) }],
  },
  {
    id: "settings", title: t("panel.settings"), icon: "settings", userManaged: false, defaultView: "main",
    views: [{ id: "main", title: t("panel.settings"), render: () => withError("Settings", <SettingsPanel />) }],
  },
  {
    id: "terminal", title: t("panel.terminal"), icon: "terminal", defaultView: "main",
    views: [{ id: "main", title: t("panel.terminal"), render: () => withError("Terminal", <TerminalPanel />) }],
  },
  {
    id: "skill-dialog", title: t("panel.skill"), icon: "default", userManaged: false, defaultView: "main",
    views: [{ id: "main", title: t("panel.skill"), render: () => withError("SkillDialog", <SkillDialogFloating />) }],
  },
  {
    id: "super-desktop", title: t("panel.superDesktop"), icon: "superDesktop", defaultView: "main",
    views: [{ id: "main", title: t("panel.superDesktop"), render: () => withError("SuperDesktop", <SuperDesktopPanel />) }],
  },
  {
    id: "ask-question", title: t("panel.question"), icon: "askQuestion", userManaged: false, defaultView: "main",
    views: [{ id: "main", title: t("panel.question"), render: () => withError("AskQuestion", <AskQuestionFloating />) }],
  },
  {
    id: "desktop-item-view", title: t("panel.item"), icon: "desktopItemView", userManaged: false, defaultView: "main",
    views: [{ id: "main", title: t("panel.item"), render: () => withError("DesktopItemView", <DesktopItemViewer />) }],
  },
  {
    id: "quick-prompts", title: t("panel.quickPrompts"), icon: "quickPrompts", defaultView: "main",
    views: [{ id: "main", title: t("panel.quickPrompts"), render: () => withError("QuickPrompts", <QuickPromptPanel />) }],
  },
  {
    id: "profile-manager", title: t("panel.profiles"), icon: "profileManager", userManaged: false, defaultView: "main",
    views: [{ id: "main", title: t("panel.profiles"), render: () => withError("ProfileManager", <ProfileDialog />) }],
  },
  {
    id: "feedback", title: t("panel.feedback"), icon: "feedback", userManaged: false, defaultView: "main",
    views: [{ id: "main", title: t("panel.feedback"), render: () => withError("Feedback", <FeedbackDialog />) }],
  },
  {
    id: "update", title: t("panel.update"), icon: "update", userManaged: false, defaultView: "main",
    views: [{ id: "main", title: t("panel.update"), render: () => withError("Update", <UpdatePanel />) }],
  },
  {
    id: "help", title: t("help.title"), icon: "help", userManaged: false, defaultView: "main",
    views: [{ id: "main", title: t("help.title"), render: () => withError("Help", <HelpPanel />) }],
  },
  {
    id: "diagnostics", title: t("panel.diagnostics"), icon: "diagnostics", userManaged: false, defaultView: "main",
    views: [{ id: "main", title: t("panel.diagnostics"), render: () => withError("Diagnostics", <DiagnosticPanel />) }],
  },
];
