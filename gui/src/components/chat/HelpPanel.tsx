import { PanelLeft, PanelRight, PanelBottom, FolderOpen, Grid3x3, LayoutTemplate, RefreshCw, Sun, Shield, User, Layers, Terminal, Download, Bug, Settings, MessageSquare, Pencil, History, Folder, Code2, Sparkles, Bot, ClipboardList, Wrench, LayoutDashboard, Zap, StickyNote, Search, Stethoscope } from "lucide-react";
import { t } from "../../i18n";
import { AgentLoopDemo } from "./help/AgentLoopDemo";
import { PermissionDialogDemo } from "./help/PermissionDialogDemo";
import { WorkspaceSessionDemo } from "./help/WorkspaceSessionDemo";
import { ProfileFlowDemo } from "./help/ProfileFlowDemo";
import { PanelToggleDemo } from "./help/PanelToggleDemo";
import { DesktopConnectDemo } from "./help/DesktopConnectDemo";
import { LayoutSystemDemo } from "./help/LayoutSystemDemo";
import { NotesDemo } from "./help/NotesDemo";
import { FileTreeDemo } from "./help/FileTreeDemo";
import { OfficeDemo } from "./help/OfficeDemo";

/* ── Styles ── */

const sectionHeader: React.CSSProperties = {
  fontSize: "calc(var(--font-scale, 1) * 15px)",
  fontWeight: 700,
  color: "var(--fg-primary)",
  paddingBottom: 10,
  marginBottom: 12,
  borderBottom: "2px solid var(--border-medium)",
  marginTop: 28,
};

const subHeader: React.CSSProperties = {
  fontSize: "calc(var(--font-scale, 1) * 13px)",
  fontWeight: 600,
  color: "var(--fg-primary)",
  marginBottom: 6,
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const desc: React.CSSProperties = {
  fontSize: "calc(var(--font-scale, 1) * 12px)",
  color: "var(--fg-muted)",
  lineHeight: 1.6,
  marginBottom: 12,
};

const diagramBox: React.CSSProperties = {
  marginBottom: 16,
  padding: 12,
  borderRadius: 8,
  background: "var(--bg-surface)",
  border: "1px solid var(--border-light)",
  overflow: "hidden",
};

const toolbarGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
  gap: 6,
};

const tbCard: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "flex-start",
  padding: "8px 10px",
  borderRadius: 6,
  background: "var(--bg-surface)",
  border: "1px solid var(--border-light)",
};

const userSelectNone: React.CSSProperties = { userSelect: "none", WebkitUserSelect: "none" };

/* ── Concept diagrams (pure HTML/CSS) ── */

