import { useState, useEffect } from "react";

interface Props {
  path: string;
  name: string;
}

export default function FilePreview({ path, name }: Props) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const base64: string = await invoke("read_bytes", { path });
        if (cancelled) return;

        if (ext === "svg") {
          // SVG — decode and render inline
          const text = atob(base64);
          setDataUrl(`data:image/svg+xml;base64,${base64}`);
        } else if (ext === "pdf") {
          setDataUrl(`data:application/pdf;base64,${base64}`);
        } else {
          // Images
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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", backgroundColor: "var(--bg-code)" }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 4, padding: "4px 8px",
        borderBottom: "1px solid var(--border-light)", flexShrink: 0,
      }}>
        <span style={{ fontSize: 11, color: "var(--fg-muted)", fontFamily: "var(--font-sans)" }}>{name}</span>
        <div style={{ flex: 1 }} />
        <ToolBtn label="−" onClick={() => setZoom((z) => Math.max(0.1, z - 0.25))} />
        <span style={{ fontSize: 10, color: "var(--fg-muted)", fontFamily: "var(--font-mono)", minWidth: 40, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
        <ToolBtn label="+" onClick={() => setZoom((z) => Math.min(5, z + 0.25))} />
        <ToolBtn label="1:1" onClick={() => setZoom(1)} />
        <ToolBtn label="Fit" onClick={() => setZoom(0)} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {ext === "pdf" ? (
          <object data={dataUrl} type="application/pdf" style={{ width: "100%", height: "100%" }}>
            <div style={{ color: "var(--fg-muted)", padding: 24 }}>PDF preview not supported in this browser. <a href={dataUrl} download={name} style={{ color: "var(--accent)" }}>Download</a></div>
          </object>
        ) : ext === "svg" ? (
          <img src={dataUrl} alt={name} style={zoom === 0 ? { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" } : { transform: `scale(${zoom})`, transformOrigin: "center center" }} />
        ) : (
          <img src={dataUrl} alt={name} style={zoom === 0 ? { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" } : { transform: `scale(${zoom})`, transformOrigin: "center center" }} />
        )}
      </div>
    </div>
  );
}

function ToolBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: "1px solid var(--border-medium)", background: "var(--bg-hover)", color: "var(--fg-secondary)",
        cursor: "pointer", fontSize: 11, padding: "1px 6px", borderRadius: 3,
        fontFamily: "var(--font-sans)", minWidth: 28,
      }}
    >{label}</button>
  );
}
