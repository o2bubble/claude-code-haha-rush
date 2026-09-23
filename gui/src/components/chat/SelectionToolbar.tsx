// ── 消息划词工具栏：选区旁的小浮层（发送到聊天框 / 复制 / 路径操作）──
// 纯表现组件：父组件传入列表容器 ref，选区落点/出现/消失逻辑都在这里。
// 发送复用 CHAT_INSERT_TEXT（纯文本插入 composer，保留可编辑性）；开关见设置 msgSelectionToolbar。
// 路径检测：从选中文本中扫描所有路径片段，汇总按钮点击展开下拉列表。
//
// 每个路径给**两种**打开方式（用户反馈：选中一个能在编辑器里看的文件，却只能跳
// 资源管理器，多此一举）：编辑器（走 openPathInEditor —— 图片/PDF 预览、文本进编辑）
// 与资源管理器（兜底）。前者失败会自动退到后者，所以两项都不是死路。

import React, { useLayoutEffect, useEffect, useRef, useState } from "react";
import { getSettings } from "../../stores/settingsStore";
import { addStatusMessage } from "../../stores/statusMsgStore";
import { windowBus } from "../../services/windowBus";
import { Events, type SettingsChangedPayload } from "../../services/events";
import { useEvent } from "../../services/useService";
import { t } from "../../i18n";
import { computeToolbarPosition, POPUP_SIZE, type Rect } from "./selectionToolbarPosition";
import { findPathsWithWorkspace } from "../../utils/pathDetector";
import { openPathInEditor } from "../../services/referenceActions";

interface SelectionToolbarProps {
  /** 消息列表滚动容器；选区必须落在其中才弹出 */
  container: React.RefObject<HTMLElement | null>;
}

interface SelState {
  text: string;
  rect: Rect;
}

