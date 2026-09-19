// ── PluginMarketDetailPanel — 插件详情页（独立系统面板, T7）──
// userManaged:false —— 不进图标栏/面板下拉, 由市场面板卡片点击时打开（editor-area
// 中央区, 宽幅展示 README markdown）。数据经 pluginDetailStore 传递。

import { useState, useEffect } from "react";
import { t as i18nT } from "../../i18n";
import { usePluginDetail } from "../../stores/pluginDetailStore";
import { skillMarketplace } from "../../services/skillMarketplace";
import { reloadPlugins } from "../../services/pluginRegistry";
import { addStatusMessage } from "../../stores/statusMsgStore";
import { getSettings, updateSettings } from "../../stores/settingsStore";
import { renderMarkdownPreview } from "../../utils/markdownPreview";
import { getInstalledPluginEntries, isPluginUpdateAvailable } from "../../services/pluginRegistry";
import { sendPluginInstruction } from "../../services/pluginInstallBridge";
import { badgeStyle, metaChipStyle } from "./marketplaceStyles";
import {
  PluginActionButtons, MetaChips, catIcon, categoryFromTags,
  type PluginCardState, type PluginActions,
} from "./pluginActionModel";

const getInstalledPlugins = getInstalledPluginEntries;

/** 详情页头部图标（40×40） */
const dtIconStyle: React.CSSProperties = {
  width: 40, height: 40, borderRadius: 8, flexShrink: 0,
  display: "flex", alignItems: "center", justifyContent: "center",
  backgroundColor: "var(--accent-subtle)", color: "var(--accent)",
};

