// ── PluginMarketPanel — 插件市场(平台化共享, T5) ──
// 复用技能市场同一 registry server(GET /api/plugins, type=plugin):
// 列表/搜索/安装 → install_plugin_package(Rust 下载+解压到 plugins/) → 重扫 → 面板活。
// T7: 卡片点击 → 详情在独立系统面板 plugin-market-detail(editor-area 中央区)打开——
// 本面板常驻侧栏窄, 宽幅 README markdown 展示由详情面板承担(数据经 pluginDetailStore)。

import { useState, useEffect, useCallback, type ReactNode } from "react";
import { t as i18nT } from "../../i18n";
import { skillMarketplace, type PackageSummary, type PackageDetail } from "../../services/skillMarketplace";
import { reloadPlugins, getInstalledPluginEntries, getGuiPlatform, pluginSupportsPlatform, isPluginUpdateAvailable, type GuiPlatform } from "../../services/pluginRegistry";
import { addStatusMessage } from "../../stores/statusMsgStore";
import { getSettings, updateSettings } from "../../stores/settingsStore";
import { setPluginDetail, setPluginDetailTrusted } from "../../stores/pluginDetailStore";
import { openPanelInTree } from "../../stores/layoutStore";
import { sendPluginInstruction } from "../../services/pluginInstallBridge";
import {
  PluginActionButtons, MetaChips, catIcon,
  type PluginCardState, type PluginActions,
} from "./pluginActionModel";
import {
  emptyStyle, retryBtnStyle, cardStyle, cardRow1Style, cardNameStyle, catIconStyle,
  cardDescStyle, cardMetaStyle, cardActStyle, metaChipStyle, badgeStyle,
} from "./marketplaceStyles";

// 已装插件条目从 pluginRegistry 取（MCP plugin_* 工具与详情面板共用同一数据源）
const getInstalledPlugins = getInstalledPluginEntries;
type LocalPluginEntry = ReturnType<typeof getInstalledPluginEntries> extends Promise<Map<string, infer T>> ? T : never;

// 分类筛选: "all" + 内置四类 + 市场出现过的自定义分类(动态并集)
const BUILTIN_CATEGORIES = ["component", "tool", "guide", "integration"] as const;

/** 动态 tab 列表: all + 内置 + 市场自定义(从 packages 收集, 稳定排序) */
function collectCategoryTabs(packages: PackageSummary[], current: string): string[] {
  const custom = new Set<string>();
  for (const p of packages) {
    const c = p.category ?? "tool";
    if (!BUILTIN_CATEGORIES.includes(c as (typeof BUILTIN_CATEGORIES)[number])) custom.add(c);
  }
  const sortedCustom = [...custom].sort();
  return ["all", ...BUILTIN_CATEGORIES, ...sortedCustom];
}

/** chip 标签: 内置类走 i18n(全量翻译); 自定义类无翻译 key → t() 返回 key,
 *  此时显示原文(作者写的词)。builtIn 区分: 内置类即使未来漏翻也显示 key 兜底。 */
function categoryLabel(c: string): string {
  const key = `pluginMarket.cat_${c}`;
  const isBuiltin = BUILTIN_CATEGORIES.includes(c as (typeof BUILTIN_CATEGORIES)[number]);
  if (isBuiltin) return i18nT(key);
  // 自定义类: i18n 有对应 key(未来作者生态约定)则翻译, 否则原文
  const translated = i18nT(key);
  return translated === key ? c : translated;
}

// ── 分区小节标题（VS Code 式: 已安装 / 可安装）──

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: "10px 12px 4px", position: "sticky", top: 0,
      backgroundColor: "var(--bg-root)", zIndex: 1, flexShrink: 0,
    }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-secondary)", letterSpacing: "0.04em" }}>
        {label}
      </span>
      <span style={{ fontSize: 10, color: "var(--fg-muted)", backgroundColor: "var(--bg-hover)", borderRadius: 8, padding: "0 6px" }}>
        {count}
      </span>
      <span style={{ flex: 1, height: 1, backgroundColor: "var(--border-light)" }} />
    </div>
  );
}

