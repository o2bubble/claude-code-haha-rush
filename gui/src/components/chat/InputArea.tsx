import React, { useState, useRef, useCallback, useEffect } from "react";
import { t } from "../../i18n";
import { useEvent, useEventHandler } from "../../services/useService";
import { Events } from "../../services/events";
import type { ChatInsertTextPayload, ChatAddReferencePayload, SettingsChangedPayload, ChatStateChangedPayload } from "../../services/events";
import { formatReference } from "../../utils/referenceParser";
import { saveClipboardItem, resolvePaste, collectPaste, isRealFilePath, defaultReadDir, defaultReadClipboardFiles, ensurePlainPasteTracking, isPlainPasteHeld } from "../../services/clipboardService";
import { getChatState, isChatReady } from "../../stores/chatStore";
import { getSettings } from "../../stores/settingsStore";
import { createComposerUndo, type ComposerSnapshot, type SnapshotKind } from "../../services/composerUndo";
import type { SlashCommand } from "../../stores/chatStore";
import { SlashCommandDropdown } from "./SlashCommandDropdown";

interface InputAreaProps {
  onSend: (content: string) => void;
  onInterrupt: () => void;
  streaming: boolean;
  /** 渲染在输入框边框容器内部顶部的内容(如消息队列), 与输入框共享外框 */
  topSlot?: React.ReactNode;
  /** 渲染在输入框边框容器内部右侧的内容(如消息队列), 与输入框共享外框 */
  rightSlot?: React.ReactNode;
  /** 渲染在输入框底部行(提示文字与发送按钮之间)的内容, 如收起态的队列胶囊 */
  footerSlot?: React.ReactNode;
}

const CHIP_ICONS: Record<string, string> = { file: "📄", dir: "📁", line: "📄", panel: "📋", session: "💬", paste: "📋", desktop: "🖥️", "desktop-item": "📌" };

/** Walk contenteditable DOM: text nodes → text, chips → @ref{...} or full text, <br> → newline */
function extractContent(container: HTMLElement): string {
  let result = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      result += (node.textContent || "").replace(/\u00A0/g, " ");
    } else if (node instanceof HTMLElement) {
      if (node.dataset.ref) {
        result += node.dataset.ref;
      } else if (node.tagName === "BR") {
        result += "\n";
      } else {
        for (const child of node.childNodes) walk(child);
      }
    }
  };
  for (const child of container.childNodes) walk(child);
  return result.trim();
}

/** True if the container has any text characters or chips */
function hasContent(container: HTMLElement): boolean {
  const text = extractContent(container);
  return text.length > 0;
}

function insertChipAtCursor(container: HTMLElement, refText: string, label: string, anchorOffset = -1) {
  const icon = (() => {
    for (const [type, emoji] of Object.entries(CHIP_ICONS)) {
      if (refText.startsWith(`@ref{${type}:`)) return emoji;
    }
    return "🔗";
  })();

  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.ref = refText;
  chip.textContent = `${icon} ${label}`;
  Object.assign(chip.style, {
    display: "inline-flex", alignItems: "center", gap: "2px",
    padding: "1px 6px", fontSize: "calc(var(--font-scale, 1) * 12px)", fontFamily: "var(--font-sans)",
    backgroundColor: "var(--accent-subtle)", border: "1px solid rgba(0,122,204,0.2)",
    borderRadius: "10px", color: "var(--accent)", cursor: "default", userSelect: "none",
    verticalAlign: "middle", margin: "0 2px",
  });

  // ⚠️ 这里**不**挂 per-chip 的 click 监听：撤销恢复 innerHTML 后新造出来的
  // chip 不会有监听器（"点 chip 删不掉"就是这么来的）。改在容器上做事件委托，
  // 见 InputArea 的 handleComposerClick。
  container.focus();
  const sel = window.getSelection();
  // 1) 面板发送时 composer 可能已失焦（实时 selection 不在容器内）——用缓存的光标锚点
  //    定位插入点：有锚点则插到"记忆的光标处"，无锚点/越界则回退。这是"光标处追加"的关键。
  if (anchorOffset >= 0 && setCaretAtCharOffset(container, anchorOffset)) {
    const range = sel ? sel.getRangeAt(0) : null;
    range?.deleteContents();
    range?.insertNode(chip);
    range?.setStartAfter(chip);
    range?.collapse(true);
    if (sel && range) { sel.removeAllRanges(); sel.addRange(range); }
    container.focus();
    return;
  }
  // 2) 实时 selection 在容器内 → 插光标处
  if (sel && sel.rangeCount > 0 && container.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(chip);
    // Place cursor after chip
    range.setStartAfter(chip);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    // 3) 末尾追加兜底
    container.appendChild(chip);
  }
  container.focus();
}

