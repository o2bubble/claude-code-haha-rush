// TimeLineBar — 消息面板左侧的时间线导航栏（右侧有滚动条，放左边避免误触）。
// 静止态：粗刻度标尺（日期分组 + 整点）。拖动/点击：指针 → 时间（秒级 tooltip）→
// 定位到该时刻之前最近一条消息（通过 onSeek(index) 通知父级滚动）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n";
import {
  buildTicks, timeToIndex, pixelToTime, timeToPixel,
  segmentizeByDay, layoutSegments, MIN_SEGMENT_PX,
  findNearestPrompt, clusterPrompts, pickEven,
  type UserPrompt, type UserPromptHit,
} from "./timelineMath";

interface TimeLineBarProps {
  /** 消息时间戳（毫秒），须递增 */
  timestamps: number[];
  /** 定位到某条消息（index） */
  onSeek: (index: number) => void;
  /** 用户提示刻度（回溯"我在哪儿说过什么"）；缺省则只画原有日期/时间刻度 */
  userPrompts?: UserPrompt[];
}

/** 用户提示刻度的数量上限：超过则均分取样（保首末）。提示本就比助手消息稀疏，
 *  正常会话远达不到；设上限只为防极端场景糊成一条线。 */
const MAX_USER_TICKS = 120;
/** 吸附半径（px）：指针离刻度多近就"吸"到它。点击与拖动共用（走 seekFromClientY）。 */
const PROMPT_HIT_RADIUS = 7;
/** 渲染聚类阈值（px）：中心距小于它就并作一个标记。
 *  点的视觉直径约 6-7px（5px + 1px 描边），取 8 保证相邻点不接触。 */
const CLUSTER_MIN_GAP = 8;

