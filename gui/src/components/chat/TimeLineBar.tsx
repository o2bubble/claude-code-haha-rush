// TimeLineBar — 消息面板左侧的时间线导航栏（右侧有滚动条，放左边避免误触）。
// 静止态：粗刻度标尺（日期分组 + 整点）。拖动/点击：指针 → 时间（秒级 tooltip）→
// 定位到该时刻之前最近一条消息（通过 onSeek(index) 通知父级滚动）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n";
import {
  buildTicks, timeToIndex, pixelToTime, timeToPixel,
  segmentizeByDay, layoutSegments, MIN_SEGMENT_PX,
} from "./timelineMath";

interface TimeLineBarProps {
  /** 消息时间戳（毫秒），须递增 */
  timestamps: number[];
  /** 定位到某条消息（index） */
  onSeek: (index: number) => void;
}

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

export function TimeLineBar({ timestamps, onSeek }: TimeLineBarProps) {
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

  const seekFromClientY = useCallback(
    (clientY: number) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const y = Math.min(el.clientHeight, Math.max(0, clientY - rect.top));
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
  if (pointerY !== null && containerRef.current) {
    const rect = containerRef.current.getBoundingClientRect();
    pointerPixel = Math.min(height, Math.max(0, pointerY - rect.top));
  }

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
        </>
      )}
    </div>
  );
}
