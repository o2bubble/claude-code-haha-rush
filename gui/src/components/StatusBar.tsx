// ── StatusBar — 轻量状态条 + 消息列表 ──
// 职责界定: 本组件**不承担提醒职责**（那是 ToastContainer 的活）。
// 它只做两件事: ① 有新消息时以最小视觉重点自动展开显示、几秒后收回;
//              ② 点击展开完整消息列表（倒序，最新在上）。
// 因此这里不做浮出告警卡片、不放动作按钮、也不复述连接状态。
// 详细规格: docs/status-bar-design-spec.md

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import {
  getStatusMessages,
  subscribeStatusMessages,
  clearStatusMessages,
  type StatusMessage,
} from "../stores/statusMsgStore";
import { STATUS_LEVEL_COLOR } from "../utils/statusLevels";

/** 字号跟随用户设置（项目约定：所有 UI 文字用 font-scale 计算，见 docs/gui/gui-agent-guide.md） */
const FS = (px: number) => `calc(var(--font-scale, 1) * ${px}px)`;

/** 展开显示时长（ms）—— 走过即收回 */
const AUTO_SHOW_MS = 5000;

/** 展开宽度上限：长消息截断，不撑破布局 */
const PEEK_MAX_W = 260;
const PEEK_TEXT_MAX_W = 200;
/** 收回态宽度上限。`max-width` 对 inline-flex 只是上限 —— 实际宽度仍由内容决定
 *  （圆点 + 计数，实测约 32px），此值只须"足够宽到不裁剪"并尽量贴近内容宽
 *  （超大值会让展开瞬间产生可见跳变）。
 *  曾写死 22（按"折叠宽度 ≈ 内容宽"估的），实测计数被 `overflow:hidden` 裁掉 ——
 *  而收回态是常态（5s 后即收回），等于用户绝大多数时间看不到消息条数。
 *  64 = padding16 + 圆点7 + gap5 + 计数区(边距6 + 三位数 × --font-scale)。
 *  不用 `none`：CSS 无法在 `none` 与长度值之间过渡，会丢失展开/收回动画。 */
const PEEK_COLLAPSED_MAX_W = 64;

