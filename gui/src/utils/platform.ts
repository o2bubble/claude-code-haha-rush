// ── 平台判断 ──
//
// 抽成独立模块的原因：判断逻辑要被多个**互不相关**的地方用
// （窗口装饰、快捷键显示/匹配），原本分散在两处、各写一份 `userAgentData`
// 提取 —— 那种重复一旦某处漏了回退分支就会在不同功能上表现得不一样。

/**
 * 取当前平台字符串（小写）。`userAgentData` 优先（`navigator.platform` 在部分
 * 环境已弃用），回落到 `platform`，再回落到空串（非浏览器环境）。
 */
export function platformString(): string {
  if (typeof navigator === "undefined") return "";
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return (uaData?.platform || navigator.platform || "").toLowerCase();
}

/** 是否 macOS。影响 `mod` 映射到 Cmd 还是 Ctrl、以及快捷键显示格式。 */
export function isMacPlatform(): boolean {
  return platformString().includes("mac");
}

/** 是否 Windows。影响是否使用自绘窗口边框（见 docs/gui/window-chrome.md）。 */
export function isWindowsPlatform(): boolean {
  return platformString().includes("win");
}