// 精简态（未 hover）窄条，只显示刻度小点；hover/拖动时展开为详细宽条。
// 展开态需容纳「MM-DD HH:MM」日期+时间，故较宽。
const COLLAPSED_WIDTH = 12;
const EXPANDED_WIDTH = 72;
// 触发展开/收起的防抖延时 — 鼠标快速经过窄条时不会立即展开抖动
const HOVER_EXPAND_DELAY = 350;
const HOVER_COLLAPSE_DELAY = 200;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatTime(time: number, withSeconds: boolean): string {
  const d = new Date(time);
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 轴时间格式：今天只显示时分(秒)，非今天带日期前缀，避免跨天会话看不出日期 */
function formatAxisTime(time: number, withSeconds: boolean, now: number): string {
  const d = new Date(time);
  if (isSameDay(d, new Date(now))) return formatTime(time, withSeconds);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatTime(time, withSeconds)}`;
}

function dayLabel(time: number, now: number): string {
  const d = new Date(time);
  const n = new Date(now);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOfDay(n) - startOfDay(d)) / 86400000);
  if (diff === 0) return t("timeline.today");
  if (diff === 1) return t("timeline.yesterday");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function TimeLineBar({ timestamps, onSeek, userPrompts }: TimeLineBarProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [hoverY, setHoverY] = useState<number | null>(null);
  const [dragY, setDragY] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const rafRef = useRef(0);
  const lastMoveYRef = useRef(0);
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  // hover 展开/收起防抖 timer — 快速经过窄条时不立即触发
  const hoverTimerRef = useRef<number | null>(null);
  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);
  useEffect(() => () => clearHoverTimer(), [clearHoverTimer]);

  // hover 或拖动时展开为详细宽条
  const expanded = hovered || dragging;
  const width = expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH;

  // 跟踪容器高度（面板可伸缩）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // 按日历日分桶：有消息的天各占一段轴高，没消息的天省略不占空间
  const layout = useMemo(() => {
    if (timestamps.length === 0) return [];
    return layoutSegments(segmentizeByDay(timestamps), height, MIN_SEGMENT_PX);
  }, [timestamps, height]);

  // 用户提示刻度 → 像素位置（时间线是分段映射，必须走 timeToPixel 而非线性换算）
  const userTicks = useMemo<UserPromptHit[]>(() => {
    if (!userPrompts || userPrompts.length === 0 || layout.length === 0) return [];
    const capped = userPrompts.length > MAX_USER_TICKS
      ? pickEven(userPrompts, MAX_USER_TICKS)
      : userPrompts;
    return capped.map((p) => ({ ...p, pixel: timeToPixel(p.time, layout) }));
  }, [userPrompts, layout]);

  // 用户提示刻度的像素位置（seekFromClientY 命中判定用；须与渲染同一套映射）
  const userTicksRef = useRef<UserPromptHit[]>([]);
  userTicksRef.current = userTicks;

  const seekFromClientY = useCallback(
    (clientY: number) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const y = Math.min(el.clientHeight, Math.max(0, clientY - rect.top));
      // 落在用户提示刻度上 → 直接跳该条。不做「像素→时间→二分」反算：
      // 反算有时间取整误差，会落到前一条（实测点第 3 个刻度跳到了 index 3
      // 而目标是 index 4）。刻度自身的 index 才是准确意图。
      const hit = findNearestPrompt(y, userTicksRef.current, PROMPT_HIT_RADIUS);
      if (hit) {
        onSeekRef.current(hit.index);
        return;
      }
      const time = pixelToTime(y, layout);
      const idx = timeToIndex(timestamps, time);
      if (idx >= 0) onSeekRef.current(idx);
    },
    [layout, timestamps]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDragging(true);
      setDragY(e.clientY);
      setHoverY(null);
      seekFromClientY(e.clientY);
    },
    [seekFromClientY]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragging) {
        lastMoveYRef.current = e.clientY;
        setDragY(e.clientY);
        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = 0;
            // 取 rAF 触发时刻的最新坐标，避免 seek 落后指针一帧
            seekFromClientY(lastMoveYRef.current);
          });
        }
      } else {
        setHoverY(e.clientY);
      }
    },
    [dragging, seekFromClientY]
  );

  const handlePointerUp = useCallback(() => {
    setDragging(false);
    setDragY(null);
  }, []);

  const pointerY = dragging ? dragY : hoverY;
  let pointerPixel: number | null = null;
  // 容器屏幕矩形：pointerPixel 换算要用（提示浮层不依赖它 —— 见下方 CSS left:100%）
  let barRect: DOMRect | null = null;
  if (containerRef.current) {
    barRect = containerRef.current.getBoundingClientRect();
    if (pointerY !== null) {
      pointerPixel = Math.min(height, Math.max(0, pointerY - barRect.top));
    }
  }

  // 当前吸附的用户提示刻度（悬停与**拖动**共用）——拖动时 pointerPixel 取自 dragY，
  // 所以拖动过程中它就是"吸到了哪条"，浮层实时跟随，松开前就能确认。
  // 早先 dragging 时返回 null，导致拖动全程看不到吸附结果（密集时无从判断）。
  const hoveredPrompt = useMemo(
    () => (pointerPixel === null ? null : findNearestPrompt(pointerPixel, userTicks, PROMPT_HIT_RADIUS)),
    [pointerPixel, userTicks],
  );

  // 渲染聚类：密集区只画一个标记，避免点糊成一片（吸附仍用原始刻度）
  const promptClusters = useMemo(
    () => clusterPrompts(userTicks, CLUSTER_MIN_GAP),
    [userTicks],
  );

  // 吸附目标在其簇内的序号（密集时告诉用户"这里挤了几条、当前是第几条"）
  const clusterPos = useMemo(() => {
    if (!hoveredPrompt) return null;
    for (const c of promptClusters) {
      const i = c.items.findIndex((it) => it.index === hoveredPrompt.index);
      if (i >= 0) return { pos: i + 1, total: c.items.length };
    }
    return null;
  }, [hoveredPrompt, promptClusters]);

  return (
    <div
      ref={containerRef}
      title={t("timeline.dragHint")}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerEnter={() => {
        clearHoverTimer();
        hoverTimerRef.current = window.setTimeout(() => setHovered(true), HOVER_EXPAND_DELAY);
      }}
      onPointerLeave={() => {
        clearHoverTimer();
        hoverTimerRef.current = window.setTimeout(() => {
          setHovered(false);
          setHoverY(null);
        }, HOVER_COLLAPSE_DELAY);
      }}
      style={{
        width,
        flexShrink: 0,
        position: "relative",
        background: expanded ? "var(--bg-surface)" : "transparent",
        borderRight: "1px solid var(--border-light)",
        cursor: "ns-resize",
        touchAction: "none",
        userSelect: "none",
        overflow: "hidden",
        transition: "width 0.15s ease",
      }}
    >
      {/* 中心竖线 */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 0,
          bottom: 0,
          width: 1,
          background: "var(--border-light)",
          pointerEvents: "none",
        }}
      />

      {/* 刻度：展开态刻度线分左右（天=左、时间=右），精简态居中小刻度 */}
      {height > 0 &&
        layout.length > 0 &&
        buildTicks(layout, { maxCount: 8 }).map((tk, i) => {
          const y = timeToPixel(tk.time, layout);
          const isDay = tk.kind === "day";
          const lineColor = isDay ? "var(--accent)" : "var(--border-medium)";
          const tickLine = (side: "left" | "right" | "center") => {
            const base = {
              position: "absolute" as const,
              top: Math.min(height - 1, Math.max(0, y - 1)),
              height: 2,
              background: lineColor,
              pointerEvents: "none" as const,
            };
            if (side === "center") return { ...base, left: "50%", width: 6, marginLeft: -3 };
            if (side === "left") return { ...base, right: "50%", width: 10 }; // 竖线左侧，向左伸
            return { ...base, left: "50%", width: 10 }; // 竖线右侧，向右伸
          };
          return (
            <React.Fragment key={i}>
              {/* 刻度线：天在左、时间在右 */}
              <div
                style={expanded ? tickLine(isDay ? "left" : "right") : tickLine("center")}
              />
              {/* 展开态文字：左侧=天刻度(日期，稀疏显示)，右侧=时间刻度(时分) */}
              {expanded && isDay && tk.showLabel && (
                <div
                  style={{
                    position: "absolute",
                    right: "50%",
                    top: Math.min(height - 12, Math.max(0, y - 6)),
                    textAlign: "right",
                    paddingRight: 5,
                    fontSize: 10,
                    lineHeight: "12px",
                    fontWeight: 600,
                    color: "var(--accent)",
                    fontFamily: "var(--font-sans)",
                    pointerEvents: "none",
                  }}
                >
                  {dayLabel(tk.time, Date.now())}
                </div>
              )}
              {expanded && !isDay && (
                <div
                  style={{
                    position: "absolute",
                    left: "50%",
                    top: Math.min(height - 12, Math.max(0, y - 6)),
                    textAlign: "left",
                    paddingLeft: 5,
                    fontSize: 10,
                    lineHeight: "12px",
                    color: "var(--fg-muted)",
                    fontFamily: "var(--font-sans)",
                    pointerEvents: "none",
                  }}
                >
                  {formatTime(tk.time, false)}
                </div>
              )}
            </React.Fragment>
          );
        })}

      {/* 用户提示刻度：实心点，折叠态也显示（回溯定位的主要抓手）。
          颜色用 warning 琥珀，与天刻度(accent 蓝)/时间刻度(border 灰)区分。
          按像素聚类渲染 —— 密集区一个标记（尺寸编码密度），避免糊成一片。 */}
      {height > 0 &&
        promptClusters.map((c, i) => {
          const active = !!hoveredPrompt && c.items.some((it) => it.index === hoveredPrompt.index);
          const dense = c.items.length > 1;
          const size = active ? 9 : dense ? 7 : 5;
          return (
            <div
              key={`up-${i}`}
              style={{
                position: "absolute",
                left: "50%",
                top: Math.min(height - size, Math.max(0, c.pixel - size / 2)),
                width: size,
                height: size,
                marginLeft: -size / 2,
                borderRadius: "50%",
                background: active ? "var(--accent)" : "var(--semantic-warning)",
                // 细描边把点从中心竖线上"抬"起来，密集处也能分辨
                boxShadow: "0 0 0 1px var(--bg-surface)",
                pointerEvents: "none",
                zIndex: active ? 2 : 1,
              }}
            />
          );
        })}

      {/* 悬停到用户提示刻度 → 浮出预览。
          定位：`left = 栏左边缘 + 展开宽度`，**不用测出的 barRect.right** ——
          栏展开有 350ms 过渡，渲染期测到的矩形是展开前的窄态（12px），
          曾因此把浮层压在栏上。左边缘稳定、展开宽度是常量，二者相加即可。
          fixed 是必需的：容器 overflow:hidden 会把内部绝对定位的浮层裁掉。 */}
      {expanded && hoveredPrompt && barRect && (
        <div
          style={{
            position: "fixed",
            left: barRect.left + EXPANDED_WIDTH + 6,
            top: Math.min(
              Math.max(4, barRect.top + hoveredPrompt.pixel - 14),
              (typeof window !== "undefined" ? window.innerHeight : 800) - 64
            ),
            maxWidth: 260,
            padding: "4px 8px",
            borderRadius: 4,
            background: "var(--bg-root)",
            border: "1px solid var(--border-medium)",
            boxShadow: "var(--shadow-md)",
            fontSize: 11,
            lineHeight: 1.45,
            color: "var(--fg-primary)",
            fontFamily: "var(--font-sans)",
            pointerEvents: "none",
            zIndex: 1000,
          }}
        >
          <div style={{ fontSize: 10, color: "var(--fg-muted)", marginBottom: 2 }}>
            {t("timeline.userPrompt")} · {formatAxisTime(hoveredPrompt.time, false, Date.now())}
            {/* 密集区标记：告诉用户"这里挤了几条、当前第几条"——像素不足以逐条区分时，
                这是唯一能让人判断自己选到哪条的信息 */}
            {clusterPos && clusterPos.total > 1 && (
              <span style={{ marginLeft: 4, color: "var(--semantic-warning)" }}>
                {clusterPos.pos}/{clusterPos.total}
              </span>
            )}
          </div>
          <div style={{ wordBreak: "break-word" }}>
            {hoveredPrompt.preview || t("timeline.emptyPrompt")}
          </div>
        </div>
      )}

      {/* 拖动/悬停指针 + 时间提示（仅展开态） */}
      {expanded && pointerPixel !== null && (
        <>
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: pointerPixel - 1,
              height: 2,
              background: "var(--accent)",
              pointerEvents: "none",
              zIndex: 2,
            }}
          />
          {/* 时间标签：吸附到用户提示时让位 —— 右侧预览浮层已含时间，避免重复 */}
          {!hoveredPrompt && (
          <div
            style={{
              position: "absolute",
              left: 6,
              top: Math.min(height - 18, Math.max(0, pointerPixel - 8)),
              fontSize: 10,
              lineHeight: "14px",
              color: "var(--fg-inverse)",
              background: "var(--accent)",
              borderRadius: 3,
              padding: "1px 5px",
              fontFamily: "var(--font-sans)",
              pointerEvents: "none",
              zIndex: 3,
            }}
          >
            {pointerPixel !== null &&
              formatAxisTime(pixelToTime(pointerPixel, layout), dragging, Date.now())}
          </div>
          )}
        </>
      )}
    </div>
  );
}