export default function PluginMarketDetailPanel() {
  const d = usePluginDetail();
  // 已装插件名集合（安装/卸载/禁用后 reloadPlugins 完毕重拉一次）
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  // 已装插件版本(名字 → version) — 版本比较(更新按钮)用; getInstalledPluginEntries 含 manifestJson
  const [installedVersions, setInstalledVersions] = useState<Map<string, string>>(new Map());
  const refreshInstalled = () => {
    void getInstalledPluginEntries().then((m) => {
      setInstalled(new Set(m.keys()));
      const vs = new Map<string, string>();
      for (const [name, e] of m) {
        try {
          const v = e.manifestJson ? (JSON.parse(e.manifestJson) as { version?: string }).version : undefined;
          if (v) vs.set(name, v);
        } catch { /* 坏 manifest */ }
      }
      setInstalledVersions(vs);
    });
  };
  useEffect(() => { refreshInstalled(); }, [d?.key]);
  // hooks 必须在早退之前(条件 hooks 违规 → d 由有到无时 hook 数量变化, React 抛
  // "Rendered fewer hooks than expected"。同 EditorPanel #300/#310 的教训)
  const [aiInstalling, setAiInstalling] = useState(false);

  if (!d) {
    return (
      <div style={{ padding: 24, fontSize: "calc(var(--font-scale, 1) * 12px)", color: "var(--fg-muted)" }}>
        {i18nT("pluginMarket.detailEmpty")}
      </div>
    );
  }

  const installedName = installed.has(d.name) ? d.name : installed.has(d.slug) ? d.slug : null;
  const isDisabled = installedName != null && (getSettings().disabledPlugins ?? []).includes(installedName);
  // 需更新: 本地已装版本 < 市场版本(已有本地版本字段, 无则保守 false)
  const needsUpdate = installedName != null && isPluginUpdateAvailable(installedVersions.get(installedName), d.version);

  const handleInstall = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("install_plugin_package", { zipUrl: skillMarketplace.getPackageDownloadUrl(d.slug), packageName: d.slug });
      addStatusMessage(i18nT("pluginMarket.installSuccess"), "success");
      await reloadPlugins();
      refreshInstalled();
    } catch (e: any) {
      addStatusMessage(`${i18nT("pluginMarket.installFailed")}: ${e}`, "error");
    }
  };

  const handleUninstall = async () => {
    if (!installedName) return;
    if (!confirm(i18nT("pluginMarket.uninstallConfirm", { name: installedName }))) return;
    try {
      const { uninstallPlugin } = await import("../../services/pluginRegistry");
      const { handleUninstallResult } = await import("../../services/pluginUninstallFlow");
      const result = await uninstallPlugin(installedName);
      addStatusMessage(i18nT("pluginMarket.uninstallSuccess"), "success");
      refreshInstalled();
      await handleUninstallResult(result, i18nT, addStatusMessage);
    } catch (e: any) {
      addStatusMessage(`${i18nT("pluginMarket.uninstallFailed")}: ${e}`, "error");
    }
  };

  const toggleDisabled = async () => {
    if (!installedName) return;
    const cur = new Set(getSettings().disabledPlugins ?? []);
    if (isDisabled) cur.delete(installedName); else cur.add(installedName);
    updateSettings({ disabledPlugins: [...cur] });
    await reloadPlugins();
    refreshInstalled();
  };

  const html = d.readme ? renderMarkdownPreview(d.readme) : "";
  const isAiGuided = (d.installType ?? "standard") === "ai-guided";
  // 未受信任(无官方签名): 只给「AI 安装」(带强制安全审查), 与市场卡片同门——
  // 信任判定必须两条入口一致, 否则详情页就是绕过未受信任管控的后门。
  const untrusted = !isAiGuided && !d.trusted;
  // AI 安装两段式(与市场卡片同款): ① 自动下载落盘 → ② 发提示词让 AI 接手配置
  const requestAi = async (kind: "install" | "uninstall") => {
    // 全新安装 or 更新(已装但版本旧) → 都要重新下载落盘。区别只在提示词语义。
    if (kind === "install" && (!installedName || needsUpdate)) {
      setAiInstalling(true);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("install_plugin_package", { zipUrl: skillMarketplace.getPackageDownloadUrl(d.slug), packageName: d.slug });
        addStatusMessage(i18nT("pluginMarket.installSuccess"), "success");
        await reloadPlugins();
        refreshInstalled();
      } catch (e: any) {
        addStatusMessage(`${i18nT("pluginMarket.installFailed")}: ${e}`, "error");
        setAiInstalling(false);
        return;
      }
      setAiInstalling(false);
    }
    // 未受信任插件: 注入安全审查要求(与市场卡片 requestAiInstall 同款)——
    // AI 先读全部代码评估风险, 用 AskUserQuestion 让用户选择, 不得直接配置。
    // 更新场景(needsUpdate + 已装): 走 aiUpdatePrompt 告知本地→市场版本, AI 先检查
    // 现状、配置正常则跳过安装步骤(只记版本), 不把幂等更新当新装重跑。
    const localVer = installedName ? installedVersions.get(installedName) : undefined;
    const base = kind === "install"
      ? (needsUpdate && localVer
          ? i18nT("pluginMarket.aiUpdatePrompt", { name: d.name, slug: d.slug, from: localVer, to: d.version })
          : i18nT("pluginMarket.aiInstallPrompt", { name: d.name, slug: d.slug, desc: d.description }))
      : i18nT("pluginMarket.aiUninstallPrompt", { name: d.name });
    const prompt = kind === "install" && untrusted
      ? base +
        "\n⚠️ 该插件未通过官方签名验证，属于第三方包。请先调用 plugin_get 读取 manifest，审查包内全部代码/文档（README/AI_NOTES/plugin.json），评估是否有恶意行为（网络请求、文件写入、命令执行等）。用 AskUserQuestion 让用户确认继续或取消，确认后再执行文档指导的配置步骤。"
      : base;
    if (!sendPluginInstruction(prompt)) addStatusMessage(i18nT("pluginMarket.aiNoSession"), "warn");
  };
  // 与市场卡片共用同一动作模型（spec §4）——判定只在 PluginMarketPanel 里写一份
  const cardState: PluginCardState = {
    installed: installedName != null,
    disabled: isDisabled,
    needsUpdate,
    trusted: d.trusted === true,
    aiGuided: isAiGuided,
  };
  const actions: PluginActions = {
    install: () => handleInstall(),
    toggle: () => toggleDisabled(),
    uninstall: () => handleUninstall(),
    aiInstall: () => void requestAi("install"),
    aiUninstall: () => void requestAi("uninstall"),
  };

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "16px 20px", backgroundColor: "var(--bg-root)", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
        <span style={dtIconStyle}>{catIcon(categoryFromTags(d.tags, d.name), 20)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: "calc(var(--font-scale, 1) * 18px)", color: "var(--fg-primary)", overflowWrap: "anywhere" }}>
              {d.name}{isDisabled ? ` (${i18nT("pluginMarket.disabled")})` : ""}
            </span>
            {isAiGuided && <span style={badgeStyle("accent", 10)}>AI-guided</span>}
            {/* 未受信任徽标: 与市场卡片同款——详情页必须显示同一信任信号 */}
            {untrusted && (
              <span style={badgeStyle("warn", 10)} title={i18nT("pluginMarket.untrustedTip")}>
                {i18nT("pluginMarket.untrusted")}
              </span>
            )}
            {/* 已装徽标: 与市场卡片同款(状态一眼可辨, 不靠按钮文案区分) */}
            {installedName && (
              <span style={badgeStyle(isDisabled ? "muted" : "accent", 10)}>
                {isDisabled ? i18nT("pluginMarket.badgeDisabled") : i18nT("pluginMarket.badgeInstalled")}
              </span>
            )}
            {needsUpdate && <span style={badgeStyle("info", 10)}>{i18nT("pluginMarket.badgeUpdatable")}</span>}
          </div>
          <div style={{ marginTop: 3, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: "calc(var(--font-scale, 1) * 11.5px)", color: "var(--fg-muted)" }}>
            <span>{i18nT("pluginMarket.byAuthor", { author: d.author })}</span>
            <span style={{ opacity: 0.45 }}>·</span>
            {/* 已装且可更新 → 「本地 → 市场」版本迁移(与卡片同款, 否则只显示市场
                版本, 用户看到「已安装 v0.1.4 [可更新]」会以为判定有误) */}
            {needsUpdate && installedName ? (
              <span style={{ color: "var(--accent)" }}>
                v{installedVersions.get(installedName)} → v{d.version}
              </span>
            ) : (
              <span>{i18nT("pluginMarket.versionLabel", { version: d.version })}</span>
            )}
            <span style={{ opacity: 0.45 }}>·</span>
            <span>{i18nT("pluginMarket.downloads", { count: d.downloadCount })}</span>
            {d.dependencies && d.dependencies.length > 0 && (
              <>
                <span style={{ opacity: 0.45 }}>·</span>
                <span style={{ color: "var(--fg-secondary)" }}>{i18nT("pluginMarket.dependsOn", { deps: d.dependencies.join(", ") })}</span>
              </>
            )}
            <MetaChips items={d.tags} style={metaChipStyle} />
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <PluginActionButtons st={cardState} busy={aiInstalling} pk={actions} />
        </div>
      </div>
      <div style={{ fontSize: "calc(var(--font-scale, 1) * 13px)", color: "var(--fg-primary)", lineHeight: 1.6, margin: "10px 0 0", padding: "10px 12px", backgroundColor: "var(--bg-surface)", borderLeft: "2px solid var(--accent)", borderRadius: "0 4px 4px 0" }}>
        {d.description}
      </div>
      <div style={{ height: 1, backgroundColor: "var(--border-light)", margin: "14px 0" }} />
      {d.readme ? (
        <div
          className="md-body"
          dangerouslySetInnerHTML={{ __html: html }}
          style={{ fontSize: "calc(var(--font-scale, 1) * 13px)", lineHeight: 1.65, color: "var(--fg-primary)", maxWidth: 900 }}
        />
      ) : (
        <div style={{ fontSize: "calc(var(--font-scale, 1) * 12px)", color: "var(--fg-muted)", fontStyle: "italic" }}>
          {i18nT("pluginMarket.noReadme")}
        </div>
      )}
    </div>
  );
}
