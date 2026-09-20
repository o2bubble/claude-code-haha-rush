// ── Command Palette 纯逻辑 — 过滤、分组、执行分发（可单测，不依赖 DOM）──

export type PaletteKind = "editor" | "panel" | "command" | "session" | "setting" | "plugin";

export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  label: string;
  /**
   * 名称**前面**的层级前缀（如会话的文件夹路径 `工作 / 项目A`）。
   * 渲染为弱化的灰色小字 —— 与 label 视觉分离，不喧宾夺主。
   * 参与搜索匹配（搜文件夹名能找到里面的会话）。
   */
  prefix?: string;
  sublabel?: string;
  icon?: string;
  /** 已打开/已激活 状态标记（面板、会话） */
  active?: boolean;
  run: () => void;
}

/** 大小写不敏感的子串匹配；label 和 sublabel 都参与 */
export function matchPaletteItem(item: PaletteItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${item.label} ${item.prefix ?? ""} ${item.sublabel ?? ""}`.toLowerCase();
  return hay.includes(q);
}

/** 过滤 + 分组。返回有序分组，仅保留有匹配项的组。编辑器命令在 query 为空时置顶。 */
export function groupPaletteItems(items: PaletteItem[], query: string, editorFocused = false): { kind: PaletteKind; title: string; items: PaletteItem[] }[] {
  const matched = items.filter((i) => matchPaletteItem(i, query));

  const order: PaletteKind[] = editorFocused
    ? ["editor", "panel", "command", "session", "setting", "plugin"]
    : ["panel", "command", "session", "setting", "plugin", "editor"];

  const titles: Record<PaletteKind, string> = {
    editor: "编辑器命令",
    panel: "面板",
    command: "AI 命令",
    session: "会话",
    setting: "设置",
    plugin: "插件命令",
  };

  const groups: { kind: PaletteKind; title: string; items: PaletteItem[] }[] = [];
  for (const kind of order) {
    const groupItems = matched.filter((i) => i.kind === kind);
    if (groupItems.length > 0) {
      groups.push({ kind, title: titles[kind], items: groupItems });
    }
  }
  return groups;
}

/** 把扁平结果展平为可导航的行序列（组内顺序），返回每个元素对应的 item */
export function flattenGroups(groups: { kind: PaletteKind; items: PaletteItem[] }[]): PaletteItem[] {
  return groups.flatMap((g) => g.items);
}

export interface ShortcutEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** 全局快捷键判定：是否应由全局监听打开命令面板。
 *  - 面板已打开时不重复触发
 *  - 焦点在 Monaco 编辑器内时跳过（交给 Monaco 自己的 F1/Ctrl+Shift+P）
 *  - F1 或 Ctrl/Cmd+Shift+P 触发
 */
export function shouldOpenPalette(e: ShortcutEventLike, isOpen: boolean, inMonaco: boolean): boolean {
  if (isOpen || inMonaco) return false;
  if (e.key === "F1") return true;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && (e.key === "p" || e.key === "P")) return true;
  return false;
}
