import { useState, useEffect } from "react";
import { t, setLanguage, getLanguage, type Language } from "../../i18n";
import { getSettings } from "../../stores/settingsStore";
import { withTimeout, DEFAULT_LOAD_TIMEOUT_MS } from "../../services/asyncUtils";
import { windowBus } from "../../services/windowBus";
import { Events } from "../../services/events";

export type ServerProfile = "intranet" | "public";

export interface WizardSettings {
  language: "zh" | "en";
  uiFontSize: number;
  selectedProfileId: string | null;
  forceChineseThinking: boolean;
  autoEnterRecentWorkspace: boolean;
  serverProfile: ServerProfile;
}

interface WelcomeWizardProps {
  onComplete: (settings: WizardSettings) => void;
}

const TOTAL_STEPS = 7;

// ── Server URLs ──
const SERVER_URLS: Record<ServerProfile, string> = {
  intranet: "http://192.168.186.96:8765",
  public: "http://123.56.66.84:8765",
};

// ── Inline style tokens ──
const C = {
  overlay: {
    position: "absolute", inset: 0, zIndex: 2000,
    display: "flex", alignItems: "center", justifyContent: "center",
    backgroundColor: "var(--bg-root)",
    fontFamily: "var(--font-sans)",
  } as React.CSSProperties,

  card: {
    width: 560, maxWidth: "92vw",
    backgroundColor: "var(--bg-surface)",
    borderRadius: 12,
    boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
    padding: "32px 36px 24px",
    display: "flex", flexDirection: "column",
    gap: 24,
    color: "var(--fg-primary)",
  } as React.CSSProperties,

  stepBar: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 0,
  } as React.CSSProperties,

  stepDot: (active: boolean, done: boolean): React.CSSProperties => ({
    width: 28, height: 28, borderRadius: "50%",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: "calc(var(--font-scale, 1) * 12px)",
    fontWeight: 600,
    backgroundColor: active ? "var(--accent)" : done ? "var(--accent-subtle)" : "transparent",
    color: active ? "var(--fg-inverse)" : done ? "var(--accent)" : "var(--fg-muted)",
    border: active || done ? "none" : "2px solid var(--border-light)",
    transition: "all 0.25s",
  }),

  stepLine: (done: boolean): React.CSSProperties => ({
    width: 32, height: 2,
    backgroundColor: done ? "var(--accent)" : "var(--border-light)",
    transition: "background-color 0.25s",
  }),

  stepLabel: (active: boolean): React.CSSProperties => ({
    fontSize: "calc(var(--font-scale, 1) * 10px)",
    color: active ? "var(--fg-primary)" : "var(--fg-muted)",
    marginTop: 4, textAlign: "center",
    fontWeight: active ? 600 : 400,
  }),

  title: {
    fontSize: "calc(var(--font-scale, 1) * 20px)",
    fontWeight: 700,
    textAlign: "center",
    color: "var(--fg-primary)",
  } as React.CSSProperties,

  subtitle: {
    fontSize: "calc(var(--font-scale, 1) * 13px)",
    color: "var(--fg-secondary)",
    textAlign: "center",
    lineHeight: 1.6,
  } as React.CSSProperties,

  langCard: (selected: boolean): React.CSSProperties => ({
    flex: 1, padding: "20px 16px",
    borderRadius: 10,
    border: selected ? "2px solid var(--accent)" : "2px solid var(--border-light)",
    backgroundColor: selected ? "var(--accent-subtle)" : "var(--bg-root)",
    cursor: "pointer",
    textAlign: "center",
    transition: "all 0.2s",
  }),

  langName: {
    fontSize: "calc(var(--font-scale, 1) * 18px)",
    fontWeight: 600,
    color: "var(--fg-primary)",
  } as React.CSSProperties,

  langSub: {
    fontSize: "calc(var(--font-scale, 1) * 12px)",
    color: "var(--fg-muted)",
    marginTop: 4,
  } as React.CSSProperties,

  sliderRow: {
    display: "flex", alignItems: "center", gap: 12,
  } as React.CSSProperties,

  slider: {
    flex: 1, height: 6,
    accentColor: "var(--accent)",
    cursor: "pointer",
  } as React.CSSProperties,

  previewBox: {
    padding: "16px 20px",
    backgroundColor: "var(--bg-root)",
    borderRadius: 8,
    border: "1px solid var(--border-light)",
    marginTop: 8,
  } as React.CSSProperties,

  toggleRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "14px 18px",
    backgroundColor: "var(--bg-root)",
    borderRadius: 10,
    border: "1px solid var(--border-light)",
    cursor: "pointer",
  } as React.CSSProperties,

  toggle: (on: boolean): React.CSSProperties => ({
    width: 44, height: 26, borderRadius: 13,
    backgroundColor: on ? "var(--accent)" : "var(--border-light)",
    position: "relative",
    transition: "background-color 0.2s",
    cursor: "pointer",
    flexShrink: 0,
  }),

  toggleKnob: (on: boolean): React.CSSProperties => ({
    width: 20, height: 20, borderRadius: "50%",
    backgroundColor: "var(--bg-root)",
    position: "absolute", top: 3,
    left: on ? 22 : 3,
    transition: "left 0.2s",
    boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
  }),

  experimentalBadge: {
    display: "inline-block",
    fontSize: "calc(var(--font-scale, 1) * 10px)",
    fontWeight: 600,
    color: "var(--semantic-warning)",
    backgroundColor: "var(--semantic-warning-subtle, #fef3c7)",
    padding: "2px 8px", borderRadius: 10,
    marginLeft: 8,
    verticalAlign: "middle",
  } as React.CSSProperties,

  navRow: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
  } as React.CSSProperties,

  navBtn: (primary: boolean): React.CSSProperties => ({
    padding: "8px 24px", borderRadius: 6,
    border: "none", cursor: "pointer",
    fontSize: "calc(var(--font-scale, 1) * 13px)",
    fontWeight: 600,
    backgroundColor: primary ? "var(--accent)" : "transparent",
    color: primary ? "var(--fg-inverse)" : "var(--fg-secondary)",
    transition: "all 0.15s",
  }),

  summaryRow: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "10px 0",
    borderBottom: "1px solid var(--border-light)",
  } as React.CSSProperties,

  summaryLabel: {
    fontSize: "calc(var(--font-scale, 1) * 13px)",
    color: "var(--fg-secondary)",
  } as React.CSSProperties,

  summaryValue: {
    fontSize: "calc(var(--font-scale, 1) * 13px)",
    fontWeight: 600,
    color: "var(--fg-primary)",
  } as React.CSSProperties,

  // ── Panel diagram styles ──
  diagramContainer: {
    display: "flex", gap: 8,
    height: 240,
    marginTop: 8,
  } as React.CSSProperties,

  diagramCol: (w: string): React.CSSProperties => ({
    width: w,
    display: "flex", flexDirection: "column",
    gap: 6,
  }),

  diagramBlock: (h: string): React.CSSProperties => ({
    flex: h === "auto" ? 1 : undefined,
    height: h !== "auto" ? h : undefined,
    border: "1px solid var(--border-light)",
    borderRadius: 6,
    padding: "6px 8px",
    backgroundColor: "var(--bg-root)",
    display: "flex", flexDirection: "column",
    gap: 3,
    overflow: "hidden",
  }),

  diagramHeader: {
    fontSize: "calc(var(--font-scale, 1) * 9px)",
    fontWeight: 700,
    color: "var(--fg-primary)",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    marginBottom: 2,
  } as React.CSSProperties,

  diagramChip: (color: string): React.CSSProperties => ({
    fontSize: "calc(var(--font-scale, 1) * 8.5px)",
    color: "var(--fg-secondary)",
    padding: "1px 4px",
    borderRadius: 2,
    backgroundColor: `rgba(${color}, 0.08)`,
    borderLeft: `2px solid rgba(${color}, 0.5)`,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  }),

  diagramDivider: {
    borderTop: "1px dashed var(--border-light)",
    margin: "4px 0",
  } as React.CSSProperties,

  diagramAnnotation: {
    fontSize: "calc(var(--font-scale, 1) * 9px)",
    color: "var(--fg-muted)",
    textAlign: "center",
    marginTop: 8,
  } as React.CSSProperties,

  inputStyle: {
    width: "100%", boxSizing: "border-box",
    padding: "8px 12px", borderRadius: 6,
    border: "1px solid var(--border-light)",
    backgroundColor: "var(--bg-root)",
    color: "var(--fg-primary)",
    fontSize: "calc(var(--font-scale, 1) * 13px)",
    outline: "none",
  } as React.CSSProperties,
};

