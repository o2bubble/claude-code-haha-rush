// ── 被「叫到前台」时的窗口内闪烁提示 ──
//
// 触发：Rust 的 `focus_main_window_impl`（托盘「切到前台」、跨实例唤醒、
// focus_main_window 命令）发 `main-window-focus-flash` 事件。
//
// ## 为什么需要它
//
// Windows 有**前台锁定**：托盘菜单是另一个进程发起的，它无权把本窗口提到最前。
// Rust 侧已经加了 `force_foreground`（AttachThreadInput + TOPMOST）去绕，
// 但在某些系统策略下仍可能失败 —— 那时用户面前的画面**毫无变化**，
// 体感就是「点了没反应」，而且他没有任何线索知道「其实是切了，只是被挡住了」。
//
// 闪烁是**窗口内部的绘制**：只要窗口还可见（哪怕被别的窗口盖住、哪怕没有焦点），
// 它照样会发生。用户一旦看到边框闪，就知道「确实是我这一窗」，可以自己去
// Alt+Tab / 任务栏找回来。
//
// ## 视觉
//
// 窗口内沿四周画一圈强调色描边，淡入 → 停留 → 淡出，重复两次（约 1.2s）。
// 用 `outline` 而不是 `border`：outline **不占布局空间**，不会让内容抖一下。
// `pointerEvents: none` —— 它纯装饰，绝不能吃掉点击。

import { useEffect, useState } from "react";

/** 与 Rust `FOCUS_FLASH_EVENT` 一致。 */
const FOCUS_FLASH_EVENT = "main-window-focus-flash";

/** 一次闪烁的完整周期（淡入 0.18s + 停留 0.22s + 淡出 0.3s ≈ 0.7s，闪 2 次）。 */
const FLASH_MS = 1400;

export function FocusFlash() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    let timer: number | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const fn = await listen(FOCUS_FLASH_EVENT, () => {
          // 用自增 key 强制重启动画（连续触发时也要重新闪，而不是叠加后卡住）
          setActive((n) => n + 1);
          if (timer) window.clearTimeout(timer);
          timer = window.setTimeout(() => setActive(0), FLASH_MS);
        });
        if (alive) unlisten = fn;
        else fn();
      } catch {
        /* 非 Tauri 环境（浏览器调试） */
      }
    })();
    return () => {
      alive = false;
      unlisten?.();
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  if (!active) return null;

  return (
    <div
      key={active}
      className="focus-flash"
      aria-hidden="true"
      style={{
        position: "fixed",
        // 盖住整个窗口内容区（含工具栏与状态栏），inset 0 即可 ——
        // 不做负偏移，避免超出窗口被裁掉一半
        inset: 0,
        zIndex: 100001,
        pointerEvents: "none",
        // outline 不占布局（border 会让内容跳 2px）
        outline: "3px solid var(--accent)",
        outlineOffset: "-3px",
        borderRadius: 4,
      }}
    />
  );
}
