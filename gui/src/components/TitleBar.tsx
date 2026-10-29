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
import { isWindowsPlatform } from "../utils/platform";

/** 是否使用自绘窗口边框。仅 Windows —— mac 走原生装饰。 */
export function isWindowsChrome(): boolean {
  return isWindowsPlatform();
}

/** 单个窗口按钮宽度（px）。46 与 Windows 11 原生标题栏一致。 */
const BTN_W = 46;
/** 三个按钮的总宽。工具栏右侧按此预留 padding（见 Toolbar 的 TOOLBAR_CONTAINER）。 */
export const WINDOW_CONTROLS_WIDTH = BTN_W * 3;
/** 按钮条高度 = 工具栏高度（36）。两处**必须一致**，否则按钮与工具栏错位。 */
export const WINDOW_CONTROLS_HEIGHT = 36;

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
    width: BTN_W,
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

  // ⚠️ `flexShrink: 0` 只保证**不被压缩**，不保证**不被挤出**：容器宽度不够时，
  // 不收缩的 flex 项会整块溢出到容器外、被祖先的 `overflow: hidden` 裁掉 ——
  // 表现就是"三个按钮不见了"。所以真正的位置保障靠
  // `WindowControlsOverlay`（固定在窗口右上角，与工具栏的 flex 流完全无关），
  // 这里的 flexShrink 只是那层保障之上的第二道保险。
  return (
    <div style={{ display: "flex", alignItems: "stretch", height: "100%", flexShrink: 0 }}>
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

/**
 * **固定在窗口右上角**的窗口按钮层。
 *
 * 为什么不是把 `WindowControls` 直接放进工具栏的 flex 行里：
 * 那样它的位置就取决于「同一行里其它元素占了多少」—— 文字缩放调大、Windows
 * 显示缩放、工作区名变长、以后新增一个按钮……任何一样都可能把总宽推过窗口宽度，
 * 于是最右侧的三个按钮被挤到窗口外（外层 `overflow: hidden` 一裁就整个消失）。
 * 无装饰窗口下失去这三个按钮 = **用户无法控制窗口**，代价远大于省一层 DOM。
 *
 * 现在它们的位置只由「窗口右上角」决定，与任何布局压力无关 —— 永远不会被
 * 挤出、也永远不会被压缩。
 *
 * 三个关键点：
 *  · `pointerEvents: none`（容器）—— 只让按钮本身接收点击，容器覆盖的那一小块
 *    不挡住下面的拖拽区/内容。
 *  · `zIndex: 99990` —— 高于所有全屏覆盖层（启动器 1000 / 向导 2000 / 面板 9999），
 *    这样它们盖住工具栏时按钮依然在；但低于右键菜单(99999)、命令面板与 Toast
 *    (100000)，避免弹层被按钮压住边缘。
 *  · 高度与工具栏一致（`WINDOW_CONTROLS_HEIGHT`），视觉上仍是标题栏的一部分。
 */
export function WindowControlsOverlay() {
  if (!isWindowsChrome()) return null;
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        height: WINDOW_CONTROLS_HEIGHT,
        display: "flex",
        alignItems: "stretch",
        zIndex: 99990,
        pointerEvents: "none",
      }}
    >
      <div style={{ pointerEvents: "auto" }}>
        <WindowControls />
      </div>
    </div>
  );
}