function LayoutDiagram() {
  return (
    <div style={diagramBox}>
      <div style={{ display: "grid", gridTemplateColumns: "140px 1fr 140px", gridTemplateRows: "1fr 48px", gap: 4, height: 160, ...userSelectNone }}>
        <div style={{ background: "var(--accent-subtle)", borderRadius: "4px 0 0 0", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontSize: 10, color: "var(--accent)", fontWeight: 600, padding: 8, textAlign: "center", lineHeight: 1.5 }}>
          左侧面板<br />
          <span style={{ fontWeight: 400, fontSize: 9, opacity: 0.7 }}>会话 · 文件 · 计划<br />子代理 · 技能 · 笔记</span>
        </div>
        <div style={{ background: "var(--bg-hover)", borderRadius: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "var(--fg-muted)", fontWeight: 600, textAlign: "center", lineHeight: 1.5 }}>
          中心区域<br />
          <span style={{ fontWeight: 400, fontSize: 9, opacity: 0.6 }}>编辑器 · 超级桌面</span>
        </div>
        <div style={{ background: "var(--accent-subtle)", borderRadius: "0 4px 0 0", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontSize: 10, color: "var(--accent)", fontWeight: 600, padding: 8, textAlign: "center", lineHeight: 1.5 }}>
          右侧面板<br />
          <span style={{ fontWeight: 400, fontSize: 9, opacity: 0.7 }}>聊天消息<br />输入区域</span>
        </div>
        <div style={{ background: "var(--semantic-success-subtle, #e8f5e9)", borderRadius: "0 0 4px 4px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "var(--semantic-success)", fontWeight: 600, gridColumn: "1 / -1" }}>
          底部面板 — 终端
        </div>
      </div>
      <div style={{ fontSize: 10, color: "var(--fg-muted)", marginTop: 8, textAlign: "center" }}>
        {t("help.layoutDesc")}
      </div>
    </div>
  );
}

function ChatSplitDiagram() {
  return (
    <div style={{ ...diagramBox, padding: 8 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, height: 120, ...userSelectNone }}>
        <div style={{ flex: 1, background: "var(--bg-hover)", borderRadius: 4, padding: 8, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ background: "var(--accent-subtle)", borderRadius: 4, padding: "4px 8px", fontSize: 9, color: "var(--accent)", alignSelf: "flex-start", maxWidth: "70%" }}>这是 AI 的回复...</div>
          <div style={{ background: "var(--bg-surface)", borderRadius: 4, padding: "4px 8px", fontSize: 9, color: "var(--fg-muted)", alignSelf: "flex-end", maxWidth: "60%" }}>用户的消息</div>
          <div style={{ background: "var(--accent-subtle)", borderRadius: 4, padding: "4px 8px", fontSize: 9, color: "var(--accent)", alignSelf: "flex-start", maxWidth: "75%" }}>工具调用: 编辑文件 app.tsx</div>
        </div>
        <div style={{ height: 32, background: "var(--bg-surface)", borderRadius: 4, border: "1px solid var(--border-light)", display: "flex", alignItems: "center", padding: "0 10px", fontSize: 10, color: "var(--fg-muted)" }}>
          <span style={{ opacity: 0.5 }}>输入消息... @文件 Enter 发送</span>
        </div>
      </div>
      <div style={{ fontSize: 10, color: "var(--fg-muted)", marginTop: 6 }}>
        上方消息区实时展示对话流，下方输入框发送消息，粘贴文本/文件自动转为引用芯片。
      </div>
    </div>
  );
}

/** 超级桌面：AI 创建场景动画 + AI 可创建的内容类型清单 */
function SuperDesktopAiDiagram() {
  const types: { icon: string; key: string }[] = [
    { icon: "📝", key: "help.sdTypeText" },
    { icon: "📊", key: "help.sdTypeTable" },
    { icon: "📈", key: "help.sdTypeChart" },
    { icon: "📐", key: "help.sdTypeGraphic" },
    { icon: "📋", key: "help.sdTypeForm" },
    { icon: "🖼️", key: "help.sdTypeImage" },
    { icon: "📎", key: "help.sdTypeRef" },
    { icon: "✏️", key: "help.sdTypeDrawing" },
    { icon: "🔗", key: "help.sdTypeConnect" },
  ];
  return (
    <div>
      <DesktopConnectDemo />
      <div style={{ marginTop: 12, fontSize: "calc(var(--font-scale, 1) * 10px)", fontWeight: 600, color: "var(--fg-primary)", marginBottom: 6 }}>
        {t("help.sdTypesTitle")}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {types.map((tp) => (
          <div key={tp.key} style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            padding: "3px 8px", borderRadius: 6,
            background: "var(--bg-hover)", border: "1px solid var(--border-light)",
            fontSize: 9, color: "var(--fg-secondary)",
          }}>
            <span>{tp.icon}</span>
            {t(tp.key as any)}
          </div>
        ))}
      </div>
    </div>
  );
}


function EditorTabsDiagram() {
  return (
    <div style={{ ...diagramBox, padding: 8 }}>
      <div style={{ ...userSelectNone }}>
        {/* Tab bar */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--border-light)", paddingBottom: 4, marginBottom: 4 }}>
          <div style={{ padding: "3px 10px", fontSize: 9, color: "var(--fg-primary)", borderBottom: "2px solid var(--accent)", marginBottom: -5 }}>App.tsx</div>
          <div style={{ padding: "3px 10px", fontSize: 9, color: "var(--fg-muted)" }}>index.ts</div>
          <div style={{ padding: "3px 10px", fontSize: 9, color: "var(--fg-muted)" }}>utils.ts</div>
        </div>
        {/* Code area */}
        <div style={{ background: "var(--bg-hover)", borderRadius: 4, padding: 8, fontFamily: "var(--font-mono)", fontSize: 9, lineHeight: 1.6, color: "var(--fg-muted)" }}>
          <div><span style={{ color: "#999" }}>01</span>  <span style={{ color: "#c678dd" }}>import</span> <span style={{ color: "#e8a840" }}>...</span></div>
          <div><span style={{ color: "#999" }}>02</span>  </div>
          <div><span style={{ color: "#999" }}>03</span>  <span style={{ color: "#c678dd" }}>export</span> <span style={{ color: "#c678dd" }}>default</span> <span style={{ color: "#61afef" }}>function</span> <span style={{ color: "#e8a840" }}>App</span>() &#123;</div>
          <div><span style={{ color: "#999" }}>04</span>  &nbsp;&nbsp;<span style={{ color: "#c678dd" }}>return</span> <span style={{ color: "#98c379" }}>&lt;div&gt;</span>...</div>
          <div><span style={{ color: "#999" }}>05</span>  &#125;</div>
        </div>
      </div>
      <div style={{ fontSize: 10, color: "var(--fg-muted)", marginTop: 6 }}>
        多标签页 · 语法高亮 (Monaco Editor) · 行号 · Ctrl+S 保存
      </div>
    </div>
  );
}

