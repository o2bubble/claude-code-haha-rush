// ── 自绘窗口按钮（Windows）──
//
// Windows 上主窗口以 `decorations(false)` 创建（见 src-tauri/src/lib.rs），
// 系统标题栏没有了，最小化/最大化/关闭要自己画。mac 保留原生装饰（红绿灯
// 与系统整合更好），所以这里**只在 Windows 渲染** —— 判断见 isWindowsChrome()。
//
// 拖拽区语义（Tauri 的 drag.js 实现，已核对源码）：
//   · `data-tauri-drag-region` 不加值 → 只有**直接**点在该元素上才拖
//   · `="deep"` → 子树内任意位置都能拖
//   · BUTTON/INPUT 等可点击元素**默认阻止拖拽**，无需手动排除
//   · 双击拖拽区 → 自动 toggle maximize（框架内置，不用自己实现）
//
// 所以：容器用 `="deep"` 让空白处能拖，按钮天然可点。

import { useCallback, useEffect, useState } from "react";
import { Minus, Square, X, Copy } from "lucide-react";
import { t } from "../i18n";

/** 是否使用自绘窗口边框。仅 Windows —— mac 走原生装饰。 */
export function isWindowsChrome(): boolean {
  if (typeof navigator === "undefined") return false;
  // userAgentData 优先（platform 在部分环境已弃用），回落到 platform
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const plat = (uaData?.platform || navigator.platform || "").toLowerCase();
  return plat.includes("win");
}

/**
 * 应用标记 —— 内联 SVG（不引外部图片：`public/` 里没有图标资源，
 * 引 src-tauri/icons 会依赖打包期拷贝路径，内联最省事且随主题着色）。
 */
export function AppMark({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ flexShrink: 0, color: "var(--accent)" }}
    >
      {/* 圆角方块 + 中心星芒：与应用图标同源的简化形 */}
      <rect x="1" y="1" width="14" height="14" rx="3.5" fill="currentColor" opacity="0.16" />
      <path
        d="M8 3.4v3.1M8 9.5v3.1M3.4 8h3.1M9.5 8h3.1M5.1 5.1l2 2M8.9 8.9l2 2M10.9 5.1l-2 2M7.1 8.9l-2 2"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none"
      />
    </svg>
  );
}

/** 窗口按钮（最小化 / 最大化-还原 / 关闭）。 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);

  // 最大化状态须跟随窗口实际状态：用户双击拖拽区、Win+↑、贴靠布局等都会改变它，
  // 只靠按钮点击维护会与实际不符（图标显示错）。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const w = getCurrentWindow();
        setMaximized(await w.isMaximized());
        const fn = await w.onResized(async () => {
          try { setMaximized(await w.isMaximized()); } catch { /* 窗口关闭中 */ }
        });
        if (alive) unlisten = fn; else fn();
      } catch { /* 非 Tauri 环境（浏览器调试）*/ }
    })();
    return () => { alive = false; unlisten?.(); };
  }, []);

  const act = useCallback(async (kind: "minimize" | "maximize" | "close") => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      if (kind === "minimize") await w.minimize();
      else if (kind === "maximize") await w.toggleMaximize();
      else await w.close();
    } catch { /* 非 Tauri 环境 */ }
  }, []);

  const btnStyle = (kind: string, danger = false): React.CSSProperties => ({
    width: 46,
    height: "100%",
    border: "none",
    background: hovered === kind
      ? (danger ? "var(--semantic-error)" : "var(--bg-hover)")
      : "transparent",
    color: hovered === kind && danger ? "var(--fg-inverse)" : "var(--fg-primary)",
    cursor: "default",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    // 按钮自带 click 语义（不是 drag region），hover 高亮才跟手
    borderRadius: 0,
  });

  return (
    <div style={{ display: "flex", alignItems: "stretch", height: "100%", marginLeft: 4 }}>
      <button
        type="button"
        aria-label={t("toolbar.windowMinimize")}
        style={btnStyle("min")}
        onMouseEnter={() => setHovered("min")}
        onMouseLeave={() => setHovered(null)}
        onClick={() => act("minimize")}
      >
        <Minus size={14} style={{ pointerEvents: "none" }} />
      </button>
      <button
        type="button"
        aria-label={maximized ? t("toolbar.windowRestore") : t("toolbar.windowMaximize")}
        style={btnStyle("max")}
        onMouseEnter={() => setHovered("max")}
        onMouseLeave={() => setHovered(null)}
        onClick={() => act("maximize")}
      >
        {maximized
          ? <Copy size={12} style={{ pointerEvents: "none", transform: "scaleX(-1)" }} />
          : <Square size={11} style={{ pointerEvents: "none" }} />}
      </button>
      <button
        type="button"
        aria-label={t("toolbar.windowClose")}
        style={btnStyle("close", true)}
        onMouseEnter={() => setHovered("close")}
        onMouseLeave={() => setHovered(null)}
        onClick={() => act("close")}
      >
        <X size={15} style={{ pointerEvents: "none" }} />
      </button>
    </div>
  );
}