// 步骤名跟随当前语言 → 渲染时经 t() 取值
const STEP_LABEL_KEYS = ["wizard.stepLanguage", "wizard.stepFontScale", "wizard.tabModel", "wizard.tabThinking", "wizard.tabLayout", "wizard.tabServer", "wizard.finish"];

// ── Step content renderers ──

function StepLanguage({ value, onChange }: { value: Language; onChange: (v: Language) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={C.title}>{t("wizard.stepLanguage")}</div>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={C.langCard(value === "zh")} onClick={() => onChange("zh")}>
          <div style={C.langName}>{t("wizard.langZh")}</div>
          <div style={C.langSub}>{t("wizard.langZhSub")}</div>
        </div>
        <div style={C.langCard(value === "en")} onClick={() => onChange("en")}>
          <div style={C.langName}>{t("wizard.langEn")}</div>
          <div style={C.langSub}>{t("wizard.langEnSub")}</div>
        </div>
      </div>
    </div>
  );
}

function StepFontScale({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={C.title}>{t("wizard.stepFontScale")}</div>
      <div style={C.sliderRow}>
        <span style={{ fontSize: "calc(var(--font-scale, 1) * 12px)", color: "var(--fg-muted)" }}>80%</span>
        <input
          type="range" min={80} max={150} step={5} value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={C.slider}
        />
        <span style={{ fontSize: "calc(var(--font-scale, 1) * 12px)", color: "var(--fg-muted)" }}>150%</span>
        <span style={{
          fontSize: "calc(var(--font-scale, 1) * 13px)", fontWeight: 700,
          color: "var(--accent)", minWidth: 42, textAlign: "right",
        }}>{value}%</span>
      </div>
      <div style={C.subtitle}>{t("wizard.fontScalePreview")}</div>
      <div style={C.previewBox}>
        <div style={{ fontSize: "calc(var(--font-scale, 1) * 28px)", fontWeight: 700, color: "var(--fg-primary)" }}>
          Aa
        </div>
        <div style={{ fontSize: "calc(var(--font-scale, 1) * 13px)", color: "var(--fg-secondary)", marginTop: 4 }}>
          {t("wizard.fontScaleSample")}
        </div>
      </div>
    </div>
  );
}

