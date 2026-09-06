import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Check, Star, X, User, Edit } from "lucide-react";
import { t } from "../../i18n";
import { eventBus } from "../../services/serviceBus";
import { Events } from "../../services/events";

interface ProfileInfo {
  id: string;
  label: string;
  model: string;
}

// ── Dropdown option presets ──

// 选项 label 含文案 → 用函数构造（跟随当前语言）
const maxTokensOptions = () => [
  { label: "64K", value: "65536" },
  { label: "128K", value: "131072" },
  { label: "256K", value: "262144" },
  { label: "384K", value: "393216" },
  { label: t("profile.customOption"), value: "__custom__" },
];

const maxContextOptions = () => [
  { label: "128K", value: "128000" },
  { label: "256K", value: "256000" },
  { label: "512K", value: "512000" },
  { label: "1M", value: "1000000" },
  { label: t("profile.customOption"), value: "__custom__" },
];

const timeoutOptions = () => [
  { label: "60s", value: "60000" },
  { label: t("profile.timeout120"), value: "120000" },
  { label: t("profile.timeout300"), value: "300000" },
  { label: t("profile.customOption"), value: "__custom__" },
];

// ── Preset templates (mirrors scripts/claude-profile.ts) ──

interface PresetTemplate {
  label: string;
  profileName: string;
  vars: Record<string, string>;
  requiresToken: boolean;
}

// 自动给 preset 写入模型能力 env，让后端 modelSupportsEffort/Thinking/Reasoning
// 对这些 3P 模型返回 true（GUI 工具栏据此显示思考/effort 档位）。切换 profile 时
// 后端 restart，这些静态能力 env 随 profile 生效。DeepSeek 用 reasoning 字段控思考，
// Qwen 走 Claude 原生 thinking 块（不加 reasoning）。
const DEEPSEEK_CAP_VARS = {
  ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: "effort,max_effort,thinking,reasoning",
  ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES: "effort,max_effort,thinking,reasoning",
  ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: "effort,max_effort,thinking,reasoning",
};
const QWEN_CAP_VARS = {
  ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: "effort,max_effort,thinking",
  ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES: "effort,max_effort,thinking",
  ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: "effort,max_effort,thinking",
};
function capabilityVarsFor(provider: "deepseek" | "qwen" | "custom"): Record<string, string> {
  if (provider === "deepseek") return DEEPSEEK_CAP_VARS;
  if (provider === "qwen") return QWEN_CAP_VARS;
  return {};
}

// ── 自定义 provider 能力勾选 ──
// 勾选的能力自动写成三个 *_MODEL_SUPPORTED_CAPABILITIES env，让后端 modelSupports*
// 正确判定，告别手写 env。空 set → 不写（后端按模型名默认判断）。
// label 文案跟随语言 → 用 i18n key，渲染时经 t() 取值
const CAPABILITY_OPTIONS: { key: string; labelKey: string }[] = [
  { key: "thinking", labelKey: "profile.capThinking" },
  { key: "adaptive_thinking", labelKey: "profile.capAdaptive" },
  { key: "effort", labelKey: "profile.capEffort" },
  { key: "max_effort", labelKey: "profile.capMaxEffort" },
  { key: "reasoning", labelKey: "profile.capReasoning" },
];
function capabilityVarsFromSet(set: Set<string>): Record<string, string> {
  if (set.size === 0) return {};
  const s = Array.from(set).join(",");
  return {
    ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: s,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES: s,
    ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: s,
  };
}
function parseCapabilities(str?: string): Set<string> {
  if (!str) return new Set();
  return new Set(str.split(",").map((x) => x.trim()).filter(Boolean));
}

const DEEPSEEK_TEMPLATES: PresetTemplate[] = [
  {
    label: "DeepSeek v4 Pro",
    profileName: "deepseek-v4-pro",
    vars: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_MODEL: "deepseek-v4-pro",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-pro",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
    },
    requiresToken: true,
  },
  {
    label: "DeepSeek v4 Flash",
    profileName: "deepseek-v4-flash",
    vars: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_MODEL: "deepseek-v4-flash",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-flash",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-flash",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
    },
    requiresToken: true,
  },
  {
    label: "DeepSeek v4 Flash Vision",
    profileName: "deepseek-v4-flash-vision-exp",
    vars: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_MODEL: "deepseek-v4-flash-vision-exp",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-flash-vision-exp",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash-vision-exp",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-flash-vision-exp",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
    },
    requiresToken: true,
  },
];

