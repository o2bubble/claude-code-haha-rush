import type { ReactNode } from "react";
import { windowBus } from "../services/windowBus";
import { Events } from "../services/events";
import type { IconKey, TabInstance } from "../types/layout";

export interface PanelView {
  id: string;
  title: string;
  icon?: ReactNode;
  render: () => ReactNode;
}

export interface PanelDefinition {
  id: string;
  title: string;
  icon: IconKey;
  defaultView: string;
  views: PanelView[];
  /** If false, hidden from toolbar PanelDropdown — managed by the system (e.g. Settings, AskQuestion) */
  userManaged?: boolean;
}

const panels = new Map<string, PanelDefinition>();

export function registerPanel(panel: PanelDefinition) {
  if (panels.has(panel.id)) {
    console.warn(`[panelRegistry] Duplicate registration ignored: "${panel.id}" — check App.tsx and FloatingApp.tsx are in sync`);
    return;
  }
  panels.set(panel.id, panel);
  windowBus.emit(Events.PANEL_REGISTRY_CHANGED, { panels: [...panels.values()] }, { sticky: true });
}

/** 覆盖注册：同名已存在时替换定义（插件重装新版本——文件更新了但面板定义还是旧版，
 *  registerPanel 的 dup 保护会静默忽略 → 用本函数覆盖再 emit）。只对"已存在"场景用。
 *  循环防护：FloatingApp 订阅 PANEL_REGISTRY_CHANGED → reloadPlugins → rerenderPanel
 *  由 reloadPlugins 的 _reloading 防重入挡住，无死循环。 */
export function rerenderPanel(panel: PanelDefinition) {
  panels.set(panel.id, panel);
  windowBus.emit(Events.PANEL_REGISTRY_CHANGED, { panels: [...panels.values()] }, { sticky: true });
}

/** 注销面板（插件禁用/卸载——定义摘除, 图标栏/下拉即消失）。
 *  已打开的实例由调用方负责从布局树移除(unregisterPluginPanels)。 */
export function unregisterPanel(id: string) {
  if (!panels.delete(id)) return;
  windowBus.emit(Events.PANEL_REGISTRY_CHANGED, { panels: [...panels.values()] }, { sticky: true });
}

export function getPanel(id: string): PanelDefinition | undefined {
  return panels.get(id);
}

export function getAllPanels(): PanelDefinition[] {
  return [...panels.values()];
}

/** Resolve a tab (single panel or compound child) to its content render fn. */
export function resolveTabRender(tab: TabInstance): (() => ReactNode) | undefined {
  let target = tab;
  if (tab.children?.length) {
    target = tab.children.find((c) => c.id === tab.activeChildId) ?? tab.children[0];
  }
  const panel = getPanel(target.panelId);
  return panel?.views.find((v) => v.id === (target.viewId ?? panel.defaultView))?.render
    ?? panel?.views[0]?.render;
}
