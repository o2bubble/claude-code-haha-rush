import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import FloatingApp from "./FloatingApp";
import PluginOverlayApp from "./components/plugin/PluginOverlayApp";
import WidgetApp from "./components/widget/WidgetApp";
import { currentWindowLabel } from "./utils/tauriWindow";

// 窗口类型判定的**两条依据**：hash 与 Tauri webview label。两者都要判 ——
// hash 是建窗时写死的，label 则是窗口被复用/恢复时的兜底。
const label = currentWindowLabel();
const isFloating =
  window.location.hash.startsWith("#floating/") || label.startsWith("float-");
// overlay 用**独立前缀**（`overlay-*`）。刻意不用 `float-`：那样会被 FloatingApp
// 抢去渲染，而 overlay 要的是插件自己的 HTML。见 Rust `open_plugin_overlay`。
const isOverlay =
  window.location.hash.startsWith("#overlay/") || label.startsWith("overlay-");
// 聊天挂件（纯挂件模式）同样用独立前缀：它要的既不是面板布局，也不是插件 HTML，
// 而是一个轻量聊天视图。见 Rust `open_chat_widget` 与 components/widget/WidgetApp。
const isWidget =
  window.location.hash.startsWith("#widget/") || label.startsWith("widget-");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isOverlay ? <PluginOverlayApp />
      : isWidget ? <WidgetApp />
      : isFloating ? <FloatingApp />
      : <App />}
  </React.StrictMode>
);
