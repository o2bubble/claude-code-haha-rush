// ── MsgQueuePanel — 消息队列面板 ──
// 收起/展开状态由 useMsgQueueCollapse() 统一持有(见下), 本组件纯展示。
//   top 位置: stub→占位条 / slim→头部细条 / expanded→头部+列表
//   right 位置: 仅在 expanded 时挂载(220px 侧栏); 收起时由 ChatInputPanel 渲染
//               MsgQueueFooterCapsule 到输入框 footer 行(释放横向空间)
// 数据来自 msgQueueStore(活跃会话); 立即发送/恢复自动 走 chatSession(会触发消化)

import React, { useEffect, useRef, useState } from "react";
import { Clock, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Edit3, Trash2, Eraser, Zap, Pause, Play, X, PanelTop, PanelRight } from "lucide-react";
import {
  getActiveQueue, subscribeMsgQueues,
  interruptQueue, removeAt, clearQueueNow, updateTextAt, moveItemAt,
} from "../../stores/msgQueueStore";
import { chatSession } from "../../chat/chatSession";
import { saveSettings, getSettings } from "../../stores/settingsStore";
import { useEvent } from "../../services/useService";
import { Events, type SettingsChangedPayload } from "../../services/events";
import {
  createCollapseState, onCountChange, onClickStub, onCollapse, onExpand,
  type CollapseState, type QueueDisplay,
} from "./msgQueueCollapseState";
import { t } from "../../i18n";

const iconBtn: React.CSSProperties = { background: "transparent", border: "none", cursor: "pointer", color: "var(--fg-muted)", padding: 2, display: "inline-flex", borderRadius: 4 };

/** 消息队列布局位置(设置): "top"(输入框上方) / "right"(聊天右侧)。 */
export function useQueuePosition(): "top" | "right" {
  const settingsPayload = useEvent<SettingsChangedPayload>(Events.SETTINGS_CHANGED);
  return settingsPayload?.settings?.msgQueuePosition ?? getSettings().msgQueuePosition ?? "top";
}

/** 收起/展开状态机 — 由 ChatInputPanel 持有, 传给面板与 footer 胶囊共享。 */
export function useMsgQueueCollapse() {
  const [, force] = useState(0);
  const ref = useRef<CollapseState | null>(null);
  useEffect(() => {
    ref.current = createCollapseState(getActiveQueue().messages.length);
    return subscribeMsgQueues(() => {
      if (ref.current) ref.current = onCountChange(ref.current, getActiveQueue().messages.length);
      force((x) => x + 1);
    });
  }, []);
  const collapse = ref.current ?? createCollapseState(getActiveQueue().messages.length);
  const toggle = () => {
    if (!ref.current) return;
    const s = ref.current;
    ref.current = s.display === "stub" ? onClickStub(s) : s.display === "expanded" ? onCollapse(s) : onExpand(s);
    force((x) => x + 1);
  };
  return { display: collapse.display, toggle };
}

