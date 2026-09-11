import { useState, useEffect, useRef, useCallback } from "react";
import { useContentZoom } from "./desktop/useContentZoom";
import { t } from "../i18n";

interface Props {
  path: string;
  name: string;
}

interface PickedColor {
  hex: string;
  rgb: string;
}

export default function FilePreview({ path, name }: Props) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 取色模式：开启后点击图片取色（此时不拖动）；再点按钮关闭
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<PickedColor | null>(null);
  const [copied, setCopied] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // 缩放/平移复用超级桌面那套 hook，但参数不同：
  //  - requireCtrl: false —— 这是**独立查看器面板**，没有外层画布，裸滚轮才符合习惯
  //  - panAlways: true    —— 1:1 时图片常大于视口，任何时候都该能拖
  const cz = useContentZoom({ requireCtrl: false, panAlways: true, min: 0.05, max: 20 });
  const { zoomTo, reset } = cz;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const base64: string = await invoke("read_bytes", { path });
        if (cancelled) return;

        if (ext === "svg") {
          setDataUrl(`data:image/svg+xml;base64,${base64}`);
        } else if (ext === "pdf") {
          setDataUrl(`data:application/pdf;base64,${base64}`);
        } else {
          const mimeMap: Record<string, string> = {
            png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
            gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon",
          };
          const mime = mimeMap[ext] || "image/png";
          setDataUrl(`data:${mime};base64,${base64}`);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [path, ext]);

  /** 缩放到刚好完整显示（留 16px 边距，避免贴边看不出边界）。1 为上限——小图不放大。 */
  const fitToViewport = useCallback(() => {
    const vp = viewportRef.current;
    const img = imgRef.current;
    if (!vp || !img || !img.naturalWidth) return;
    const s = Math.min(
      (vp.clientWidth - 16) / img.naturalWidth,
      (vp.clientHeight - 16) / img.naturalHeight,
      1,
    );
    zoomTo(s > 0 ? s : 1);
  }, [zoomTo]);

  /** 图片解码完成 → 自动 Fit（打开就是"看得见整张图"，而不是原始像素的局部） */
  const handleImgLoad = useCallback(() => { fitToViewport(); }, [fitToViewport]);

  /** 取色：把点击位置换算成图片像素坐标，用 1×1 canvas 采样该点颜色。
   *  坐标换算基于**渲染后的 rect**（已含 zoom/pan），不必自己推变换矩阵。 */
  const pickColorAt = useCallback((e: React.MouseEvent) => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;
    const rect = img.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * img.naturalWidth);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * img.naturalHeight);
    if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, x, y, 1, 1, 0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      setPicked({ hex, rgb: `rgb(${r}, ${g}, ${b})` });
      setCopied(false);
    } catch {
      // canvas 被污染（跨源图片）——本应用读本地文件走 data URL，正常不会发生
    }
  }, []);

  const copyPicked = useCallback(() => {
    if (!picked) return;
    navigator.clipboard.writeText(picked.hex).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  }, [picked]);

  if (error) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--fg-muted)", fontFamily: "var(--font-sans)", fontSize: 13 }}>
        Failed to load: {error}
      </div>
    );
  }

  if (!dataUrl) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--fg-muted)", fontFamily: "var(--font-sans)", fontSize: 13 }}>
        Loading preview...
      </div>
    );
  }

  const isImage = ext !== "pdf";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", backgroundColor: "var(--bg-code)" }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 4, padding: "4px 8px",
        borderBottom: "1px solid var(--border-light)", flexShrink: 0,
      }}>
        <span style={{ fontSize: 11, color: "var(--fg-muted)", fontFamily: "var(--font-sans)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
        <div style={{ flex: 1 }} />
        {isImage && (
          <>
            <ToolBtn label="🎨" title={t("editor.pickColor")} active={picking}
              onClick={() => { setPicking((p) => !p); }} />
            <ToolBtn label="−" title={t("editor.zoomOut")} onClick={() => zoomTo(cz.zoom / 1.25)} />
            <span style={{ fontSize: 10, color: "var(--fg-muted)", fontFamily: "var(--font-mono)", minWidth: 40, textAlign: "center" }}>
              {Math.round(cz.zoom * 100)}%
            </span>
            <ToolBtn label="+" title={t("editor.zoomIn")} onClick={() => zoomTo(cz.zoom * 1.25)} />
            <ToolBtn label="1:1" title={t("editor.actualSize")} onClick={reset} />
            <ToolBtn label={t("editor.fit")} title={t("editor.fitHint")} onClick={fitToViewport} />
          </>
        )}
      </div>

      {/* Content */}
      <div
        ref={(node) => { viewportRef.current = node; cz.ref(node); }}
        data-zoom-viewport
        onMouseDown={(e) => {
          // 取色模式：点击即取色，不启动拖动（两种意图不并存）
          if (picking && isImage) { e.preventDefault(); pickColorAt(e); return; }
          cz.onMouseDown(e);
        }}
        onDoubleClick={() => { if (!picking && isImage) fitToViewport(); }}
        title={isImage && !picking ? t("editor.zoomHint") : undefined}
        style={{
          flex: 1,
          overflow: "hidden",          // 缩放/平移由 transform 表达，不出滚动条
          position: "relative",
          cursor: picking && isImage ? "crosshair" : cz.cursor,
        }}
      >
        {ext === "pdf" ? (
          <object data={dataUrl} type="application/pdf" style={{ width: "100%", height: "100%" }}>
            <div style={{ color: "var(--fg-muted)", padding: 24 }}>PDF preview not supported in this browser. <a href={dataUrl} download={name} style={{ color: "var(--accent)" }}>Download</a></div>
          </object>
        ) : (
          // 外层铺满 + flex 居中：pan=0 时图片天然居中，transform 在此之上叠加
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", ...cz.style }}>
            <img
              ref={imgRef}
              src={dataUrl}
              alt={name}
              draggable={false}
              onLoad={handleImgLoad}
              style={{ userSelect: "none", pointerEvents: "none", maxWidth: "none", maxHeight: "none" }}
            />
          </div>
        )}

        {/* 取色结果：色块 + hex + 点击复制 */}
        {picked && isImage && (
          <button
            onClick={copyPicked}
            title={t("editor.copyColor")}
            style={{
              position: "absolute", bottom: 10, right: 10,
              display: "flex", alignItems: "center", gap: 8,
              padding: "5px 10px", borderRadius: 5, cursor: "pointer",
              border: "1px solid var(--border-medium)", background: "var(--bg-root)",
              color: "var(--fg-primary)", fontFamily: "var(--font-mono)", fontSize: 11,
              boxShadow: "var(--shadow-md)",
            }}
          >
            <span style={{ width: 16, height: 16, borderRadius: 3, background: picked.hex, border: "1px solid var(--border-medium)" }} />
            <span>{copied ? t("editor.copied") : picked.hex}</span>
            <span style={{ color: "var(--fg-muted)", fontFamily: "var(--font-sans)" }}>{picked.rgb}</span>
          </button>
        )}
      </div>
    </div>
  );
}

function ToolBtn({ label, onClick, title, active }: { label: string; onClick: () => void; title?: string; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        border: `1px solid ${active ? "var(--accent)" : "var(--border-medium)"}`,
        background: active ? "var(--accent-subtle)" : "var(--bg-hover)",
        color: active ? "var(--accent)" : "var(--fg-secondary)",
        cursor: "pointer", fontSize: 11, padding: "1px 6px", borderRadius: 3,
        fontFamily: "var(--font-sans)", minWidth: 28,
      }}
    >{label}</button>
  );
}