/** 路径下拉项：动作文字 + 截断的路径（完整路径见 title）。 */
const pathItemStyle: React.CSSProperties = {
  padding: "5px 10px",
  cursor: "pointer",
  fontSize: 11,
  fontFamily: "var(--font-sans)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

/** 路径本身用弱色 —— 与前面的动作文字拉开层次，扫一眼先看到"能做什么"。 */
const pathDimStyle: React.CSSProperties = { color: "var(--fg-muted)" };

export function SelectionToolbar({ container }: SelectionToolbarProps) {
  const settingsPayload = useEvent<SettingsChangedPayload>(Events.SETTINGS_CHANGED);
  const enabled = settingsPayload?.settings?.msgSelectionToolbar ?? getSettings().msgSelectionToolbar ?? true;
  const workDir = settingsPayload?.settings?.workDir ?? getSettings().workDir ?? "";
  const [sel, setSel] = useState<SelState | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [showPaths, setShowPaths] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // 最近一次 mousedown 是否落在工具栏内。点击工具栏自身的按钮时, 浏览器对
  // 选区所在的可选中区域可能调整/清空 selection 并触发 selectionchange——
  // 若此时把工具栏关闭, 展开中的下拉(如路径列表)会闪没, 用户来不及点选项。
  // 实测差异: 点击消息富文本选区时触发 selectionchange 被清空, 发布构建必须守卫。
  const lastMouseDownInToolbar = useRef(false);
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      lastMouseDownInToolbar.current = !!(toolbarRef.current && toolbarRef.current.contains(e.target as Node));
    };
    window.addEventListener("mousedown", onMouseDown, true);
    return () => window.removeEventListener("mousedown", onMouseDown, true);
  }, []);

  // 容器内松开鼠标且选区非空 → 弹出
  useEffect(() => {
    const el = container.current;
    if (!el || !enabled) return;
    const onMouseUp = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const text = selection.toString().trim();
      if (!text) return;
      const anchor = selection.anchorNode;
      if (!anchor || !el.contains(anchor)) return;
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const vp = { width: window.innerWidth, height: window.innerHeight };
      setSel({ text, rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right } });
      setPos(computeToolbarPosition(rect, vp, POPUP_SIZE));

      // Scan selected text for paths. workspace 含空格时先转义再匹配,
      // 避免工作区路径在空格处被拆成两段
      setPaths(findPathsWithWorkspace(text, workDir));
      setShowPaths(false);
    };
    el.addEventListener("mouseup", onMouseUp);
    return () => el.removeEventListener("mouseup", onMouseUp);
  }, [container, enabled]);

  // 渲染后测量工具栏真实尺寸, 用实测值重新夹紧/翻转
  useLayoutEffect(() => {
    if (!sel) {
      setPos(null);
      return;
    }
    const el = toolbarRef.current;
    if (!el) return;
    const m = el.getBoundingClientRect();
    setPos(computeToolbarPosition(
      sel.rect,
      { width: window.innerWidth, height: window.innerHeight },
      { width: m.width, height: m.height },
    ));
  }, [sel, paths, showPaths]);

  // 列表滚动 → 消失
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const onScroll = () => { setSel(null); setShowPaths(false); };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [container]);

  // 点弹层外 / Esc / 选区被清空 → 消失
  useEffect(() => {
    if (!sel) return;
    const onMouseDown = (e: MouseEvent) => {
      if (toolbarRef.current && toolbarRef.current.contains(e.target as Node)) return;
      setSel(null);
      setShowPaths(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setSel(null); setShowPaths(false); }
    };
    const onSelChange = () => {
      const s = window.getSelection();
      if ((!s || !s.toString().trim()) && !lastMouseDownInToolbar.current) {
        setSel(null);
        setShowPaths(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("selectionchange", onSelChange);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("selectionchange", onSelChange);
    };
  }, [sel]);

  if (!enabled || !sel || !pos) return null;

  const clear = () => {
    // 不 removeAllRanges：发送/回复的 CHAT_INSERT_TEXT handler 已在 composer 放好光标，
    // 这里再清全局 selection 会把刚放的光标抹掉。工具栏用 setSel(null) 隐藏；消息区选区
    // 会在 composer 聚焦时被自然替换（复制路径在 handleCopy 里单独清）。
    setSel(null);
    setPaths([]);
    setShowPaths(false);
  };
  const handleSend = () => {
    // appendEnd: 追加到输入框末尾, 多次划词发送层层追加(默认光标分支会被 focus() 塌缩到开头)
    windowBus.emit(Events.CHAT_INSERT_TEXT, { text: sel.text, appendEnd: true });
    clear();
  };
  const handleReply = () => {
    // 回复引用：换行(若当前有内容) + 目标文本原样复制 + 末尾追加「」+ 光标停在「」中间待输入回复
    windowBus.emit(Events.CHAT_INSERT_TEXT, { text: sel.text + "「", replySuffix: "」", newlineBefore: true });
    clear();
  };
  const handleCopy = () => {
    navigator.clipboard.writeText(sel.text).catch(() => {});
    clear();
    // 复制不聚焦 composer（消息区选区保留），这里显式清掉选区高亮
    window.getSelection()?.removeAllRanges();
  };

  const btnStyle = (primary: boolean): React.CSSProperties => ({
    border: "none",
    padding: "4px 10px",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: "calc(var(--font-scale, 1) * 12px)",
    fontFamily: "var(--font-sans)",
    fontWeight: 600,
    whiteSpace: "nowrap",
    color: primary ? "var(--fg-inverse)" : "var(--fg-secondary)",
    backgroundColor: primary ? "var(--accent)" : "transparent",
  });

  return (
    <div
      ref={toolbarRef}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        zIndex: 999,
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "3px 4px",
        borderRadius: 8,
        backgroundColor: "var(--bg-root)",
        border: "1px solid var(--border-medium)",
        boxShadow: "0 2px 10px rgba(0,0,0,0.2)",
      }}
    >
      <button onClick={handleSend} style={btnStyle(true)}>{t("message.sendToChatInput")}</button>
      <button onClick={handleReply} style={btnStyle(false)}>{t("message.reply")}</button>
      <span style={{ width: 1, height: 14, backgroundColor: "var(--border-medium)" }} />
      <button onClick={handleCopy} style={btnStyle(false)}>{t("message.copy")}</button>

      {/* Paths: single dropdown button */}
      {paths.length > 0 && (
        <>
          <span style={{ width: 1, height: 14, backgroundColor: "var(--border-medium)" }} />
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setShowPaths(!showPaths)}
              style={btnStyle(false)}
              title={t("files.pathActionsHint")}
            >
              {t("files.pathActions")} ({paths.length})
            </button>
            {showPaths && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  right: 0,
                  marginTop: 4,
                  backgroundColor: "var(--bg-root)",
                  border: "1px solid var(--border-medium)",
                  borderRadius: 6,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                  zIndex: 1000,
                  minWidth: 180,
                  maxWidth: 300,
                  maxHeight: 200,
                  overflow: "auto",
                }}
              >
                {paths.map((p) => (
                  // 每个路径两项：**动作在前、路径在后**（两个动作对同一路径，
                  // 路径放前面会把两项挤成两行重复的长文本，反而看不出区别）。
                  // 路径过长由 ellipsis 截断，悬停看完整（title）。
                  <React.Fragment key={p}>
                    <div
                      onClick={async () => {
                        // 内部按类型分流（图片/PDF 走预览、文本走编辑），
                        // 读失败会自动回退到资源管理器 —— 所以这里只管成功/失败提示
                        const ok = await openPathInEditor(p);
                        if (!ok) addStatusMessage(`${t("files.pathNotFound")}: ${p}`, "error");
                        clear();
                      }}
                      style={{ ...pathItemStyle, color: "var(--fg-primary)" }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-hover)")}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                      title={`${t("files.openInEditor")} — ${p}`}
                    >
                      📝 {t("files.openInEditor")}
                      <span style={pathDimStyle}> — {p}</span>
                    </div>
                    <div
                      onClick={async () => {
                        try {
                          const { invoke } = await import("@tauri-apps/api/core");
                          await invoke("open_in_explorer", { path: p });
                        } catch {
                          // 路径不存在等 → 提示，不再打开资源管理器
                          addStatusMessage(`${t("files.pathNotFound")}: ${p}`, "error");
                        }
                        clear();
                      }}
                      style={{ ...pathItemStyle, color: "var(--fg-secondary)" }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-hover)")}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                      title={`${t("files.openInExplorer")} — ${p}`}
                    >
                      📂 {t("files.openInExplorer")}
                      <span style={pathDimStyle}> — {p}</span>
                    </div>
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}