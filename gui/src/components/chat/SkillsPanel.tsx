import { memo, useState, useMemo, useRef, useEffect, useCallback } from "react";
import { Languages } from "lucide-react";
import { t as i18nT } from "../../i18n";
import { useEvent } from "../../services/useService";
import { Events, type ChatStateChangedPayload, type SettingsChangedPayload } from "../../services/events";
import { getChatState, updateChatState, type SlashCommand } from "../../stores/chatStore";
import { getSettings, updateSettings, saveSettings } from "../../stores/settingsStore";
import { addFloatingPanel, getFloatingPanels, bringFloatingToFront } from "../../stores/layoutStore";
import { commands } from "../../services/serviceBus";
import { setSkillDialogCallbacks } from "./SkillDialogFloating";
import { skillMarketplace, type PackageSummary, type PackageDetail } from "../../services/skillMarketplace";
import { requestPluginRefresh } from "./useChatBridge";
import { addStatusMessage } from "../../stores/statusMsgStore";

type I18nMap = Record<string, { title?: string; desc?: string }>;

// ── Marketplace Tab (inline sub-component) ──

function MarketplaceTab() {
  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedPkg, setExpandedPkg] = useState<string | null>(null);
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [installedSkills, setInstalledSkills] = useState<Set<string>>(new Set());
  const [pkgDetails, setPkgDetails] = useState<Record<string, PackageDetail>>({});
  const [pkgTrans, setPkgTrans] = useState<Record<string, Record<string, { title?: string; desc?: string }>>>({});

  const refreshInstalled = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const dir: string = await invoke("get_skills_dir");
      const entries: { name: string; is_dir: boolean }[] = await invoke("read_dir", { path: dir, showHiddenFiles: false });
      setInstalledSkills(new Set(entries.filter((e: any) => e.is_dir).map((e: any) => e.name)));
    } catch { /* ignore */ }
  }, []);

  const fetchPackages = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const list = await skillMarketplace.listPackages();
      setPackages(list);
    } catch (e: any) {
      setError(e.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refreshInstalled(); fetchPackages(); }, [refreshInstalled, fetchPackages]);

  const loadPkgDetail = async (slug: string) => {
    if (pkgDetails[slug]) return;
    try {
      const [detail, trans] = await Promise.all([
        skillMarketplace.getPackage(slug),
        skillMarketplace.fetchTranslations(slug, "zh").catch(() => null),
      ]);
      setPkgDetails((prev) => ({ ...prev, [slug]: detail }));
      if (trans) setPkgTrans((prev) => ({ ...prev, [slug]: trans }));
    } catch { /* ignore */ }
  };

  const handleInstall = async (slug: string, skillName: string, zipUrl: string) => {
    const key = `${slug}/${skillName}`;
    setInstalling((prev) => new Set(prev).add(key));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("install_skill", { zipUrl, skillName });
      addStatusMessage(`"${skillName}" ${i18nT("skills.installSuccess")}`, "success");
      requestPluginRefresh();
      await refreshInstalled();
      await mergeTranslations(slug);
    } catch (e: any) {
      addStatusMessage(`${i18nT("skills.installFailed")}: ${e}`, "error");
    } finally {
      setInstalling((prev) => { const next = new Set(prev); next.delete(key); return next; });
    }
  };

  const mergeTranslations = async (slug: string) => {
    try {
      const trans = await skillMarketplace.fetchTranslations(slug, "zh");
      if (!trans || Object.keys(trans).length === 0) return;
      const { invoke } = await import("@tauri-apps/api/core");
      const raw = await invoke("load_skills_i18n") as string;
      const existing = raw ? JSON.parse(raw) : {};
      const merged = { ...existing, ...trans };
      await invoke("save_skills_i18n", { json: JSON.stringify(merged) });
    } catch { /* translations are best-effort */ }
  };

  const handleInstallAll = async (slug: string, zipUrl: string) => {
    const key = `pkg:${slug}`;
    setInstalling((prev) => new Set(prev).add(key));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("install_package", { zipUrl, packageName: slug });
      addStatusMessage(`${i18nT("skills.installSuccess")}`, "success");
      requestPluginRefresh();
      await refreshInstalled();
      await mergeTranslations(slug);
    } catch (e: any) {
      addStatusMessage(`${i18nT("skills.installFailed")}: ${e}`, "error");
    } finally {
      setInstalling((prev) => { const next = new Set(prev); next.delete(key); return next; });
    }
  };

  if (loading) return <div style={emptyStyle}>{i18nT("skills.marketplaceLoading")}</div>;
  if (error) return (
    <div style={emptyStyle}>
      <div>{i18nT("skills.marketplaceError")}: {error}</div>
      <button onClick={fetchPackages} style={retryBtnStyle}>{i18nT("skills.marketplaceRetry")}</button>
    </div>
  );
  if (packages.length === 0) return <div style={emptyStyle}>{i18nT("skills.marketplaceEmpty")}</div>;

  return (
    <div style={{ overflow: "auto", flex: "1 1 auto" }}>
      {packages.map((pkg) => {
        const isExpanded = expandedPkg === pkg.slug;
        const pkgInstalling = installing.has(`pkg:${pkg.slug}`);
        const detail = pkgDetails[pkg.slug];
        return (
          <div key={pkg.slug} style={pkgCardStyle}>
            <div style={pkgHeaderStyle} onClick={() => { if (!isExpanded) loadPkgDetail(pkg.slug); setExpandedPkg(isExpanded ? null : pkg.slug); }}>
              <span style={{ fontWeight: 600, fontSize: "calc(var(--font-scale, 1) * 13px)", flex: 1 }}>{pkg.name}</span>
              <span style={{ fontSize: 10, color: "var(--fg-muted)" }}>
                {i18nT("skills.skillsCount", { count: pkg.skill_count })} · {i18nT("skills.downloads", { count: pkg.download_count })}
              </span>
              {pkgInstalling ? (
                <span style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--accent)" }}>{i18nT("skills.installing")}</span>
              ) : (
                <button onClick={(e) => { e.stopPropagation(); handleInstallAll(pkg.slug, skillMarketplace.getPackageDownloadUrl(pkg.slug)); }}
                  style={installBtnStyle}>{i18nT("skills.installAll")}</button>
              )}
              <span style={{ fontSize: 10, color: "var(--fg-muted)", marginLeft: 4 }}>
                {isExpanded ? "\u25B2" : "\u25BC"}
              </span>
            </div>
            <div style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-muted)", padding: "0 12px 6px" }}>
              {pkg.description}<br/>
              {i18nT("skills.byAuthor", { author: pkg.author })} · {i18nT("skills.versionLabel", { version: pkg.version })}
              {pkg.tags.length > 0 && <span> · {pkg.tags.join(", ")}</span>}
            </div>

            {isExpanded && (
              <div style={{ borderTop: "1px solid var(--border-light)", padding: "4px 0" }}>
                {!detail ? (
                  <div style={{ padding: 8, fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-muted)" }}>Loading skills...</div>
                ) : detail.skills.length === 0 ? (
                  <div style={{ padding: 8, fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-muted)" }}>No skills in this package</div>
                ) : (
                  detail.skills.map((skill) => {
                    const isInstalled = installedSkills.has(skill.name);
                    const isInstalling = installing.has(`${pkg.slug}/${skill.name}`);
                    const key = "/" + skill.name;
                    const t = pkgTrans[pkg.slug]?.[key];
                    const transTitle = t?.title;
                    const displayDesc = t?.desc || skill.description;
                    return (
                      <div key={skill.name} style={skillItemStyle}>
                        <span style={{ fontWeight: 600, fontSize: "calc(var(--font-scale, 1) * 12px)", flexShrink: 0 }}>/{skill.name}</span>
                        {transTitle && <span style={{ fontWeight: 400, color: "var(--fg-muted)", fontSize: "calc(var(--font-scale, 1) * 12px)", flexShrink: 0 }}>{transTitle}</span>}
                        <span style={{ color: "var(--fg-muted)", fontSize: "calc(var(--font-scale, 1) * 11px)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }} title={displayDesc}>{displayDesc}</span>
                        {isInstalled ? (
                          <span style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--semantic-success)", flexShrink: 0, minWidth: 42, textAlign: "right" }}>{i18nT("skills.installed")}</span>
                        ) : isInstalling ? (
                          <span style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--accent)", flexShrink: 0, minWidth: 42, textAlign: "right" }}>{i18nT("skills.installing")}</span>
                        ) : (
                          <button onClick={() => handleInstall(pkg.slug, skill.name, skillMarketplace.getSkillDownloadUrl(pkg.slug, skill.name))}
                            style={installBtnStyle}>{i18nT("skills.install")}</button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function _SkillsPanel() {
  const [tab, setTab] = useState<"installed" | "marketplace">("installed");
  const payload = useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED);
  const rawCommands = payload?.state?.slashCommands ?? getChatState().slashCommands ?? [];

  const [search, setSearch] = useState("");
  const [, setTick] = useState(0);
  const floatRef = useRef<string | null>(null);

  // ── Translations ──
  const [i18n, setI18n] = useState<I18nMap>({});
  const [translating, setTranslating] = useState(false);
  const [transMsg, setTransMsg] = useState("");

  // Load saved translations on mount
  const settingsPayload = useEvent<SettingsChangedPayload>(Events.SETTINGS_CHANGED);
  const workDir = settingsPayload?.settings?.workDir ?? getSettings().workDir;
  useEffect(() => {
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const json: string = await invoke("load_skills_i18n");
        if (json) setI18n(JSON.parse(json));
      } catch { /* no translations yet */ }
    })();
  }, []);

  const t = useCallback((cmd: string): { title: string; desc: string } => {
    const tx = i18n[cmd] || i18n["/" + cmd];
    return { title: tx?.title || cmd, desc: tx?.desc || "" };
  }, [i18n]);

  const skills = useMemo(() => {
    const list = rawCommands
      .filter((c) => c && c.cmd && (c.type === "prompt" || c.type === "skill"))
      .filter((c) => !search || c.cmd.includes(search.toLowerCase()) || (c.desc && c.desc.toLowerCase().includes(search.toLowerCase())));

    const favs = getSettings().favoriteSkills ?? [];
    const favorite: SlashCommand[] = [];
    const regular: SlashCommand[] = [];
    for (const s of list) {
      (favs.includes(s.cmd) ? favorite : regular).push(s);
    }
    return { favorite, regular };
  }, [rawCommands, search, settingsPayload]);

  function toggleFavorite(cmd: string) {
    const s = getSettings();
    const favs = new Set(s.favoriteSkills ?? []);
    if (favs.has(cmd)) { favs.delete(cmd); } else { favs.add(cmd); }
    const list = [...favs];
    updateSettings({ favoriteSkills: list });
    saveSettings({ favoriteSkills: list });
    setTick((t) => t + 1);
  }

  function isFavorite(cmd: string): boolean {
    return (getSettings().favoriteSkills ?? []).includes(cmd);
  }

  function openSkillDialog(skill: SlashCommand) {
    if (floatRef.current) {
      const existing = getFloatingPanels().find((fp) => fp.id === floatRef.current);
      if (existing) {
        bringFloatingToFront(floatRef.current);
        return;
      }
    }
    const w = 440, h = 340;
    const x = Math.max(40, (window.innerWidth - w) / 2);
    const y = Math.max(60, (window.innerHeight - h) / 2);
    const floatId = addFloatingPanel(
      {
        type: "group",
        id: `skill-dialog-float-${crypto.randomUUID()}`,
        tabs: [{ id: "tab-skill-dialog", panelId: "skill-dialog", title: "/" + skill.cmd }],
        activeTabId: "tab-skill-dialog",
      },
      x, y, w, h,
    );
    floatRef.current = floatId;
    updateChatState({ activeSkillDialog: { skill, isFav: isFavorite(skill.cmd) } });
    setSkillDialogCallbacks(
      floatId,
      (text) => {
        commands.execute("SEND_MESSAGE", text);
        updateChatState({ activeSkillDialog: null });
        floatRef.current = null;
      },
      () => {
        updateChatState({ activeSkillDialog: null });
        floatRef.current = null;
      },
      () => toggleFavorite(skill.cmd),
    );
  }

  // ── Translate (async, non-blocking via Tauri event) ──
  const translateUnlistenRef = useRef<(() => void) | null>(null);
  useEffect(() => () => translateUnlistenRef.current?.(), []);

  const handleTranslate = async () => {
    setTranslating(true);
    setTransMsg(i18nT("skills.translating"));
    try {
      translateUnlistenRef.current?.();
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");

      const skillsList = rawCommands
        .filter((c) => c && c.cmd && (c.type === "prompt" || c.type === "skill"))
        .map((c) => `/${c.cmd}: ${c.desc || ""}`)
        .join("\n");

      const prompt = `Translate the following Claude Code skill names and descriptions to Simplified Chinese (zh-CN). Keep skill command names (starting with /) as-is. Return ONLY a valid JSON object — plain text, no markdown fences, no code blocks, no explanation. Escape all double quotes and backslashes inside string values. Format: { "/command-name": { "title": "中文标题", "desc": "中文描述" } }

Skills:
${skillsList}`;

      setTransMsg(i18nT("skills.translatingProgress"));
      const ridRef = { current: "" };

      const unlisten = await listen<{ request_id: string; ok: boolean; output?: string; error?: string }>(
        "cli-translate-result",
        async (event) => {
          if (event.payload.request_id !== ridRef.current) return;
          translateUnlistenRef.current = null;
          unlisten();
          setTranslating(false);

          if (!event.payload.ok) {
            setTransMsg(`${i18nT("skills.translateFailed")}: ${event.payload.error || i18nT("skills.unknownError")}`);
            return;
          }

          const output = event.payload.output || "";
          let text = output.trim();
          text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
          const start = text.indexOf("{");
          if (start === -1) {
            setTransMsg(`翻译失败: 输出中未找到 JSON\n${output.slice(0, 300)}`);
            return;
          }
          let depth = 0, end = -1;
          for (let i = start; i < text.length; i++) {
            if (text[i] === "{") depth++;
            else if (text[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
          }
          if (end === -1) {
            setTransMsg(`翻译失败: JSON 未闭合\n${text.slice(start, start + 300)}`);
            return;
          }
          const jsonStr = text.slice(start, end);

          let parsed: Record<string, { title: string; desc?: string }>;
          try {
            parsed = JSON.parse(jsonStr);
          } catch (parseErr: any) {
            const m = parseErr.message.match(/position (\d+)/);
            const p = m ? parseInt(m[1], 10) : 0;
            const ctx = jsonStr.slice(Math.max(0, p - 60), p + 60);
            setTransMsg(`翻译失败: JSON 解析错误 — ${parseErr.message}\n  ...${ctx}...`);
            return;
          }

          await invoke("save_skills_i18n", { json: JSON.stringify(parsed) });
          setI18n(parsed);
          setTransMsg(i18nT("skills.translateSuccess"));
          setTimeout(() => setTransMsg(""), 3000);
        }
      );
      translateUnlistenRef.current = unlisten;

      const requestId: string = await invoke("run_cli_print", { prompt, workDir });
      ridRef.current = requestId;
    } catch (e: any) {
      setTransMsg(`翻译失败: ${e.message || String(e)}`);
      setTranslating(false);
    }
  };

  // ── Render helpers ──
  const skillTitle = (s: SlashCommand): { title: string; cmd: string; translated: boolean } => {
    const tx = t(s.cmd);
    if (tx.title !== s.cmd) return { title: tx.title, cmd: "/" + s.cmd, translated: true };
    return { title: "/" + s.cmd, cmd: "", translated: false };
  };
  const skillDesc = (s: SlashCommand) => {
    const tx = t(s.cmd);
    return tx.desc || s.desc || "";
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", backgroundColor: "var(--bg-root)" }}>
      {/* Tab bar */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--border-light)", flexShrink: 0 }}>
        <button onClick={() => setTab("installed")}
          style={tabBtnStyle(tab === "installed")}>{i18nT("skills.tabInstalled")}</button>
        <button onClick={() => setTab("marketplace")}
          style={tabBtnStyle(tab === "marketplace")}>{i18nT("skills.tabMarketplace")}</button>
      </div>

      {tab === "installed" ? (
        <>
          {/* Header: search + translate */}
          <div style={{ padding: "8px 12px", flexShrink: 0, display: "flex", gap: 6 }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={i18nT("skills.searchPlaceholder")}
          style={{
            flex: 1, boxSizing: "border-box",
            padding: "4px 8px", border: "1px solid var(--border-medium)", borderRadius: 4,
            fontSize: "calc(var(--font-scale, 1) * 12px)", fontFamily: "var(--font-sans)", outline: "none",
          }}
        />
        <button
          type="button"
          onClick={handleTranslate}
          disabled={translating}
          title={i18nT("skills.translateToChinese")}
          style={{
            display: "flex", alignItems: "center", gap: 3,
            border: "1px solid var(--border-medium)", borderRadius: 4,
            padding: "4px 8px", cursor: translating ? "default" : "pointer",
            fontSize: "calc(var(--font-scale, 1) * 11px)", fontFamily: "var(--font-sans)",
            backgroundColor: "var(--bg-root)", color: translating ? "var(--fg-muted)" : "var(--accent)",
            whiteSpace: "nowrap", opacity: translating ? 0.6 : 1,
          }}
        >
          <Languages size={13} />
          {Object.keys(i18n).length > 0 ? i18nT("skills.retranslate") : i18nT("skills.translate")}
        </button>
      </div>

      {/* Translation message */}
      {transMsg && (
        <div style={{
          padding: "4px 12px", fontSize: "calc(var(--font-scale, 1) * 11px)",
          color: transMsg.includes("失败") || transMsg.includes("请先") ? "var(--semantic-error)" : "var(--semantic-success)",
          borderBottom: "1px solid #f0f0f0",
        }}>
          {transMsg}
        </div>
      )}

      <div style={{ flex: "1 1 auto", overflow: "auto" }}>
        {skills.favorite.length > 0 && (
          <>
            <div style={{ padding: "4px 12px", fontSize: 10, color: "var(--fg-muted)", fontFamily: "var(--font-sans)", fontWeight: 600 }}>收藏</div>
            {skills.favorite.map((s) => {
              const st = skillTitle(s);
              const desc = skillDesc(s);
              return (
                <div key={s.cmd} style={itemStyle} onClick={() => openSkillDialog(s)}>
                  <span style={{ color: "#f0a500", flexShrink: 0, width: 14, textAlign: "center" }}>★</span>
                  <span style={{ fontWeight: 600, color: "var(--fg-primary)", flexShrink: 0 }}>{st.cmd || "/" + s.cmd}</span>
                  {st.translated && <span style={{ fontWeight: 400, color: "#555", flexShrink: 0 }}>{st.title}</span>}
                  <span style={{ color: "var(--fg-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={desc}>
                    {desc}
                    {!st.translated && s.desc && <span style={{ fontSize: 9, color: "#bbb", marginLeft: 4 }}>(未翻译)</span>}
                  </span>
                </div>
              );
            })}
            <div style={{ height: 1, backgroundColor: "var(--border-light)", margin: "4px 12px" }} />
          </>
        )}

        {skills.regular.map((s) => {
          const st = skillTitle(s);
          const desc = skillDesc(s);
          return (
            <div key={s.cmd} style={itemStyle} onClick={() => openSkillDialog(s)}>
              <span style={{ width: 14, flexShrink: 0 }} />
              <span style={{ fontWeight: 600, color: "var(--fg-primary)", flexShrink: 0 }}>{st.cmd || "/" + s.cmd}</span>
              {st.translated && <span style={{ fontWeight: 400, color: "#555", flexShrink: 0 }}>{st.title}</span>}
              <span style={{ color: "var(--fg-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={desc}>
                {desc}
                {!st.translated && s.desc && <span style={{ fontSize: 9, color: "#bbb", marginLeft: 4 }}>(未翻译)</span>}
              </span>
            </div>
          );
        })}

        {skills.favorite.length === 0 && skills.regular.length === 0 && (
          <div style={{ padding: "20px 12px", textAlign: "center", fontSize: "calc(var(--font-scale, 1) * 12px)", color: "var(--fg-muted)", fontFamily: "var(--font-sans)" }}>
            {search ? i18nT("skills.noMatch") : i18nT("skills.empty")}
          </div>
        )}
      </div>
        </>
      ) : (
        <MarketplaceTab />
      )}
    </div>
  );
}

const itemStyle: React.CSSProperties = {
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: "calc(var(--font-scale, 1) * 12px)",
  fontFamily: "var(--font-sans)",
  display: "flex",
  alignItems: "center",
  gap: 8,
};

// ── Marketplace styles ──

function tabBtnStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1, padding: "6px 12px", border: "none",
    cursor: "pointer", fontSize: "calc(var(--font-scale, 1) * 12px)", fontFamily: "var(--font-sans)",
    backgroundColor: active ? "var(--bg-root)" : "var(--bg-muted)",
    color: active ? "var(--fg-primary)" : "var(--fg-muted)",
    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
    fontWeight: active ? 600 : 400,
  };
}

const pkgCardStyle: React.CSSProperties = {
  borderBottom: "1px solid var(--border-light)",
  backgroundColor: "var(--bg-root)",
};

const pkgHeaderStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8,
  padding: "8px 12px", cursor: "pointer",
};

const skillItemStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8,
  padding: "6px 12px 6px 24px",
  fontSize: "calc(var(--font-scale, 1) * 12px)", fontFamily: "var(--font-sans)",
  minWidth: 0,
};

const installBtnStyle: React.CSSProperties = {
  border: "1px solid var(--accent)", borderRadius: 3,
  padding: "2px 8px", cursor: "pointer",
  fontSize: "calc(var(--font-scale, 1) * 11px)", fontFamily: "var(--font-sans)",
  backgroundColor: "transparent", color: "var(--accent)",
  flexShrink: 0,
};

const emptyStyle: React.CSSProperties = {
  padding: "20px 12px", textAlign: "center",
  fontSize: "calc(var(--font-scale, 1) * 12px)", color: "var(--fg-muted)", fontFamily: "var(--font-sans)",
};

const retryBtnStyle: React.CSSProperties = {
  marginTop: 8, border: "1px solid var(--accent)", borderRadius: 3,
  padding: "2px 12px", cursor: "pointer",
  fontSize: "calc(var(--font-scale, 1) * 11px)", fontFamily: "var(--font-sans)",
  backgroundColor: "transparent", color: "var(--accent)",
};

export default memo(_SkillsPanel);
