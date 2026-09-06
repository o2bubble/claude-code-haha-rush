// ── PluginMarketPanel — 插件市场(平台化共享, T5) ──
// 复用技能市场同一 registry server(/api/packages, type=plugin):
// 列表/搜索/安装 → install_plugin_package(Rust 下载+解压到 plugins/) → 重扫 → 面板活。
// 与 SkillsPanel 的 MarketplaceTab 同范式(列表卡片/展开/安装按钮)。

import { useState, useEffect, useCallback } from "react";
import { t as i18nT } from "../../i18n";
import { skillMarketplace, type PackageSummary } from "../../services/skillMarketplace";
import { reloadPlugins } from "../../services/pluginRegistry";
import { addStatusMessage } from "../../stores/statusMsgStore";
import { pkgCardStyle, pkgHeaderStyle, installBtnStyle, emptyStyle, retryBtnStyle } from "./marketplaceStyles";

// ── 已安装插件集合(从 list_plugin_manifests 拿) ──

async function getInstalledPluginNames(): Promise<Set<string>> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const entries = (await invoke<{ name: string; manifestJson?: string }[]>("list_plugin_manifests")) ?? [];
    return new Set(entries.map((e) => e.name));
  } catch {
    return new Set(); // 非 Tauri 环境
  }
}

// ── 插件市场面板 ──

export default function PluginMarketPanel() {
  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [installed, setInstalled] = useState<Set<string>>(new Set());

  const refreshInstalled = useCallback(async () => {
    setInstalled(await getInstalledPluginNames());
  }, []);

  const fetchPackages = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const list = await skillMarketplace.listPackages();
      // 只显示插件包(type=plugin; server 旧包无 type 默认 skill, 过滤掉)
      setPackages(list.filter((p) => p.type === "plugin"));
    } catch (e: any) {
      setError(e.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refreshInstalled(); fetchPackages(); }, [refreshInstalled, fetchPackages]);

  const handleInstall = async (slug: string, zipUrl: string) => {
    setInstalling((prev) => new Set(prev).add(slug));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("install_plugin_package", { zipUrl, packageName: slug });
      addStatusMessage(`${i18nT("skills.installSuccess")}`, "success");
      // 安装即活: 重扫插件 manifest → 面板注册 + 事件转发 + 进程刷新
      await refreshInstalled();
      await refreshPluginRegistry();
    } catch (e: any) {
      addStatusMessage(`${i18nT("skills.installFailed")}: ${e}`, "error");
    } finally {
      setInstalling((prev) => { const next = new Set(prev); next.delete(slug); return next; });
    }
  };

  const refreshPluginRegistry = async () => {
    // 单一入口 reloadPlugins (scan→setActiveManifests→registerPluginPanels→事件→进程)
    await reloadPlugins();
  };

  const filtered = packages.filter(
    (p) =>
      !search ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.description ?? "").toLowerCase().includes(search.toLowerCase()) ||
      p.tags.some((tag) => tag.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", backgroundColor: "var(--bg-root)" }}>
      {/* 搜索 */}
      <div style={{ padding: "8px 12px", flexShrink: 0 }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={i18nT("skills.searchPlaceholder")}
          style={{
            width: "100%", boxSizing: "border-box",
            padding: "4px 8px", border: "1px solid var(--border-medium)", borderRadius: 4,
            fontSize: "calc(var(--font-scale, 1) * 12px)", fontFamily: "var(--font-sans)", outline: "none",
          }}
        />
      </div>

      <div style={{ flex: "1 1 auto", overflow: "auto" }}>
        {loading ? (
          <div style={emptyStyle}>{i18nT("skills.marketplaceLoading")}</div>
        ) : error ? (
          <div style={emptyStyle}>
            <div>{i18nT("skills.marketplaceError")}: {error}</div>
            <button onClick={fetchPackages} style={retryBtnStyle}>{i18nT("skills.marketplaceRetry")}</button>
          </div>
        ) : filtered.length === 0 ? (
          <div style={emptyStyle}>{i18nT("skills.marketplaceEmpty")}</div>
        ) : (
          filtered.map((pkg) => {
            const isInstalling = installing.has(pkg.slug);
            // installed(key=插件目录名=pluginName) 可能 ≠ market name/slug → 两者任一命中
            const isInstalled = installed.has(pkg.name) || installed.has(pkg.slug);
            return (
              <div key={pkg.slug} style={pkgCardStyle}>
                <div style={pkgHeaderStyle}>
                  <span style={{ fontWeight: 600, fontSize: "calc(var(--font-scale, 1) * 13px)", flex: 1 }}>{pkg.name}</span>
                  <span style={{ fontSize: 10, color: "var(--fg-muted)" }}>
                    {i18nT("skills.downloads", { count: pkg.download_count })}
                  </span>
                  {isInstalled ? (
                    <span style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--semantic-success)", flexShrink: 0, minWidth: 42, textAlign: "right" }}>
                      {i18nT("skills.installed")}
                    </span>
                  ) : isInstalling ? (
                    <span style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--accent)", flexShrink: 0, minWidth: 42, textAlign: "right" }}>
                      {i18nT("skills.installing")}
                    </span>
                  ) : (
                    <button
                      onClick={() => handleInstall(pkg.slug, skillMarketplace.getPackageDownloadUrl(pkg.slug))}
                      style={installBtnStyle}
                    >
                      {i18nT("skills.install")}
                    </button>
                  )}
                </div>
                <div style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-muted)", padding: "0 12px 6px" }}>
                  {pkg.description ?? ""}
                  <br />
                  {i18nT("skills.byAuthor", { author: pkg.author })} · {i18nT("skills.versionLabel", { version: pkg.version })}
                  {pkg.tags?.length > 0 && <span> · {pkg.tags.join(", ")}</span>}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
