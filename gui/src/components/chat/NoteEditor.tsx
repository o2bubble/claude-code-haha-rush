import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Bold, Italic, Strikethrough, Code, Heading1, Heading2, Heading3, List, ListOrdered, Quote, Table, MoreHorizontal, Minus, Link, X } from "lucide-react";
import { t } from "../../i18n";
import { eventBus } from "../../services/serviceBus";
import { showCtxMenu } from "../ContextMenu";

// ─── Types ───

export interface NoteData {
  id: string;
  title: string;
  content: string;
  scope: string;
  tags: string[];
  associations: { id: string; title: string; type: string; weight: number; direction: string }[];
  created_at: string;
  updated_at: string;
}

export type SaveState = "saved" | "saving" | "error";

interface NoteEditorProps {
  note: NoteData;
  scopeOptions: string[];
  saveState: SaveState;
  onChange: (n: NoteData) => void;
  onDelete: () => void;
  onJump: (id: string) => void;
  onRetrySave: () => void;
}

// ─── Toolbar defs (lucide icons) ───

interface ToolDef { icon?: ReactNode; title?: string; action?: string; sep?: boolean; }

const TOOLS: ToolDef[] = [
  { icon: <Bold size={15} />, title: "bold", action: "bold" },
  { icon: <Italic size={15} />, title: "italic", action: "italic" },
  { icon: <Code size={15} />, title: "inlineCode", action: "code" },
  { sep: true },
  { icon: <Heading1 size={15} />, title: "h1", action: "h1" },
  { icon: <Heading2 size={15} />, title: "h2", action: "h2" },
  { icon: <Heading3 size={15} />, title: "h3", action: "h3" },
  { sep: true },
  { icon: <List size={15} />, title: "ul", action: "ul" },
  { icon: <ListOrdered size={15} />, title: "ol", action: "ol" },
  { icon: <Quote size={15} />, title: "quote", action: "quote" },
  { sep: true },
  { icon: <Table size={15} />, title: "table", action: "table" },
];

const OVERFLOW_TOOLS: ToolDef[] = [
  { icon: <Strikethrough size={14} />, title: "strike", action: "strike" },
  { icon: <Minus size={14} />, title: "hr", action: "hr" },
  { icon: <Link size={14} />, title: "link", action: "link" },
];

const TYPE_META: Record<string, string> = {
  related_to: "notes.assocTypeRelated",
  derived_from: "notes.assocTypeDerived",
  contradicts: "notes.assocTypeContradicts",
  supports: "notes.assocTypeSupports",
};

// ── Portal 定位：按锚点计算 fixed 坐标，跟随滚动/缩放 ──

function useAnchored(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  opts: { align?: "left" | "right"; width?: number; gap?: number; offset?: number },
) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const update = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = opts.width || 180;
    const gap = opts.gap ?? 4;
    const offset = opts.offset ?? 0;
    let left = opts.align === "right" ? r.right - width : r.left + offset;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    setPos({ left, top: r.bottom + gap });
  }, [anchorRef, opts.align, opts.width, opts.gap, opts.offset]);

  useEffect(() => {
    if (!open) { setPos(null); return; }
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, update]);

  return pos;
}

// ─── Component ───

