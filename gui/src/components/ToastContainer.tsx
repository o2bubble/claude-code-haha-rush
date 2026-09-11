// ── ToastContainer — 前台通知（右下角滑入），StatusBar 退化为历史日志 ──

import { useCallback, useEffect, useReducer, useRef } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, X } from "lucide-react";
import { t } from "../i18n";
import { getStatusMessages, subscribeStatusMessages, type StatusMessage } from "../stores/statusMsgStore";
import { STATUS_LEVEL_COLOR } from "../utils/statusLevels";

/** 自动消失时长（ms）；error 常驻直到手动关闭 */
const DURATION: Record<StatusMessage["level"], number> = {
  success: 3000,
  warn: 6000,
  error: Infinity,
  info: Infinity, // info 不进 Toast
};

const ICONS: Record<StatusMessage["level"], React.ReactNode> = {
  error: <AlertCircle size={15} />,
  warn: <AlertTriangle size={15} />,
  success: <CheckCircle2 size={15} />,
  info: null,
};

// COLORS 已由 STATUS_LEVEL_COLOR 统一提供

/** 同时可见的最大条数；超出排队，有空位按序补上，不再吞掉 */
const MAX_VISIBLE = 3;

interface ToastItem {
  msg: StatusMessage;
  leaving: boolean;
}

interface ToastState {
  active: ToastItem[];
  /** 待显示队列 — 满栈时进入，空位后按序补上 */
  pending: StatusMessage[];
}

type ToastAction =
  | { type: "enqueue"; messages: StatusMessage[] }
  | { type: "setLeaving"; id: string }
  | { type: "dismiss"; id: string };

function toastReducer(state: ToastState, action: ToastAction): ToastState {
  switch (action.type) {
    case "enqueue": {
      let active = [...state.active];
      let pending = [...state.pending];
      for (const m of action.messages) {
        if (active.some((t) => t.msg.id === m.id)) continue;
        if (active.length < MAX_VISIBLE) {
          // 追加到末尾 — 新 toast 出现在底部，已有条目只整体上移、不重排
          active = [...active, { msg: m, leaving: false }];
        } else if (m.level === "error") {
          // 满栈时 error 抢占一个非 error 的位置（原位替换，不重排）
          const idx = active.findIndex((t) => t.msg.level !== "error");
          if (idx !== -1) {
            active = [...active.slice(0, idx), { msg: m, leaving: false }, ...active.slice(idx + 1)];
          } else {
            pending = [...pending, m];
          }
        } else {
          pending = [...pending, m];
        }
      }
      return { active, pending };
    }
    case "setLeaving":
      return {
        active: state.active.map((t) =>
          t.msg.id === action.id ? { ...t, leaving: true } : t
        ),
        pending: state.pending,
      };
    case "dismiss": {
      const active = state.active.filter((t) => t.msg.id !== action.id);
      const [first, ...rest] = state.pending;
      if (first && active.length < MAX_VISIBLE) {
        return { active: [...active, { msg: first, leaving: false }], pending: rest };
      }
      return { active, pending: state.pending };
    }
  }
}

export default function ToastContainer() {
  const [state, dispatch] = useReducer(toastReducer, { active: [], pending: [] });
  const seenRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissAnimated = useCallback((id: string) => {
    // 先清掉自动消失定时器，避免手动关闭后残留空跑
    const t = timersRef.current.get(id);
    if (t) { clearTimeout(t); timersRef.current.delete(id); }
    dispatch({ type: "setLeaving", id });
    setTimeout(() => dispatch({ type: "dismiss", id }), 200);
  }, []);

  // 新消息：未消费过且非 info（info 只进历史日志）
  useEffect(() => {
    return subscribeStatusMessages(() => {
      const all = getStatusMessages();
      const fresh = all.filter((m) => !seenRef.current.has(m.id) && m.level !== "info");
      if (fresh.length === 0) return;
      fresh.forEach((m) => seenRef.current.add(m.id));
      dispatch({ type: "enqueue", messages: fresh });
    });
  }, []);

  // 为新增的非驻留 toast 启动自动消失定时器；
  // leaving 中的条目不重装 timer（避免 dismissAnimated 清 timer 后又被 effect 补装孤儿 timer）；
  // 顺带清理已不在 active 里的 timer（error 抢占顶掉的条目、已 dismiss 的条目）。
  useEffect(() => {
    for (const item of state.active) {
      const id = item.msg.id;
      if (item.leaving) continue;
      if (timersRef.current.has(id)) continue;
      const dur = DURATION[item.msg.level];
      if (dur === Infinity) continue;
      timersRef.current.set(id, setTimeout(() => dismissAnimated(id), dur));
    }
    const activeIds = new Set(state.active.map((t) => t.msg.id));
    for (const [id, t] of timersRef.current) {
      if (!activeIds.has(id)) {
        clearTimeout(t);
        timersRef.current.delete(id);
      }
    }
  }, [state.active, dismissAnimated]);

  // 卸载时清理所有 timer
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  if (state.active.length === 0) return null;

  return (
    <div
      data-od-id="toast-container"
      style={{
        position: "fixed", right: 16, bottom: 40, zIndex: 100000,
        display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end",
      }}
    >
      {state.active.map(({ msg, leaving }) => (
        <div
          key={msg.id}
          onClick={() => dismissAnimated(msg.id)}
          style={{
            display: "flex", alignItems: "center", gap: 8,
            maxWidth: 340, padding: "8px 12px",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-medium)",
            borderLeft: `3px solid ${STATUS_LEVEL_COLOR[msg.level]}`,
            borderRadius: "var(--radius-lg)",
            boxShadow: "var(--shadow-lg)",
            fontFamily: "var(--font-sans)", fontSize: 12, color: "var(--fg-primary)",
            cursor: "pointer",
            animation: leaving ? "toast-out 0.2s forwards" : "toast-in 0.25s",
          }}
        >
          <span style={{ color: STATUS_LEVEL_COLOR[msg.level], flexShrink: 0 }}>{ICONS[msg.level]}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{msg.text}</span>
          <span
            role="button"
            aria-label={t("floating.close")}
            onClick={(e) => { e.stopPropagation(); dismissAnimated(msg.id); }}
            style={{ flexShrink: 0, color: "var(--fg-muted)", cursor: "pointer", display: "flex" }}
          >
            <X size={13} />
          </span>
        </div>
      ))}
      <style>{`
        @keyframes toast-in {
          from { opacity: 0; transform: translateX(30px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes toast-out {
          from { opacity: 1; transform: translateX(0); }
          to   { opacity: 0; transform: translateX(30px); }
        }
      `}</style>
    </div>
  );
}