/** Get cursor position as character offset within the container's text */
function getCursorTextOffset(container: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !container.contains(sel.anchorNode)) return -1;
  let offset = 0;
  let found = false;
  const walk = (node: Node) => {
    if (found) return;
    if (node === sel.anchorNode) {
      offset += sel.anchorOffset;
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      offset += (node.textContent || "").length;
    } else if (node instanceof HTMLElement && node.dataset.ref) {
      offset += (node.dataset.ref || "").length;
    } else {
      for (const child of node.childNodes) walk(child);
    }
  };
  for (const child of container.childNodes) walk(child);
  return found ? offset : -1;
}

/**
 * 把塌缩光标设到容器内指定字符偏移处（文本字符 + @ref chip 的引用长度，与
 * getCursorTextOffset 互为逆映射）。面板发送时 composer 可能已失焦、实时 selection
 * 不在容器内，用这个把"缓存的光标偏移"定回编辑器。越界/容器空 → false（调用方回退末尾追加）。
 */
function setCaretAtCharOffset(container: HTMLElement, offset: number): boolean {
  if (offset < 0) return false;
  let remaining = offset;
  const walk = (node: Node): { node: Node; i: number } | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.textContent || "").length;
      if (remaining <= len) return { node, i: remaining };
      remaining -= len;
      return null;
    }
    if (node instanceof HTMLElement) {
      if (node.dataset.ref) {
        const len = (node.dataset.ref || "").length;
        if (remaining <= len) return { node, i: 0 }; // 落在 chip 起点，插到它前面
        remaining -= len;
        return null;
      }
      for (const child of Array.from(node.childNodes)) {
        const r = walk(child);
        if (r) return r;
      }
    }
    return null;
  };
  let target: { node: Node; i: number } | null = null;
  for (const child of Array.from(container.childNodes)) {
    const r = walk(child);
    if (r) { target = r; break; }
  }
  if (!target) return false;
  const sel = window.getSelection();
  const range = document.createRange();
  if (target.node.nodeType === Node.TEXT_NODE) {
    range.setStart(target.node, target.i);
  } else {
    range.setStartBefore(target.node);
  }
  range.collapse(true);
  if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  container.focus();
  return true;
}

/** Check if container text has a / at a word boundary before the cursor */
function findSlashContext(container: HTMLElement): { trigger: boolean; filter: string; slashPos: number; cursor: number } | null {
  const text = extractContent(container);
  const cursor = getCursorTextOffset(container);
  if (cursor < 0) return null;
  // Look for the closest / before cursor that is at a word boundary
  let slashPos = -1;
  for (let i = cursor - 1; i >= 0; i--) {
    if (text[i] === "/") {
      // Must be at start of input or preceded by space/newline
      if (i === 0 || text[i - 1] === " " || text[i - 1] === "\n") {
        slashPos = i;
        break;
      }
      if (text[i - 1] === "/") continue;
    }
  }
  if (slashPos < 0) return null;
  const filter = text.slice(slashPos + 1, cursor);
  if (filter.includes(" ")) return null;
  return { trigger: true, filter, slashPos, cursor };
}

function getCaretRect(container: HTMLElement): { top: number; left: number } | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rect = range.getClientRects()[0];
  if (rect) return { top: rect.bottom + 4, left: rect.left };
  // Fallback: use container rect
  const cr = container.getBoundingClientRect();
  return { top: cr.bottom + 4, left: cr.left };
}

/**
 * 撤销栈**放在模块级**，不随组件卸载消失。
 *
 * 为什么（2026-10-28 用户反馈「切到终端面板再切回来，输入的内容没了」）：
 * 布局渲染器只挂载**当前激活**的标签页（LayoutRenderer 的 contentRender），
 * 切到「终端」→ ChatInputPanel 整个卸载 → InputArea 的 DOM 连同未发送的内容
 * 一起没了。这不是撤销功能引入的（上一版同样如此），是老问题。
 *
 * 把栈放模块级，`current()` 就是草稿的唯一事实来源：卸载不丢、重挂载时
 * 原样贴回，连撤销历史一起活过来（回来还能接着 Ctrl+Z）。
 *
 * 同一 JS 上下文里只会有一个 composer（App 与 WidgetApp 二选一渲染，
 * 见 main.tsx），且不同 Tauri 窗口是不同上下文 —— 单例安全。
 */