export function NoteEditor({ note, scopeOptions, saveState, onChange, onDelete, onJump, onRetrySave }: NoteEditorProps) {
  const [tagInput, setTagInput] = useState("");
  const [rawMode, setRawMode] = useState(false);
  const [showTablePopover, setShowTablePopover] = useState(false);
  const [tableCols, setTableCols] = useState(3);
  const [tableRows, setTableRows] = useState(3);
  const [scopeDraft, setScopeDraft] = useState(note.scope);
  const [scopeFocused, setScopeFocused] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [assocOpen, setAssocOpen] = useState(true);
  const editorReady = useRef(false);
  const editorRef = useRef<any>(null);
  const noteRef = useRef(note);
  useEffect(() => { noteRef.current = note; }, [note]);

  const scopeAnchorRef = useRef<HTMLDivElement>(null);
  const overflowWrapRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setScopeDraft(note.scope); }, [note.id, note.scope]);

  const update = useCallback((patch: Partial<NoteData>) => {
    onChange({ ...note, ...patch });
  }, [note, onChange]);

  // ── Ctrl+E: toggle raw / WYSIWYG ──
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setRawMode((r) => !r);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // ── Milkdown init (skip in raw mode) ──
  useEffect(() => {
    if (rawMode) return;
    let cancelled = false;
    editorReady.current = false;
    const container = document.getElementById("milkdown-editor");
    if (!container) return;
    container.innerHTML = "";

    (async () => {
      const { Editor, rootCtx, defaultValueCtx } = await import("@milkdown/kit/core");
      const { commonmark } = await import("@milkdown/kit/preset/commonmark");
      const { gfm } = await import("@milkdown/kit/preset/gfm");
      const { history } = await import("@milkdown/kit/plugin/history");
      const { listener, listenerCtx } = await import("@milkdown/kit/plugin/listener");
      if (cancelled) return;
      const editor = Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, container);
          ctx.set(defaultValueCtx, note.content || "");
          ctx.get(listenerCtx).markdownUpdated((_, md) => {
            if (editorReady.current) {
              const cur = noteRef.current;
              onChange({ ...cur, content: md });
            }
          });
        })
        .use(commonmark)
        .use(gfm)
        .use(history)
        .use(listener)
        .create();
      const ed = await editor;
      if (cancelled) { ed.destroy(); return; }
      editorRef.current = ed;
      editorReady.current = true;
      return () => { ed.destroy(); };
    })();

    return () => { cancelled = true; };
  }, [note.id, rawMode, onChange]); // re-init when switching notes or toggling raw mode

  // ── Toolbar actions (Milkdown $Command.run()) ──
  const doInsertTable = useCallback(async () => {
    const gfm = await import("@milkdown/preset-gfm").catch(() => null as any);
    if (!gfm) return;
    (gfm as any).insertTableCommand?.run({ row: tableRows, col: tableCols });
    setShowTablePopover(false);
    const view: any = editorRef.current?.ctx?.get?.("prosemirrorView");
    view?.focus();
  }, [tableRows, tableCols]);

  const toolAction = useCallback(async (action: string) => {
    if (action === "table") { setShowTablePopover(true); return; }
    const [cm, gfm] = await Promise.all([
      import("@milkdown/preset-commonmark"),
      import("@milkdown/preset-gfm"),
    ]).catch(() => [null, null] as any);
    if (!cm || !gfm) return;
    try {
      switch (action) {
        case "bold": cm.toggleStrongCommand.run(); break;
        case "italic": cm.toggleEmphasisCommand.run(); break;
        case "code": cm.toggleInlineCodeCommand.run(); break;
        case "strike": (gfm as any).toggleStrikethroughCommand?.run(); break;
        case "h1": cm.wrapInHeadingCommand.run(1); break;
        case "h2": cm.wrapInHeadingCommand.run(2); break;
        case "h3": cm.wrapInHeadingCommand.run(3); break;
        case "ul": cm.wrapInBulletListCommand.run(); break;
        case "ol": cm.wrapInOrderedListCommand.run(); break;
        case "quote": cm.wrapInBlockquoteCommand.run(); break;
        case "codeblock": cm.createCodeBlockCommand.run(); break;
        case "hr": {
          const view: any = editorRef.current?.ctx?.get?.("prosemirrorView");
          if (view) {
            const hrType = view.state.schema.nodes.horizontal_rule;
            if (hrType) view.dispatch(view.state.tr.replaceSelectionWith(hrType.create()));
          }
          break;
        }
        case "link": {
          const view: any = editorRef.current?.ctx?.get?.("prosemirrorView");
          if (view && view.state.selection.empty === false) {
            const href = window.prompt(t("notes.linkUrl"), "https://");
            if (href) view.dispatch(view.state.tr.addMark(view.state.selection.from, view.state.selection.to, view.state.schema.marks.link.create({ href })));
          }
          break;
        }
      }
    } finally {
      const view: any = editorRef.current?.ctx?.get?.("prosemirrorView");
      view?.focus();
    }
  }, []);

  // ── 弹层点击外部关闭（溢出菜单 + 表格弹层） ──
  useEffect(() => {
    if (!overflowOpen && !showTablePopover) return;
    const h = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      const inToolbar = toolbarRef.current?.contains(el);
      const inPop = !!el.closest(".ne-overflow-pop") || !!el.closest(".ne-table-pop");
      if (!inToolbar && !inPop) { setOverflowOpen(false); setShowTablePopover(false); }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [overflowOpen, showTablePopover]);

  // ── Scope ──
  const scopeMatches = scopeOptions.filter((s) => s.toLowerCase().includes(scopeDraft.toLowerCase()));
  const scopeCanCreate = scopeDraft.trim().length > 0 && !scopeOptions.includes(scopeDraft.trim());
  const scopeShow = scopeFocused && (scopeMatches.length > 0 || scopeCanCreate);
  const commitScope = (val: string) => {
    const v = val.trim();
    if (!v) return;
    update({ scope: v });
    setScopeDraft(v);
    setScopeFocused(false);
  };

  // ── Portal 坐标 ──
  const scopePos = useAnchored(scopeShow, scopeAnchorRef, { width: 200 });
  const overflowPos = useAnchored(overflowOpen, overflowWrapRef, { align: "right", width: 160 });
  const tablePos = useAnchored(showTablePopover, toolbarRef, { width: 220, gap: 4, offset: 8 });

  // ── Tags ──
  const addTag = () => {
    const tag = tagInput.trim().toLowerCase();
    if (!tag || note.tags.includes(tag)) { setTagInput(""); return; }
    update({ tags: [...note.tags, tag] });
    setTagInput("");
  };
  const removeTag = (tag: string) => update({ tags: note.tags.filter((x) => x !== tag) });

  const selectionMenu = (x: number, y: number, sel: string) => showCtxMenu(x, y, [
    { label: t("notes.sendSelectionToChat"), action: () => eventBus.emit("chat.addReference", { reference: { type: "note", path: note.id, label: sel.slice(0, 60) } }) },
  ]);
  const getSelectionText = () => {
    const view: any = editorRef.current?.ctx?.get?.("prosemirrorView");
    if (view) {
      const { from, to } = view.state.selection;
      const txt = view.state.doc.textBetween(from, to);
      if (txt) return txt;
    }
    return window.getSelection()?.toString() || "";
  };

  return (
    <div className="ne-root">
      <input
        className="ne-title"
        value={note.title}
        onChange={(e) => update({ title: e.target.value })}
        placeholder={t("notes.titlePlaceholder")}
      />

      {/* 元信息：scope + 标签 */}
      <div className="ne-meta">
        <div className="ne-scope" ref={scopeAnchorRef}>
          <input
            className="ne-scope-input"
            value={scopeDraft}
            onFocus={() => setScopeFocused(true)}
            onBlur={() => setScopeFocused(false)}
            onChange={(e) => setScopeDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitScope(scopeDraft); } if (e.key === "Escape") setScopeFocused(false); }}
            placeholder={t("notes.scopePlaceholder")}
            spellCheck={false}
          />
        </div>
        {note.tags.map((tg) => (
          <span key={tg} className="ne-tag">
            {tg}
            <button type="button" className="ne-tag-x" onClick={() => removeTag(tg)} aria-label={t("notes.tagRemove")}><X size={10} /></button>
          </span>
        ))}
        <input
          className="ne-tag-input"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addTag(); if (e.key === "Escape") (e.target as HTMLInputElement).blur(); }}
          placeholder={t("notes.tagPlaceholder")}
        />
      </div>

      {/* 工具栏 */}
      <div className="ne-toolbar" ref={toolbarRef}>
        {TOOLS.map((tool, i) =>
          tool.sep ? (
            <span key={i} className="ne-sep" />
          ) : (
            <button key={i} type="button" className="ne-tb" title={t("notes." + tool.title)} onClick={() => toolAction(tool.action!)}>
              {tool.icon}
            </button>
          )
        )}
        <span className="ne-tb-spacer" />
        <button type="button" className={"ne-tb ne-mode" + (rawMode ? " on" : "")} title={rawMode ? t("notes.switchWysiwyg") : t("notes.switchMarkdown")} onClick={() => setRawMode(!rawMode)}>MD</button>
        <div className="ne-overflow" ref={overflowWrapRef}>
          <button type="button" className="ne-tb" title="⋯" onClick={() => setOverflowOpen(!overflowOpen)}><MoreHorizontal size={15} /></button>
        </div>
      </div>

      {/* Portal 弹层：scope 联想 / 溢出菜单 / 表格 */}
      {scopeShow && scopePos && createPortal(
        <div className="ne-scope-pop fixed" style={{ left: scopePos.left, top: scopePos.top }} data-od-id="notes-scope-pop">
          {scopeMatches.slice(0, 8).map((s) => (
            <div key={s} className="ne-scope-opt" onMouseDown={(e) => { e.preventDefault(); commitScope(s); }}>{s}</div>
          ))}
          {scopeCanCreate && (
            <div className="ne-scope-opt new" onMouseDown={(e) => { e.preventDefault(); commitScope(scopeDraft); }}>
              {t("notes.scopeNew", { scope: scopeDraft.trim() })}
            </div>
          )}
        </div>,
        document.body
      )}
      {overflowOpen && overflowPos && createPortal(
        <div className="ne-overflow-pop fixed" style={{ left: overflowPos.left, top: overflowPos.top }} data-od-id="notes-overflow-menu">
          {OVERFLOW_TOOLS.map((tool, i) => (
            <div key={i} className="ne-overflow-it" onClick={() => { setOverflowOpen(false); toolAction(tool.action!); }}>
              {tool.icon}<span>{t("notes." + tool.title)}</span>
            </div>
          ))}
        </div>,
        document.body
      )}
      {showTablePopover && tablePos && createPortal(
        <div className="ne-table-pop fixed" style={{ left: tablePos.left, top: tablePos.top }} data-od-id="notes-table-pop">
          <div className="ne-table-row">
            <label>{t("notes.tableCols")}</label>
            <input type="number" min={1} max={10} value={tableCols} onChange={(e) => setTableCols(Math.max(1, parseInt(e.target.value) || 1))} />
            <label>{t("notes.tableRows")}</label>
            <input type="number" min={1} max={20} value={tableRows} onChange={(e) => setTableRows(Math.max(1, parseInt(e.target.value) || 1))} />
          </div>
          <div className="ne-table-acts">
            <button type="button" className="ne-btn-ghost" onClick={() => setShowTablePopover(false)}>{t("notes.cancel")}</button>
            <button type="button" className="ne-btn-primary" onClick={doInsertTable}>{t("notes.tableInsert")}</button>
          </div>
        </div>,
        document.body
      )}

      {/* 正文 */}
      {rawMode ? (
        <textarea
          className="ne-raw"
          value={note.content}
          onChange={(e) => update({ content: e.target.value })}
          onContextMenu={(e) => {
            const ta = e.target as HTMLTextAreaElement;
            const sel = ta.value.substring(ta.selectionStart, ta.selectionEnd);
            if (sel) { e.preventDefault(); selectionMenu(e.clientX, e.clientY, sel); }
          }}
          placeholder={t("notes.contentPlaceholder")}
          spellCheck={false}
        />
      ) : (
        <div
          id="milkdown-editor"
          className="ne-content"
          onContextMenu={(e) => {
            const sel = getSelectionText();
            if (sel) { e.preventDefault(); selectionMenu(e.clientX, e.clientY, sel); }
          }}
        />
      )}

      {/* 关联 */}
      {note.associations.length > 0 && (
        <div className={"ne-assoc" + (assocOpen ? " open" : "")}>
          <div className="ne-assoc-hd" onClick={() => setAssocOpen(!assocOpen)}>
            <span className="ne-assoc-t">{t("notes.assocCount", { count: note.associations.length })}</span>
            <span className="ne-assoc-chev">›</span>
          </div>
          {assocOpen && (
            <div className="ne-assoc-list">
              {note.associations.map((a) => (
                <div key={a.id + a.type} className="ne-assoc-item">
                  <span className="ne-assoc-link" onClick={() => onJump(a.id)}>{a.title}</span>
                  <span className="ne-assoc-type">{t(TYPE_META[a.type] || a.type)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 底部：保存状态 + 删除 */}
      <div className="ne-bottom">
        <button
          type="button"
          className={"ne-save save-" + saveState}
          onClick={() => { if (saveState === "error") onRetrySave(); }}
          title={saveState === "error" ? t("notes.saveFailedRetry") : undefined}
        >
          <span className="ne-save-dot" />
          <span>
            {saveState === "saving" ? t("notes.saving") : saveState === "error" ? t("notes.saveFailedRetry") : t("notes.autoSaved")}
          </span>
        </button>
        <button type="button" className="ne-del" onClick={onDelete}>{t("notes.deleteNote")}</button>
      </div>
    </div>
  );
}