const LEVEL_DOT: Record<StatusMessage["level"], string> = {
  info: STATUS_LEVEL_COLOR.info,
  warn: STATUS_LEVEL_COLOR.warn,
  error: STATUS_LEVEL_COLOR.error,
  success: STATUS_LEVEL_COLOR.success,
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

/** 消息列表浮层 —— 向上覆盖，不吃布局流 */
function MessageList({ msgs, onClose }: { msgs: StatusMessage[]; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);

  // 点外部 / Esc 关闭
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // 延后一帧绑定，避免触发本次点击自己
    const id = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      data-od-id="status-message-list"
      style={{
        // fixed 定位到左下角（与胶囊同一角落，向上展开）。
        // 不能用 absolute 相对 StatusBar 根节点 —— 那是个 height:0 的占位，
        // 100% 会算成 0，浮层被推到视口下方之外。
        position: "fixed", left: 8, bottom: 32, zIndex: 90001,
        width: "min(420px, calc(100vw - 24px))",
        maxHeight: 260, display: "flex", flexDirection: "column",
        backgroundColor: "var(--bg-root)",
        border: "1px solid var(--border-medium)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-lg)",
        overflow: "hidden",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div style={{
        display: "flex", alignItems: "center", gap: 6, padding: "6px 10px",
        borderBottom: "1px solid var(--border-light)",
        backgroundColor: "var(--bg-surface)", flexShrink: 0,
      }}>
        <span style={{ fontSize: FS(11), fontWeight: 700, color: "var(--fg-secondary)" }}>
          {t("status.records")}
        </span>
        <span style={{
          fontSize: FS(10), color: "var(--fg-muted)", backgroundColor: "var(--bg-hover)",
          borderRadius: 8, padding: "0 6px", lineHeight: "15px",
        }}>
          {msgs.length}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => clearStatusMessages()}
          style={{
            border: 0, background: "transparent", cursor: "pointer",
            fontSize: FS(10.5), color: "var(--fg-muted)", fontFamily: "inherit",
            padding: "1px 6px", borderRadius: 3,
          }}
        >
          {t("status.clear")}
        </button>
      </div>

      <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
        {msgs.length === 0 ? (
          <div style={{ padding: 18, textAlign: "center", fontSize: FS(11.5), color: "var(--fg-muted)" }}>
            {t("status.noMessages")}
          </div>
        ) : (
          // 倒序：最新在上（现状是最老在上，得翻到底才看到刚发生的）
          [...msgs].reverse().map((m) => (
            <div
              key={m.id}
              style={{
                display: "flex", alignItems: "flex-start", gap: 8,
                padding: "6px 10px", borderBottom: "1px solid var(--border-light)",
                fontSize: FS(11.5), lineHeight: 1.5,
              }}
            >
              <span style={{
                width: 3, alignSelf: "stretch", minHeight: 14, borderRadius: 2,
                backgroundColor: STATUS_LEVEL_COLOR[m.level], flexShrink: 0,
              }} />
              <span style={{ flex: 1, wordBreak: "break-word", color: "var(--fg-primary)" }}>
                {m.text}
              </span>
              <span style={{
                flexShrink: 0, fontSize: FS(10), color: "var(--fg-muted)",
                fontVariantNumeric: "tabular-nums", fontFamily: "var(--font-mono)",
              }}>
                {fmtTime(m.timestamp)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function _StatusBar() {
  const t = useT();
  const [msgs, setMsgs] = useState<StatusMessage[]>(() => [...getStatusMessages()]);
  const [expanded, setExpanded] = useState(false);
  // 当前自动展开的消息 id + 起始时刻。null = 收回态。
  const [peek, setPeek] = useState<{ id: string; at: number } | null>(null);

  // 新消息 → 自动展开 + 重置计时
  useEffect(() => {
    return subscribeStatusMessages(() => {
      const all = getStatusMessages();
      setMsgs([...all]);
      if (all.length > 0) setPeek({ id: all[all.length - 1].id, at: Date.now() });
    });
  }, []);

  // 悬停态放 ref —— 计时器读它判断暂停（不触发重渲染）
  const hoverRef = useRef(false);
  const [hover, setHover] = useState(false);

  // 计时收回：每 250ms 检查一次。
  // 悬停中 → 不断续期（等效暂停）；离开后 at 已重置 → 重新起算完整 5s。
  // 依赖用 peek?.id 而非 peek：续期只改 at，不必重建 interval。
  useEffect(() => {
    if (!peek) return;
    const id = setInterval(() => {
      setPeek((p) => {
        if (!p) return p;
        if (hoverRef.current) return { ...p, at: Date.now() };              // 悬停 → 续期
        return Date.now() - p.at >= AUTO_SHOW_MS ? null : p;                // 超时 → 收回
      });
    }, 250);
    return () => clearInterval(id);
  }, [peek?.id]);

  const onEnter = useCallback(() => { hoverRef.current = true; setHover(true); }, []);
  const onLeave = useCallback(() => {
    hoverRef.current = false;
    setHover(false);
    setPeek((p) => (p ? { ...p, at: Date.now() } : p));   // 离开重新起算完整 5s
  }, []);

  // 无任何消息：不渲染（避免出现「◯ 0」这种无意义元素）
  if (msgs.length === 0) return null;

  const newest = msgs[msgs.length - 1];
  // 只呈现消息本身。**不复述连接状态** —— 那是 ChatStatusBar 的职责，
  // 且 spec §1.1/§10 明确把「连接状态展示」列为非目标（本组件不承担提醒职责）。
  const showing = (peek && peek.id === newest.id) || hover;
  const dot = showing ? LEVEL_DOT[newest.level] : "var(--fg-muted)";
  const text = showing ? newest.text : null;

  return (
    <div style={{ flexShrink: 0 }}>
      {/* 动效降级：展开/收起不做宽度过渡（同 WorkspaceSelector 的注入式媒体查询） */}
      <style>{`@media (prefers-reduced-motion: reduce) {
        [data-od-id="status-peek"] { transition: none !important; }
      }`}</style>

      {/* 浮层：向上覆盖，不占布局高度 */}
      {expanded && <MessageList msgs={msgs} onClose={() => setExpanded(false)} />}

      {/* 胶囊 —— 唯一元素。左下角，与右下角的 ToastContainer 错开 */}
      {!expanded && (
        <button
          type="button"
          data-od-id="status-peek"
          aria-label={t("status.records")}
          aria-expanded={expanded}
          title={t("status.records")}
          onClick={() => setExpanded(true)}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          style={{
            position: "fixed", left: 8, bottom: 6, zIndex: 90000,
            display: "inline-flex", alignItems: "center", gap: 5,
            // 展开态限制宽度（长消息截断）；收回态上限取 PEEK_COLLAPSED_MAX_W
            maxWidth: text ? PEEK_MAX_W : PEEK_COLLAPSED_MAX_W,
            padding: "2px 8px", borderRadius: 10,
            border: `1px solid ${text ? "var(--border-medium)" : "var(--border-light)"}`,
            backgroundColor: text ? "var(--bg-root)" : "var(--bg-surface)",
            color: "var(--fg-secondary)",
            fontSize: FS(10), fontFamily: "var(--font-sans)",
            cursor: "pointer", opacity: text ? 0.9 : 0.5,
            boxShadow: text ? "var(--shadow-sm)" : "none",
            overflow: "hidden",
            transition: "max-width .28s cubic-bezier(.4,0,.2,1), opacity .15s, border-color .15s",
          }}
        >
          <span style={{
            width: 7, height: 7, borderRadius: "50%",
            backgroundColor: dot, flexShrink: 0,
          }} />
          {text && (
            <span style={{
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              maxWidth: PEEK_TEXT_MAX_W, color: "var(--fg-primary)",
            }}>
              {text}
            </span>
          )}
          <span style={{
            flexShrink: 0, fontVariantNumeric: "tabular-nums",
            paddingLeft: 5, borderLeft: "1px solid var(--border-light)",
          }}>
            {msgs.length}
          </span>
        </button>
      )}
    </div>
  );
}

export default memo(_StatusBar);
