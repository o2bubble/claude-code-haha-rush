// ── 当前窗口的 Tauri label ──
//
// ⚠️ **路径陷阱**（2026-09-22 排查数小时才定位）：
//   · 代码里一直读的是 `__TAURI_INTERNALS__.webview.label`
//   · 但**当前 Tauri 版本把它放在** `__TAURI_INTERNALS__.metadata.currentWebview.label`
//   · 前者在本版本恒为 `undefined` —— 读错**不报错、不抛异常**，只静默拿到空串
//
// 后果（为什么这么难查）：多数调用点有"兜底数据源"所以看不出来 ——
//   `main.tsx` / `FloatingApp` / `detectRole` 都同时看 `location.hash`，hash 恰好是对的
//   → 一直靠 hash 工作。但 `bridge.getWindowId()` **没有兜底**，于是退化成
//   `main-${Date.now()}` 这种**每次调用都不同**的假 ID。
//
// 致命之处：hub 用 `emitTo(windowId, ...)` 定向投递，而 emitTo 的目标必须是**真实
// 窗口 label** —— 拿假 ID 去投递，Tauri 找不到窗口，**静默失败**（不报错！）。
// 表现就是：子窗口收不到任何数据（主题没镜像、消息空白），且看起来"时好时坏"。
//
// 所以：**任何需要窗口 label 的地方都走这里**，别再各读各的。
export function currentWindowLabel(): string {
  const ti = (window as unknown as {
    __TAURI_INTERNALS__?: {
      // 当前版本的真实位置
      metadata?: { currentWebview?: { label?: string } };
      // 早期路径 —— 保留兜底，避免 Tauri 再挪位置时又静默失效
      webview?: { label?: string };
    };
  }).__TAURI_INTERNALS__;
  return ti?.metadata?.currentWebview?.label ?? ti?.webview?.label ?? "";
}

/** 是否运行在 Tauri 里（浏览器开发时为 false）。 */
export function isTauri(): boolean {
  return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}
