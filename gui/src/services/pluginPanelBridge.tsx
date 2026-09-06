// ── pluginPanelBridge — 插件面板接入现有布局系统 ──
// T2: 把已解析的 PluginManifest 贡献的面板注册进 panelRegistry。
// id 前缀 `plugin:<name>:<panelId>` 防撞内置面板。render 用同进程声明式组件
// (第一版显示插件信息; sandbox:true 的隔离渲染留作后续选项, 见 PRD §10)。

import { registerPanel } from "../stores/panelRegistry";
import type { PluginManifest, PluginPanel } from "./pluginRegistry";
import type { PanelView } from "../stores/panelRegistry";

/** 生成插件面板的注册 id（前缀防撞） */
export function pluginPanelId(pluginName: string, panelId: string): string {
  return `plugin:${pluginName}:${panelId}`;
}

/** 插件面板的声明式 render（第一版：显示插件事信息，不加载任意 HTML）。
 *  future: sandbox:true 时改走隔离渲染。 */
function pluginPanelContent(manifest: PluginManifest, panel: PluginPanel) {
  return () => (
    <div data-plugin-panel={panel.id} style={{ padding: 12, fontFamily: "var(--font-sans)" }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{panel.title}</div>
      <div style={{ fontSize: 12, color: "var(--fg-muted)", marginBottom: 8 }}>
        {manifest.displayName} v{manifest.version}
      </div>
      {manifest.description ? (
        <div style={{ fontSize: 12, color: "var(--fg-secondary)", whiteSpace: "pre-wrap" }}>
          {manifest.description}
        </div>
      ) : null}
    </div>
  );
}

/** 把 manifest 里贡献的面板注册进 panelRegistry。
 *  注: `panelKind`(in-main/floating) 第一版是死字段——in-main 与 floating 面板都以
 *  普通面板注册进布局系统(布局自带"开新窗/浮窗"通用能力)。区分隔离渲染留作
 *  sandbox:true 的后续扩展(PRD §10)。
 *  @param manifests 由 scanPlugins 解析出的插件清单（已容错）*/
export function registerPluginPanels(manifests: PluginManifest[]): void {
  for (const manifest of manifests) {
    for (const panel of manifest.contributes.panels) {
      const views: PanelView[] = (panel.views?.length ? panel.views : [{ id: "main", title: panel.title }]).map((v) => ({
        id: v.id,
        title: v.title,
        render: pluginPanelContent(manifest, panel),
      }));
      registerPanel({
        id: pluginPanelId(manifest.pluginName, panel.id),
        title: panel.title,
        icon: "grid3x3", // 插件面板默认图标（第一版）
        defaultView: views[0]?.id ?? "main",
        views,
        userManaged: panel.userManaged !== false,
      });
    }
  }
}
