/**
 * 布局树类型定义
 *
 * 整个工作区是一棵树，每个节点要么是 SplitNode（分割容器）
 * 要么是 TabGroup（标签组，包含可切换的标签页）。
 */

export type LayoutNode = SplitNode | TabGroup;

/** 可序列化的图标键 — 布局持久化直接存这个字符串，由 utils/icons.tsx 的 iconFor() 映射到组件 */
export type IconKey =
  | "editor" | "workers" | "plan" | "subagents" | "messages" | "input"
  | "sessions" | "skills" | "files" | "settings" | "terminal" | "superDesktop"
  | "askQuestion" | "desktopItemView" | "profileManager" | "feedback" | "update"
  | "explorer" | "search" | "outline" | "compoundGroup" | "file" | "notes"
  | "quickPrompts" | "help" | "diagnostics" | "default" | "user"
  | "folderKanban" | "package" | "grid3x3" | "layoutGrid" | "combine" | "gitBranch";

/** 分割容器 — 水平或垂直排列子节点，带可拖拽分隔线 */
export interface SplitNode {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  children: LayoutNode[];
  /** 每个子节点的尺寸比例（百分比），和 children 一一对应 */
  sizes: number[];
  /** 可见状态（split 级）— 2026-09-09: 左列/拆分列整体可隐藏（内部切分的面板随列一起）
   *  expanded=完整, collapsed=仅图标栏, hidden=整列消失 */
  visibility?: Visibility;
}

/** TabGroup 显示风格 */
export type TabStyle = "tabs" | "activity" | "activity-right" | "activity-bottom";

/** 面板可见性三态 */
export type Visibility = "expanded" | "collapsed" | "hidden";

/** 标签组 — 一组可切换的标签页，当前只能一个活跃 */
export interface TabGroup {
  type: "group";
  id: string;
  tabs: TabInstance[];
  activeTabId: string | null;
  /** 标签显示风格: "tabs" 横排顶部, "activity" 竖排左侧图标栏 */
  tabStyle?: TabStyle;
  /** 可见状态: expanded=完整, collapsed=仅图标栏(activity), hidden=隐藏 */
  visibility?: Visibility;
}

/** 悬浮面板 — 脱离布局树的 position:fixed 窗口，内嵌一个完整 TabGroup */
export interface FloatingWindow {
  type: "floating";
  id: string;
  group: TabGroup;
  /** 距视口左上的像素偏移 */
  x: number;
  y: number;
  /** 像素尺寸 */
  width: number;
  height: number;
  /** 层叠次序：值越大越靠前 */
  zIndex: number;
}

/** Tauri 原生子窗口 — 独立的 WebView2 窗口，内嵌一个 TabGroup */
export interface TauriWindow {
  type: "tauri";
  id: string;
  /** Tauri webview label，匹配 `create_floating_window` 的 label 参数 */
  label: string;
  /** 窗口位置与尺寸 */
  x: number;
  y: number;
  width: number;
  height: number;
  group: TabGroup;
}

/** 标签实例 — 可以是单 panel 也可以是复合组（嵌套子 tab） */
export interface TabInstance {
  id: string;
  /** 单 panel: 引用注册 panel；复合组: panelId 为空，由 children 驱动 */
  panelId: string;
  viewId?: string;
  title: string;
  icon?: IconKey;
  /** 复合组：嵌套子 tab，Activity Bar 只占一个图标位 */
  children?: TabInstance[];
  activeChildId?: string | null;
}