const QWEN_TEMPLATES: PresetTemplate[] = [
  {
    label: "Qwen 3.7 Plus",
    profileName: "qwen-3.7-plus",
    vars: {
      ANTHROPIC_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      ANTHROPIC_MODEL: "qwen3.7-plus",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3.7-plus",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3.7-plus",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen3.7-plus",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "256000",
    },
    requiresToken: true,
  },
  {
    label: "Qwen 3.8 Flash",
    profileName: "qwen-3.8-flash",
    vars: {
      ANTHROPIC_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      ANTHROPIC_MODEL: "qwen3.8-flash",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3.8-flash",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3.8-flash",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen3.8-flash",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "256000",
    },
    requiresToken: true,
  },
];

// ── OptionSelector: preset chips + custom input ──

function OptionSelector({ options, value, onChange, style }: {
  options: { label: string; value: string }[];
  value: string;
  onChange: (v: string) => void;
  style?: React.CSSProperties;
}) {
  // 记录"选中自定义"状态——点自定义 chip 时即便 value 为空也要显示输入框（原逻辑 value 空判定死）。
  const [customActive, setCustomActive] = useState(false);
  const isCustom = value !== "" && !options.some((o) => o.value === value);
  const selectedPreset = customActive || isCustom ? "__custom__" : value;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, ...style }}>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {options.map((o) => (
          <div key={o.value}
            onClick={() => {
              if (o.value === "__custom__") {
                setCustomActive(true);
                // 进入自定义：当前若是预设值则清空待输入，若已是自定义值则保留
                onChange(options.some((x) => x.value === value) ? "" : value);
              } else {
                setCustomActive(false);
                onChange(o.value);
              }
            }}
            style={{
              padding: "3px 10px", borderRadius: 4, cursor: "pointer", fontSize: 11,
              border: selectedPreset === o.value
                ? "1.5px solid var(--accent)"
                : "1px solid var(--border-medium)",
              backgroundColor: selectedPreset === o.value ? "var(--bg-active)" : "var(--bg-root)",
              color: selectedPreset === o.value ? "var(--accent)" : "var(--fg-primary)",
              fontWeight: selectedPreset === o.value ? 600 : 400,
            }}
          >
            {o.label}
          </div>
        ))}
      </div>
      {(customActive || isCustom) && (
        <input
          value={value}
          onChange={(e) => { setCustomActive(true); onChange(e.target.value); }}
          placeholder={t("profile.customValue")}
          style={{ border: "1px solid var(--border-medium)", borderRadius: 4, padding: "3px 6px", fontSize: 11, fontFamily: "inherit", width: "100%", boxSizing: "border-box" }}
        />
      )}
    </div>
  );
}

// ── Styles ──

