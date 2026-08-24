import React, { useEffect, useState } from "react";
import type { DesktopItem, ImageContent } from "../../types/desktop";
import { t } from "../../i18n";

interface Props {
  item: DesktopItem;
}

export function ImageItem({ item }: Props) {
  const content = item.content as ImageContent;
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
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
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        backgroundColor: "var(--bg-hover)",
      }}
    >
      <img
        src={dataUrl}
        alt={item.label}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
        }}
      />
    </div>
  );
}
