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
