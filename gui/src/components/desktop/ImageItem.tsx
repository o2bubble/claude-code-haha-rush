import React, { useEffect, useRef, useState } from "react";
import type { DesktopItem, ImageContent } from "../../types/desktop";
import { t } from "../../i18n";
import { useContentZoom } from "./useContentZoom";

interface Props {
  item: DesktopItem;
}

export function ImageItem({ item }: Props) {
  const content = item.content as ImageContent;
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  // 内部缩放（Ctrl/Cmd+滚轮）—— ref 用 callback 形式挂外层容器（不含 transform，
  // 且容器是"图片加载完才渲染"的条件分支，见 useContentZoom 的 ref 说明）
  const cz = useContentZoom();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // path 缺失（块内容不完整，如 AI 经 MCP 创建时漏字段）→ 直接进错误态。
        // 不先拦的话会在 split 处抛，被 ErrorBoundary 捕获后整个画布都看不见。
        if (!content.path) { if (!cancelled) setError(true); return; }
        const { invoke } = await import("@tauri-apps/api/core");
        const b64: string = await invoke("read_bytes", { path: content.path });
        if (cancelled) return;
        const ext = content.path.split(".").pop()?.toLowerCase() || "png";
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
          : ext === "gif" ? "image/gif"
          : ext === "webp" ? "image/webp"
          : ext === "svg" ? "image/svg+xml"
          : "image/png";
        setDataUrl(`data:${mime};base64,${b64}`);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [content.path]);

  if (error) {
    return (
      <div style={{ padding: 16, color: "var(--fg-muted)", fontSize: 12, textAlign: "center" }}>
        {t("desktop.block.imageLoadFailed")}
      </div>
    );
  }

  if (!dataUrl) {
    return (
      <div style={{ padding: 16, color: "var(--fg-muted)", fontSize: 12, textAlign: "center" }}>
        {t("desktop.block.loading")}
      </div>
    );
  }

  return (
    <div
      ref={cz.ref}
      data-wheel-zoom
      onMouseDown={cz.onMouseDown}
      onDoubleClick={cz.onDoubleClick}
      title={t("desktop.block.zoomHint")}
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",          // 放大后不溢出块外
        backgroundColor: "var(--bg-hover)",
        cursor: cz.cursor,
        position: "relative",
      }}
    >
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          ...cz.style,
        }}
      >
        <img
          src={dataUrl}
          alt={item.label}
          draggable={false}
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            objectFit: "contain",
            userSelect: "none",
            pointerEvents: "none",   // 拖拽/光标统一由外层容器处理
          }}
        />
      </div>
      {cz.isZoomed && (
        <button
          onClick={(e) => { e.stopPropagation(); cz.reset(); }}
          title={t("desktop.block.zoomReset")}
          style={{
            position: "absolute", bottom: 6, right: 6,
            padding: "2px 8px", borderRadius: 4, cursor: "pointer",
            border: "1px solid var(--border-medium)", background: "var(--bg-root)",
            color: "var(--fg-primary)", fontFamily: "var(--font-sans)", fontSize: 11,
          }}
        >{Math.round(cz.zoom * 100)}% ↺</button>
      )}
    </div>
  );
}