const composerUndo = createComposerUndo();

export function InputArea({ onSend, onInterrupt, streaming, topSlot, rightSlot, footerSlot }: InputAreaProps) {
  const divRef = useRef<HTMLDivElement>(null);
  const slashPosRef = useRef<number>(-1);
  const slashCursorRef = useRef<number>(-1);
  const [hasText, setHasText] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashAnchor, setSlashAnchor] = useState({ top: 0, left: 0 });
  const [slashHighlight, setSlashHighlight] = useState(0);
  // 光标锚点：composer 聚焦时随时记住光标字符偏移，供面板"发送到聊天"引用（失焦时也能插到记忆位置）
  const cursorOffsetRef = useRef<number>(-1);

  // 撤销栈是模块级单例（见上面的 composerUndo 注释），这里只做别名。
  const undo = composerUndo;

  // Reactive slash commands from chatStore
  const chatPayload = useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED);
  // 后端就绪 + 会话已加载 才能发送。就绪判定收敛到共享 isChatReady（单一源），
  // 策略本身由 sendMessage 层拥有；这里只读 boolean 用于按钮 disabled 的 UI 反馈。
  const backendReady = !!chatPayload?.state
    ? isChatReady(chatPayload.state)
    : isChatReady();
  const rawCommands: SlashCommand[] = chatPayload?.state?.slashCommands ?? getChatState().slashCommands ?? [];
  const slashCommands = rawCommands.filter((c) => c && c.cmd);
  const slashFiltered = slashCommands.filter((c) => {
    const f = slashFilter.toLowerCase();
    return c.cmd.includes(slashFilter) || (c.desc && c.desc.toLowerCase().includes(f));
  });

  const updateHasText = useCallback(() => {
    if (divRef.current) setHasText(hasContent(divRef.current));
  }, []);

  /**
   * 把编辑器当前状态记进撤销栈。
   *
   * `kind`：`typing`（用户键入，按时间合并）/ `edit`（chip、粘贴、命令补全、
   * 面板插入 —— 永远独立成步）。
   *
   * ⚠️ **所有改动 DOM 的地方都要调**（除了 onInput）：程序化写入不会触发
   * onInput，漏一处就会让撤销栈与真实内容脱节 —— 那正是原生 undo 坏掉的原因，
   * 不能在自己实现里重犯。
   */
  const snapshotNow = useCallback((kind: SnapshotKind) => {
    const el = divRef.current;
    if (!el) return;
    undo.record(
      { html: el.innerHTML, caret: getCursorTextOffset(el) },
      kind,
      Date.now(),
    );
  }, []);

  /** 把快照贴回编辑器（含光标位置） */
  const applySnapshot = useCallback((snap: ComposerSnapshot) => {
    const el = divRef.current;
    if (!el) return;
    el.innerHTML = snap.html;
    if (!setCaretAtCharOffset(el, snap.caret)) {
      // 偏移未记录（-1）或越界 → 光标放到末尾，总比停在开头让人接着打字更自然
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
    }
    el.focus();
    // 撤销后的内容多半不再匹配之前打开的斜杠面板 —— 先关掉，下次输入会自然重算
    setSlashOpen(false);
    updateHasText();
  }, [updateHasText]);

  // 挂载：先贴上"上次离开时的草稿"，再把结果记为基线。
  //
  // 为什么要有这一步：切到「终端」标签会把本面板整个卸载（布局只渲染激活标签），
  // 未发送的内容只存在 DOM 里 → 切回来就没了（用户反馈 2026-10-28）。
  // 撤销栈在模块级，`current()` 就是那份草稿。
  //
  // 没有草稿时记一条空基线：这样第一段键入之后 Ctrl+Z 能退回空，
  // 而不是因为"没有更早的状态"什么也不做。
  useEffect(() => {
    const el = divRef.current;
    if (!el) return;
    const draft = undo.current();
    if (draft && draft.html && draft.html !== el.innerHTML) {
      el.innerHTML = draft.html;
      updateHasText();
      // 光标接回草稿里记的位置 —— 否则重新挂载后 caret 在开头，
      // 用户接着打字会插到最前面（而不是他离开时停的地方）。
      if (setCaretAtCharOffset(el, draft.caret)) {
        // 用户从终端切回来，本意多半是继续写 —— 直接把焦点交还给输入框。
        // 只有"有草稿"时才抢焦点：空状态切过来不该打断用户。
        el.focus();
      }
    }
    snapshotNow("edit");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 点 chip 删除（事件委托 —— 撤销恢复 innerHTML 后新造的 chip 也有效）。
   * 删除本身要记一步撤销，否则删错了没法用 Ctrl+Z 找回。
   */
  const handleComposerClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      const chip = target?.closest?.("[data-ref]") as HTMLElement | null;
      if (!chip || !divRef.current?.contains(chip)) return;
      chip.remove();
      updateHasText();
      snapshotNow("edit");
    },
    [snapshotNow, updateHasText],
  );

  // 光标锚点更新：composer 处于 activeElement 时（聚焦态），selectionchange 随时记录偏移
  useEffect(() => {
    const onSelChange = () => {
      const el = divRef.current;
      if (el && document.activeElement === el) {
        const o = getCursorTextOffset(el);
        if (o >= 0) cursorOffsetRef.current = o;
      }
    };
    document.addEventListener("selectionchange", onSelChange);
    return () => document.removeEventListener("selectionchange", onSelChange);
  }, []);

  // Handle plain-text insert (命令面板 atStart → 最前；其他 → 光标处)
  useEventHandler<ChatInsertTextPayload>(Events.CHAT_INSERT_TEXT, ({ text: insertText, atStart, appendEnd, replySuffix, newlineBefore }) => {
    const el = divRef.current;
    if (!el) return;
    // 回复引用模式：若当前行有文字先换行，插入《选中文字》并把光标停在书名号中间
    if (replySuffix) {
      el.focus();
      if (newlineBefore && hasContent(el)) el.appendChild(document.createElement("br"));
      const prefix = document.createTextNode(insertText);          // 《选中文字
      el.appendChild(prefix);
      const suffix = document.createTextNode(replySuffix);         // 》
      el.appendChild(suffix);
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(prefix, prefix.length);                        // 光标停在 prefix 末尾（》前）
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
      updateHasText();
      snapshotNow("edit");
      return;
    }
    el.focus();
    const sel = window.getSelection();
    if (atStart) {
      // 插到最前面，光标移到插入文本末尾（便于继续输入参数）
      const node = document.createTextNode(insertText);
      el.insertBefore(node, el.firstChild);
      const range = document.createRange();
      range.setStart(node, node.length);
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
    } else if (appendEnd) {
      // 追加到末尾（划词/快捷提示多次发送层层追加）；focus() 会把选区塌缩到开头，
      // 若走光标分支会插到最前面造成倒序
      const node = document.createTextNode(insertText);
      el.appendChild(node);
      const range = document.createRange();
      range.setStart(node, node.length);
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
    } else if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(insertText));
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      el.appendChild(document.createTextNode(insertText));
    }
    updateHasText();
    snapshotNow("edit");
  });

  // Handle reference → chip at cursor (skip if SkillDialog is open)
  useEventHandler<ChatAddReferencePayload>(Events.CHAT_ADD_REFERENCE, ({ reference }) => {
    if (getChatState().activeSkillDialog) return;
    const el = divRef.current;
    if (!el) return;
    const refText = formatReference(reference);
    const label = reference.label || reference.path.split(/[/\\]/).pop() || reference.path;
    insertChipAtCursor(el, refText, label, cursorOffsetRef.current);
    updateHasText();
    snapshotNow("edit");
  });

  const handleSend = useCallback(() => {
    if (getChatState().inputBlockedReason) return;
    const el = divRef.current;
    if (!el) return;
    const content = extractContent(el);
    if (!content) return;
    onSend(content);
    el.innerHTML = "";
    setHasText(false);
    cursorOffsetRef.current = -1; // 内容清空 → 锚点作废
    // 发出去的内容不再算"可撤销的编辑"（与主流聊天框一致）：
    // 保留它会让 Ctrl+Z 把已发送的话原样搬回输入框。
    undo.reset({ html: "", caret: -1 });
  }, [onSend]);

  const handleSlashSelect = useCallback((cmd: string) => {
    if (!cmd) return;
    setSlashOpen(false);
    setSlashHighlight(0);
    const el = divRef.current;
    if (!el) return;
    const slashPos = slashPosRef.current;
    const cursor = slashCursorRef.current;
    if (slashPos < 0 || cursor <= slashPos) { el.focus(); return; }
    // Replace from slashPos to cursor with /cmd
    const text = extractContent(el);
    const before = text.slice(0, slashPos);
    const after = text.slice(cursor);
    el.innerHTML = "";
    const newText = before + "/" + cmd + " " + after;
    el.appendChild(document.createTextNode(newText));
    // Place cursor after "/cmd "
    const newCursor = before.length + cmd.length + 2; // +2 for "/" + space
    const tn = el.firstChild;
    if (tn && tn.nodeType === Node.TEXT_NODE) {
      const r = document.createRange();
      r.setStart(tn, Math.min(newCursor, (tn.textContent || "").length));
      r.collapse(true);
      const s = window.getSelection();
      if (s) { s.removeAllRanges(); s.addRange(r); }
    }
    el.focus();
    updateHasText();
    snapshotNow("edit"); // 补全是一次结构性改写（整段 innerHTML 重建）
  }, [updateHasText, snapshotNow]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // ── 撤销 / 重做 ──
      // 必须**自己接管**：原生 undo 与程序化写入（chip / innerHTML 重建）混在
      // 一起会还原出半截内容（用户反馈「乱七八糟」的根因）。
      // 输入法组字期间不接管 —— 撤销半截拼音是 IME 自己的事。
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const isUndo = mod && !e.altKey && !e.shiftKey && key === "z";
      const isRedo = mod && !e.altKey && ((key === "z" && e.shiftKey) || (key === "y" && !e.shiftKey));
      if ((isUndo || isRedo) && !e.nativeEvent.isComposing) {
        // 始终 preventDefault：即使栈空也不让浏览器原生 undo 插手 ——
        // 它可能把我们早已替换掉的旧 DOM 状态翻出来。
        e.preventDefault();
        const snap = isRedo ? undo.redo() : undo.undo();
        if (snap) applySnapshot(snap);
        return;
      }

      if (slashOpen && slashFiltered.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashHighlight((i) => Math.min(i + 1, slashFiltered.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashHighlight((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          handleSlashSelect(slashFiltered[slashHighlight]?.cmd ?? "");
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashOpen(false);
          return;
        }
        // Any other non-nav key: keep typing, filter updates via onInput
        return;
      }
      const enterBehavior = getSettings().chatEnterBehavior ?? "send";
      if (enterBehavior === "send") {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      } else {
        if (e.key === "Enter" && e.ctrlKey) {
          e.preventDefault();
          handleSend();
        }
      }
    },
    [handleSend, slashOpen, slashFiltered, slashHighlight, handleSlashSelect, applySnapshot],
  );

  const handleInput = useCallback(() => {
    updateHasText();
    // 键入也进撤销栈（按时间合并成步，见 composerUndo）
    snapshotNow("typing");
    const el = divRef.current;
    if (!el) return;
    const ctx = findSlashContext(el);
    if (ctx && ctx.trigger) {
      slashPosRef.current = ctx.slashPos;
      slashCursorRef.current = ctx.cursor;
      setSlashHighlight(0);
      const rect = getCaretRect(el);
      if (rect) {
        setSlashFilter(ctx.filter);
        setSlashAnchor(rect);
        setSlashOpen(true);
        return;
      }
    }
    setSlashOpen(false);
  }, [updateHasText, snapshotNow]);

  // Work dir for saving pasted images/files
  const settingsPayload = useEvent<SettingsChangedPayload>(Events.SETTINGS_CHANGED);
  const workDir = settingsPayload?.settings?.workDir ?? "";

  // Shift 键跟踪（"Ctrl+Shift+V = 强制纯文本"）—— 必须在挂载时就开始（详见 clipboardService）
  useEffect(() => { ensurePlainPasteTracking(); }, []);

  // Strip formatting on paste; auto-chip long text; handle images/files
  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      e.preventDefault();
      const el = divRef.current;
      if (!el) return;
      el.focus();

      // 提取结构化剪贴板输入，交给 resolvePaste 做粘贴决策。
      // readClipboardFiles：粘贴的文件没有 .path（Tauri 只对拖放注入），
      // 靠它拿源路径让文件走引用而非复制内容（见 clipboardService 注释）。
      // Ctrl+Shift+V = 强制纯文本（跳过路径探测与长文本折叠）—— 见 features.md 3.2。
      const { files, images, text } = collectPaste(e);
      const decision = await resolvePaste({
        files,
        images,
        text,
        pathExists: isRealFilePath,
        readDir: defaultReadDir,
        readClipboardFiles: defaultReadClipboardFiles,
        forceText: isPlainPasteHeld(),
      });

      if (decision.kind === "refs") {
        for (const r of decision.refs) {
          const refText = formatReference({ type: r.type, path: r.path, label: r.label });
          insertChipAtCursor(el, refText, r.label, cursorOffsetRef.current);
        }
        updateHasText();
        snapshotNow("edit");
        return;
      }

      if (decision.kind === "saveImages") {
        let anySaved = false;
        for (const item of decision.items) {
          const filePath = await saveClipboardItem(item.blob, workDir, item.name);
          if (filePath) {
            const name = filePath.split(/[/\\]/).pop() || "image";
            const refText = formatReference({ type: "file", path: filePath, label: name });
            insertChipAtCursor(el, refText, name, cursorOffsetRef.current);
            anySaved = true;
          }
        }
        if (anySaved) {
          updateHasText();
          snapshotNow("edit");
        }
        return;
      }

      // decision.kind === "inlineText": 普通短文本按光标位置插入。
      const plain = decision.text;
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(plain));
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        el.appendChild(document.createTextNode(plain));
      }
      updateHasText();
      snapshotNow("edit");
    },
    [updateHasText, workDir, snapshotNow],
  );

  return (
    <div
      style={{
        borderTop: "1px solid var(--border-light)",
        padding: "12px 16px",
        backgroundColor: "var(--bg-root)",
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          border: hasText ? "2px solid var(--accent)" : "2px solid var(--border-light)",
          borderRadius: 12,
          overflow: "hidden",
          transition: "border-color 0.2s",
          backgroundColor: "var(--bg-surface)",
          minHeight: 44,
        }}
      >
        {topSlot && (
          <div style={{ flexShrink: 0, borderBottom: "1px solid var(--border-light)", background: "var(--bg-surface)" }}>
            {topSlot}
          </div>
        )}
        <div style={{ display: "flex", flex: 1, minHeight: 0, padding: "10px 6px 4px 12px" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div
          ref={divRef}
          contentEditable
          suppressContentEditableWarning
          data-placeholder={t("chat.placeholder")}
          onClick={handleComposerClick}
          onInput={handleInput}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          style={{
            flex: 1,
            outline: "none",
            fontSize: "calc(var(--font-scale, 1) * 14px)",
            fontFamily: "var(--font-sans)",
            lineHeight: 1.6,
            overflow: "auto",
            minHeight: 22,
            wordBreak: "break-word",
          }}
        />
        <style>{`
          [data-placeholder]:empty:before {
            content: attr(data-placeholder);
            color: #aaa;
            pointer-events: none;
          }
        `}</style>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingTop: 2,
          }}
        >
          {getChatState().inputBlockedReason ? (
            <span style={{
              fontSize: 10, color: "#7c3aed",
              fontFamily: "var(--font-sans)", fontWeight: 500,
            }}>
              {getChatState().inputBlockedReason}
            </span>
          ) : (
            <span style={{
              fontSize: 10, color: "var(--fg-muted)",
              fontFamily: "var(--font-sans)",
            }}>
              {t("chat.enterShortcut")}
            </span>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {footerSlot}
          {streaming ? (
            <button
              onClick={onInterrupt}
              style={{
                padding: "6px 14px",
                border: "none",
                borderRadius: 8,
                backgroundColor: "var(--semantic-error)",
                color: "var(--fg-inverse)",
                fontSize: 13,
                fontFamily: "var(--font-sans)",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              {t("chat.stop")}
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!hasText || !backendReady}
              style={{
                padding: "6px 14px",
                border: "none",
                borderRadius: 8,
                backgroundColor: hasText && backendReady ? "var(--accent)" : "#ccc",
                color: "var(--fg-inverse)",
                fontSize: 13,
                fontFamily: "var(--font-sans)",
                cursor: hasText && backendReady ? "pointer" : "default",
                fontWeight: 600,
              }}
            >
              {t("chat.send")}
            </button>
          )}
          </div>
        </div>
        </div>
        {rightSlot && (
          <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
            {rightSlot}
          </div>
        )}
        </div>
      </div>

      {/* Slash command autocomplete */}
      {slashOpen && (
        <SlashCommandDropdown
          commands={slashCommands}
          filter={slashFilter}
          highlightIndex={slashHighlight}
          onHighlight={setSlashHighlight}
          onSelect={handleSlashSelect}
          onClose={() => setSlashOpen(false)}
          anchorTop={slashAnchor.top}
          anchorLeft={slashAnchor.left}
        />
      )}
    </div>
  );
}
