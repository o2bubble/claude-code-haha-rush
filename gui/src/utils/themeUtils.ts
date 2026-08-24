/**
 * Theme utilities — 暗色预设判定
 *
 * GUI 支持 4 个主题预设：light / dark / dark-a / dark-b。
 * `dark` 是兼容旧值，视觉等同 `dark-b`。判定"是否暗色"时必须统一走这里，
 * 避免各处硬编码 `=== "dark"` 导致新预设被误判成亮色。
 */

export type ThemeValue = "light" | "dark" | "dark-a" | "dark-b";

export const DARK_THEMES: ThemeValue[] = ["dark", "dark-a", "dark-b"];

/** 是否为暗色主题（含全部暗色预设） */
export function isDarkTheme(theme: string | undefined | null): boolean {
  return DARK_THEMES.includes(theme as ThemeValue);
}

/** 规范化 theme 值：非法/未知值回退 light；`dark` 保留（视觉等同 dark-b） */
export function normalizeTheme(theme: string | undefined | null): ThemeValue {
  if (theme === "dark" || theme === "dark-a" || theme === "dark-b") return theme;
  return "light";
}

/** 从 DOM 的 data-theme 属性读取当前主题并判定暗色 */
export function isDarkNow(): boolean {
  if (typeof document === "undefined") return false;
  return isDarkTheme(document.documentElement.dataset.theme);
}
