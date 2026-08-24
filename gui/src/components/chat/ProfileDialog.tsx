import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Check, Star, X, User } from "lucide-react";
import { t } from "../../i18n";
import { eventBus } from "../../services/serviceBus";
import { Events } from "../../services/events";

interface ProfileInfo {
  id: string;
  label: string;
  model: string;
}

// ── Dropdown option presets ──

const MAX_TOKENS_OPTIONS = [
  { label: "64K", value: "65536" },
  { label: "128K", value: "131072" },
  { label: "256K", value: "262144" },
  { label: "自定义", value: "__custom__" },
];

const MAX_CONTEXT_OPTIONS = [
  { label: "128K", value: "128000" },
  { label: "256K", value: "256000" },
  { label: "512K", value: "512000" },
  { label: "1M", value: "1000000" },
  { label: "自定义", value: "__custom__" },
];

const TIMEOUT_OPTIONS = [
  { label: "60s", value: "60000" },
  { label: "120s（默认）", value: "120000" },
  { label: "300s（5分钟）", value: "300000" },
  { label: "自定义", value: "__custom__" },
];

// ── Preset templates (mirrors scripts/claude-profile.ts) ──

interface PresetTemplate {
  label: string;
  profileName: string;
  vars: Record<string, string>;
  requiresToken: boolean;
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
];

