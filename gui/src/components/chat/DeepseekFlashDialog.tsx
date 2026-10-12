import { useState } from "react";
import { t } from "../../i18n";

/**
 * 一次性提示：当前激活 Profile 用的是 DeepSeek Pro 模型时，建议换到 Flash
 * （能力已优于 Pro、费用更低、推理更快）。用户确认后：
 *   复制当前 Profile 的全部 env → 仅把模型键换成 Flash 预设值 → 新建
 *   `<原id>-flash` Profile → 切换过去（Rust 侧会写 markers 并重启后端）。
 *
 * 「其他不变」是有意的：token / base url / 上下文窗口 / 超时 / 能力 env 一律保留，
 * 只动模型名 —— 用户对旧 Profile 的自定义不该因为换模型而丢失。
 *
 * 只弹一次由调用方（App.tsx）用 settings.deepseekFlashNoticeShown 控制。
 */

const FLASH_MODEL = "deepseek-flash";
// 与 ProfileDialog 的 DeepSeek Flash 模板一致：这四个键统一换成 flash（缺则补上）
const MODEL_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
] as const;
// 可能残留 pro 值的次级键：存在才换，不新增
const SECONDARY_MODEL_KEYS = [
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
] as const;

/** 该模型名是否属于 DeepSeek Pro 系（触发一次性提示的判定，App.tsx 启动检查用）。
 *  同时要求含 "deepseek" 与 "pro"，避免误伤其它 provider 里带 pro 的模型名。 */
export function isDeepseekProModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m.includes("deepseek") && m.includes("pro");
}

/**
 * 由当前 profile 的 env 构造新 profile 的 env：**仅替换模型键**，其余原样保留
 * （token / base url / 上下文窗口 / 超时 / 能力 env / 用户其它自定义）。
 *
 * - 四个模板键（MODEL / SONNET / HAIKU / OPUS）：统一写入 Flash 值，缺则补上
 *   —— 与 ProfileDialog 的 DeepSeek Flash 模板保持一致，避免某个档位残留 pro。
 * - 次级键（DEFAULT_MODEL / SMALL_FAST_MODEL）：存在才替换，不新增（部分用户
 *   刻意不配这些键）。
 */
export function buildFlashProfileEnv(env: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = { ...env };
  for (const k of MODEL_KEYS) next[k] = FLASH_MODEL;
  for (const k of SECONDARY_MODEL_KEYS) {
    if (k in next) next[k] = FLASH_MODEL;
  }
  return next;
}

interface Props {
  /** 当前激活的 profile id（派生新 profile 的基底） */
  profileId: string;
  /** 当前模型名（仅供展示） */
  fromModel: string;
  /** 关闭对话框（无论选了是/否都调用；调用方负责置一次性标记） */
  onClose: () => void;
}

export function DeepseekFlashDialog({ profileId, fromModel, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSwitch = async () => {
    setBusy(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const env: Record<string, string> = await invoke("get_profile_env", {
        profileName: profileId,
      });
      const next = buildFlashProfileEnv(env);
      const newId = `${profileId}-flash`;
      await invoke("create_profile", { profileName: newId, envVars: next });
      await invoke("switch_model_profile", { profileId: newId });
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div style={S.overlay}>
      <div style={S.card}>
        <div style={S.title}>{t("flashSuggest.title")}</div>
        <div style={S.body}>
          {t("flashSuggest.body", { model: fromModel })}
          <ul style={S.list}>
            <li>{t("flashSuggest.point1")}</li>
            <li>{t("flashSuggest.point2")}</li>
            <li>{t("flashSuggest.point3")}</li>
          </ul>
          <div style={S.hint}>
            {t("flashSuggest.keepHint", { profile: profileId, next: `${profileId}-flash` })}
          </div>
          {error && <div style={S.error}>{t("flashSuggest.failed", { err: error })}</div>}
        </div>
        <div style={S.actions}>
          <button style={S.btnSecondary} disabled={busy} onClick={onClose}>
            {t("flashSuggest.keepPro")}
          </button>
          <button style={S.btnPrimary} disabled={busy} onClick={handleSwitch}>
            {busy ? t("flashSuggest.switching") : t("flashSuggest.switchToFlash")}
          </button>
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 2000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  card: {
    backgroundColor: "var(--bg-root)",
    border: "1px solid var(--border-light)",
    borderRadius: 8,
    padding: "20px 22px",
    maxWidth: 420,
    boxShadow: "var(--shadow-lg)",
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--fg-primary)",
    marginBottom: 10,
  },
  body: {
    fontSize: 12.5,
    lineHeight: 1.65,
    color: "var(--fg-secondary)",
  },
  list: {
    margin: "8px 0 10px",
    paddingLeft: 18,
  },
  hint: {
    fontSize: 11.5,
    color: "var(--fg-muted)",
    marginTop: 6,
  },
  error: {
    fontSize: 11.5,
    color: "var(--semantic-error)",
    marginTop: 10,
  },
  actions: {
    display: "flex",
    gap: 8,
    justifyContent: "flex-end",
    marginTop: 18,
  },
  btnSecondary: {
    padding: "6px 14px",
    fontSize: 12.5,
    borderRadius: 6,
    border: "1px solid var(--border-medium)",
    backgroundColor: "var(--bg-root)",
    color: "var(--fg-secondary)",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  btnPrimary: {
    padding: "6px 14px",
    fontSize: 12.5,
    borderRadius: 6,
    border: "1px solid var(--accent)",
    backgroundColor: "var(--accent)",
    color: "var(--fg-inverse)",
    cursor: "pointer",
    fontFamily: "inherit",
  },
};