const S = {
  container: { display: "flex", flexDirection: "column", height: "100%", fontFamily: "var(--font-sans)", fontSize: 12 } as React.CSSProperties,
  header: { display: "flex", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid var(--border-light)", fontWeight: 600, color: "var(--fg-primary)", fontSize: 13 } as React.CSSProperties,
  body: { flex: 1, overflow: "auto", padding: "8px 0" } as React.CSSProperties,
  profileRow: { display: "flex", alignItems: "center", padding: "8px 12px", gap: 8, borderBottom: "1px solid var(--border-light)" } as React.CSSProperties,
  activeDot: { width: 6, height: 6, borderRadius: "50%", backgroundColor: "var(--semantic-success)", flexShrink: 0 } as React.CSSProperties,
  inactiveDot: { width: 6, height: 6, borderRadius: "50%", backgroundColor: "var(--border-medium)", flexShrink: 0 } as React.CSSProperties,
  btnSm: (bg: string, fg: string): React.CSSProperties => ({
    border: "1px solid var(--border-medium)", borderRadius: 3, padding: "2px 8px",
    backgroundColor: bg, color: fg, cursor: "pointer", fontSize: 11,
    fontFamily: "inherit", whiteSpace: "nowrap",
  }),
  footer: { padding: "8px 12px", borderTop: "1px solid var(--border-light)" } as React.CSSProperties,
  input: { border: "1px solid var(--border-medium)", borderRadius: 4, padding: "5px 8px", fontSize: 12, fontFamily: "inherit" } as React.CSSProperties,
  label: { display: "block", marginBottom: 2, color: "var(--fg-secondary)", fontWeight: 500, fontSize: 11 } as React.CSSProperties,
  providerBtn: (active: boolean): React.CSSProperties => ({
    flex: 1, border: active ? "2px solid var(--accent)" : "1px solid var(--border-medium)", borderRadius: 6,
    padding: "10px", textAlign: "center", cursor: "pointer",
    backgroundColor: active ? "var(--bg-active)" : "var(--bg-root)",
    fontWeight: active ? 600 : 400, color: active ? "var(--accent)" : "var(--fg-primary)",
  }),
};

// ── Main component ──

export default function ProfileDialog() {
  const [view, setView] = useState<"list" | "create">("list");
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // ── Create form state ──
  const [provider, setProvider] = useState<"deepseek" | "qwen" | "custom">("deepseek");
  const [createMsg, setCreateMsg] = useState<{ text: string; ok: boolean } | null>(null);
  // Preset
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [authToken, setAuthToken] = useState("");
  // Custom
  const [custName, setCustName] = useState("");
  const [custBaseUrl, setCustBaseUrl] = useState("");
  const [custModel, setCustModel] = useState("");
  const [custToken, setCustToken] = useState("");
  // Shared: max tokens / max context / timeout (used by both preset and custom)
  const [maxTokens, setMaxTokens] = useState("65536");
  const [maxContext, setMaxContext] = useState("1000000");
  const [timeout, setTimeout_] = useState("120000");
  // 自定义 provider 能力勾选（thinking/adaptive/effort/max_effort/reasoning）
  const [capabilities, setCapabilities] = useState<Set<string>>(new Set());
  const toggleCapability = (key: string) =>
    setCapabilities((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  // ── Delete confirm ──
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  // 当前正在编辑的 profile（null = 新建模式）
  const [editingId, setEditingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result: any = await invoke("list_model_profiles");
      setProfiles(result.profiles || []);
      setActiveId(result.active || null);
      // 广播给其他订阅者（如工具栏模型下拉），让新建/删除/切换后即时刷新
      eventBus.emit(Events.PROFILES_CHANGED, { profiles: result.profiles || [] });
    } catch { /* Tauri not available */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const showMsg = (text: string, ok: boolean) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 2500);
  };

  // ── Switch profile ──
  const handleSwitch = async (id: string) => {
    setLoading(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("switch_model_profile", { profileId: id });
      showMsg(t("profile.switched", { id }), true);
      refresh();
    } catch (e: any) {
      showMsg(String(e), false);
    }
    setLoading(false);
  };

  // ── Set default ──
  const handleSetDefault = async (id: string) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_default_profile", { profileName: id });
      showMsg(t("profile.setAsDefault", { id }), true);
    } catch (e: any) {
      showMsg(String(e), false);
    }
  };

  // ── Edit：加载 profile 当前 env → 预填表单，保存复用 create_profile 覆盖同名 ──
  const handleEdit = async (id: string) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const env: Record<string, string> = await invoke("get_profile_env", { profileName: id });
      setEditingId(id);
      setProvider("custom");
      setCustName(id);
      setCustBaseUrl(env.ANTHROPIC_BASE_URL || "");
      setCustModel(env.ANTHROPIC_MODEL || "");
      setCustToken(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "");
      setMaxTokens(env.MAX_TOKENS || env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || "65536");
      setMaxContext(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS || "1000000");
      setTimeout_(env.API_TIMEOUT_MS || "120000");
      setCapabilities(parseCapabilities(env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES));
      setView("create");
    } catch (e: any) {
      showMsg(String(e), false);
    }
  };

  // ── Delete ──
  const handleDelete = async (id: string) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("delete_profile", { profileName: id });
      setDeleteTarget(null);
      showMsg(t("profile.deleted", { id }), true);
      refresh();
    } catch (e: any) {
      showMsg(String(e), false);
    }
  };

  // ── Create ──
  const getTemplates = (): PresetTemplate[] => {
    if (provider === "deepseek") return DEEPSEEK_TEMPLATES;
    if (provider === "qwen") return QWEN_TEMPLATES;
    return [];
  };

  /** Collect extra env vars shared by preset and custom modes (max_tokens, context, timeout). */
  const getExtraVars = (): Record<string, string> => {
    const vars: Record<string, string> = {};
    if (maxTokens.trim()) {
      vars.MAX_TOKENS = maxTokens.trim();
      vars.CLAUDE_CODE_MAX_OUTPUT_TOKENS = maxTokens.trim();
    }
    if (maxContext.trim()) vars.CLAUDE_CODE_MAX_CONTEXT_TOKENS = maxContext.trim();
    if (timeout.trim()) vars.API_TIMEOUT_MS = timeout.trim();
    return vars;
  };

  const handleCreate = async () => {
    const extra = getExtraVars();

    if (provider === "custom") {
      if (!custName.trim() || !custBaseUrl.trim() || !custModel.trim() || !custToken.trim()) {
        setCreateMsg({ text: t("profile.fillRequired"), ok: false });
        return;
      }
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const vars: Record<string, string> = {
          ANTHROPIC_AUTH_TOKEN: custToken.trim(),
          ANTHROPIC_BASE_URL: custBaseUrl.trim(),
          ANTHROPIC_MODEL: custModel.trim(),
          ANTHROPIC_DEFAULT_SONNET_MODEL: custModel.trim(),
          ANTHROPIC_DEFAULT_HAIKU_MODEL: custModel.trim(),
          ANTHROPIC_DEFAULT_OPUS_MODEL: custModel.trim(),
          ...capabilityVarsFromSet(capabilities),
          ...extra,
        };
        await invoke("create_profile", { profileName: editingId || custName.trim(), envVars: vars });
        setCreateMsg({ text: t(editingId ? "profile.saved" : "profile.createdName", { name: custName.trim() }), ok: true });
        refresh();
        setTimeout(() => { setView("list"); resetCreateForm(); }, 800);
      } catch (e: any) {
        setCreateMsg({ text: String(e), ok: false });
      }
      return;
    }

    // Preset
    if (selectedModels.size === 0) {
      setCreateMsg({ text: t("profile.selectModel"), ok: false });
      return;
    }
    if (!authToken.trim()) {
      setCreateMsg({ text: t("profile.enterApiKey"), ok: false });
      return;
    }
    const templates = getTemplates().filter((tpl) => selectedModels.has(tpl.profileName));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      for (const tpl of templates) {
        const vars: Record<string, string> = {
          ...tpl.vars,
          ...capabilityVarsFor(provider),
          ANTHROPIC_AUTH_TOKEN: authToken.trim(),
          ...extra,
        };
        // Skip if already exists (don't overwrite silently)
        const existing = profiles.find((p) => p.id === tpl.profileName);
        if (existing) {
          setCreateMsg({ text: t("profile.exists", { name: tpl.profileName }), ok: false });
          continue;
        }
        await invoke("create_profile", { profileName: tpl.profileName, envVars: vars });
      }
      setCreateMsg({ text: t("profile.created"), ok: true });
      refresh();
      setTimeout(() => { setView("list"); resetCreateForm(); }, 800);
    } catch (e: any) {
      setCreateMsg({ text: String(e), ok: false });
    }
  };

  const resetCreateForm = () => {
    setProvider("deepseek");
    setSelectedModels(new Set());
    setAuthToken("");
    setCustName(""); setCustBaseUrl(""); setCustModel(""); setCustToken("");
    setMaxTokens("65536"); setMaxContext("1000000"); setTimeout_("120000");
    setCapabilities(new Set());
    setCreateMsg(null);
    setEditingId(null);
  };

  const toggleModel = (name: string) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  // ── Render ──

  return (
    <div style={S.container}>
      {/* Header */}
      <div style={S.header}>
        <span style={{ flex: 1 }}>{t("profile.title")}</span>
        {view === "create" && (
          <button onClick={() => { setView("list"); resetCreateForm(); }}
            style={S.btnSm("var(--bg-root)", "var(--fg-secondary)")}>
            <X size={12} style={{ marginRight: 2 }} /> {t("profile.back")}
          </button>
        )}
      </div>

      {/* Message */}
      {msg && (
        <div style={{ padding: "4px 12px", fontSize: 11, color: msg.ok ? "var(--semantic-success)" : "var(--semantic-error)", borderBottom: "1px solid var(--border-light)" }}>
          {msg.text}
        </div>
      )}

      {/* ── List view ── */}
      {view === "list" && (
        <>
          <div style={S.body}>
            {profiles.length === 0 && (
              <div style={{ padding: "24px 12px", textAlign: "center", color: "var(--fg-muted)" }}>
                {t("profile.empty")}
              </div>
            )}
            {profiles.map((p) => {
              const isActive = p.id === activeId;
              return (
                <div key={p.id} style={S.profileRow}>
                  <div style={isActive ? S.activeDot : S.inactiveDot} title={isActive ? t("profile.current") : ""} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, color: "var(--fg-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {p.label}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--fg-muted)" }}>
                      {p.id}{p.model ? ` · ${p.model}` : ""}
                      {isActive && <span style={{ color: "var(--semantic-success)", marginLeft: 6 }}>{t("profile.current")}</span>}
                    </div>
                  </div>
                  <button onClick={() => handleSwitch(p.id)} disabled={loading || isActive}
                    style={S.btnSm(isActive ? "var(--bg-hover)" : "var(--accent)", isActive ? "var(--fg-muted)" : "var(--fg-inverse)")}>
                    {t("profile.switchTo")}
                  </button>
                  <button onClick={() => handleSetDefault(p.id)}
                    style={S.btnSm("var(--bg-root)", "var(--fg-secondary)")} title={t("profile.setDefault")}>
                    <Star size={11} />
                  </button>
                  <button onClick={() => handleEdit(p.id)}
                    style={S.btnSm("var(--bg-root)", "var(--fg-secondary)")} title={t("profile.editTitle")}>
                    <Edit size={11} />
                  </button>
                  <button onClick={() => setDeleteTarget(p.id)}
                    style={S.btnSm("var(--bg-root)", "var(--semantic-error)")} title={t("profile.delete")}>
                    <Trash2 size={11} />
                  </button>
                </div>
              );
            })}
          </div>
          <div style={S.footer}>
            <button onClick={() => setView("create")}
              style={{ ...S.btnSm("var(--bg-root)", "var(--accent)"), padding: "4px 12px", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Plus size={14} /> {t("profile.newProfile")}
            </button>
          </div>
        </>
      )}

      {/* ── Create view ── */}
      {view === "create" && (
        <div style={{ ...S.body, padding: "12px" }}>
          {/* Provider selection */}
          <div style={{ marginBottom: 16 }}>
            <div style={S.label}>{t("profile.selectProvider")}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <div onClick={() => { setProvider("deepseek"); setCreateMsg(null); }}
                style={S.providerBtn(provider === "deepseek")}>
                <div style={{ fontSize: 16, marginBottom: 2 }}>🆕</div>
                <div>DeepSeek</div>
              </div>
              <div onClick={() => { setProvider("qwen"); setCreateMsg(null); }}
                style={S.providerBtn(provider === "qwen")}>
                <div style={{ fontSize: 16, marginBottom: 2 }}>☁️</div>
                <div>Qwen</div>
              </div>
              <div onClick={() => { setProvider("custom"); setCreateMsg(null); }}
                style={S.providerBtn(provider === "custom")}>
                <div style={{ fontSize: 16, marginBottom: 2 }}>⚙️</div>
                <div>{t("profile.custom")}</div>
              </div>
            </div>
          </div>

          {/* Custom form */}
          {provider === "custom" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                <div style={S.label}>{t("profile.name")}</div>
                <input value={custName} onChange={(e) => setCustName(e.target.value)}
                  placeholder={t("profile.idPlaceholder")} style={{ ...S.input, width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <div style={S.label}>ANTHROPIC_BASE_URL *</div>
                <input value={custBaseUrl} onChange={(e) => setCustBaseUrl(e.target.value)}
                  placeholder="https://api.example.com/v1" style={{ ...S.input, width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <div style={S.label}>ANTHROPIC_MODEL *</div>
                <input value={custModel} onChange={(e) => setCustModel(e.target.value)}
                  placeholder="model-name" style={{ ...S.input, width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <div style={S.label}>ANTHROPIC_AUTH_TOKEN *</div>
                <input value={custToken} onChange={(e) => setCustToken(e.target.value)}
                  type="password" placeholder="sk-..." style={{ ...S.input, width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <div style={S.label}>{t("profile.maxTokensLabel")}</div>
                <OptionSelector options={maxTokensOptions()} value={maxTokens} onChange={setMaxTokens} />
              </div>
              <div>
                <div style={S.label}>{t("profile.maxContextLabel")}</div>
                <OptionSelector options={maxContextOptions()} value={maxContext} onChange={setMaxContext} />
              </div>
              <div>
                <div style={S.label}>{t("profile.timeoutLabel")}</div>
                <OptionSelector options={timeoutOptions()} value={timeout} onChange={setTimeout_} />
              </div>
              <div>
                <div style={S.label}>{t("profile.capLabel")}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {CAPABILITY_OPTIONS.map((c) => {
                    const on = capabilities.has(c.key);
                    return (
                      <label key={c.key} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12 }}>
                        <input type="checkbox" checked={on} onChange={() => toggleCapability(c.key)} />
                        <span>{t(c.labelKey)}</span>
                      </label>
                    );
                  })}
                </div>
                <div style={{ fontSize: 10, color: "var(--fg-muted)", marginTop: 4 }}>
                  {t("profile.capHint")}
                </div>
              </div>
              {createMsg && (
                <div style={{ fontSize: 11, color: createMsg.ok ? "var(--semantic-success)" : "var(--semantic-error)" }}>{createMsg.text}</div>
              )}
              <button onClick={handleCreate}
                style={{ ...S.btnSm("var(--accent)", "var(--fg-inverse)"), padding: "6px 16px", alignSelf: "flex-start" }}>
                {editingId ? t("profile.save") : t("profile.create")}
              </button>
            </div>
          )}

          {/* Preset form */}
          {provider !== "custom" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div style={S.label}>{t("profile.selectModel")}</div>
                {getTemplates().map((tpl) => {
                  const sel = selectedModels.has(tpl.profileName);
                  return (
                    <label key={tpl.profileName} style={{
                      display: "flex", alignItems: "center", gap: 8, padding: "4px 0",
                      cursor: "pointer", fontSize: 12,
                    }}>
                      <input type="checkbox" checked={sel} onChange={() => toggleModel(tpl.profileName)} />
                      <span>{tpl.label}</span>
                      <span style={{ fontSize: 10, color: "var(--fg-muted)" }}>({tpl.profileName})</span>
                    </label>
                  );
                })}
              </div>
              <div>
                <div style={S.label}>{t("profile.tokenLabel")}</div>
                <input value={authToken} onChange={(e) => setAuthToken(e.target.value)}
                  type="password" placeholder="sk-..."
                  style={{ ...S.input, width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <div style={S.label}>{t("profile.maxTokensLabel")}</div>
                <OptionSelector options={maxTokensOptions()} value={maxTokens} onChange={setMaxTokens} />
              </div>
              <div>
                <div style={S.label}>{t("profile.maxContextLabel")}</div>
                <OptionSelector options={maxContextOptions()} value={maxContext} onChange={setMaxContext} />
              </div>
              <div>
                <div style={S.label}>{t("profile.timeoutLabel")}</div>
                <OptionSelector options={timeoutOptions()} value={timeout} onChange={setTimeout_} />
              </div>
              {createMsg && (
                <div style={{ fontSize: 11, color: createMsg.ok ? "var(--semantic-success)" : "var(--semantic-error)" }}>{createMsg.text}</div>
              )}
              <button onClick={handleCreate}
                disabled={selectedModels.size === 0 || !authToken.trim()}
                style={{
                  ...S.btnSm("var(--accent)", "var(--fg-inverse)"), padding: "6px 16px", alignSelf: "flex-start",
                  opacity: selectedModels.size === 0 || !authToken.trim() ? 0.4 : 1,
                }}>
                {t("profile.create")}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Delete confirm overlay ── */}
      {deleteTarget && (
        <div style={{
          position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.3)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10,
        }}>
          <div style={{
            backgroundColor: "var(--bg-root)", borderRadius: 8, padding: "20px 24px",
            boxShadow: "0 4px 20px rgba(0,0,0,0.15)", maxWidth: 320, textAlign: "center",
          }}>
            <div style={{ fontSize: 13, color: "var(--fg-primary)", marginBottom: 12 }}>
              {t("profile.deleteConfirmName", { name: deleteTarget })}
            </div>
            <div style={{ fontSize: 11, color: "var(--fg-muted)", marginBottom: 16 }}>
              {t("profile.deleteWarn")}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button onClick={() => setDeleteTarget(null)}
                style={S.btnSm("var(--bg-root)", "var(--fg-secondary)")}>{t("profile.cancel")}</button>
              <button onClick={() => handleDelete(deleteTarget)}
                style={S.btnSm("var(--semantic-error)", "var(--fg-inverse)")}>{t("profile.delete")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
