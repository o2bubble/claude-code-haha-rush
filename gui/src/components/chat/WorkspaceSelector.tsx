import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { t } from "../../i18n";

interface WorkspaceSelectorProps {
  workspaces: string[];
  activeWorkDir: string;
  onLaunch: (workDir: string, workspaceList: string[]) => void;
}

async function pickFolder(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({ directory: true, multiple: false });
    return (result as string) ?? null;
  } catch {
    return null;
  }
}

function workspaceBasename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/* ── 一次性注入启动器样式：keyframes + 容器查询响应式（不修改 tokens.css） ── */
let launcherStylesInjected = false;
function ensureLauncherStyles() {
  if (launcherStylesInjected) return;
  launcherStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.ws-launcher { container-type: inline-size; position: absolute; inset: 0; z-index: 1000; overflow: hidden; background: var(--bg-root); color: var(--fg-primary); font-family: var(--font-sans); display: flex; }
@keyframes ws-drift1 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(46px,34px) scale(1.07); } }
@keyframes ws-drift2 { 0%,100% { transform: translate(0,0) scale(1.05); } 50% { transform: translate(-38px,-30px) scale(1); } }
@keyframes ws-blink { 50% { opacity: 0; } }
@keyframes ws-dot { 0%,60%,100% { opacity:.35; transform:none; } 30% { opacity:1; transform: translateY(-2px); } }
.ws-bg { position: absolute; inset: 0; pointer-events: none; }
.ws-bg-dots { position: absolute; inset: 0; background-image: radial-gradient(var(--grid-dot) 1px, transparent 1.2px); background-size: 26px 26px; opacity: .5; }
.ws-glow1 { position: absolute; width: 540px; height: 540px; left: -180px; top: -200px; border-radius: 50%; filter: blur(90px); background: radial-gradient(circle, var(--accent-glow), transparent 66%); animation: ws-drift1 20s ease-in-out infinite; }
.ws-glow2 { position: absolute; width: 480px; height: 480px; right: -160px; bottom: -180px; border-radius: 50%; filter: blur(90px); background: radial-gradient(circle, var(--accent-glow), transparent 66%); animation: ws-drift2 26s ease-in-out infinite; }

.ws-rail { position: relative; z-index: 1; width: 37%; min-width: 330px; padding: 30px 30px 24px; display: flex; flex-direction: column; gap: 20px; }
.ws-brand { display: flex; align-items: center; gap: 12px; }
.ws-logo { width: 42px; height: 42px; border-radius: 11px; background: var(--accent); color: var(--fg-inverse); display: grid; place-items: center; box-shadow: var(--shadow-md); flex-shrink: 0; }
.ws-logo svg { width: 21px; height: 21px; }
.ws-word { font-size: calc(var(--font-scale, 1) * 16px); font-weight: 650; letter-spacing: -.2px; }
.ws-ver { font-size: calc(var(--font-scale, 1) * 11px); color: var(--fg-secondary); margin-top: 1px; }

.ws-chat { border: 1px solid var(--border-light); border-radius: 12px; background: var(--bg-surface); box-shadow: var(--shadow-md); overflow: hidden; }
.ws-chat-bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border-light); background: var(--bg-hover); font-size: calc(var(--font-scale, 1) * 10.5px); color: var(--fg-secondary); font-weight: 600; letter-spacing: .2px; }
.ws-chat-bm { width: 18px; height: 18px; border-radius: 6px; background: var(--accent); color: var(--fg-inverse); display: grid; place-items: center; flex-shrink: 0; }
.ws-chat-bm svg { width: 10px; height: 10px; }
.ws-chat-body { padding: 12px 12px 14px; display: flex; flex-direction: column; gap: 8px; min-height: 104px; }
.ws-msg { font-size: calc(var(--font-scale, 1) * 11px); line-height: 1.55; }
.ws-user { align-self: flex-end; max-width: 86%; background: var(--accent-subtle); color: var(--fg-primary); border: 1px solid var(--accent-glow); border-radius: 10px 10px 3px 10px; padding: 7px 11px; }
.ws-ai { align-self: flex-start; max-width: 94%; display: flex; gap: 7px; align-items: flex-start; }
.ws-ai-mark { flex-shrink: 0; width: 20px; height: 20px; border-radius: 6px; background: var(--accent-subtle); color: var(--accent); display: grid; place-items: center; margin-top: 1px; }
.ws-ai-mark svg { width: 11px; height: 11px; }
.ws-ai-bubble { background: var(--bg-root); border: 1px solid var(--border-light); border-radius: 3px 10px 10px 10px; padding: 7px 11px; color: var(--fg-primary); }
.ws-typing { display: inline-flex; gap: 3px; align-items: center; height: 16px; }
.ws-typing i { width: 4px; height: 4px; border-radius: 50%; background: var(--fg-muted); animation: ws-dot 1.2s infinite; }
.ws-typing i:nth-child(2) { animation-delay: .15s; }
.ws-typing i:nth-child(3) { animation-delay: .3s; }
.ws-cur { display: inline-block; width: 6px; height: 11px; background: var(--accent); vertical-align: -2px; margin-left: 2px; animation: ws-blink 1s steps(1) infinite; }