function TerminalTabsDiagram() {
  return (
    <div style={{ ...diagramBox, padding: 8 }}>
      <div style={{ ...userSelectNone }}>
        {/* Tab bar */}
        <div style={{ display: "flex", gap: 0, marginBottom: 4, borderBottom: "1px solid var(--border-light)", paddingBottom: 3 }}>
          <div style={{ padding: "2px 10px", fontSize: 9, color: "var(--fg-primary)", background: "var(--bg-surface)", borderRadius: "4px 4px 0 0" }}>bash</div>
          <div style={{ padding: "2px 10px", fontSize: 9, color: "var(--fg-muted)" }}>build</div>
          <div style={{ marginLeft: "auto", fontSize: 9, color: "var(--fg-muted)", padding: "2px 6px", cursor: "default" }}>✕</div>
        </div>
        {/* Terminal content — AI 执行的命令与输出（本面板不支持手动输入） */}
        <div style={{ background: "#1e1e1e", borderRadius: 4, padding: 8, fontFamily: "var(--font-mono)", fontSize: 9, lineHeight: 1.6, color: "#d4d4d4" }}>
          <div><span style={{ color: "#6a9955" }}>user@pc:/project$</span> npm run build</div>
          <div style={{ color: "#ce9178" }}>Building...</div>
          <div style={{ color: "#6a9955" }}>✓ Compiled in 3.2s</div>
          <div><span style={{ color: "#6a9955" }}>user@pc:/project$</span> npm test</div>
          <div style={{ color: "#6a9955" }}>✓ 12 passed</div>
        </div>
      </div>
      <div style={{ fontSize: 10, color: "var(--fg-muted)", marginTop: 6 }}>
        多标签终端 · AI 命令实时输出 · xterm.js 模拟
      </div>
    </div>
  );
}

/* ── Help item data ── */

interface HelpItem {
  icon: React.ReactNode;
  nameKey: string;
  descKey: string;
}

const TOOLBAR_ITEMS: HelpItem[] = [
  { icon: <PanelLeft size={18} />, nameKey: "toolbar.toggleLeftPanel", descKey: "help.tbToggleLeft" },
  { icon: <PanelRight size={18} />, nameKey: "toolbar.toggleRightPanel", descKey: "help.tbToggleRight" },
  { icon: <PanelBottom size={18} />, nameKey: "toolbar.toggleBottomPanel", descKey: "help.tbToggleBottom" },
  { icon: <FolderOpen size={18} />, nameKey: "workspace.title", descKey: "help.tbWorkspace" },
  { icon: <Grid3x3 size={18} />, nameKey: "toolbar.layoutMode", descKey: "help.tbLayoutMode" },
  { icon: <LayoutTemplate size={18} />, nameKey: "toolbar.layoutPicker", descKey: "help.tbLayoutPicker" },
  { icon: <RefreshCw size={18} />, nameKey: "toolbar.hardRefresh", descKey: "help.tbHardRefresh" },
  { icon: <Sun size={18} />, nameKey: "toolbar.switchToLight", descKey: "help.tbTheme" },
  { icon: <Shield size={18} />, nameKey: "permission.default", descKey: "help.tbPermission" },
  { icon: <Bot size={18} />, nameKey: "toolbar.model", descKey: "help.tbModel" },
  { icon: <User size={18} />, nameKey: "toolbar.profileManage", descKey: "help.tbProfile" },
  { icon: <Layers size={18} />, nameKey: "toolbar.panels", descKey: "help.tbPanels" },
  { icon: <Search size={18} />, nameKey: "toolbar.commandPalette", descKey: "help.tbCommandPalette" },
  { icon: <Terminal size={18} />, nameKey: "toolbar.openSystemTerminal", descKey: "help.tbTerminal" },
  { icon: <Stethoscope size={18} />, nameKey: "toolbar.diagnostics", descKey: "help.tbDiagnostics" },
  { icon: <Shield size={18} />, nameKey: "guard.title", descKey: "help.tbGuard" },
  { icon: <Download size={18} />, nameKey: "update.title", descKey: "help.tbUpdate" },
  { icon: <Bug size={18} />, nameKey: "feedback.title", descKey: "help.tbFeedback" },
  { icon: <Settings size={18} />, nameKey: "toolbar.settings", descKey: "help.tbSettings" },
];

