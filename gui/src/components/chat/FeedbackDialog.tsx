import { useState, useRef } from "react";
import { t } from "../../i18n";
import { getSettings } from "../../stores/settingsStore";
import { INTRANET_SERVER_URL } from "../../utils/serverProfile";
import { submitFeedback } from "../../services/feedbackService";
import { windowBus } from "../../services/windowBus";
import { Events } from "../../services/events";

// ── Image resize utility ──

function resizeImage(file: File, maxSize: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width <= maxSize && height <= maxSize) {
          // No resize needed, return original as blob
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
          canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.85);
          return;
        }
        if (width > height) {
          height = Math.round((height / width) * maxSize);
          width = maxSize;
        } else {
          width = Math.round((width / height) * maxSize);
          height = maxSize;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.85);
      };
      img.onerror = () => reject(new Error("Failed to load image"));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

// ── Styles ──

const S = {
  container: { padding: "16px 20px", fontFamily: "var(--font-sans)", fontSize: 12, height: "100%", display: "flex", flexDirection: "column" } as React.CSSProperties,
  header: { fontSize: 14, fontWeight: 600, color: "var(--fg-primary)", marginBottom: 16 } as React.CSSProperties,
  label: { display: "block", marginBottom: 4, color: "var(--fg-secondary)", fontWeight: 500, fontSize: 11 } as React.CSSProperties,
  typeRow: { display: "flex", gap: 8, marginBottom: 14 } as React.CSSProperties,
  typeBtn: (active: boolean): React.CSSProperties => ({
    flex: 1, padding: "8px 12px", border: active ? "2px solid var(--accent)" : "2px solid var(--border-light)",
    borderRadius: 6, cursor: "pointer", textAlign: "center", fontSize: 12, fontFamily: "inherit",
    background: active ? "var(--accent-subtle)" : "var(--bg-root)", color: active ? "var(--accent)" : "var(--fg-primary)",
    fontWeight: active ? 600 : 400,
  }),
  textarea: { width: "100%", height: 120, border: "1px solid var(--border-medium)", borderRadius: 6, padding: "8px 10px", fontSize: 12, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" } as React.CSSProperties,
  imageArea: { marginTop: 12, marginBottom: 4 } as React.CSSProperties,
  imagePreview: { maxWidth: "100%", maxHeight: 120, borderRadius: 4, border: "1px solid var(--border-light)", display: "block" } as React.CSSProperties,
  fileBtn: { padding: "5px 12px", border: "1px solid var(--border-medium)", borderRadius: 4, cursor: "pointer", fontSize: 11, fontFamily: "inherit", background: "var(--bg-root)" } as React.CSSProperties,
  footer: { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "auto", paddingTop: 14, borderTop: "1px solid var(--border-light)" } as React.CSSProperties,
  submitBtn: (disabled: boolean): React.CSSProperties => ({
    padding: "6px 20px", border: "none", borderRadius: 4, cursor: disabled ? "not-allowed" : "pointer",
    backgroundColor: disabled ? "var(--bg-hover)" : "var(--accent)", color: "var(--fg-inverse)",
    fontSize: 12, fontFamily: "inherit", fontWeight: 500, opacity: disabled ? 0.6 : 1,
  }),
  version: { fontSize: 10, color: "var(--fg-muted)" } as React.CSSProperties,
  toast: (color: string): React.CSSProperties => ({
    padding: "6px 12px", borderRadius: 4, fontSize: 11, color,
    backgroundColor: color === "var(--semantic-success)" ? "var(--semantic-success-subtle, #f0fff4)" : "var(--semantic-error-subtle, #fed7d7)",
  }),
};

export default function FeedbackDialog() {
  const [type, setType] = useState<"bug" | "suggestion">("bug");
  const [message, setMessage] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const version = getSettings()._version ?? "1.0.0-preview";
  const adminUrl = (getSettings().skillRegistryUrl ?? INTRANET_SERVER_URL) + "/admin";

  const handleBrowse = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(adminUrl);
    } catch {
      window.open(adminUrl, "_blank");
    }
  };

  const handleImagePick = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const result = await open({
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
        multiple: false,
      });
      if (!result) return;
      const path = result as string;

      // Read file via Tauri invoke (binary → base64)
      const { invoke } = await import("@tauri-apps/api/core");
      const b64: string = await invoke("read_bytes", { path });
      const byteChars = atob(b64);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);

      // Detect mime from extension
      const ext = path.split(".").pop()?.toLowerCase() || "png";
      const mimeMap: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
      const mime = mimeMap[ext] || "image/png";

      const blob = new Blob([bytes], { type: mime });
      const filename = path.split(/[/\\]/).pop() || "screenshot.png";
      const file = new File([blob], filename, { type: mime });

      // Show preview
      const previewUrl = URL.createObjectURL(blob);
      setImagePreview(previewUrl);

      // Resize
      const resized = await resizeImage(file, 1024);
      const resizedFile = new File([resized], filename.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" });
      setImageFile(resizedFile);
      // Update preview with resized version
      URL.revokeObjectURL(previewUrl);
      setImagePreview(URL.createObjectURL(resized));
    } catch (e) {
      console.warn("Image pick failed:", e);
    }
  };

  const handleRemoveImage = () => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(null);
    setImagePreview(null);
  };

  const handleSubmit = async () => {
    if (!message.trim() || submitting) return;
    setSubmitting(true);
    setStatus(null);
    try {
      await submitFeedback({ type, message: message.trim(), appVersion: version, image: imageFile || undefined });
      setStatus({ ok: true, text: t("feedback.success") });
      setMessage("");
      setImageFile(null);
      setImagePreview(null);
      setTimeout(() => setStatus(null), 3000);
    } catch (e: any) {
      setStatus({ ok: false, text: t("feedback.failed") + ": " + (e.message || String(e)) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={S.container}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <div style={S.header}>{t("feedback.title")}</div>
          <div style={S.version}>v{version}</div>
        </div>
        <button
          onClick={handleBrowse}
          style={{
            ...S.fileBtn, display: "flex", alignItems: "center", gap: 4,
            color: "var(--accent)", borderColor: "var(--accent)",
          }}
        >
          {t("feedback.browseAll")}
        </button>
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={S.label}>{t("feedback.type")}</div>
        <div style={S.typeRow}>
          <div style={S.typeBtn(type === "bug")} onClick={() => setType("bug")}>
            🐛 {t("feedback.typeBug")}
          </div>
          <div style={S.typeBtn(type === "suggestion")} onClick={() => setType("suggestion")}>
            💡 {t("feedback.typeSuggestion")}
          </div>
        </div>
      </div>

      <div>
        <div style={S.label}>{t("feedback.message")}</div>
        <textarea
          style={S.textarea}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t("feedback.messagePlaceholder")}
          maxLength={5000}
        />
        <div style={{ fontSize: 10, color: "var(--fg-muted)", textAlign: "right" }}>{message.length}/5000</div>
      </div>

      <div style={S.imageArea}>
        <div style={S.label}>{t("feedback.image")}</div>
        {imagePreview ? (
          <div>
            <img src={imagePreview} style={S.imagePreview} alt="preview" />
            <button style={{ ...S.fileBtn, marginTop: 4 }} onClick={handleRemoveImage}>
              {t("feedback.removeImage")}
            </button>
          </div>
        ) : (
          <button style={S.fileBtn} onClick={handleImagePick}>
            {t("feedback.addImage")}
          </button>
        )}
      </div>

      {/* Privacy warning */}
      <div style={{
        fontSize: 10, color: "var(--semantic-error)", lineHeight: 1.6,
        background: "var(--semantic-error-subtle, #fff5f5)", borderRadius: 4, padding: "6px 10px",
        border: "1px solid var(--semantic-error-subtle, #fed7d7)", marginTop: 12,
      }}>
        {t("feedback.privacyWarning")}
      </div>

      <div style={S.footer}>
        {status ? (
          <span style={S.toast(status.ok ? "var(--semantic-success)" : "var(--semantic-error)")}>{status.text}</span>
        ) : (
          <span style={{ fontSize: 10, color: "var(--fg-muted)" }}>{t("feedback.anonymous")}</span>
        )}
        <button
          style={S.submitBtn(!message.trim() || submitting)}
          disabled={!message.trim() || submitting}
          onClick={handleSubmit}
        >
          {submitting ? t("feedback.submitting") : t("feedback.submit")}
        </button>
      </div>
    </div>
  );
}
