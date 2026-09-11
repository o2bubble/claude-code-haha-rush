/**
 * linkOpen — 外部链接打开裁决
 *
 * 全应用唯一决策点：给定链接 href + 事件修饰，裁决应如何处理。
 * 点击委托（左键/Ctrl/中键）与右键菜单共用，避免逻辑散落多处。
 * 只处理 http(s) 绝对外部链接；mailto:/相对/本地路径一律忽略
 * （GUI 防替换由 Rust on_navigation 守卫兜底）。
 */

export type LinkAction =
  | { kind: "open_window"; url: string } // 应用内置原生窗口渲染
  | { kind: "open_browser"; url: string } // 系统默认浏览器
  | { kind: "context_menu"; url: string } // 右键菜单（内置/浏览器/复制）
  | { kind: "ignore" }; // 不处理

export interface LinkModifiers {
  ctrl: boolean; // Ctrl（Windows/Linux）
  meta: boolean; // Cmd/Meta（macOS）
  middle: boolean; // 鼠标中键
  right: boolean; // 右键（contextmenu）
}

/** 是否 http(s) 绝对外部链接（大小写不敏感） */
export function isExternalHttpUrl(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}

/**
 * 该 href 点击后是否会导致顶层导航（http(s) 或路径）。
 * 相对/绝对路径会解析到应用自身 origin → 必须 preventDefault，防主 GUI 被替换。
 * `mailto:`/`tel:`/`data:`/`javascript:`/`#`/空 不导航，交给浏览器默认。
 */
export function isNavigableHref(href: string | null | undefined): boolean {
  if (!href) return false;
  const h = href.trim();
  if (!h) return false;
  if (/^(mailto:|tel:|data:|javascript:|#)/i.test(h)) return false;
  return true;
}

/** 裁决：href + 修饰 → 打开动作 */
export function resolveLinkAction(
  href: string | null | undefined,
  mods: LinkModifiers
): LinkAction {
  if (!href) return { kind: "ignore" };
  const url = href.trim();
  if (!isExternalHttpUrl(url)) return { kind: "ignore" };
  if (mods.right) return { kind: "context_menu", url };
  if (mods.ctrl || mods.meta || mods.middle) return { kind: "open_browser", url };
  return { kind: "open_window", url };
}