.ws-status { border: 1px solid var(--border-light); border-radius: 10px; background: var(--bg-surface); padding: 11px 13px; }
.ws-status-hd { font-size: calc(var(--font-scale, 1) * 10px); font-weight: 600; color: var(--fg-muted); letter-spacing: .3px; margin-bottom: 9px; line-height: 1.5; }
.ws-status-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.ws-status-row + .ws-status-row { margin-top: 8px; }
.ws-status-t { min-width: 0; }
.ws-status-l { font-size: calc(var(--font-scale, 1) * 11.5px); color: var(--fg-primary); font-weight: 500; }
.ws-status-s { font-size: calc(var(--font-scale, 1) * 10px); color: var(--fg-secondary); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-badge { flex-shrink: 0; font-size: calc(var(--font-scale, 1) * 10px); font-weight: 600; color: var(--fg-secondary); background: var(--bg-hover); border: 1px solid var(--border-light); padding: 1px 7px; border-radius: 8px; }

.ws-tips { margin-top: auto; font-size: calc(var(--font-scale, 1) * 11.5px); color: var(--fg-secondary); line-height: 1.7; padding: 0 2px; }
.ws-tips b { color: var(--fg-primary); font-weight: 600; }

.ws-main { position: relative; z-index: 1; flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 30px 34px 24px; }
.ws-hd { margin-bottom: 16px; }
.ws-hd h1 { margin: 0; font-size: calc(var(--font-scale, 1) * 22px); font-weight: 650; letter-spacing: -.3px; }
.ws-hd p { margin: 4px 0 0; font-size: calc(var(--font-scale, 1) * 12.5px); color: var(--fg-secondary); }
.ws-search { margin-bottom: 16px; max-width: 520px; display: flex; align-items: center; gap: 8px; border: 1px solid var(--border-light); background: var(--bg-surface); border-radius: 8px; padding: 9px 12px; transition: border-color .14s ease, box-shadow .14s ease; }
.ws-search:focus-within { border-color: var(--border-focus); box-shadow: 0 0 0 2px var(--accent-glow); }
.ws-search svg { width: 15px; height: 15px; color: var(--fg-muted); flex-shrink: 0; }
.ws-search input { flex: 1; border: none; background: transparent; color: var(--fg-primary); font-family: inherit; font-size: calc(var(--font-scale, 1) * 12.5px); outline: none; }
.ws-search input::placeholder { color: var(--fg-muted); }

.ws-cards { flex: 1; min-height: 0; overflow: auto; padding: 2px 2px 16px; }
.ws-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; align-content: start; }
.ws-card { border: 1.5px solid var(--border-light); background: var(--bg-surface); border-radius: 12px; padding: 15px 15px 13px; cursor: pointer; position: relative; transition: border-color .14s ease, box-shadow .14s ease, background .14s ease, transform .14s ease; }
.ws-card:hover { border-color: var(--border-focus); box-shadow: var(--shadow-md); background: var(--bg-root); transform: translateY(-1px); }
.ws-card.sel { border-color: var(--accent); background: var(--accent-subtle); }
.ws-card-top { display: flex; align-items: center; gap: 10px; }
.ws-card-ico { width: 34px; height: 34px; border-radius: 9px; background: var(--accent-subtle); color: var(--accent); display: grid; place-items: center; flex-shrink: 0; }
.ws-card-ico svg { width: 18px; height: 18px; }
.ws-card-name { flex: 1; min-width: 0; font-size: calc(var(--font-scale, 1) * 13.5px); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-card-path { font-family: var(--font-mono); font-size: calc(var(--font-scale, 1) * 10.5px); color: var(--fg-secondary); margin-top: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-badge-now { flex-shrink: 0; font-size: calc(var(--font-scale, 1) * 10.5px); font-weight: 600; color: var(--accent); background: var(--accent-subtle); padding: 1px 8px; border-radius: 10px; }
.ws-card-del { position: absolute; top: 10px; right: 10px; border: none; background: transparent; color: var(--fg-muted); cursor: pointer; padding: 5px; border-radius: 6px; opacity: 0; transition: opacity .14s ease, color .14s ease, background .14s ease; }
.ws-card:hover .ws-card-del, .ws-card.sel .ws-card-del { opacity: 1; }
.ws-card-del:focus-visible { opacity: 1; }
.ws-card-del:hover { color: var(--semantic-error); background: var(--semantic-error-subtle); }
.ws-card-del svg { width: 13px; height: 13px; }
.ws-add-card { border: 1.5px dashed var(--border-medium); border-radius: 12px; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--fg-secondary); font-size: calc(var(--font-scale, 1) * 13px); cursor: pointer; min-height: 96px; transition: border-color .14s ease, color .14s ease, background .14s ease; }
.ws-add-card:hover { border-color: var(--border-focus); color: var(--accent); background: var(--bg-hover); }
.ws-add-card svg { width: 16px; height: 16px; }
.ws-empty { grid-column: 1 / -1; text-align: center; color: var(--fg-muted); font-size: calc(var(--font-scale, 1) * 12px); padding: 28px 0; }

.ws-addpanel { border: 1.5px solid var(--border-focus); border-radius: 12px; padding: 15px; background: var(--bg-root); box-shadow: var(--shadow-md); max-width: 520px; }
.ws-addpanel label { display: block; font-size: calc(var(--font-scale, 1) * 11px); font-weight: 600; color: var(--fg-secondary); margin-bottom: 6px; }
.ws-addpanel-row { display: flex; gap: 8px; }
.ws-addpanel input { flex: 1; min-width: 0; border: 1px solid var(--border-medium); border-radius: 7px; padding: 9px 11px; font-family: var(--font-mono); font-size: calc(var(--font-scale, 1) * 11px); background: var(--bg-surface); color: var(--fg-primary); outline: none; }
.ws-addpanel input:focus { border-color: var(--border-focus); }
.ws-addpanel-acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }

.ws-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; border-top: 1px solid var(--border-light); }
.ws-foot-pick { font-size: calc(var(--font-scale, 1) * 11.5px); color: var(--fg-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-foot-pick b { color: var(--fg-primary); font-weight: 600; }
.ws-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 34px; padding: 0 16px; border-radius: 7px; font-family: inherit; font-size: calc(var(--font-scale, 1) * 12.5px); font-weight: 600; cursor: pointer; border: 1px solid transparent; transition: all .14s ease; white-space: nowrap; }
.ws-btn.primary { background: var(--accent); color: var(--fg-inverse); }
.ws-btn.primary:hover:not(:disabled) { filter: brightness(1.08); box-shadow: var(--shadow-sm); }
.ws-btn.primary:disabled { opacity: .45; cursor: default; }
.ws-btn.ghost { background: transparent; color: var(--fg-secondary); border-color: var(--border-light); }
.ws-btn.ghost:hover { border-color: var(--border-focus); color: var(--fg-primary); background: var(--bg-hover); }
.ws-btn.sm { height: 30px; padding: 0 12px; font-size: calc(var(--font-scale, 1) * 11.5px); }
.ws-foot .ws-btn { height: 38px; padding: 0 22px; }

@container (max-width: 980px) {
  .ws-rail { display: none; }
  .ws-main { padding: 24px 26px 20px; }
  .ws-main .ws-hd h1 { font-size: calc(var(--font-scale, 1) * 19px); }
  .ws-search { max-width: none; }
}
@container (max-width: 640px) {
  .ws-grid { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .ws-glow1, .ws-glow2, .ws-cur, .ws-typing i { animation: none; }
}
`;
  document.head.appendChild(style);
}

/* ── 图标 ── */
function Svg({ children, width = 1.6 }: { children: ReactNode; width?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" style={{ width: "1em", height: "1em", display: "block" }}>
      {children}
    </svg>
  );
}
const FolderIcon = () => (
  <Svg>
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.06c.5 0 .96.24 1.25.62l.9 1.14c.29.37.75.61 1.24.61H19.5A1.5 1.5 0 0 1 21 8.87v8.63a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11Z" />
  </Svg>
);
const SearchIcon = () => (
  <Svg>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-3.1-3.1" />
  </Svg>
);
const PlusIcon = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
const TrashIcon = () => (
  <Svg>
    <path d="M4 7h16M10 11v5M14 11v5M9 7l.5-2.5A1.5 1.5 0 0 1 11 3h2a1.5 1.5 0 0 1 1.5 1.5L15 7M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7" />
  </Svg>
);
const PromptIcon = () => (
  <Svg width={2}>
    <path d="M5 6.5 9.5 12 5 17.5" />
    <path d="M12 18h7" />
  </Svg>
);

/* ── 对话预览：用户 → AI 思考 → AI 逐字回复，循环 ── */
function ChatPreview() {
  const [items, setItems] = useState<Array<{ role: "user" | "ai"; text?: string; thinking?: boolean }>>([]);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const userMsg = t("workspace.chatUser");
    const answer = t("workspace.chatAnswer");
    let cancelled = false;
    let timer: number | undefined;
    let charIdx = 0;

    const run = (delay: number, fn: () => void) => {
      timer = window.setTimeout(() => { if (!cancelled) fn(); }, delay);
    };
    const showUser = () => {
      setItems([{ role: "user", text: userMsg }]);
      setTyping(false);
      run(700, showThink);
    };
    const showThink = () => {
      setItems([{ role: "user", text: userMsg }, { role: "ai", thinking: true }]);
      setTyping(false);
      run(1000, showAnswer);
    };
    const showAnswer = () => {
      if (reduced) {
        setItems([{ role: "user", text: userMsg }, { role: "ai", text: answer }]);
        setTyping(false);
        run(3800, reset);
        return;
      }
      charIdx++;
      const done = charIdx >= answer.length;
      setTyping(!done);
      setItems([{ role: "user", text: userMsg }, { role: "ai", text: answer.slice(0, charIdx) }]);
      run(done ? 3600 : 16, done ? reset : showAnswer);
    };
    const reset = () => {
      setItems([]);
      setTyping(false);
      run(1400, showUser);
    };

    run(250, showUser);
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, []);

  return (
    <div className="ws-chat">
      <div className="ws-chat-bar">
        <span className="ws-chat-bm"><PromptIcon /></span>
        <span>{t("workspace.chatPreview")}</span>
      </div>
      <div className="ws-chat-body">
        {items.map((it, i) =>
          it.role === "user" ? (
            <div key={i} className="ws-msg ws-user">{it.text}</div>
          ) : (
            <div key={i} className="ws-msg ws-ai">
              <span className="ws-ai-mark"><PromptIcon /></span>
              <span className="ws-ai-bubble">
                {it.thinking
                  ? <span className="ws-typing"><i /><i /><i /></span>
                  : <>{it.text}{typing && <span className="ws-cur" />}</>}
              </span>
            </div>
          )
        )}
      </div>
    </div>
  );
}

/* ── 主组件 ── */
export function WorkspaceSelector({ workspaces, activeWorkDir, onLaunch }: WorkspaceSelectorProps) {
  ensureLauncherStyles();
  const [list, setList] = useState<string[]>(workspaces);
  const [selected, setSelected] = useState<string>(
    activeWorkDir && workspaces.includes(activeWorkDir) ? activeWorkDir : (workspaces[0] || "")
  );
  const [query, setQuery] = useState("");
  const [newPath, setNewPath] = useState("");
  const [adding, setAdding] = useState(false);
  const [launching, setLaunching] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding && addInputRef.current) addInputRef.current.focus();
  }, [adding]);

  const q = query.trim().toLowerCase();
  const rows = list.filter((p) => (workspaceBasename(p) + " " + p).toLowerCase().includes(q));
  const selName = selected ? workspaceBasename(selected) : "";

  const handleAdd = () => {
    const trimmed = newPath.trim();
    if (!trimmed) return;
    if (!list.includes(trimmed)) setList((prev) => [...prev, trimmed]);
    setSelected(trimmed);
    setNewPath("");
    setAdding(false);
  };

  const handleBrowse = async () => {
    const dir = await pickFolder();
    if (dir) setNewPath(dir);
  };

  const handleDelete = (path: string) => {
    const next = list.filter((p) => p !== path);
    setList(next);
    if (selected === path) setSelected(next[0] || "");
  };

  const handleLaunch = async () => {
    if (!selected || launching) return;
    setLaunching(true);
    await onLaunch(selected, list);
  };

  const handleAddKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); handleAdd(); }
    else if (e.key === "Escape") { setAdding(false); setNewPath(""); }
  };

  return (
    <div className="ws-launcher" data-od-id="workspace-launcher">
      <div className="ws-bg">
        <div className="ws-bg-dots" />
        <div className="ws-glow1" />
        <div className="ws-glow2" />
      </div>

      {/* 品牌语境面板 */}
      <div className="ws-rail" data-od-id="launcher-brand-rail">
        <div className="ws-brand">
          <span className="ws-logo"><PromptIcon /></span>
          <div>
            <div className="ws-word">Claude Code Desktop</div>
            <div className="ws-ver">{t("workspace.previewBadge")}</div>
          </div>
        </div>
        <ChatPreview />
        <div className="ws-status">
          <div className="ws-status-hd">{t("workspace.connTitle")}</div>
          <div className="ws-status-row">
            <div className="ws-status-t">
              <div className="ws-status-l">{t("workspace.connServer")}</div>
              <div className="ws-status-s">{t("workspace.connServerSub")}</div>
            </div>
            <span className="ws-badge">{t("workspace.connServerBadge")}</span>
          </div>
          <div className="ws-status-row">
            <div className="ws-status-t">
              <div className="ws-status-l">{t("workspace.connBackend")}</div>
              <div className="ws-status-s">{t("workspace.connBackendSub")}</div>
            </div>
            <span className="ws-badge">{t("workspace.connBackendBadge")}</span>
          </div>
          <div className="ws-status-row">
            <div className="ws-status-t">
              <div className="ws-status-l">{t("workspace.connLocal")}</div>
              <div className="ws-status-s">{t("workspace.connLocalSub")}</div>
            </div>
            <span className="ws-badge">{t("workspace.connLocalBadge")}</span>
          </div>
        </div>
        <div className="ws-tips">{t("workspace.tipShortcuts")}</div>
      </div>

      {/* 主区 */}
      <div className="ws-main" data-od-id="launcher-main">
        <div className="ws-hd">
          <h1>{t("workspace.title")}</h1>
          <p>{t("workspace.subtitle")}</p>
        </div>
        <div className="ws-search">
          <SearchIcon />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("workspace.searchPlaceholder")}
            spellCheck={false}
          />
        </div>
        <div className="ws-cards">
          {adding ? (
            <div className="ws-addpanel">
              <label>{t("workspace.newPath")}</label>
              <div className="ws-addpanel-row">
                <input
                  ref={addInputRef}
                  type="text"
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  onKeyDown={handleAddKeyDown}
                  placeholder="C:\\Users\\SZH\\my-workspace"
                />
                <button type="button" className="ws-btn ghost sm" onClick={handleBrowse}>
                  {t("workspace.browse")}
                </button>
              </div>
              <div className="ws-addpanel-acts">
                <button type="button" className="ws-btn ghost sm" onClick={() => { setAdding(false); setNewPath(""); }}>
                  {t("workspace.cancel")}
                </button>
                <button type="button" className="ws-btn primary sm" onClick={handleAdd} disabled={!newPath.trim()}>
                  {t("workspace.addWorkspace")}
                </button>
              </div>
            </div>
          ) : (
            <div className="ws-grid">
              {rows.map((p) => {
                const isSel = p === selected;
                const isActive = p === activeWorkDir;
                return (
                  <div key={p} className={"ws-card" + (isSel ? " sel" : "")} onClick={() => setSelected(p)} onDoubleClick={() => { setSelected(p); void handleLaunch(); }}>
                    <button
                      type="button"
                      className="ws-card-del"
                      title={t("workspace.delete")}
                      onClick={(e) => { e.stopPropagation(); handleDelete(p); }}
                    >
                      <TrashIcon />
                    </button>
                    <div className="ws-card-top">
                      <span className="ws-card-ico"><FolderIcon /></span>
                      <span className="ws-card-name">{workspaceBasename(p)}</span>
                      {isActive && <span className="ws-badge-now">{t("workspace.currentBadge")}</span>}
                    </div>
                    <div className="ws-card-path">{p}</div>
                  </div>
                );
              })}
              <button type="button" className="ws-add-card" onClick={() => { setAdding(true); setNewPath(""); }}>
                <PlusIcon /> {t("workspace.newCard")}
              </button>
              {rows.length === 0 && (
                <div className="ws-empty">{list.length === 0 ? t("workspace.noWorkspaces") : t("workspace.noMatch")}</div>
              )}
            </div>
          )}
        </div>
        <div className="ws-foot">
          <span className="ws-foot-pick">
            {selName ? t("workspace.launching", { name: selName }) : t("workspace.selectWorkspace")}
          </span>
          <button type="button" className="ws-btn primary" onClick={handleLaunch} disabled={!selected || launching}>
            {launching ? "..." : t("workspace.launch")}
          </button>
        </div>
      </div>
    </div>
  );
}