// ── 插件市场面板（纯列表态）──

export default function PluginMarketPanel() {
  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [installedMap, setInstalledMap] = useState<Map<string, LocalPluginEntry>>(new Map());
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [platform, setPlatform] = useState<GuiPlatform>("windows");
  useEffect(() => { void getGuiPlatform().then(setPlatform); }, []);
  // 受信任包(slug): Rust Ed25519 签名验证通过。未受信任 → 只「AI 安装」+ AI 安全审查
  const [trustedSlugs, setTrustedSlugs] = useState<Set<string>>(new Set());

  const refreshInstalled = useCallback(async () => {
    setInstalledMap(await getInstalledPlugins());
  }, []);

  const fetchPackages = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const list = await skillMarketplace.listPlugins();
      // 服务端 /api/plugins 已按 type=plugin 过滤; 保留客户端过滤作旧服务端防御
      const pkgs = list.filter((p) => p.type === "plugin");
      setPackages(pkgs);
      // 批量验证签名（信任判定）— 串行逐个 verify(Rust 下载 zip 校验), 失败即未受信任
      const { invoke } = await import("@tauri-apps/api/core");
      const trusted = new Set<string>();
      for (const p of pkgs) {
        try {
          const r = await invoke<{ trusted: boolean }>("verify_plugin_signature", {
            zipUrl: skillMarketplace.getPackageDownloadUrl(p.slug),
          });
          if (r.trusted) trusted.add(p.slug);
          // 逐个回填: 用户可能在全部验证完成前就点开了详情页
          setPluginDetailTrusted(p.slug, r.trusted);
        } catch { /* 验证失败 → 不加入 trusted */ }
      }
      setTrustedSlugs(trusted);
    } catch (e: any) {
      setError(e.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refreshInstalled(); fetchPackages(); }, [refreshInstalled, fetchPackages]);

  // 插件重扫完成（装/卸/启停任何路径, 含 MCP 工具在聊天里执行的）→ 刷新已装快照,
  // 否则卡片按钮停留在旧状态（用户实测: AI 卸载后面板仍显示已装按钮）。
  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const { windowBus } = await import("../../services/windowBus");
      const { Events } = await import("../../services/events");
      if (cancelled) return;
      unsub = windowBus.on(Events.PLUGINS_RESCANNED, () => { void refreshInstalled(); });
    })();
    return () => { cancelled = true; unsub?.(); };
  }, [refreshInstalled]);

  // 卡片点击: 发布详情数据 → 打开独立详情面板(editor-area 中央区)
  const openDetail = useCallback(async (pkg: PackageSummary) => {
    const local = installedMap.get(pkg.name) ?? installedMap.get(pkg.slug);
    // 先开面板(空 readme 立即可见) → 异步补拉 README(本地已有则免拉)
    setPluginDetail({
      key: `market:${pkg.slug}:${pkg.version}`,
      slug: pkg.slug,
      name: pkg.name,
      description: pkg.description ?? "",
      author: pkg.author,
      version: pkg.version,
      tags: pkg.tags ?? [],
      downloadCount: pkg.download_count,
      readme: local?.readme ?? null,
      installType: pkg.installType ?? "standard",
      dependencies: pkg.dependencies ?? [],
      // 信任状态随数据下发——详情页与卡片同门(未受信任不给「安装」按钮)。
      // 注意: 可能在验证完成前打开(那时 trusted=false), 由 setPluginDetailTrusted 回填修正。
      trusted: trustedSlugs.has(pkg.slug),
    });
    openPanelInTree("plugin-market-detail");
    if (!local?.readme) {
      try {
        const d: PackageDetail = await skillMarketplace.getPackage(pkg.slug);
        if (d.readme) {
          // 只在仍是同一插件时回填(用户快速连点另一卡片不覆盖)
          setPluginDetail((prev) => prev && prev.slug === pkg.slug ? { ...prev, readme: d.readme ?? null } : prev);
        }
      } catch { /* 详情拉取失败 → 显示无 README 兜底 */ }
    }
  }, [installedMap, trustedSlugs]);

  const handleInstall = async (slug: string, zipUrl: string) => {
    setInstalling((prev) => new Set(prev).add(slug));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("install_plugin_package", { zipUrl, packageName: slug });
      addStatusMessage(`${i18nT("pluginMarket.installSuccess")}`, "success");
      // 安装即活: 重扫插件 manifest → 面板注册 + 事件转发 + 进程刷新
      await refreshInstalled();
      await refreshPluginRegistry();
    } catch (e: any) {
      addStatusMessage(`${i18nT("pluginMarket.installFailed")}: ${e}`, "error");
    } finally {
      setInstalling((prev) => { const next = new Set(prev); next.delete(slug); return next; });
    }
  };

  const refreshPluginRegistry = async () => {
    // 单一入口 reloadPlugins (scan→setActiveManifests→registerPluginPanels→事件→进程)
    await reloadPlugins();
  };

  // ── 卸载/禁用/启用 ──

  const handleUninstall = async (pluginName: string) => {
    if (!confirm(i18nT("pluginMarket.uninstallConfirm", { name: pluginName }))) return;
    try {
      const { uninstallPlugin } = await import("../../services/pluginRegistry");
      const { handleUninstallResult } = await import("../../services/pluginUninstallFlow");
      const result = await uninstallPlugin(pluginName);
      addStatusMessage(i18nT("pluginMarket.uninstallSuccess"), "success");
      await refreshInstalled();
      // 需要重启 / hook 没跑成 → 在这里提示（用户可拒绝重启）
      await handleUninstallResult(result, i18nT, addStatusMessage);
    } catch (e: any) {
      addStatusMessage(`${i18nT("pluginMarket.uninstallFailed")}: ${e}`, "error");
    }
  };

  const toggleDisabled = async (pluginName: string, disabled: boolean) => {
    const cur = new Set(getSettings().disabledPlugins ?? []);
    if (disabled) cur.add(pluginName); else cur.delete(pluginName);
    updateSettings({ disabledPlugins: [...cur] });
    await refreshPluginRegistry();
  };

  // ── AI 帮我安装/卸载（ai-guided 插件唯一通道; standard 插件也可选 AI 代办）──

  const requestAiInstall = async (pkg: PackageSummary, installedVersion?: string) => {
    // 两段式: ① 前端自动下载落盘(纯机械操作, 不劳烦 AI) → ② 发提示词让 AI
    // 做真正的配置工作(ai-guided 的配置/环境安装)。用户视角一次点击。
    setInstalling((prev) => new Set(prev).add(pkg.slug));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("install_plugin_package", { zipUrl: skillMarketplace.getPackageDownloadUrl(pkg.slug), packageName: pkg.slug });
      addStatusMessage(`${i18nT("pluginMarket.installSuccess")}`, "success");
      await refreshInstalled();
      await refreshPluginRegistry();
      // 落盘成功 → 发提示词(AI 接手配置; plugin_get/plugin_set_status 从此可用)。
      // 未受信任插件(无官方签名): 注入安全审查要求——AI 先读全部代码评估风险,
      // 用 AskUserQuestion 让用户选择继续/取消, 不得未经审查直接配置。
      const untrusted = !trustedSlugs.has(pkg.slug);
      // 更新场景用 aiUpdatePrompt: 明确告知「这是更新不是新装」+ 本地→市场版本,
      // 让 AI 先检查现状、配置正常就跳过安装步骤(只记版本)。否则 AI 可能把
      // 幂等重装当新装跑全套(重写配置/重装依赖), 用户要的只是更新。
      const base = installedVersion
        ? i18nT("pluginMarket.aiUpdatePrompt", { name: pkg.name, slug: pkg.slug, from: installedVersion, to: pkg.version })
        : i18nT("pluginMarket.aiInstallPrompt", { name: pkg.name, slug: pkg.slug, desc: pkg.description ?? "" });
      const prompt = untrusted
        ? base +
          "\n⚠️ 该插件未通过官方签名验证，属于第三方包。请先调用 plugin_get 读取 manifest，审查包内全部代码/文档（README/AI_NOTES/plugin.json），评估是否有恶意行为（网络请求、文件写入、命令执行等）。用 AskUserQuestion 让用户确认继续或取消，确认后再执行文档指导的配置步骤。"
        : base;
      const ok = sendPluginInstruction(prompt);
      if (!ok) addStatusMessage(i18nT("pluginMarket.aiNoSession"), "warn");
    } catch (e: any) {
      addStatusMessage(`${i18nT("pluginMarket.installFailed")}: ${e}`, "error");
    } finally {
      setInstalling((prev) => { const next = new Set(prev); next.delete(pkg.slug); return next; });
    }
  };

  const requestAiUninstall = (pluginName: string) => {
    const ok = sendPluginInstruction(
      i18nT("pluginMarket.aiUninstallPrompt", { name: pluginName }),
    );
    if (!ok) addStatusMessage(i18nT("pluginMarket.aiNoSession"), "warn");
  };

  const filtered = packages.filter(
    (p) =>
      (categoryFilter === "all" || (p.category ?? "tool") === categoryFilter) &&
      (!search ||
        p.name.toLowerCase().includes(search.toLowerCase()) ||
        (p.description ?? "").toLowerCase().includes(search.toLowerCase()) ||
        p.tags.some((tag) => tag.toLowerCase().includes(search.toLowerCase()))),
  );
  // VS Code 式分区: 已安装(含禁用)在上, 可安装在下——装多了不再混排难找
  const installedPkgs = filtered.filter(
    (p) => installedMap.has(p.name) || installedMap.has(p.slug),
  );
  const availablePkgs = filtered.filter(
    (p) => !installedMap.has(p.name) && !installedMap.has(p.slug),
  );
  const categoryTabs = collectCategoryTabs(packages, categoryFilter);

  // 卡片共享上下文（两分区同款卡片, 避免逐 prop 透传）
  const cardCtx: PkgCardCtx = {
    installedMap,
    installing,
    openDetail,
    handleInstall,
    handleUninstall,
    toggleDisabled,
    requestAiInstall,
    requestAiUninstall,
    platform,
    trustedSlugs,
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", backgroundColor: "var(--bg-root)" }}>
      {/* 搜索 */}
      <div style={{ padding: "8px 12px", flexShrink: 0 }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={i18nT("pluginMarket.searchPlaceholder")}
          style={{
            width: "100%", boxSizing: "border-box",
            padding: "4px 8px", border: "1px solid var(--border-medium)", borderRadius: 4,
            fontSize: "calc(var(--font-scale, 1) * 12px)", fontFamily: "var(--font-sans)", outline: "none",
          }}
        />
      </div>

      {/* 分类筛选 chips（all/component/tool/guide/integration） */}
      <div style={{ padding: "0 12px 6px", display: "flex", gap: 4, flexWrap: "wrap", flexShrink: 0 }}>
        {categoryTabs.map((c) => {
          const active = categoryFilter === c;
          return (
            <button
              key={c}
              onClick={() => setCategoryFilter(c)}
              style={{
                padding: "2px 8px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
                fontSize: "calc(var(--font-scale, 1) * 11px)",
                border: `1px solid ${active ? "var(--accent)" : "var(--border-medium)"}`,
                backgroundColor: active ? "var(--accent-subtle)" : "transparent",
                color: active ? "var(--accent)" : "var(--fg-muted)",
              }}
            >
              {categoryLabel(c)}
            </button>
          );
        })}
      </div>

      <div style={{ flex: "1 1 auto", overflow: "auto" }}>
        {loading ? (
          <div style={emptyStyle}>{i18nT("pluginMarket.marketplaceLoading")}</div>
        ) : error ? (
          <div style={emptyStyle}>
            <div>{i18nT("pluginMarket.marketplaceError")}: {error}</div>
            <button onClick={fetchPackages} style={retryBtnStyle}>{i18nT("pluginMarket.marketplaceRetry")}</button>
          </div>
        ) : filtered.length === 0 ? (
          <div style={emptyStyle}>{i18nT("pluginMarket.marketplaceEmpty")}</div>
        ) : (
          <>
            {/* VS Code 式分区: 已安装(含禁用)在上, 可安装在下 — 装多了不再混排难找 */}
            {installedPkgs.length > 0 && (
              <>
                <SectionHeader label={i18nT("pluginMarket.sectionInstalled")} count={installedPkgs.length} />
                {installedPkgs.map((pkg) => (
                  <PkgCard key={pkg.slug} pkg={pkg} ctx={cardCtx} />
                ))}
              </>
            )}
            {availablePkgs.length > 0 && (
              <>
                <SectionHeader label={i18nT("pluginMarket.sectionAvailable")} count={availablePkgs.length} />
                {availablePkgs.map((pkg) => (
                  <PkgCard key={pkg.slug} pkg={pkg} ctx={cardCtx} />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── 插件卡片（已安装/可安装两分区共用, VS Code 式同款渲染）──

export interface PkgCardCtx {
  installedMap: Map<string, LocalPluginEntry>;
  installing: Set<string>;
  openDetail: (pkg: PackageSummary) => void;
  handleInstall: (slug: string, zipUrl: string) => void;
  handleUninstall: (pluginName: string) => void;
  toggleDisabled: (pluginName: string, disabled: boolean) => void;
  /** installedVersion 传入 = 更新场景(提示词走 aiUpdatePrompt, AI 先检查现状再决定是否跳过) */
  requestAiInstall: (pkg: PackageSummary, installedVersion?: string) => Promise<void>;
  requestAiUninstall: (pluginName: string) => void;
  /** 当前 GUI 平台（get_platform, 编译结果）——判断插件 platforms 支持 */
  platform: GuiPlatform;
  /** 签名验证通过的 slug 集（Ed25519 Rust 校验）— 非集内只能 AI 安装 */
  trustedSlugs: Set<string>;
}

export function PkgCard({ pkg, ctx }: { pkg: PackageSummary; ctx: PkgCardCtx }) {
  const isInstalling = ctx.installing.has(pkg.slug);
  // installed(key=插件目录名=pluginName) 可能 ≠ market name/slug → 两者任一命中
  const installedName = ctx.installedMap.has(pkg.name) ? pkg.name : ctx.installedMap.has(pkg.slug) ? pkg.slug : null;
  const isDisabled = installedName != null && (getSettings().disabledPlugins ?? []).includes(installedName);
  // 需更新: 已装插件版本 < 市场版本（本地 manifestJson 解析 version）
  const installedEntry = installedName ? ctx.installedMap.get(installedName) : undefined;
  let installedVersion: string | undefined;
  try {
    installedVersion = installedEntry?.manifestJson
      ? (JSON.parse(installedEntry.manifestJson) as { version?: string }).version
      : undefined;
  } catch { /* 坏 manifest 无版本 */ }
  const needsUpdate = isPluginUpdateAvailable(installedVersion, pkg.version);
  // 平台支持判定: 市场包的 platforms(可能 undefined) + 当前平台。不支持 → 灰置+徽标
  const unsupported = !pluginSupportsPlatform(pkg.platforms ?? [], ctx.platform);

  const st: PluginCardState = {
    installed: installedName != null,
    disabled: isDisabled,
    needsUpdate,
    trusted: ctx.trustedSlugs.has(pkg.slug),
    aiGuided: (pkg.installType ?? "standard") === "ai-guided",
  };
  const pk: PluginActions = {
    install: () => ctx.handleInstall(pkg.slug, skillMarketplace.getPackageDownloadUrl(pkg.slug)),
    toggle: () => installedName != null && ctx.toggleDisabled(installedName, !isDisabled),
    uninstall: () => installedName != null && ctx.handleUninstall(installedName),
    aiInstall: () => void ctx.requestAiInstall(pkg, needsUpdate ? installedVersion : undefined),
    aiUninstall: () => installedName != null && ctx.requestAiUninstall(installedName),
  };

  return (
    <div
      style={{ ...cardStyle, ...(isDisabled || unsupported ? { opacity: 0.55 } : {}) }}
      onClick={() => ctx.openDetail(pkg)}
    >
      {/* r1 名称行: 图标 + 名称 + 徽标 */}
      <div style={cardRow1Style}>
        <span style={catIconStyle}>{catIcon(pkg.category)}</span>
        <span style={cardNameStyle} title={pkg.name}>
          {pkg.name}{isDisabled ? ` (${i18nT("pluginMarket.disabled")})` : ""}
        </span>
        {/* 平台不支持徽标: 当前 GUI 平台不在插件声明列表内 → 灰置+提示 */}
        {unsupported && (
          <span style={badgeStyle("error", 10)} title={i18nT("pluginMarket.unsupportedPlatformTip", { platform: ctx.platform })}>
            {i18nT("pluginMarket.unsupportedPlatform")}
          </span>
        )}
        {/* 已装徽标: 强视觉区分已装/未装(否则只有按钮文案差异, 极易误判状态) */}
        {installedName && (
          <span
            style={badgeStyle(isDisabled ? "muted" : "accent", 10)}
            title={isDisabled ? i18nT("pluginMarket.installedDisabledTip") : i18nT("pluginMarket.installedTip")}
          >
            {isDisabled ? i18nT("pluginMarket.badgeDisabled") : i18nT("pluginMarket.badgeInstalled")}
          </span>
        )}
        {needsUpdate && (
          <span style={badgeStyle("info", 10)}>{i18nT("pluginMarket.badgeUpdatable")}</span>
        )}
        {/* 未受信任徽标: 未装(已装的信任状态由「已安装」徽标承载, 避免徽标行过挤) */}
        {!installedName && !ctx.trustedSlugs.has(pkg.slug) && (
          <span style={badgeStyle("warn", 10)} title={i18nT("pluginMarket.untrustedTip")}>
            {i18nT("pluginMarket.untrusted")}
          </span>
        )}
      </div>

      {/* r2 描述（clamp 2 行） */}
      {pkg.description ? <div style={cardDescStyle}>{pkg.description}</div> : null}

      {/* r3 元信息: 作者 · 版本 · 下载 + 依赖/标签小片 */}
      <div style={cardMetaStyle}>
        <span>{i18nT("pluginMarket.byAuthor", { author: pkg.author })}</span>
        <span style={{ opacity: 0.45 }}>·</span>
        {/* 已装且可更新 → 显示「本地 → 市场」版本迁移, 否则只显示市场版本。
            只给市场版本时用户看到「已安装 v0.1.4 [可更新]」会以为判定有误(实测困惑)。 */}
        {needsUpdate && installedVersion ? (
          <span style={{ color: "var(--accent)" }}>
            v{installedVersion} → v{pkg.version}
          </span>
        ) : (
          <span>{i18nT("pluginMarket.versionLabel", { version: pkg.version })}</span>
        )}
        <span style={{ opacity: 0.45 }}>·</span>
        <span>{i18nT("pluginMarket.downloads", { count: pkg.download_count })}</span>
        <MetaChips items={[...(pkg.dependencies ?? []), ...(pkg.tags ?? [])]} style={metaChipStyle} />
      </div>

      {/* 操作行: 主按钮 + ⋯（无主按钮时 ⋯ 自动加描边, 否则它是卡片唯一控件却不可见） */}
      <div style={cardActStyle} onClick={(e) => e.stopPropagation()}>
        <PluginActionButtons st={st} busy={isInstalling} pk={pk} />
      </div>
    </div>
  );
}

// MetaChips 定义在 pluginActionModel（详情页共用），此处直接传入小片样式

