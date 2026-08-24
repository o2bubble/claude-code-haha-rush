import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search, Filter, ArrowLeft, X, ChevronRight, ChevronDown } from "lucide-react";
import { t } from "../../i18n";
import { addStatusMessage } from "../../stores/statusMsgStore";
import { useEventHandler } from "../../services/useService";
import { Events } from "../../services/events";
import { eventBus } from "../../services/serviceBus";
import { showCtxMenu, type ContextMenuItem } from "../ContextMenu";
import { NoteEditor, type NoteData, type SaveState } from "./NoteEditor";

// ─── Types ───

interface NoteSummary {
  id: string;
  title: string;
  scope: string;
  tags: string[];
  snippet?: string;
  updated_at: string;
}

interface ScopeNode { path: string; label: string; count: number; children: ScopeNode[]; }

let _invoke: any = null;
async function getInvoke() {
  if (_invoke) return _invoke;
  try { _invoke = (await import("@tauri-apps/api/core")).invoke; } catch { _invoke = null; }
  return _invoke;
}
async function invoke<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const inv = await getInvoke();
  if (!inv) throw new Error("Tauri IPC not available");
  return inv(cmd, args);
}

// ─── Scope tree ───

function buildScopeTree(notes: NoteSummary[]): ScopeNode[] {
  const scopeCounts: Record<string, number> = {};
  for (const n of notes) {
    scopeCounts[n.scope] = (scopeCounts[n.scope] || 0) + 1;
    const parts = n.scope.split(":");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join(":");
      scopeCounts[parent] = (scopeCounts[parent] || 0) + 1;
    }
  }
  const nodes: Record<string, ScopeNode> = {};
  const roots: ScopeNode[] = [];
  for (const [scope, count] of Object.entries(scopeCounts)) {
    const parts = scope.split(":");
    nodes[scope] = { path: scope, label: parts[parts.length - 1], count, children: [] };
  }
  for (const [scope, node] of Object.entries(nodes)) {
    const lastColon = scope.lastIndexOf(":");
    if (lastColon < 0) roots.push(node);
    else {
      const parent = scope.slice(0, lastColon);
      if (nodes[parent]) nodes[parent].children.push(node);
      else roots.push(node);
    }
  }
  roots.sort((a, b) => a.label.localeCompare(b.label));
  const sortChildren = (ns: ScopeNode[]) => { ns.sort((a, b) => a.label.localeCompare(b.label)); ns.forEach((n) => sortChildren(n.children)); };
  sortChildren(roots);
  return roots;
}