export function MsgQueuePanel({ pos, bare, display, onToggle }: {
  pos: "top" | "right"; bare?: boolean; display: QueueDisplay; onToggle: () => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const queue = getActiveQueue();

  const toggleAuto = () => {
    if (queue.autoSend) interruptQueue();
    else chatSession.queueResume();
  };
  const startEdit = (i: number) => { setEditing(i); setEditText(queue.messages[i].text); };
  const saveEdit = () => {
    if (editing !== null && editText.trim()) updateTextAt(editing, editText);
    setEditing(null);
  };

  const scrollStyle: React.CSSProperties =
    pos === "top"
      ? { maxHeight: 180, overflowY: "auto" }
      : { flex: 1, minHeight: 0, overflowY: "auto" };

  // 展开态容器样式: right 220px 侧栏(flex 撑满 + borderLeft 分隔); top 无固定宽度
  const rootStyle: React.CSSProperties = {
    display: "flex", flexDirection: "column", minHeight: 0,
    background: "var(--bg-surface)",
    border: bare ? "none" : "1px solid var(--border-medium)",
    borderRadius: bare ? 0 : "var(--radius-md)",
    ...(pos === "right" && display === "expanded"
      ? { flex: 1, boxSizing: "border-box" as const, borderLeft: "1px solid var(--border-light)", marginLeft: 8, width: 220 }
      : {}),
  };

  // top 位 stub → 占位条(可点击展开)
  if (display === "stub") {
    return (
      <div onClick={onToggle} title={t("msgQueue.expand")} style={{ ...rootStyle, cursor: "pointer" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 10px", fontSize: 12 }}>
          <Clock size={13} color="var(--accent)" />
          <b style={{ color: "var(--fg-primary)" }}>{t("msgQueue.title")}</b>
          <span style={{ marginLeft: "auto", color: "var(--fg-muted)", display: "flex" }}><ChevronUp size={13} /></span>
        </div>
      </div>
    );
  }

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 10px", borderBottom: "1px solid var(--border-light)", fontSize: 12, flexShrink: 0 }}>
      <Clock size={13} color="var(--accent)" />
      <b style={{ color: "var(--fg-primary)" }}>{t("msgQueue.count", { n: queue.messages.length })}</b>
      <button onClick={toggleAuto} title={queue.autoSend ? t("msgQueue.pauseHint") : t("msgQueue.resumeHint")}
        style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer", border: "1px solid " + (queue.autoSend ? "var(--semantic-success)" : "var(--semantic-warning)"), color: queue.autoSend ? "var(--semantic-success)" : "var(--semantic-warning)", background: "var(--bg-root)", borderRadius: 999, padding: "2px 8px", fontSize: 11, fontWeight: 600, flexShrink: 0 }}>
        {queue.autoSend ? <Play size={11} /> : <Pause size={11} />}
        {queue.autoSend ? t("msgQueue.auto") : t("msgQueue.paused")}
      </button>
      <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
        <button onClick={() => saveSettings({ msgQueuePosition: pos === "top" ? "right" : "top" }, "global")}
          title={pos === "top" ? t("msgQueue.switchRight") : t("msgQueue.switchTop")}
          style={iconBtn}>
          {pos === "top" ? <PanelRight size={13} /> : <PanelTop size={13} />}
        </button>
        {display === "expanded" && queue.messages.length > 0 && (
          <button onClick={clearQueueNow} title={t("msgQueue.clearAll")} style={iconBtn}><Eraser size={13} /></button>
        )}
        <button onClick={onToggle} title={display === "slim" ? t("msgQueue.expand") : t("msgQueue.collapse")} style={iconBtn}>
          {display === "slim"
            ? <ChevronUp size={13} />
            : pos === "right" ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>
    </div>
  );

  // top 位 slim → 仅头部细条
  if (display === "slim") {
    return (
      <div style={rootStyle}>
        {header}
      </div>
    );
  }

  // 展开态: 头部 + (空态占位 或 列表)
  return (
    <>
      <div style={rootStyle}>
        {header}
        {queue.messages.length === 0 ? (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--fg-muted)" }}>{t("msgQueue.empty")}</div>
        ) : (
          <div style={scrollStyle}>
            {queue.messages.map((m, i) => (
              <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", borderBottom: "1px solid var(--border-light)" }}>
                <span style={{ flexShrink: 0, width: 16, height: 16, borderRadius: 4, background: "var(--accent-subtle)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 600 }}>{i + 1}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--fg-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={m.text}>{m.text}</span>
                <div style={{ display: "flex", gap: 1, flexShrink: 0 }}>
                  <button onClick={() => chatSession.queueSendNow(i)} title={t("msgQueue.sendNow")} style={iconBtn}><Zap size={13} /></button>
                  <button onClick={() => moveItemAt(i, i - 1)} title={t("msgQueue.up")} style={iconBtn}><ChevronUp size={13} /></button>
                  <button onClick={() => moveItemAt(i, i + 1)} title={t("msgQueue.down")} style={iconBtn}><ChevronDown size={13} /></button>
                  <button onClick={() => startEdit(i)} title={t("msgQueue.edit")} style={iconBtn}><Edit3 size={13} /></button>
                  <button onClick={() => removeAt(i)} title={t("msgQueue.remove")} style={iconBtn}><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 编辑弹窗 */}
      {editing !== null && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setEditing(null); }}>
          <div style={{ width: 480, maxWidth: "90vw", background: "var(--bg-surface)", border: "1px solid var(--border-medium)", borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-lg)", padding: 16, fontFamily: "var(--font-sans)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <b style={{ fontSize: 13, color: "var(--fg-primary)" }}>{t("msgQueue.editTitle", { n: editing + 1 })}</b>
              <button onClick={() => setEditing(null)} style={iconBtn}><X size={14} /></button>
            </div>
            <textarea value={editText} onChange={(e) => setEditText(e.target.value)} autoFocus
              style={{ width: "100%", minHeight: 90, resize: "vertical", boxSizing: "border-box", padding: 8, border: "1px solid var(--border-medium)", borderRadius: 6, fontFamily: "var(--font-sans)", fontSize: 13, background: "var(--bg-root)", color: "var(--fg-primary)" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
              <button onClick={() => setEditing(null)} style={{ border: "1px solid var(--border-medium)", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: "var(--font-sans)", fontSize: 12, background: "var(--bg-root)", color: "var(--fg-primary)" }}>{t("msgQueue.cancel")}</button>
              <button onClick={saveEdit} style={{ border: "1px solid var(--border-medium)", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: "var(--font-sans)", fontSize: 12, background: "var(--accent)", color: "var(--fg-inverse)" }}>{t("msgQueue.save")}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** right 位收起态的胶囊 — 渲染在输入框 footer 行(发送按钮旁), 释放横向空间。 */
export function MsgQueueFooterCapsule({ onToggle }: { onToggle: () => void }) {
  const queue = getActiveQueue();
  return (
    <button onClick={onToggle} title={t("msgQueue.expand")}
      style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 999,
        border: "1px solid var(--border-medium)", background: "var(--bg-surface)", cursor: "pointer",
        fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--fg-primary)", flexShrink: 0 }}>
      <span title={queue.autoSend ? t("msgQueue.auto") : t("msgQueue.paused")}
        style={{ width: 6, height: 6, borderRadius: "50%", background: queue.autoSend ? "var(--semantic-success)" : "var(--semantic-warning)" }} />
      <b style={{ fontWeight: 600 }}>{queue.messages.length}</b>
      <span style={{ color: "var(--fg-muted)", display: "flex" }}><ChevronLeft size={12} /></span>
    </button>
  );
}
