import React, { useRef, useCallback, useLayoutEffect, useState, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import type { ChatMessage } from "../../stores/chatStore";
import { MessageItem } from "./MessageItem";
import { SelectionToolbar } from "./SelectionToolbar";
import { ErrorBoundary } from "../ErrorBoundary";
import { t } from "../../i18n";

interface MessageListProps {
  /** 面板实际渲染的消息（「只看我的消息」的过滤由调用方做 —— 时间线/搜索的
   *  index 也基于同一个数组，否则下标空间不一致会导致跳错消息）。 */
  messages: ChatMessage[];
  /** 外部跳转目标（消息搜索/时间线）：index 是 `messages` 的下标，seq 递增触发 */
  scrollTarget?: { index: number; seq: number } | null;
}

/**
 * 虚拟滚动前的粗略高度估计(measureElement 会在渲染后测量修正)。
 * 只影响未渲染项的占位高度,不必精确。
 */
const MIN_ESTIMATE = 60;
const MAX_ESTIMATE = 420;
function estimateHeight(m?: ChatMessage): number {
  if (!m) return MIN_ESTIMATE;
  let size = 40;
  if (m.thinking) size += 80;
  if (m.content) size += Math.min(m.content.length * 0.9, 160);
  if (m.toolUses?.length) size += m.toolUses.length * 110;
  return Math.max(MIN_ESTIMATE, Math.min(MAX_ESTIMATE, size));
}

/**
 * 全量虚拟滚动的消息列表。
 * - 所有消息都在内存,初始滚到底部显示最新;向上滚自然看到更早(无分页)。
 * - 新消息只向下增长:跟随底部时每次渲染后钉住底部;上滚后停止跟随,
 *   新消息在下方累积不影响当前视口。
 * - 渲染窗口完全由虚拟列表决定,不再有 displayCount/冻结窗口那套机制。
 */
export function MessageList({ messages, scrollTarget }: MessageListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  // 是否跟随底部:初始 true;任何上滚动作立即置 false,回到真正底部才恢复
  const followRef = useRef(true);
  const prevScrollTopRef = useRef(0);
  const prevScrollHeightRef = useRef(0);

  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => estimateHeight(messages[index]),
    overscan: 8,
    getItemKey: (index) => messages[index]?.id ?? index,
    // 会话加载后直接锚定底部,避免首帧先画列表顶部再跳到底部(闪烁)
    initialOffset: () => Number.MAX_SAFE_INTEGER,
    // 默认 useFlushSync=true 会在 render/lifecycle 期间同步 flushSync(rerender),
    // 触发 React 警告。本组件用 useLayoutEffect 自行钉住底部,不需要同步重渲染。
    useFlushSync: false,
  });

  // 跟随底部:每次渲染后,若仍跟随则把滚动位置钉到最新。
  // 覆盖初始加载(滚动到最新)与流式期间(高度测量更新后补钉),是唯一锚点。
  useLayoutEffect(() => {
    if (!followRef.current) return;
    const el = parentRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const prevTop = prevScrollTopRef.current;
    const prevHeight = prevScrollHeightRef.current;
    const curTop = el.scrollTop;
    prevScrollTopRef.current = curTop;
    prevScrollHeightRef.current = el.scrollHeight;
    // 内容收缩(如流式结束时工具输出折叠)会让浏览器 clamp scrollTop 减小,
    // 那不是用户上滚,不停止跟随。只有 scrollHeight 未缩小时 scrollTop 减小
    // 才意味着用户手动上滚 → 立即停止跟随,自由回看历史。
    const contentShrank = el.scrollHeight < prevHeight;
    if (!contentShrank && curTop < prevTop - 0.5) {
      followRef.current = false;
    } else if (el.scrollHeight - curTop - el.clientHeight < 2) {
      // 回到真正的底部才恢复跟随(2px 容差吸收 scrollTop 取整误差)
      followRef.current = true;
    }
    const nearBottom = el.scrollHeight - curTop - el.clientHeight < 100;
    setShowJumpToBottom((prev) => (prev === !nearBottom ? prev : !nearBottom));
  }, []);

  const jumpToBottom = useCallback(() => {
    followRef.current = true;
    setShowJumpToBottom(false);
    const el = parentRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // ── 跳到某条消息：**必须校验落点**，不能只调一次 scrollToIndex ──
  //
  // 虚拟列表对未渲染的行只有估算高度（estimateHeight），scrollToIndex 是按估算
  // 算偏移的；滚过去之后新渲染的行被真实测量、上方所有行的偏移随之改写，
  // 目标行就会被推出视野。实测真实会话（232 条）：index 161 落在视口上方 133px，
  // 完全看不见 —— 用户看到的就是「点了却定位到别的消息」。
  //
  // 做法：滚动 → 等一帧让测量发生 → 用目标行的**实际矩形**校正（直接调 scrollTop，
  // 比再走一次估算更准）→ 再确认，直到落点稳定或达到上限。目标行比视口还高时
  // 顶部对齐，避免居中把开头裁掉。
  const scrollRafRef = useRef(0);

  const scrollToIndexStable = useCallback(
    (index: number) => {
      const el = parentRef.current;
      if (!el) return;
      cancelAnimationFrame(scrollRafRef.current);

      const MAX_TRIES = 8;
      let tries = 0;

      // 落点是否已稳定（或已校正）；返回 true 表示不用再等
      const settle = (): boolean => {
        const row = el.querySelector<HTMLElement>(`[data-index="${index}"]`);
        if (!row) return false; // 还没渲染到目标 → 调用方会继续滚
        const view = el.getBoundingClientRect();
        const rect = row.getBoundingClientRect();
        // 比视口还高的行居中会把开头裁到视野外 → 顶部对齐
        const wantTop =
          rect.height > view.height - 24
            ? view.top + 8
            : view.top + (view.height - rect.height) / 2;
        const delta = rect.top - wantTop;
        if (Math.abs(delta) <= 6) return true;
        el.scrollTop += delta;
        return false;
      };

      const tick = () => {
        if (settle() || tries >= MAX_TRIES) return;
        tries++;
        // 目标行不在渲染窗口里（估算偏差太大）→ 再按索引滚一次
        if (!el.querySelector(`[data-index="${index}"]`)) {
          rowVirtualizer.scrollToIndex(index, { align: "center" });
        }
        scrollRafRef.current = requestAnimationFrame(tick);
      };

      rowVirtualizer.scrollToIndex(index, { align: "center" });
      scrollRafRef.current = requestAnimationFrame(tick);
    },
    [rowVirtualizer],
  );

  // 外部跳转（消息搜索 / 时间线）：滚动到指定消息并停止跟随，方便浏览匹配上下文
  useEffect(() => {
    if (!scrollTarget) return;
    const { index } = scrollTarget;
    if (index < 0 || index >= messages.length) return;
    followRef.current = false;
    scrollToIndexStable(index);
    return () => cancelAnimationFrame(scrollRafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTarget?.seq]);

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        ref={parentRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflow: "auto",
          padding: "8px 16px",
        }}
      >
        {messages.length === 0 ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "var(--fg-muted)",
              fontSize: 14,
              fontFamily: "var(--font-sans)",
            }}
          >
            {t("chat.startConversation")}
          </div>
        ) : (
          <div style={{ height: rowVirtualizer.getTotalSize(), width: "100%", position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                // display:flex 使子元素 marginBottom 计入测量(否则 margin 会折叠出父容器,行高测少)
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <ErrorBoundary panelName="Messages">
                  <MessageItem
                    message={messages[virtualRow.index]}
                    animateIn={virtualRow.index === messages.length - 1}
                  />
                </ErrorBoundary>
              </div>
            ))}
          </div>
        )}
      </div>

      {showJumpToBottom && (
        <button
          onClick={jumpToBottom}
          title={t("message.backToBottom")}
          style={{
            position: "absolute",
            bottom: 16,
            right: 24,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "7px 14px",
            borderRadius: 20,
            border: "1px solid var(--border-medium)",
            backgroundColor: "var(--bg-surface)",
            color: "var(--fg-primary)",
            fontSize: 12,
            fontFamily: "var(--font-sans)",
            cursor: "pointer",
            boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
            zIndex: 10,
          }}
        >
          <ArrowDown size={14} />
          {t("message.backToBottom")}
        </button>
      )}

      <SelectionToolbar container={parentRef} />
    </div>
  );
}