const QWEN_TEMPLATES: PresetTemplate[] = [
  {
    label: "Qwen 3.6 Plus",
    profileName: "qwen-3.6-plus",
    vars: {
      ANTHROPIC_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      ANTHROPIC_MODEL: "qwen3.6-plus",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3.6-plus",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3.6-plus",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen3.6-plus",
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
  const isCustom = value !== "" && !options.some((o) => o.value === value);
  const selectedPreset = isCustom ? "__custom__" : value;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, ...style }}>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {options.map((o) => (
          <div key={o.value}
            onClick={() => onChange(o.value === "__custom__" ? (isCustom ? value : "") : o.value)}
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
      {(isCustom || selectedPreset === "__custom__") && (
        <input
          value={isCustom ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="输入自定义值"
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

  // ── Delete confirm ──
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

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
      showMsg(`已切换到 ${id}`, true);
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
      showMsg(`${id} 已设为默认`, true);
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
      showMsg(`${id} 已删除`, true);
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
          ...extra,
        };
        await invoke("create_profile", { profileName: custName.trim(), envVars: vars });
        setCreateMsg({ text: `${custName.trim()} 创建成功`, ok: true });
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
    const templates = getTemplates().filter((t) => selectedModels.has(t.profileName));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      for (const t of templates) {
        const vars: Record<string, string> = {
          ...t.vars,
          ANTHROPIC_AUTH_TOKEN: authToken.trim(),
          ...extra,
        };
        // Skip if already exists (don't overwrite silently)
        const existing = profiles.find((p) => p.id === t.profileName);
        if (existing) {
          setCreateMsg({ text: `${t.profileName} 已存在，跳过`, ok: false });
          continue;
        }
        await invoke("create_profile", { profileName: t.profileName, envVars: vars });
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
    setCreateMsg(null);
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
        <span style={{ flex: 1 }}>Profile 管理</span>
        {view === "create" && (
          <button onClick={() => { setView("list"); resetCreateForm(); }}
            style={S.btnSm("var(--bg-root)", "var(--fg-secondary)")}>
            <X size={12} style={{ marginRight: 2 }} /> 返回
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
                还没有 Profile，点击下方按钮创建
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
                      {isActive && <span style={{ color: "var(--semantic-success)", marginLeft: 6 }}>当前使用</span>}
                    </div>
                  </div>
                  <button onClick={() => handleSwitch(p.id)} disabled={loading || isActive}
                    style={S.btnSm(isActive ? "var(--bg-hover)" : "var(--accent)", isActive ? "var(--fg-muted)" : "var(--fg-inverse)")}>
                    切换
                  </button>
                  <button onClick={() => handleSetDefault(p.id)}
                    style={S.btnSm("var(--bg-root)", "var(--fg-secondary)")} title={t("profile.setDefault")}>
                    <Star size={11} />
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
              <Plus size={14} /> 新建 Profile
            </button>
          </div>
        </>
      )}

      {/* ── Create view ── */}
      {view === "create" && (
        <div style={{ ...S.body, padding: "12px" }}>
          {/* Provider selection */}
          <div style={{ marginBottom: 16 }}>
            <div style={S.label}>选择提供商</div>
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
                <div>自定义</div>
              </div>
            </div>
          </div>

          {/* Custom form */}
          {provider === "custom" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                <div style={S.label}>Profile 名称 *</div>
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
                <div style={S.label}>MAX_TOKENS（最大输出）</div>
                <OptionSelector options={MAX_TOKENS_OPTIONS} value={maxTokens} onChange={setMaxTokens} />
              </div>
              <div>
                <div style={S.label}>CLAUDE_CODE_MAX_CONTEXT_TOKENS（上下文窗口）</div>
                <OptionSelector options={MAX_CONTEXT_OPTIONS} value={maxContext} onChange={setMaxContext} />
              </div>
              <div>
                <div style={S.label}>API_TIMEOUT_MS（超时）</div>
                <OptionSelector options={TIMEOUT_OPTIONS} value={timeout} onChange={setTimeout_} />
              </div>
              {createMsg && (
                <div style={{ fontSize: 11, color: createMsg.ok ? "var(--semantic-success)" : "var(--semantic-error)" }}>{createMsg.text}</div>
              )}
              <button onClick={handleCreate}
                style={{ ...S.btnSm("var(--accent)", "var(--fg-inverse)"), padding: "6px 16px", alignSelf: "flex-start" }}>
                创建
              </button>
            </div>
          )}

          {/* Preset form */}
          {provider !== "custom" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div style={S.label}>选择模型</div>
                {getTemplates().map((t) => {
                  const sel = selectedModels.has(t.profileName);
                  return (
                    <label key={t.profileName} style={{
                      display: "flex", alignItems: "center", gap: 8, padding: "4px 0",
                      cursor: "pointer", fontSize: 12,
                    }}>
                      <input type="checkbox" checked={sel} onChange={() => toggleModel(t.profileName)} />
                      <span>{t.label}</span>
                      <span style={{ fontSize: 10, color: "var(--fg-muted)" }}>({t.profileName})</span>
                    </label>
                  );
                })}
              </div>
              <div>
                <div style={S.label}>ANTHROPIC_AUTH_TOKEN (API Key)</div>
                <input value={authToken} onChange={(e) => setAuthToken(e.target.value)}
                  type="password" placeholder="sk-..."
                  style={{ ...S.input, width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <div style={S.label}>MAX_TOKENS（最大输出）</div>
                <OptionSelector options={MAX_TOKENS_OPTIONS} value={maxTokens} onChange={setMaxTokens} />
              </div>
              <div>
                <div style={S.label}>CLAUDE_CODE_MAX_CONTEXT_TOKENS（上下文窗口）</div>
                <OptionSelector options={MAX_CONTEXT_OPTIONS} value={maxContext} onChange={setMaxContext} />
              </div>
              <div>
                <div style={S.label}>API_TIMEOUT_MS（超时）</div>
                <OptionSelector options={TIMEOUT_OPTIONS} value={timeout} onChange={setTimeout_} />
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
                创建
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
              确定删除 Profile <strong>{deleteTarget}</strong>？
            </div>
            <div style={{ fontSize: 11, color: "var(--fg-muted)", marginBottom: 16 }}>
              这将永久删除对应的 .env 文件，此操作不可撤销。
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button onClick={() => setDeleteTarget(null)}
                style={S.btnSm("var(--bg-root)", "var(--fg-secondary)")}>取消</button>
              <button onClick={() => handleDelete(deleteTarget)}
                style={S.btnSm("var(--semantic-error)", "var(--fg-inverse)")}>删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