function relTime(iso: string): string {
  if (!iso) return "";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso.slice(0, 10);
  const diff = Date.now() - time;
  const min = Math.floor(diff / 60000);
  if (min < 1) return t("notes.justNow");
  if (min < 60) return t("notes.minAgo", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("notes.hourAgo", { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return t("notes.dayAgo", { n: day });
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ─── 一次性注入样式（不修改 tokens.css） ───

let notesStylesInjected = false;
function ensureNotesStyles() {
  if (notesStylesInjected) return;
  notesStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.np-root { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; font-family: var(--font-sans); font-size: 12px; color: var(--fg-primary); background: var(--bg-root); }
.np-toolbar { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-bottom: 1px solid var(--border-light); flex-shrink: 0; }
.np-btn { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 10px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--fg-secondary); font-family: inherit; font-size: 11.5px; cursor: pointer; white-space: nowrap; transition: all .14s ease; }
.np-btn:hover { background: var(--bg-hover); color: var(--fg-primary); }
.np-btn.primary { background: var(--accent); color: var(--fg-inverse); }
.np-btn.primary:hover:not(:disabled) { filter: brightness(1.08); box-shadow: var(--shadow-sm); }
.np-btn.ghost { border-color: var(--border-light); }
.np-btn.ghost:hover { border-color: var(--border-focus); }
.np-btn svg { width: 14px; height: 14px; }
.np-search { flex: 1; min-width: 60px; max-width: 380px; display: flex; align-items: center; gap: 6px; border: 1px solid var(--border-light); background: var(--bg-surface); border-radius: 6px; padding: 5px 9px; transition: border-color .14s ease, box-shadow .14s ease; }
.np-search:focus-within { border-color: var(--border-focus); box-shadow: 0 0 0 2px var(--accent-glow); }
.np-search svg { width: 13px; height: 13px; color: var(--fg-muted); flex-shrink: 0; }
.np-search input { flex: 1; border: none; background: transparent; color: var(--fg-primary); font-family: inherit; font-size: 12px; outline: none; min-width: 0; }
.np-search input::placeholder { color: var(--fg-muted); }
.np-filter-wrap { position: relative; }
.np-filter-dot { position: absolute; top: 2px; right: 3px; width: 7px; height: 7px; border-radius: 50%; background: var(--semantic-warning); border: 1.5px solid var(--bg-surface); }
.np-filter-pop { position: absolute; top: calc(100% + 6px); left: 0; z-index: 60; width: 280px; background: var(--bg-surface); border: 1px solid var(--border-light); border-radius: 10px; box-shadow: var(--shadow-lg); padding: 10px; }
.np-filter-pop.fixed { position: fixed; z-index: 1000; }
.np-pop-sec + .np-pop-sec { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border-light); }
.np-pop-hd { font-size: 10px; font-weight: 700; color: var(--fg-muted); letter-spacing: .5px; text-transform: uppercase; margin-bottom: 6px; }
.np-pop-tree { max-height: 150px; overflow: auto; }
.np-pop-node { display: flex; align-items: center; gap: 4px; padding: 4px 6px; border-radius: 6px; cursor: pointer; font-size: 11.5px; color: var(--fg-primary); user-select: none; }
.np-pop-node:hover { background: var(--bg-hover); }
.np-pop-node.active { background: var(--accent-subtle); color: var(--accent); font-weight: 600; }
.np-pop-node .tri { width: 12px; height: 12px; flex-shrink: 0; display: grid; place-items: center; color: var(--fg-muted); }
.np-pop-node .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.np-pop-node .cnt { font-size: 10px; color: var(--fg-muted); font-family: var(--font-mono); }
.np-pop-tags { display: flex; flex-wrap: wrap; gap: 5px; max-height: 90px; overflow: auto; }
.np-pop-tag { font-size: 10.5px; padding: 2px 8px; border-radius: 10px; background: var(--bg-hover); color: var(--fg-secondary); cursor: pointer; border: 1px solid transparent; }
.np-pop-tag:hover { color: var(--fg-primary); }
.np-pop-tag.active { background: var(--accent-subtle); color: var(--accent); border-color: var(--accent); font-weight: 600; }
.np-pop-sort { display: flex; gap: 6px; }
.np-pop-sort button { flex: 1; font-size: 11px; padding: 5px 0; border-radius: 6px; border: 1px solid var(--border-light); background: transparent; color: var(--fg-secondary); cursor: pointer; }
.np-pop-sort button.active { border-color: var(--accent); background: var(--accent-subtle); color: var(--accent); font-weight: 600; }

.np-body { flex: 1; min-height: 0; display: flex; }
.np-list { width: 300px; flex-shrink: 0; border-right: 1px solid var(--border-light); display: flex; flex-direction: column; min-height: 0; }
.np-editor { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.np-filter-chips { display: flex; flex-wrap: wrap; gap: 5px; padding: 6px 10px; border-bottom: 1px solid var(--border-light); }
.np-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 600; color: var(--accent); background: var(--accent-subtle); border: 1px solid var(--accent-glow); border-radius: 12px; padding: 2px 6px 2px 9px; }
.np-chip button { border: none; background: transparent; color: var(--accent); cursor: pointer; padding: 0 2px; display: grid; place-items: center; }
.np-chip button svg { width: 9px; height: 9px; }
.np-list-hd { display: flex; align-items: center; justify-content: space-between; padding: 7px 12px 5px; }
.np-list-hd .tt { font-size: 10.5px; font-weight: 700; color: var(--fg-muted); letter-spacing: .5px; text-transform: uppercase; }
.np-list-hd .n { font-size: 10.5px; color: var(--fg-muted); }
.np-rows { flex: 1; overflow: auto; }
.np-row { position: relative; display: flex; align-items: flex-start; gap: 8px; padding: 9px 12px; cursor: pointer; border-bottom: 1px solid var(--border-light); transition: background .12s ease; }
.np-row:hover { background: var(--bg-hover); }
.np-row.sel { background: var(--accent-subtle); }
.np-row.sel::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--accent); }
.np-row .cb { width: 14px; height: 14px; margin-top: 2px; flex-shrink: 0; accent-color: var(--accent); opacity: 0; transition: opacity .12s ease; cursor: pointer; }
.np-row:hover .cb, .np-root.multi .np-row .cb { opacity: 1; }
.np-row .main { flex: 1; min-width: 0; }
.np-row .tt { font-size: 12.5px; font-weight: 600; color: var(--fg-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.np-row .snip { font-size: 11px; color: var(--fg-secondary); margin-top: 3px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.np-row .meta { display: flex; align-items: center; gap: 4px; margin-top: 5px; flex-wrap: wrap; }
.np-scope-chip { font-size: 9px; padding: 1px 6px; border-radius: 4px; background: var(--accent-subtle); color: var(--accent); font-weight: 600; }
.np-tag-sm { font-size: 9px; padding: 1px 5px; border-radius: 4px; background: var(--bg-hover); color: var(--fg-secondary); }
.np-time { font-size: 10px; color: var(--fg-muted); }
.np-empty { padding: 32px 16px; text-align: center; color: var(--fg-muted); font-size: 12px; }
.np-batch { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-top: 1px solid var(--accent); background: var(--accent-subtle); position: sticky; bottom: 0; }
.np-batch .cnt { font-size: 11.5px; font-weight: 600; flex: 1; }
.np-batch button { height: 26px; padding: 0 10px; font-size: 11px; border-radius: 5px; border: 1px solid var(--border-light); background: transparent; color: var(--fg-secondary); cursor: pointer; }
.np-batch button.danger { border-color: var(--semantic-error); color: var(--semantic-error); }
.np-batch button.danger:hover { background: var(--semantic-error-subtle); }
.np-editor-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--fg-muted); font-size: 13px; }

/* 窄屏单栏 */
.np-root.narrow .np-body { display: block; }
.np-root.narrow .np-list { width: 100%; height: 100%; border-right: none; }
.np-root.narrow .np-editor { display: none; }
.np-root.narrow.editor-open .np-list { display: none; }
.np-root.narrow.editor-open .np-editor { display: flex; }
.np-root.narrow .np-row .snip { display: none; }
.np-root.narrow .np-search { max-width: none; }
.np-root.mini .np-tag-sm { display: none; }

/* ── NoteEditor ── */
.ne-root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.ne-title { font-size: calc(var(--font-scale, 1) * 16px); font-family: inherit; font-weight: 600; padding: 9px 14px; border: none; border-bottom: 1px solid var(--border-light); outline: none; background: transparent; color: var(--fg-primary); }
.ne-meta { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; padding: 6px 12px; border-bottom: 1px solid var(--border-light); }
.ne-scope { position: relative; }
.ne-scope-input { font-size: 10px; padding: 2px 6px; border: 1px dashed var(--border-medium); border-radius: 4px; outline: none; width: 96px; font-family: var(--font-mono); color: var(--accent); background: var(--bg-surface); }
.ne-scope-input:focus { border-color: var(--border-focus); }
.ne-scope-pop { position: absolute; top: calc(100% + 4px); left: 0; z-index: 70; min-width: 180px; background: var(--bg-surface); border: 1px solid var(--border-light); border-radius: 8px; box-shadow: var(--shadow-md); padding: 4px; }
.ne-scope-opt { padding: 5px 8px; border-radius: 5px; font-size: 11px; font-family: var(--font-mono); color: var(--fg-primary); cursor: pointer; }
.ne-scope-opt:hover { background: var(--bg-hover); }
.ne-scope-opt.new { color: var(--accent); }
.ne-tag { display: inline-flex; align-items: center; gap: 2px; padding: 2px 6px; font-size: 10px; border-radius: 4px; background: var(--bg-active); border: 1px solid var(--border-medium); color: var(--accent); }
.ne-tag-x { border: none; background: none; cursor: pointer; color: var(--fg-muted); padding: 0; display: grid; place-items: center; }
.ne-tag-x:hover { color: var(--semantic-error); }
.ne-tag-x svg { width: 10px; height: 10px; }
.ne-tag-input { width: 56px; font-size: 10px; font-family: inherit; padding: 2px 4px; border: 1px dashed var(--border-medium); border-radius: 4px; outline: none; background: transparent; }
.ne-toolbar { display: flex; align-items: center; gap: 1px; padding: 4px 8px; border-bottom: 1px solid var(--border-light); background: var(--bg-surface); flex-shrink: 0; }
.ne-sep { width: 1px; height: 16px; background: var(--border-light); margin: 0 4px; }
.ne-tb { width: 26px; height: 24px; border-radius: 5px; border: none; background: transparent; color: var(--fg-secondary); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; transition: all .12s ease; }
.ne-tb:hover { background: var(--bg-hover); color: var(--fg-primary); }
.ne-mode { font-family: var(--font-mono); font-weight: 700; font-size: 10px; width: 30px; }
.ne-mode.on { color: var(--accent); background: var(--accent-subtle); }
.ne-tb-spacer { flex: 1; }
.ne-overflow { position: relative; }
.ne-overflow-pop { position: absolute; top: calc(100% + 4px); right: 0; z-index: 70; min-width: 160px; background: var(--bg-surface); border: 1px solid var(--border-light); border-radius: 8px; box-shadow: var(--shadow-md); padding: 4px; }
.ne-overflow-it { display: flex; align-items: center; gap: 8px; padding: 6px 9px; border-radius: 5px; font-size: 11.5px; color: var(--fg-primary); cursor: pointer; }
.ne-overflow-it:hover { background: var(--bg-hover); }
.ne-overflow-it svg { width: 14px; height: 14px; color: var(--fg-secondary); }
.ne-table-pop { position: absolute; top: calc(100% + 4px); left: 8px; z-index: 70; min-width: 220px; background: var(--bg-surface); border: 1px solid var(--border-medium); border-radius: 8px; box-shadow: var(--shadow-md); padding: 10px; }
.ne-scope-pop.fixed, .ne-overflow-pop.fixed, .ne-table-pop.fixed { position: fixed; z-index: 1000; }
.ne-table-row { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 11px; color: var(--fg-secondary); }
.ne-table-row input { width: 44px; font-size: 12px; font-family: inherit; padding: 2px 6px; border: 1px solid var(--border-light); border-radius: 3px; outline: none; text-align: center; }
.ne-table-acts { display: flex; gap: 6px; justify-content: flex-end; }
.ne-btn-ghost { font-size: 11px; padding: 3px 10px; border: 1px solid var(--border-light); border-radius: 4px; background: transparent; color: var(--fg-muted); cursor: pointer; }
.ne-btn-primary { font-size: 11px; padding: 3px 12px; border: 1px solid var(--accent); border-radius: 4px; background: var(--accent); color: var(--fg-inverse); cursor: pointer; }
.ne-content { flex: 1; overflow: auto; display: flex; flex-direction: column; }
.ne-raw { flex: 1; padding: 16px 18px; font-family: var(--font-mono); font-size: 13px; line-height: 1.6; border: none; outline: none; resize: none; background: var(--bg-root); color: var(--fg-primary); }
.ne-assoc { border-top: 1px solid var(--border-light); flex-shrink: 0; }
.ne-assoc-hd { display: flex; align-items: center; justify-content: space-between; padding: 7px 14px; cursor: pointer; }
.ne-assoc-t { font-size: 11px; font-weight: 600; color: var(--fg-secondary); }
.ne-assoc-chev { color: var(--fg-muted); font-size: 14px; transition: transform .15s ease; }
.ne-assoc.open .ne-assoc-chev { transform: rotate(90deg); }
.ne-assoc-list { padding: 0 14px 8px; }
.ne-assoc-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 0; border-top: 1px solid var(--border-light); font-size: 11.5px; }
.ne-assoc-item:first-child { border-top: none; }
.ne-assoc-link { color: var(--accent); cursor: pointer; }
.ne-assoc-link:hover { text-decoration: underline; }
.ne-assoc-type { font-size: 9px; padding: 1px 6px; border-radius: 4px; background: var(--bg-hover); color: var(--fg-secondary); font-family: var(--font-mono); }
.ne-bottom { display: flex; align-items: center; justify-content: space-between; padding: 6px 14px; border-top: 1px solid var(--border-light); flex-shrink: 0; }
.ne-save { display: inline-flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--fg-muted); border: none; background: transparent; cursor: default; font-family: inherit; padding: 2px 4px; border-radius: 4px; }
.ne-save.save-error { color: var(--semantic-error); cursor: pointer; }
.ne-save-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--semantic-success); box-shadow: 0 0 5px var(--semantic-success); }
.save-saving .ne-save-dot { background: var(--semantic-warning); animation: np-blink 1s steps(1) infinite; }
.save-error .ne-save-dot { background: var(--semantic-error); box-shadow: none; }
.ne-del { font-size: 11px; padding: 4px 10px; border: 1px solid var(--semantic-error); border-radius: 5px; background: transparent; color: var(--semantic-error); cursor: pointer; }
.ne-del:hover { background: var(--semantic-error-subtle); }
@keyframes np-blink { 50% { opacity: 0; } }