interface PanelSection {
  icon: React.ReactNode;
  titleKey: string;
  descKey: string;
  diagram?: React.ReactNode;
}

const PANEL_SECTIONS: PanelSection[] = [
  // Chat area (messages + input combined)
  { icon: <MessageSquare size={20} />, titleKey: "panel.messages", descKey: "help.panelMessages", diagram: <ChatSplitDiagram /> },
  { icon: <Pencil size={20} />, titleKey: "panel.input", descKey: "help.panelInput" },
  { icon: <History size={20} />, titleKey: "panel.sessions", descKey: "help.panelSessions" },
  { icon: <Folder size={20} />, titleKey: "panel.files", descKey: "help.panelFiles", diagram: <FileTreeDemo /> },
  { icon: <Code2 size={20} />, titleKey: "panel.editor", descKey: "help.panelEditor", diagram: <EditorTabsDiagram /> },
  { icon: <Terminal size={20} />, titleKey: "panel.terminal", descKey: "help.panelTerminal", diagram: <TerminalTabsDiagram /> },
  { icon: <Sparkles size={20} />, titleKey: "panel.skills", descKey: "help.panelSkills" },
  { icon: <Bot size={20} />, titleKey: "panel.subagents", descKey: "help.panelSubagents" },
  { icon: <ClipboardList size={20} />, titleKey: "panel.plan", descKey: "help.panelPlan" },
  { icon: <Wrench size={20} />, titleKey: "panel.workers", descKey: "help.panelWorkers" },
  { icon: <LayoutDashboard size={20} />, titleKey: "panel.superDesktop", descKey: "help.panelSuperDesktop", diagram: <SuperDesktopAiDiagram /> },
  { icon: <Zap size={20} />, titleKey: "panel.quickPrompts", descKey: "help.panelQuickPrompts" },
  { icon: <StickyNote size={20} />, titleKey: "panel.notes", descKey: "help.panelNotes", diagram: <NotesDemo /> },
  { icon: <Stethoscope size={20} />, titleKey: "panel.diagnostics", descKey: "help.panelDiagnostics" },
];

/* ── Core flow tutorial section ── */

function CoreFlowSection() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 8 }}>
      {/* Flow 1: Agent loop */}
      <div style={flowCard}>
        <div style={flowCardHeader}>🤖 {t("help.flowAgentTitle")}</div>
        <div style={flowCardDesc}>{t("help.flowAgentIntro")}</div>
        <AgentLoopDemo />
      </div>

      {/* Flow 2: Permission dialog */}
      <div style={flowCard}>
        <div style={flowCardHeader}>🔐 {t("help.flowPermTitle")}</div>
        <div style={flowCardDesc}>{t("help.flowPermIntro")}</div>
        <PermissionDialogDemo />
      </div>

      {/* Flow 3: Workspace & sessions */}
      <div style={flowCard}>
        <div style={flowCardHeader}>📁 {t("help.flowWsTitle")}</div>
        <div style={flowCardDesc}>{t("help.flowWsIntro")}</div>
        <WorkspaceSessionDemo />
      </div>

      {/* Flow 4: Profile & models */}
      <div style={flowCard}>
        <div style={flowCardHeader}>🔑 {t("help.flowProfileTitle")}</div>
        <div style={flowCardDesc}>{t("help.flowProfileIntro")}</div>
        <ProfileFlowDemo />
      </div>

      {/* Office suite (major, near top — very useful for office workers) */}
      <div style={flowCard}>
        <div style={flowCardHeader}>📊 {t("help.officeTitle")}</div>
        <div style={flowCardDesc}>{t("help.officeIntro")}</div>
        <OfficeDemo />
      </div>

      {/* Layout system (major, standalone) */}
      <div style={flowCard}>
        <div style={flowCardHeader}>🧱 {t("help.flowLayoutTitle")}</div>
        <div style={flowCardDesc}>{t("help.flowLayoutIntro")}</div>
        <LayoutSystemDemo />
      </div>

      {/* Bonus: panel toggle + desktop connect */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={flowCard}>
          <div style={flowCardHeader}>🧱 {t("help.flowPanelTitle")}</div>
          <div style={{ fontSize: "calc(var(--font-scale, 1) * 10px)", color: "var(--fg-muted)", marginBottom: 8 }}>
            {t("help.tbToggleLeft")} · {t("help.tbToggleRight")} · {t("help.tbToggleBottom")}
          </div>
          <PanelToggleDemo />
        </div>
      </div>
    </div>
  );
}

