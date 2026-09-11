// ── pluginLayout — 插件布局纯函数 ──
// removePanelsFromTree: 插件停用/卸载时从布局树递归移除其面板(决策#5 彻底移除)。
// 纯递归(无 side-effect), 供 layoutStore/插件停用逻辑调用。可单测。

import type { LayoutNode, TabInstance, SplitNode, TabGroup } from "../types/layout";

/** 递归移除一个 tab：① 单 panel tab.panelId 匹配 → 删；② compound tab.children
 *  里匹配的全部删掉, 剩余 children 保留；全部匹配 → tab 删。
 *  返回 `null` 表示该 tab 应被移除。 */
function removeTab(tab: TabInstance, panelIds: string[]): TabInstance | null {
  if (tab.children?.length) {
    const remaining: TabInstance[] = [];
    for (const c of tab.children) {
      // 显式比较（避免 filter/some 隐式行为依赖），命中即剔除
      let hit = false;
      for (const p of panelIds) {
        if (p === c.panelId) { hit = true; break; }
      }
      if (!hit) remaining.push(c);
    }
    if (remaining.length === 0) return null;
    if (remaining.length !== tab.children.length) {
      return { ...tab, children: remaining, activeChildId: remaining[0]?.id ?? null };
    }
    return tab;
  }
  return panelIds.includes(tab.panelId) ? null : tab;
}

/** 递归清理一个组：过滤 tabs；若组空了 → null(移除)。
 * 注意: 始终返回新对象(即使 tabs 数量未变)——compound tab 内容可能变了
 * (children 剪枝) 但 tabs 长度相同, 不能因 length 相等就返回旧引用。 */
function cleanGroup(node: TabGroup, panelIds: string[]): TabGroup | null {
  let changed = false;
  const tabs: TabInstance[] = [];
  for (const t of node.tabs) {
    const kept = removeTab(t, panelIds);
    if (!kept) { changed = true; continue; }
    tabs.push(kept);
    if (kept !== t) changed = true;
  }
  if (tabs.length === 0) return null;
  return changed || tabs.length !== node.tabs.length
    ? { ...node, tabs, activeTabId: tabs[0]?.id ?? null }
    : node;
}

/** 递归清理节点。返回 `null` → 应从父节点移除（空组/空 split）。 */
function cleanNode(node: LayoutNode, panelIds: string[]): LayoutNode | null {
  if (node.type === "group") {
    return cleanGroup(node, panelIds);
  }
  // split: 递归 children, 清除空子节点, 收敛 sizes
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const cleaned = cleanNode(node.children[i], panelIds);
    if (cleaned) {
      children.push(cleaned);
      sizes.push(node.sizes[i] ?? 1);
    }
  }
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]; // 只剩一个子 → 直接顶替 split(去包裹层)
  return { ...node, children, sizes };
}

/**
 * 从布局树递归移除指定 panelId 的面板(插件停用/卸载)。
 * 规则: 匹配的 tab 删除; 空组删除; split 只剩一个子时顶替(split 去包裹)。
 * 不匹配则原样返回(引用不变)。
 */
export function removePanelsFromTree(tree: LayoutNode, panelIds: string[]): LayoutNode {
  const cleaned = cleanNode(tree, panelIds);
  return cleaned ?? tree; // 整树清空 → 保留空(不应发生, 防呆)
}