// ── Step 2: Profile Selection ──

function StepProfile({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const [profiles, setProfiles] = useState<Array<{ id: string; label: string; model: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"select" | "create">("select");
  const [provider, setProvider] = useState<"deepseek" | "qwen" | "custom">("deepseek");

  // Create form state
  const [profileName, setProfileName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [authToken, setAuthToken] = useState("");
  // DeepSeek/Qwen presets
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set(["deepseek-v4-flash"]));
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const done = () => { if (!cancelled) setLoading(false); };
    import("@tauri-apps/api/core").then(({ invoke }) => {
      type ProfilesResult = { profiles: Array<{ id: string; label: string; model: string }> };
      withTimeout(
        invoke<ProfilesResult>("list_model_profiles"),
        DEFAULT_LOAD_TIMEOUT_MS,
        "load profiles timeout"
      )
        .then((r) => { if (!cancelled) { setProfiles(r.profiles); setLoading(false); } })
        .catch(done);
    }).catch(done);
    return () => { cancelled = true; };
  }, []);

  const handleCreate = async () => {
    setCreating(true);
    setCreateError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const extraVars: Record<string, string> = {};
      // 预设模板（与 ProfileDialog 对齐）
      const TEMPLATES: Record<string, { baseUrl: string; model: string; label: string }> = {
        "deepseek-v4-pro": { baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-pro", label: "DeepSeek v4 Pro" },
        "deepseek-v4-flash": { baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-flash", label: "DeepSeek v4 Flash" },
        "deepseek-v4-flash-vision-exp": { baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-flash-vision-exp", label: "DeepSeek v4 Flash Vision" },
        "qwen-3.6-plus": { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.6-plus", label: "Qwen 3.6 Plus" },
      };

      if (provider === "deepseek" || provider === "qwen") {
        if (!authToken.trim()) { setCreateError(t("profile.enterApiKey")); setCreating(false); return; }
        for (const id of selectedModels) {
          const cfg = TEMPLATES[id];
          if (!cfg) continue;
          const vars: Record<string, string> = {
            ANTHROPIC_BASE_URL: cfg.baseUrl,
            ANTHROPIC_MODEL: cfg.model,
            ANTHROPIC_DEFAULT_SONNET_MODEL: cfg.model,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: cfg.model,
            ANTHROPIC_DEFAULT_OPUS_MODEL: cfg.model,
            ANTHROPIC_AUTH_TOKEN: authToken.trim(),
            CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
            ...extraVars,
          };
          await invoke("create_profile", { profileName: id, envVars: vars });
        }
        windowBus.emit(Events.PROFILES_CHANGED, {});
        const first = [...selectedModels][0];
        onChange(first);
      } else {
        // Custom
        const name = profileName.trim() || "custom";
        const vars: Record<string, string> = {
          ANTHROPIC_BASE_URL: baseUrl.trim(),
          ANTHROPIC_MODEL: model.trim(),
          ANTHROPIC_DEFAULT_SONNET_MODEL: model.trim(),
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model.trim(),
          ANTHROPIC_DEFAULT_OPUS_MODEL: model.trim(),
          ...(authToken.trim() ? { ANTHROPIC_AUTH_TOKEN: authToken.trim() } : {}),
          ...extraVars,
        };
        await invoke("create_profile", {
          profileName: name,
          envVars: vars,
        });
        windowBus.emit(Events.PROFILES_CHANGED, {});
        onChange(name);
      }
    } catch (e: any) {
      setCreateError(String(e));
    } finally {
      setCreating(false);
    }
  };

  const toggleModel = (id: string) => {
    const next = new Set(selectedModels);
    if (next.has(id)) { next.delete(id); } else { next.add(id); }
    if (next.size > 0) setSelectedModels(next);
  };

  const hasProfiles = profiles.length > 0;

  // Preset model options per provider
  const getPresetModels = () => {
    if (provider === "deepseek") return ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"];
    if (provider === "qwen") return ["qwen-3.6-plus"];
    return [];
  };
  const getPresetLabels = (id: string) => {
    const labels: Record<string, string> = {
      "deepseek-v4-pro": "DeepSeek v4 Pro",
      "deepseek-v4-flash": "DeepSeek v4 Flash",
      "deepseek-v4-flash-vision-exp": "DeepSeek v4 Flash Vision",
      "qwen-3.6-plus": "Qwen 3.6 Plus",
    };
    return labels[id] || id;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={C.title}>{t("wizard.stepProfile")}</div>

      {loading ? (
        <div style={{ textAlign: "center", color: "var(--fg-muted)", fontSize: "calc(var(--font-scale, 1) * 13px)" }}>
          {t("common.loading")}...
        </div>
      ) : mode === "select" ? (
        <>
          {/* Skip option */}
          <div
            style={{
              ...C.toggleRow,
              borderColor: value === null ? "var(--accent)" : "var(--border-light)",
              backgroundColor: value === null ? "var(--accent-subtle)" : "var(--bg-root)",
            }}
            onClick={() => onChange(null)}
          >
            <div>
              <div style={{ fontSize: "calc(var(--font-scale, 1) * 13px)", fontWeight: 500, color: "var(--fg-primary)" }}>
                {t("wizard.profileSkip")}
              </div>
              <div style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-muted)", marginTop: 2 }}>
                {t("wizard.doneProfileNone")}
              </div>
            </div>
            <div style={{
              width: 20, height: 20, borderRadius: "50%",
              border: value === null ? "2px solid var(--accent)" : "2px solid var(--border-light)",
              backgroundColor: value === null ? "var(--accent)" : "transparent",
            }} />
          </div>

          {/* Existing profiles */}
          {hasProfiles && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-muted)", fontWeight: 600 }}>
                {t("wizard.profileSelectExisting")}
              </div>
              {profiles.map((p) => (
                <div
                  key={p.id}
                  style={{
                    ...C.toggleRow,
                    borderColor: value === p.id ? "var(--accent)" : "var(--border-light)",
                    backgroundColor: value === p.id ? "var(--accent-subtle)" : "var(--bg-root)",
                  }}
                  onClick={() => onChange(p.id)}
                >
                  <div>
                    <div style={{ fontSize: "calc(var(--font-scale, 1) * 12px)", fontWeight: 500, color: "var(--fg-primary)" }}>
                      {p.label}
                    </div>
                    <div style={{ fontSize: "calc(var(--font-scale, 1) * 10px)", color: "var(--fg-muted)" }}>
                      {p.model}
                    </div>
                  </div>
                  <div style={{
                    width: 20, height: 20, borderRadius: "50%",
                    border: value === p.id ? "2px solid var(--accent)" : "2px solid var(--border-light)",
                    backgroundColor: value === p.id ? "var(--accent)" : "transparent",
                  }} />
                </div>
              ))}
            </div>
          )}

          {/* Create new button */}
          <button
            style={{
              ...C.navBtn(false),
              alignSelf: "center",
              fontSize: "calc(var(--font-scale, 1) * 12px)",
              color: "var(--accent)",
              padding: "6px 16px",
            }}
            onClick={() => setMode("create")}
          >
            + {t("wizard.profileCreateNew")}
          </button>
        </>
      ) : (
        /* Create mode */
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Provider tabs */}
          <div style={{ display: "flex", gap: 8 }}>
            {(["deepseek", "qwen", "custom"] as const).map((p) => (
              <button
                key={p}
                onClick={() => { setProvider(p); setCreateError(""); }}
                style={{
                  flex: 1, padding: "6px 0", borderRadius: 6,
                  border: provider === p ? "2px solid var(--accent)" : "1px solid var(--border-light)",
                  backgroundColor: provider === p ? "var(--accent-subtle)" : "transparent",
                  cursor: "pointer",
                  fontSize: "calc(var(--font-scale, 1) * 12px)",
                  fontWeight: 600,
                  color: "var(--fg-primary)",
                }}
              >
                {p === "deepseek" ? "DeepSeek" : p === "qwen" ? "Qwen" : "Custom"}
              </button>
            ))}
          </div>

          {(provider === "deepseek" || provider === "qwen") ? (
            <>
              <div>
                <div style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-secondary)", marginBottom: 4 }}>
                  {t("wizard.profileApiKey")}
                </div>
                <input
                  type="password"
                  value={authToken}
                  onChange={(e) => setAuthToken(e.target.value)}
                  placeholder="sk-..."
                  style={C.inputStyle}
                />
                <div style={{ fontSize: "calc(var(--font-scale, 1) * 10px)", color: "var(--fg-muted)", marginTop: 2 }}>
                  {t("wizard.useAuthToken")}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-secondary)", marginBottom: 4 }}>
                  {t("wizard.profileSelectModels")}
                </div>
                {getPresetModels().map((id) => (
                  <label
                    key={id}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "8px 12px", cursor: "pointer",
                      fontSize: "calc(var(--font-scale, 1) * 12px)",
                      color: "var(--fg-primary)",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedModels.has(id)}
                      onChange={() => toggleModel(id)}
                      style={{ accentColor: "var(--accent)" }}
                    />
                    {getPresetLabels(id)}
                  </label>
                ))}
              </div>
            </>
          ) : (
            <>
              {([
                ["wizard.profileName", "wizard.profileNamePlaceholder", profileName, setProfileName],
                ["wizard.profileBaseUrl", "wizard.profileBaseUrlPlaceholder", baseUrl, setBaseUrl],
                ["wizard.profileModel", "wizard.profileModelPlaceholder", model, setModel],
              ] as const).map(([labelKey, placeholderKey, val, setter]) => (
                <div key={labelKey}>
                  <div style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-secondary)", marginBottom: 4 }}>
                    {t(labelKey)}
                  </div>
                  <input
                    type="text"
                    value={val}
                    onChange={(e) => setter(e.target.value)}
                    placeholder={t(placeholderKey)}
                    style={C.inputStyle}
                  />
                </div>
              ))}
              <div>
                <div style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-secondary)", marginBottom: 4 }}>
                  ANTHROPIC_AUTH_TOKEN
                </div>
                <input
                  type="password"
                  value={authToken}
                  onChange={(e) => setAuthToken(e.target.value)}
                  placeholder="sk-..."
                  style={C.inputStyle}
                />
              </div>
            </>
          )}

          {createError && (
            <div style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--semantic-error)", padding: "4px 0" }}>
              {createError}
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button
              style={{ ...C.navBtn(false), flex: 1, fontSize: "calc(var(--font-scale, 1) * 12px)" }}
              onClick={() => { setMode("select"); setCreateError(""); }}
            >
              ← {t("wizard.previous")}
            </button>
            <button
              style={{ ...C.navBtn(true), flex: 1, fontSize: "calc(var(--font-scale, 1) * 12px)" }}
              onClick={handleCreate}
              disabled={creating}
            >
              {creating ? t("wizard.profileCreating") : t("wizard.profileCreate")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StepThinking({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={C.title}>
        {t("wizard.tabThinking")}
        <span style={C.experimentalBadge}>{t("wizard.thinkingExperimental")}</span>
      </div>
      <div style={C.subtitle}>{t("wizard.thinkingDesc")}</div>
      <div style={{
        padding: "12px 16px",
        backgroundColor: "var(--semantic-warning-subtle, #fef3c7)",
        borderRadius: 8,
        borderLeft: "3px solid var(--semantic-warning)",
        fontSize: "calc(var(--font-scale, 1) * 12px)",
        color: "var(--semantic-warning)",
        lineHeight: 1.6,
      }}>
        {t("wizard.thinkingExperimentalNote")}
      </div>
      <div style={C.toggleRow} onClick={() => onChange(!value)}>
        <span style={{ fontSize: "calc(var(--font-scale, 1) * 14px)", fontWeight: 500, color: "var(--fg-primary)" }}>
          {t("wizard.thinkingEnable")}
        </span>
        <div style={C.toggle(value)}>
          <div style={C.toggleKnob(value)} />
        </div>
      </div>
    </div>
  );
}

async function testServerConnection(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`${baseUrl}/api/packages`, {
      signal: controller.signal,
      method: "GET",
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

type ConnState = "idle" | "testing" | "available" | "unavailable";

function StepServer({ value, onChange }: { value: ServerProfile; onChange: (v: ServerProfile) => void }) {
  const [conn, setConn] = useState<Record<ServerProfile, ConnState>>({ intranet: "idle", public: "idle" });

  useEffect(() => {
    (async () => {
      for (const profile of ["intranet", "public"] as const) {
        setConn((s) => ({ ...s, [profile]: "testing" }));
        const ok = await testServerConnection(SERVER_URLS[profile], 3000);
        setConn((s) => ({ ...s, [profile]: ok ? "available" : "unavailable" }));
      }
    })();
  }, []);

  const statusStyle = (s: ConnState): React.CSSProperties => ({
    fontSize: "calc(var(--font-scale, 1) * 10px)",
    fontWeight: 500,
    color: s === "available" ? "var(--semantic-success)" : s === "unavailable" ? "var(--semantic-error)" : "var(--fg-muted)",
    marginTop: 2,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={C.title}>{t("wizard.tabServer")}</div>
      <div style={C.subtitle}>{t("wizard.serverDesc")}</div>
      <div style={{
        fontSize: "calc(var(--font-scale, 1) * 11px)",
        color: "var(--fg-secondary)",
        textAlign: "center",
        padding: "6px 12px",
        backgroundColor: "var(--bg-root)",
        borderRadius: 8,
        border: "1px solid var(--border-light)",
      }}>
        {t("wizard.serverUsedFor")}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {(["intranet", "public"] as const).map((profile) => (
          <div
            key={profile}
            style={{
              ...C.toggleRow,
              borderColor: value === profile ? "var(--accent)" : "var(--border-light)",
              backgroundColor: value === profile ? "var(--accent-subtle)" : "var(--bg-root)",
              cursor: "pointer",
            }}
            onClick={() => onChange(profile)}
          >
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: "calc(var(--font-scale, 1) * 13px)", fontWeight: 500, color: "var(--fg-primary)" }}>
                  {profile === "intranet" ? t("wizard.serverIntranet") : t("wizard.serverPublic")}
                </span>
                {profile === "intranet" && (
                  <span style={{
                    display: "inline-block", fontSize: "calc(var(--font-scale, 1) * 10px)",
                    fontWeight: 600, color: "var(--semantic-success)", backgroundColor: "var(--semantic-success-subtle, #d1fae5)",
                    padding: "1px 8px", borderRadius: 10,
                  }}>
                    {t("wizard.serverRecommended")}
                  </span>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-muted)", marginTop: 2 }}>
                  {SERVER_URLS[profile]}
                </span>
                <span style={statusStyle(conn[profile])}>
                  {conn[profile] === "testing" && t("wizard.serverTesting")}
                  {conn[profile] === "available" && t("wizard.serverAvailable")}
                  {conn[profile] === "unavailable" && t("wizard.serverUnavailable")}
                </span>
              </div>
            </div>
            <div style={{
              width: 20, height: 20, borderRadius: "50%",
              border: value === profile ? "2px solid var(--accent)" : "2px solid var(--border-light)",
              backgroundColor: value === profile ? "var(--accent)" : "transparent",
              flexShrink: 0,
            }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function StepPanels() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={C.title}>{t("wizard.stepPanels")}</div>
      <div style={C.diagramContainer}>
        {/* Left sidebar — 25% */}
        <div style={C.diagramCol("25%")}>
          <div style={C.diagramBlock("auto")}>
            <div style={C.diagramHeader}>{t("wizard.panelsLeftLabel")}</div>
            <div style={C.diagramChip("0,122,204")}>Sessions</div>
            <div style={C.diagramChip("0,122,204")}>Files</div>
            <div style={C.diagramChip("0,122,204")}>Plan</div>
            <div style={C.diagramChip("0,122,204")}>Sub-agents</div>
            <div style={C.diagramChip("0,122,204")}>Skills</div>
            <div style={C.diagramChip("0,122,204")}>Quick Prompts</div>
            <div style={C.diagramChip("0,122,204")}>Workers</div>
          </div>
        </div>

        {/* Center column — 45% */}
        <div style={C.diagramCol("45%")}>
          <div style={C.diagramBlock("75%")}>
            <div style={C.diagramHeader}>{t("wizard.panelsCenterLabel")}</div>
            <div style={C.diagramChip("34,139,34")}>Super Desktop</div>
            <div style={C.diagramChip("34,139,34")}>Editor</div>
            <div style={C.diagramChip("34,139,34")}>Notes</div>
          </div>
          <div style={C.diagramBlock("25%")}>
            <div style={C.diagramChip("34,139,34")}>Terminal</div>
          </div>
        </div>

        {/* Right chat split — 30% */}
        <div style={C.diagramCol("30%")}>
          <div style={C.diagramBlock("65%")}>
            <div style={C.diagramHeader}>{t("wizard.panelsRightLabel")}</div>
            <div style={C.diagramChip("128,0,128")}>Messages</div>
          </div>
          <div style={C.diagramBlock("35%")}>
            <div style={C.diagramChip("128,0,128")}>Input</div>
          </div>
        </div>
      </div>

      {/* Annotations */}
      <div style={{ display: "flex", gap: 8, fontSize: "calc(var(--font-scale, 1) * 9px)", color: "var(--fg-muted)" }}>
        <div style={{ width: "25%", textAlign: "center" }}>{t("wizard.panelsLeftDesc")}</div>
        <div style={{ width: "45%", textAlign: "center" }}>{t("wizard.panelsCenterDesc")}</div>
        <div style={{ width: "30%", textAlign: "center" }}>{t("wizard.panelsRightDesc")}</div>
      </div>
    </div>
  );
}

function StepDone({ settings, onAutoEnterChange }: {
  settings: WizardSettings;
  onAutoEnterChange: (v: boolean) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={C.title}>{t("wizard.stepDone")}</div>
      <div style={{
        padding: "12px 16px",
        backgroundColor: "var(--bg-root)",
        borderRadius: 10,
        border: "1px solid var(--border-light)",
      }}>
        <div style={C.summaryRow}>
          <span style={C.summaryLabel}>{t("wizard.doneLanguage")}</span>
          <span style={C.summaryValue}>{settings.language === "zh" ? t("wizard.langZh") : "English"}</span>
        </div>
        <div style={C.summaryRow}>
          <span style={C.summaryLabel}>{t("wizard.doneFontScale")}</span>
          <span style={C.summaryValue}>{settings.uiFontSize}%</span>
        </div>
        <div style={C.summaryRow}>
          <span style={C.summaryLabel}>{t("wizard.doneProfile")}</span>
          <span style={C.summaryValue}>{settings.selectedProfileId ?? t("wizard.doneProfileNone")}</span>
        </div>
        <div style={C.summaryRow}>
          <span style={C.summaryLabel}>{t("wizard.doneServer")}</span>
          <span style={C.summaryValue}>
            {settings.serverProfile === "intranet" ? t("wizard.serverIntranet") : t("wizard.serverPublic")}
          </span>
        </div>
        <div style={{ ...C.summaryRow, borderBottom: "none" }}>
          <span style={C.summaryLabel}>{t("wizard.doneThinking")}</span>
          <span style={{
            ...C.summaryValue,
            color: settings.forceChineseThinking ? "var(--semantic-success)" : "var(--fg-muted)",
          }}>
            {settings.forceChineseThinking ? t("wizard.doneThinkingOn") : t("wizard.doneThinkingOff")}
          </span>
        </div>
      </div>
      <div style={C.toggleRow} onClick={() => onAutoEnterChange(!settings.autoEnterRecentWorkspace)}>
        <div>
          <div style={{ fontSize: "calc(var(--font-scale, 1) * 13px)", fontWeight: 500, color: "var(--fg-primary)" }}>
            {t("wizard.doneAutoEnter")}
          </div>
          <div style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-muted)", marginTop: 2 }}>
            {t("wizard.doneAutoEnterDesc")}
          </div>
        </div>
        <div style={C.toggle(settings.autoEnterRecentWorkspace)}>
          <div style={C.toggleKnob(settings.autoEnterRecentWorkspace)} />
        </div>
      </div>
      <div style={C.subtitle}>{t("wizard.doneHint")}</div>
    </div>
  );
}

// ── Main Wizard Component ──

export function WelcomeWizard({ onComplete }: WelcomeWizardProps) {
  const [step, setStep] = useState(0);
  const [lang, setLang] = useState<Language>(() => getLanguage());
  const [fontScale, setFontScale] = useState(() => getSettings().uiFontSize ?? 100);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [forceChinese, setForceChinese] = useState(() => getSettings().forceChineseThinking ?? false);
  const [autoEnterRecent, setAutoEnterRecent] = useState(() => getSettings().autoEnterRecentWorkspace ?? false);
  const [serverProfile, setServerProfile] = useState<ServerProfile>("intranet");

  // Ensure language is applied on mount (before wizard renders text)
  useEffect(() => {
    setLanguage(getLanguage());
  }, []);

  const settings: WizardSettings = {
    language: lang,
    uiFontSize: fontScale,
    selectedProfileId,
    forceChineseThinking: forceChinese,
    autoEnterRecentWorkspace: autoEnterRecent,
    serverProfile,
  };

  const handleNext = () => {
    if (step < TOTAL_STEPS - 1) setStep((s) => s + 1);
  };
  const handlePrev = () => {
    if (step > 0) setStep((s) => s - 1);
  };
  const handleFinish = () => {
    onComplete(settings);
  };

  const handleLangChange = (v: Language) => {
    setLang(v);
    setLanguage(v);
  };

  const handleFontChange = (v: number) => {
    setFontScale(v);
    document.documentElement.style.setProperty("--font-scale", (v / 100).toFixed(2));
  };

  // Restore font scale on unmount (if user closes before finishing)
  useEffect(() => {
    return () => {
      const saved = getSettings().uiFontSize ?? 100;
      document.documentElement.style.setProperty("--font-scale", (saved / 100).toFixed(2));
    };
  }, []);

  const stepLabels = STEP_LABEL_KEYS.map((k) => t(k));

  return (
    <div style={C.overlay}>
      <div style={C.card}>
        {/* Step Indicator */}
        <div style={C.stepBar}>
          {stepLabels.map((label, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center" }}>
              {i > 0 && <div style={C.stepLine(i <= step)} />}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div style={C.stepDot(i === step, i < step)}>
                  {i < step ? "✓" : i + 1}
                </div>
                <div style={C.stepLabel(i === step)}>{label}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Step Content */}
        <div style={{ minHeight: 200 }}>
          {step === 0 && <StepLanguage value={lang} onChange={handleLangChange} />}
          {step === 1 && <StepFontScale value={fontScale} onChange={handleFontChange} />}
          {step === 2 && <StepProfile value={selectedProfileId} onChange={setSelectedProfileId} />}
          {step === 3 && <StepThinking value={forceChinese} onChange={setForceChinese} />}
          {step === 4 && <StepPanels />}
          {step === 5 && <StepServer value={serverProfile} onChange={setServerProfile} />}
          {step === 6 && <StepDone settings={settings} onAutoEnterChange={setAutoEnterRecent} />}
        </div>

        {/* Navigation */}
        <div style={C.navRow}>
          <button
            style={{ ...C.navBtn(false), visibility: step === 0 ? "hidden" : "visible" }}
            onClick={handlePrev}
          >
            ← {t("wizard.previous")}
          </button>
          <span style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-muted)" }}>
            {t("wizard.stepIndicator", { current: String(step + 1), total: String(TOTAL_STEPS) })}
          </span>
          {step < TOTAL_STEPS - 1 ? (
            <button style={C.navBtn(true)} onClick={handleNext}>
              {t("wizard.next")} →
            </button>
          ) : (
            <button style={{
              ...C.navBtn(true),
              fontSize: "calc(var(--font-scale, 1) * 14px)",
              padding: "10px 32px",
            }} onClick={handleFinish}>
              {t("wizard.finish")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