const flowCard: React.CSSProperties = {
  padding: 16, borderRadius: 8,
  background: "var(--bg-surface)",
  border: "1px solid var(--border-light)",
};

const flowCardHeader: React.CSSProperties = {
  fontSize: "calc(var(--font-scale, 1) * 13px)",
  fontWeight: 600,
  color: "var(--fg-primary)",
  marginBottom: 6,
};

const flowCardDesc: React.CSSProperties = {
  fontSize: "calc(var(--font-scale, 1) * 11px)",
  color: "var(--fg-muted)",
  lineHeight: 1.6,
  marginBottom: 12,
};

/* ── Main component ── */

export default function HelpPanel() {
  return (
    <div style={{
      padding: "20px 24px 32px",
      overflow: "auto",
      height: "100%",
      fontFamily: "var(--font-sans)",
    }}>
      {/* 首次提示 */}
      <div style={{
        padding: "10px 14px",
        borderRadius: 8,
        background: "var(--accent-subtle)",
        color: "var(--accent)",
        fontSize: "calc(var(--font-scale, 1) * 12px)",
        fontWeight: 500,
        marginBottom: 4,
      }}>
        {t("help.firstLaunchTip")}
      </div>

      {/* ═══════ 核心流程教学 ═══════ */}
      <div style={sectionHeader}>{t("help.coreTitle")}</div>
      <div style={{ ...desc, marginBottom: 16, color: "var(--fg-secondary)" }}>{t("help.coreIntro")}</div>

      <CoreFlowSection />

      {/* ═══════ 布局总览 ═══════ */}
      <div style={sectionHeader}>{t("help.layoutTitle")}</div>
      <LayoutDiagram />

      {/* ═══════ 工具栏 ═══════ */}
      <div style={sectionHeader}>{t("help.toolbarSection")}</div>
      <div style={toolbarGrid}>
        {TOOLBAR_ITEMS.map((item) => (
          <div key={item.descKey} style={tbCard}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 30, height: 30, borderRadius: 6,
              background: "var(--bg-hover)", color: "var(--fg-muted)", flexShrink: 0,
            }}>
              {item.icon}
            </div>
            <div>
              <div style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", fontWeight: 600, color: "var(--fg-primary)", marginBottom: 2 }}>
                {t(item.nameKey as any)}
              </div>
              <div style={{ fontSize: "calc(var(--font-scale, 1) * 10px)", color: "var(--fg-muted)", lineHeight: 1.45 }}>
                {t(item.descKey as any)}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ═══════ 面板详情 ═══════ */}
      <div style={sectionHeader}>{t("help.panelsSection")}</div>
      {PANEL_SECTIONS.map((panel) => (
        <div key={panel.descKey} style={{
          marginBottom: 14,
          padding: 16,
          borderRadius: 8,
          background: "var(--bg-surface)",
          border: "1px solid var(--border-light)",
        }}>
          <div style={subHeader}>
            <span style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 34, height: 34, borderRadius: 8,
              background: "var(--accent-subtle)", color: "var(--accent)",
            }}>
              {panel.icon}
            </span>
            <span>{t(panel.titleKey as any)}</span>
          </div>
          <div style={desc}>{t(panel.descKey as any)}</div>
          {panel.diagram}
        </div>
      ))}
    </div>
  );
}