/* Milkdown 正文样式 */
#milkdown-editor, #milkdown-editor .milkdown, #milkdown-editor .editor { display: flex; flex-direction: column; flex: 1; }
#milkdown-editor .ProseMirror { flex: 1; min-height: 100%; outline: none; font-size: calc(var(--font-scale, 1) * 14px); line-height: 1.7; color: var(--fg-primary); padding: 16px 20px; }
#milkdown-editor .ProseMirror:focus { outline: none; }
#milkdown-editor .ProseMirror p { margin: 0 0 0.75em 0; }
#milkdown-editor .ProseMirror h1 { font-size: 1.6em; font-weight: 700; margin: 1.2em 0 0.4em; color: var(--fg-primary); border-bottom: 2px solid var(--border-medium); padding-bottom: 0.2em; }
#milkdown-editor .ProseMirror h2 { font-size: 1.35em; font-weight: 600; margin: 1.1em 0 0.35em; color: var(--fg-primary); border-bottom: 1px solid var(--border-light); padding-bottom: 0.15em; }
#milkdown-editor .ProseMirror h3 { font-size: 1.15em; font-weight: 600; margin: 1em 0 0.25em; color: var(--fg-primary); }
#milkdown-editor .ProseMirror h4, #milkdown-editor .ProseMirror h5, #milkdown-editor .ProseMirror h6 { font-size: 1em; font-weight: 600; margin: 0.75em 0 0.25em; color: var(--fg-secondary); }
#milkdown-editor .ProseMirror strong { font-weight: 700; color: var(--fg-primary); }
#milkdown-editor .ProseMirror em { font-style: italic; }
#milkdown-editor .ProseMirror s { text-decoration: line-through; color: var(--fg-muted); }
#milkdown-editor .ProseMirror code { font-family: 'Cascadia Code','Fira Code',Consolas,monospace; font-size: 0.88em; padding: 1px 5px; border-radius: 3px; background: var(--bg-hover); color: var(--accent); }
#milkdown-editor .ProseMirror a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
#milkdown-editor .ProseMirror ul, #milkdown-editor .ProseMirror ol { padding-left: 1.8em; margin: 0.5em 0; }
#milkdown-editor .ProseMirror li { margin: 0.2em 0; }
#milkdown-editor .ProseMirror li p { margin: 0; }
#milkdown-editor .ProseMirror blockquote { margin: 0.75em 0; padding: 8px 16px; border-left: 3px solid var(--accent); background: var(--accent-subtle); border-radius: 0 4px 4px 0; color: var(--fg-secondary); }
#milkdown-editor .ProseMirror blockquote p { margin: 0.3em 0; }
#milkdown-editor .ProseMirror pre { margin: 0.75em 0; padding: 12px 16px; background: var(--bg-hover); border: 1px solid var(--border-light); border-radius: 6px; overflow-x: auto; }
#milkdown-editor .ProseMirror pre code { font-family: 'Cascadia Code','Fira Code',Consolas,monospace; font-size: 0.85em; line-height: 1.5; background: none; padding: 0; color: var(--fg-primary); }
#milkdown-editor .ProseMirror table { margin: 0.75em 0; border-collapse: collapse; width: 100%; }
#milkdown-editor .ProseMirror th, #milkdown-editor .ProseMirror td { border: 1px solid var(--border-light); padding: 6px 12px; font-size: 0.92em; text-align: left; }
#milkdown-editor .ProseMirror th { background: var(--bg-surface); font-weight: 600; }
#milkdown-editor .ProseMirror tr:nth-child(even) td { background: var(--bg-hover); }
#milkdown-editor .ProseMirror hr { margin: 1.5em 0; border: none; border-top: 1px solid var(--border-medium); }
#milkdown-editor .ProseMirror img { max-width: 100%; border-radius: 4px; }
#milkdown-editor .ProseMirror p.is-editor-empty:first-child::before { content: attr(data-placeholder); color: var(--fg-muted); opacity: 0.5; pointer-events: none; float: left; height: 0; }
`;
  document.head.appendChild(style);
}

// ─── Scope 树节点（筛选下拉内） ───

function ScopeTreeNode({ node, depth, active, onSelect }: { node: ScopeNode; depth: number; active: string; onSelect: (s: string) => void }) {
  const [open, setOpen] = useState(depth < 1);
  const isActive = active === node.path;
  return (
    <div>
      <div className={"np-pop-node" + (isActive ? " active" : "")} style={{ paddingLeft: 6 + depth * 14 }} onClick={() => onSelect(node.path)}>
        <span className="tri" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
          {node.children.length > 0 ? (open ? <ChevronDown size={9} /> : <ChevronRight size={9} />) : null}
        </span>
        <span className="nm">{node.label}</span>
        <span className="cnt">{node.count}</span>
      </div>
      {open && node.children.map((c) => (
        <ScopeTreeNode key={c.path} node={c} depth={depth + 1} active={active} onSelect={onSelect} />
      ))}
    </div>
  );
}

// ─── Component ───

export default function NotesPanel() {
  ensureNotesStyles();

  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState<NoteData | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [sort, setSort] = useState<"updated" | "title">("updated");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [narrow, setNarrow] = useState(false);
  const [mini, setMini] = useState(false);
  const [view, setView] = useState<"list" | "editor">("list");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterPos, setFilterPos] = useState<{ left: number; top: number } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const savedNoteRef = useRef<NoteData | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout>>();

  // ── 窄屏检测（决定列表/编辑器单栏推入） ──
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      setNarrow(w <= 640);
      setMini(w <= 440);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── 加载列表 ──
  const loadList = useCallback(async () => {
    try {
      const q = searchQuery.trim();
      const scope = scopeFilter ? scopeFilter + "*" : undefined;
      let result: NoteSummary[];
      if (q) {
        result = await invoke<NoteSummary[]>("note_search", { query: q, scope, limit: 200 });
      } else {
        result = await invoke<NoteSummary[]>("note_list", { scope, tag: tagFilter || undefined, limit: 200 });
      }
      if (sort === "title") result = [...result].sort((a, b) => (a.title || "").localeCompare(b.title || "", "zh"));
      setNotes(result);
    } catch (e: any) {
      console.error("[Notes] list:", e);
    }
  }, [scopeFilter, tagFilter, searchQuery, sort]);

  useEffect(() => {
    if (searchQuery) {
      const timer = setTimeout(() => loadList(), 350);
      return () => clearTimeout(timer);
    }
    loadList();
  }, [scopeFilter, tagFilter, searchQuery, sort, loadList]);

  // ── MCP / AI 联动（保留） ──
  useEventHandler<{ noteId?: string }>(Events.NOTE_SELECTED as any, (payload) => {
    if (!payload?.noteId) return;
    if (selectedId === payload.noteId) return;
    invoke<NoteData>("note_get", { id: payload.noteId }).then((n) => {
      setNote(n);
      savedNoteRef.current = n;
      setSelectedId(payload.noteId!);
      setView("editor");
    }).catch(() => {});
  });

  useEventHandler(Events.NOTES_CHANGED, () => {
    loadList();
    if (selectedId) {
      invoke<NoteData>("note_get", { id: selectedId }).then((n) => {
        setNote(n);
        savedNoteRef.current = n;
      }).catch(() => setNote(null));
    }
  });

  // ── 载入选中笔记 ──
  useEffect(() => {
    if (!selectedId) { setNote(null); return; }
    (async () => {
      try {
        const n = await invoke<NoteData>("note_get", { id: selectedId });
        setNote(n);
        savedNoteRef.current = n;
      } catch { setNote(null); }
    })();
  }, [selectedId]);

  // ── 保存 ──
  const handleSave = useCallback(async (data: NoteData) => {
    setSaveState("saving");
    try {
      const changed: Record<string, unknown> = {};
      if (!savedNoteRef.current || data.title !== savedNoteRef.current.title) changed.title = data.title;
      if (!savedNoteRef.current || data.content !== savedNoteRef.current.content) changed.content = data.content;
      if (!savedNoteRef.current || data.scope !== savedNoteRef.current.scope) changed.scope = data.scope;
      if (!savedNoteRef.current || JSON.stringify(data.tags) !== JSON.stringify(savedNoteRef.current.tags)) changed.tags = data.tags;
      if (Object.keys(changed).length === 0) { setSaveState("saved"); return; }
      const updated = await invoke<NoteData>("note_update", { id: data.id, input: changed });
      setNote(updated);
      savedNoteRef.current = updated;
      setSaveState("saved");
    } catch (e: any) {
      setSaveState("error");
      addStatusMessage(t("notes.saveFailed", { e: String(e) }), "error");
    }
  }, []);

  useEffect(() => {
    if (!note) return;
    if (savedNoteRef.current?.id === note.id &&
        savedNoteRef.current?.title === note.title &&
        savedNoteRef.current?.content === note.content &&
        savedNoteRef.current?.scope === note.scope &&
        JSON.stringify(savedNoteRef.current?.tags) === JSON.stringify(note.tags)) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => handleSave(note), 2000);
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.title, note?.content, note?.scope, note?.tags]);

  // ── 增删 ──
  const handleCreate = async () => {
    try {
      const n = await invoke<NoteData>("note_create", { input: { title: t("notes.newTitle"), content: "", scope: "global", tags: [] } });
      addStatusMessage(t("notes.created"), "success");
      await loadList();
      setSelectedId(n.id);
      setView("editor");
    } catch (e: any) {
      addStatusMessage(t("notes.createFailed", { e: String(e) }), "error");
    }
  };

  const handleDelete = async (id?: string) => {
    const targetId = id || selectedId;
    if (!targetId) return;
    try {
      await invoke("note_delete", { id: targetId });
      addStatusMessage(t("notes.deleted"), "success");
      if (targetId === selectedId) { setSelectedId(null); setView("list"); }
      setSelectedIds((prev) => { const n = new Set(prev); n.delete(targetId); return n; });
      await loadList();
    } catch (e: any) {
      addStatusMessage(t("notes.deleteFailed", { e: String(e) }), "error");
    }
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    try {
      for (const id of selectedIds) await invoke("note_delete", { id });
      addStatusMessage(t("notes.deletedBatch", { count: selectedIds.size }), "success");
      if (selectedId && selectedIds.has(selectedId)) { setSelectedId(null); setView("list"); }
      setSelectedIds(new Set());
      await loadList();
    } catch (e: any) {
      addStatusMessage(t("notes.batchDeleteFailed", { e: String(e) }), "error");
    }
  };

  // ── 选择 / 多选 ──
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const onRowClick = (id: string, ctrl: boolean) => {
    if (ctrl || selectedIds.size > 0) { toggleSelect(id); return; }
    setSelectedId(id);
    setView("editor");
  };

  // ── 发送到超级桌面（保留） ──
  const sendToDesktop = async (id: string) => {
    try {
      const n = await invoke<NoteData>("note_get", { id });
      const { addItem, findSmartPlace, getActiveDesktop } = await import("../../stores/desktopStore");
      const desktop = getActiveDesktop();
      if (!desktop) { addStatusMessage(t("notes.noDesktop"), "warn"); return; }
      const pos = findSmartPlace(desktop, 350, 250);
      addItem(desktop.id, {
        x: pos.x, y: pos.y, width: 350, height: 250,
        content: { type: "text", format: "markdown", text: `# ${n.title}\n\n${n.content}` },
        label: n.title || t("notes.note"),
      });
      addStatusMessage(t("notes.sentToDesktop", { title: n.title }), "success");
    } catch (e: any) {
      addStatusMessage(t("notes.sendFailed", { e: String(e) }), "error");
    }
  };

  // ── 右键菜单（保留） ──
  const onRowContext = (e: ReactMouseEvent, n: NoteSummary) => {
    e.preventDefault();
    const items: ContextMenuItem[] = [
      { label: t("notes.sendToChat"), action: () => eventBus.emit("chat.addReference", { reference: { type: "note", path: n.id, label: n.title || t("notes.untitled") } }) },
      { label: t("notes.sendToDesktopMenu"), action: () => sendToDesktop(n.id) },
      { separator: true },
    ];
    if (selectedIds.size >= 2) {
      items.unshift({ label: t("notes.deletedBatch", { count: selectedIds.size }), action: handleBatchDelete });
    } else {
      items.push({ label: t("notes.deleteNote"), action: () => handleDelete(n.id) });
    }
    showCtxMenu(e.clientX, e.clientY, items);
  };

  // ── 快捷键（Ctrl+N / Ctrl+K / Esc）——仅在笔记面板内或非编辑态触发，避免劫持其他面板 ──
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inNotes = !!rootRef.current && rootRef.current.contains(target);
      const editingElsewhere = !!target.closest?.("input, textarea, [contenteditable='true'], .ProseMirror") && !inNotes;
      if (editingElsewhere) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "n") { e.preventDefault(); handleCreate(); }
      else if ((e.ctrlKey || e.metaKey) && k === "k") { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
      else if (k === "escape") {
        if (filterOpen) setFilterOpen(false);
        else if (selectedIds.size > 0) setSelectedIds(new Set());
        else if (narrow && view === "editor") setView("list");
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [filterOpen, selectedIds, narrow, view, handleCreate]);

  // ── 筛选下拉：Portal 定位 + 点击外部关闭（避免被布局容器裁切） ──
  const updateFilterPos = useCallback(() => {
    const el = filterBtnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = 280;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    setFilterPos({ left, top: r.bottom + 6 });
  }, []);

  const toggleFilter = () => {
    if (!filterOpen) updateFilterPos();
    setFilterOpen(!filterOpen);
  };

  useEffect(() => {
    if (!filterOpen) return;
    updateFilterPos();
    window.addEventListener("resize", updateFilterPos);
    window.addEventListener("scroll", updateFilterPos, true);
    return () => {
      window.removeEventListener("resize", updateFilterPos);
      window.removeEventListener("scroll", updateFilterPos, true);
    };
  }, [filterOpen, updateFilterPos]);

  useEffect(() => {
    if (!filterOpen) return;
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".np-filter-wrap") && !t.closest(".np-filter-pop")) setFilterOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [filterOpen]);

  // ── 派生数据 ──
  const scopeTree = useMemo(() => buildScopeTree(notes), [notes]);
  const tagCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const n of notes) for (const tg of n.tags) m[tg] = (m[tg] || 0) + 1;
    return Object.entries(m).map(([name, count]) => ({ name, count }));
  }, [notes]);
  const scopeOptions = useMemo(() => {
    const s = new Set(notes.map((n) => n.scope));
    if (note?.scope) s.add(note.scope);
    return Array.from(s);
  }, [notes, note?.scope]);

  // ── 列表虚拟滚动 ──
  const rowVirtualizer = useVirtualizer({
    count: notes.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => 78,
    overscan: 10,
    getItemKey: (i) => notes[i]?.id ?? i,
    useFlushSync: false,
  });

  const editorOpen = narrow && view === "editor";
  const filterActive = !!scopeFilter || !!tagFilter;

  return (
    <div
      className={"np-root" + (narrow ? " narrow" : "") + (mini ? " mini" : "") + (editorOpen ? " editor-open" : "") + (selectedIds.size > 0 ? " multi" : "")}
      ref={rootRef}
      data-od-id="notes-panel"
    >
      {/* 工具栏 */}
      <div className="np-toolbar">
        <button type="button" className="np-btn primary" onClick={handleCreate} data-od-id="notes-new">
          {t("notes.newNote")}
        </button>
        <div className="np-search">
          <Search />
          <input
            ref={searchRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("notes.search")}
            spellCheck={false}
          />
        </div>
        <div className="np-filter-wrap">
          <button
            ref={filterBtnRef}
            type="button"
            className="np-btn ghost"
            onClick={toggleFilter}
            title={t("notes.filter")}
            data-od-id="notes-filter"
          >
            <Filter size={14} />
            {filterActive && <span className="np-filter-dot" />}
          </button>
        </div>
        {filterOpen && filterPos && createPortal(
          <div className="np-filter-pop fixed" style={{ left: filterPos.left, top: filterPos.top }} data-od-id="notes-filter-pop">
            <div className="np-pop-sec">
              <div className="np-pop-hd">{t("notes.filterScope")}</div>
              <div className="np-pop-tree">
                {scopeTree.map((node) => (
                  <ScopeTreeNode key={node.path} node={node} depth={0} active={scopeFilter} onSelect={(s) => setScopeFilter(scopeFilter === s ? "" : s)} />
                ))}
              </div>
            </div>
            <div className="np-pop-sec">
              <div className="np-pop-hd">{t("notes.filterTag")}</div>
              <div className="np-pop-tags">
                {tagCounts.length === 0 && <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>—</span>}
                {tagCounts.map((x) => (
                  <span key={x.name} className={"np-pop-tag" + (tagFilter === x.name ? " active" : "")} onClick={() => setTagFilter(tagFilter === x.name ? "" : x.name)}>
                    {x.name} · {x.count}
                  </span>
                ))}
              </div>
            </div>
            <div className="np-pop-sec">
              <div className="np-pop-hd">{t("notes.sortLabel")}</div>
              <div className="np-pop-sort">
                <button type="button" className={sort === "updated" ? "active" : ""} onClick={() => setSort("updated")}>{t("notes.sortRecent")}</button>
                <button type="button" className={sort === "title" ? "active" : ""} onClick={() => setSort("title")}>{t("notes.sortTitle")}</button>
              </div>
            </div>
          </div>,
          document.body
        )}
        {editorOpen && (
          <button type="button" className="np-btn ghost" onClick={() => setView("list")} title={t("notes.back")} data-od-id="notes-back">
            <ArrowLeft size={14} />
          </button>
        )}
      </div>

      {/* 主体 */}
      <div className="np-body">
        {/* 列表 */}
        <div className="np-list">
          {(scopeFilter || tagFilter) && (
            <div className="np-filter-chips">
              {scopeFilter && (
                <span className="np-chip">
                  {scopeFilter}
                  <button type="button" onClick={() => setScopeFilter("")}><X /></button>
                </span>
              )}
              {tagFilter && (
                <span className="np-chip">
                  #{tagFilter}
                  <button type="button" onClick={() => setTagFilter("")}><X /></button>
                </span>
              )}
            </div>
          )}
          <div className="np-list-hd">
            <span className="tt">{t("notes.listTitle")}</span>
            <span className="n">{t("notes.countLabel", { count: notes.length })}</span>
          </div>
          <div className="np-rows" ref={listScrollRef}>
            {notes.length === 0 ? (
              <div className="np-empty">{searchQuery.trim() ? t("notes.noMatch") : t("notes.empty")}</div>
            ) : (
              <div style={{ height: rowVirtualizer.getTotalSize(), width: "100%", position: "relative" }}>
                {rowVirtualizer.getVirtualItems().map((vi) => {
                  const n = notes[vi.index];
                  if (!n) return null;
                  const isSel = n.id === selectedId;
                  const isMulti = selectedIds.has(n.id);
                  return (
                    <div
                      key={vi.key}
                      data-index={vi.index}
                      ref={rowVirtualizer.measureElement}
                      style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}
                    >
                      <div
                        className={"np-row" + (isSel ? " sel" : "")}
                        onClick={(e) => onRowClick(n.id, e.ctrlKey || e.metaKey)}
                        onContextMenu={(e) => onRowContext(e, n)}
                        data-od-id="notes-row"
                      >
                        <input
                          type="checkbox"
                          className="cb"
                          checked={isMulti}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleSelect(n.id)}
                          aria-label={n.title}
                        />
                        <div className="main">
                          <div className="tt">{n.title || t("notes.untitled")}</div>
                          {n.snippet && <div className="snip">{n.snippet}</div>}
                          <div className="meta">
                            <span className="np-scope-chip">{n.scope}</span>
                            {n.tags.slice(0, 2).map((tg) => <span key={tg} className="np-tag-sm">{tg}</span>)}
                            <span className="np-time">{relTime(n.updated_at)}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {selectedIds.size > 0 && (
            <div className="np-batch" data-od-id="notes-batch-bar">
              <span className="cnt">{t("notes.selectedCount", { count: selectedIds.size })}</span>
              <button type="button" className="danger" onClick={handleBatchDelete}>{t("notes.batchDelete")}</button>
              <button type="button" onClick={() => setSelectedIds(new Set())}>{t("notes.cancel")}</button>
            </div>
          )}
        </div>

        {/* 编辑器 */}
        <div className="np-editor">
          {note ? (
            <NoteEditor
              note={note}
              scopeOptions={scopeOptions}
              saveState={saveState}
              onChange={setNote}
              onDelete={() => handleDelete(note.id)}
              onJump={(id) => { setSelectedId(id); setView("editor"); }}
              onRetrySave={() => { if (note) handleSave(note); }}
            />
          ) : (
            <div className="np-editor-empty">{t("notes.selectNote")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
