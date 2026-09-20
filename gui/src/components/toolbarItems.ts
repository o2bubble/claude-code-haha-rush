// ── 工具栏项目定义（单一真相源）──
//
// 这个数组**同时**定义两件事：
//   1. 哪些项在工具栏常驻、哪些收进应用菜单
//   2. 窗口变窄时的折叠优先级
//
// 顺序即优先级：**从数组头部开始折叠**。所以
//   · 靠前的项 = 最先被折叠进菜单（低频）
//   · `alwaysVisible` 标记的项永不折叠（核心交互 + 窗口按钮）
//
// 调整某个按钮的位置/优先级 = 改这一个数组，不要改渲染逻辑。
//
// 快捷键字段 `shortcut` 目前硬编码，为后续「快捷键管理」预留 —— 届时换成
// 从统一注册表读取即可，字段位置已就位。

import type { ReactNode } from "react";

export interface ToolbarItem {
  /** 稳定标识，也用作菜单项的 key */
  id: string;
  /** 显示名（已本地化） */
  label: string;
  /** 图标（lucide 元素，由调用方构建以保持本模块无 JSX 依赖） */
  icon: ReactNode;
  /** 快捷键提示，右对齐灰字。规范格式如 "Ctrl+R"；无则省略 */
  shortcut?: string;
  /** 点击行为 */
  onClick: () => void;
  /** 危险操作（菜单里用警示色） */
  danger?: boolean;
  /**
   * 常驻项：永不折叠。核心交互（窗口按钮、设置、搜索、面板开关）用这个。
   * 未标记的项在窗口变窄时按数组顺序依次折叠进菜单。
   */
  alwaysVisible?: boolean;
  /**
   * **固定降级项**：永远在菜单里、工具栏不显示。与响应式折叠是两套独立机制：
   *   · `inMenuByDefault` —— 用户决议「这个功能就该在菜单里」（低频），与窗口宽度无关
   *   · 折叠 —— 窗口太窄放不下时的**被动**降级
   * 两者最终都进同一个菜单，但触发原因不同。
   */
  inMenuByDefault?: boolean;
  /**
   * 在工具栏里是否连文字一起显示（默认只显示图标）。
   * 用于那些「窄按钮不足以表达含义」的动作（如新实例）。
   */
  showLabel?: boolean;
  /** 工具栏上显示的短标签（宽度紧张时用）。缺省则用 `label`。 */
  shortLabel?: string;
  /** 悬停提示文案。缺省则用 `label`。 */
  title?: string;
  /** 有未读/新内容时在菜单项 + AppMark 上显示红点（如「有新版本」） */
  hasBadge?: boolean;
  /** 是否禁用（灰显、不可点） */
  disabled?: boolean;
  /**
   * **自定义渲染** —— 用于「带自身弹层/交互的组件」（如布局预设的预览网格、
   * 无人值守的确认框）。设置后工具栏用它替代 `icon`+`onClick` 的默认按钮渲染，
   * 组件自身的交互完全保留。
   *
   * ⚠️ 折叠进菜单时**不能**用 render（菜单项只支持 icon+onClick）——
   * 所以带 render 的项必须同时提供「菜单形态」：见 Toolbar 的 menuItems 扩展
   * （布局预设 → 逐个预设成项；无人值守 → 单个 toggle 项）。
   */
  render?: () => ReactNode;
}

/**
 * 决定哪些项应该折叠。
 *
 * 从数组头部开始，逐个尝试折叠，直到「折叠后总宽度能放下」为止。
 * 调用方提供 `fits(n)`：假设只保留后 `n` 个可折叠项时是否放得下。
 *
 * 返回需要折叠的 id 集合。常驻项（alwaysVisible）永不折叠。
 *
 * 纯函数 —— 便于单测，且把「试折叠」的循环与 DOM 测量解耦。
 */
export function computeCollapsed(
  items: ToolbarItem[],
  fits: (keptCount: number) => boolean,
): Set<string> {
  // 固定降级项不参与折叠计算 —— 它们本来就不在工具栏，折了也没有意义
  // （否则会把它们算进「可折叠数」，导致 fits 的 kept 语义错位）。
  const collapsible = items.filter((it) => !it.alwaysVisible && !it.inMenuByDefault);
  if (collapsible.length === 0) return new Set();

  // 全部保留也能放下 → 不折叠
  if (fits(collapsible.length)) return new Set();

  // 从头（最低优先级）开始折，找到第一个「放得下」的保留数量。
  // 一步折一个，保证折叠数最少 —— 不跳着折，否则会出现「折了 3 个但只
  // 需要折 1 个」的过度折叠。
  for (let kept = collapsible.length - 1; kept >= 0; kept--) {
    if (fits(kept)) {
      const collapsed = collapsible.slice(0, collapsible.length - kept);
      return new Set(collapsed.map((it) => it.id));
    }
  }
  // 全折了还放不下 → 全折（剩下的挤是容器太小，不是折叠逻辑能解决的）
  return new Set(collapsible.map((it) => it.id));
}

/**
 * 拆分工具栏项与菜单项。两套机制叠加：
 *   进菜单 = `inMenuByDefault`（固定降级，与宽度无关） OR 被折叠（响应式）
 *   进工具栏 = 其余
 *
 * 菜单内的顺序：固定的在前（按数组序），被折叠的在后 —— 后者是"临时"降级，
 * 窗口拉宽就回去了，视觉上排在后面更符合直觉。
 */
export function partitionItems(
  items: ToolbarItem[],
  collapsed: Set<string>,
): { inBar: ToolbarItem[]; inMenu: ToolbarItem[] } {
  const inBar: ToolbarItem[] = [];
  const fixedInMenu: ToolbarItem[] = [];
  const collapsedInMenu: ToolbarItem[] = [];
  for (const it of items) {
    if (it.inMenuByDefault) {
      fixedInMenu.push(it);
    } else if (collapsed.has(it.id) && !it.alwaysVisible) {
      // 常驻项即使被误标进 collapsed 也留在工具栏（防御：computeCollapsed
      // 本身不折叠常驻项，但调用方可能传入手工构造的集合）
      collapsedInMenu.push(it);
    } else {
      inBar.push(it);
    }
  }
  return { inBar, inMenu: [...fixedInMenu, ...collapsedInMenu] };
}
