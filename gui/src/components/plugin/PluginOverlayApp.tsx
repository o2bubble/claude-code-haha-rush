/**
 * PluginOverlayApp — 插件「全屏 overlay 窗口」的宿主壳。
 *
 * 由 `open_plugin_overlay`（Rust）建的无边框置顶窗口加载
 * `index.html#overlay/<plugin>|<src>`，本组件再把插件自己的 HTML 装进一个
 * iframe 渲染。
 *
 * **为什么再套一层 iframe**：overlay 窗口若直接渲染插件 HTML，就得到另一套
 * 加载/校验/postMessage 逻辑；套 iframe 后，插件侧看到的环境与普通插件面板
 * **完全一致**（同样是 `plugins://localhost` origin、同样的 source 校验），
 * 于是 `pluginPanelBridge` 那套协议（含新增的上行 kind）一行不改就能复用。
 *
 * 安全边界：iframe 用与面板相同的 sandbox 与 origin 校验；overlay 窗口本身
 * 在 capabilities 里只多了「存在于 windows 列表」这一点，不额外放权。
 */
import { useEffect, useState } from "react";
import { pluginIframeBase, isPluginFrameOrigin } from "../../services/pluginPanelBridge";
import { getGuiPlatform, type GuiPlatform } from "../../services/pluginRegistry";

interface OverlayTarget {
  plugin: string;
  src: string;
  /** 打开者透传的查询串（不透明，宿主不解释）—— 插件常用它把后台进程端口带进来。 */
  params?: string;
}

/**
 * 解析 `#overlay/<plugin>|<src>[|<params>]`（各段 decode，分隔符 `|`）。
 * 解析失败返回 null，窗口显示错误而不是白屏。
 */
export function parseOverlayHash(hash: string): OverlayTarget | null {
  if (!hash.startsWith("#overlay/")) return null;
  const body = hash.slice("#overlay/".length);
  const parts = body.split("|");
  if (parts.length < 2) return null;
  try {
    const plugin = decodeURIComponent(parts[0]);
    const src = decodeURIComponent(parts[1]);
    const params = parts.length > 2 && parts[2] ? decodeURIComponent(parts[2]) : undefined;
    if (!plugin || !src) return null;
    return { plugin, src, ...(params ? { params } : {}) };
  } catch {
    return null;
  }
}

export default function PluginOverlayApp() {
  const [target] = useState(() => parseOverlayHash(window.location.hash));
  const [platform, setPlatform] = useState<GuiPlatform | null>(null);

  useEffect(() => {
    void getGuiPlatform().then(setPlatform);
  }, []);

  // overlay 是独立窗口：禁用右键菜单与文本选择，避免干扰框选类交互。
  // （插件可自行覆盖——它拿不到宿主 DOM，所以只能通过自己 iframe 内的样式。）
  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener("contextmenu", prevent);
    return () => document.removeEventListener("contextmenu", prevent);
  }, []);

  // 把 iframe 的上行消息**转发到主窗**。
  //
  // 为什么需要：overlay 里的插件 iframe 调 postMessage 只会到**本窗口**（overlay），
  // 而宿主处理插件上行的那套逻辑（投递到聊天/超桌/写文件…）跑在主窗。不发这一步，
  // overlay 的插件就只能干"显示"，什么也投递不出去。
  //
  // 走的通道：overlay 窗 → Tauri 事件 → 主窗监听。复用同一套来源校验（跨窗口
  // postMessage 仍可能被伪造），主窗侧再按 kind 分派（同一份 handler）。
  useEffect(() => {
    if (!target) return;
    const onMessage = (e: MessageEvent) => {
      const d = e.data;
      if (!d || typeof d !== "object") return;
      if (d.source !== `plugin:viewer:${target.plugin}`) return;
      if (!isPluginFrameOrigin(e.origin)) return;
      void import("@tauri-apps/api/event").then(({ emit }) =>
        emit("plugin-overlay-uplink", {
          plugin: target.plugin, kind: d.kind, payload: d.payload,
        }),
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [target]);

  if (!target) {
    return (
      <div style={S.hint}>
        无效的 overlay 地址（期望 #overlay/&lt;plugin&gt;|&lt;src&gt;）
      </div>
    );
  }

  // 平台未就绪前不渲染 iframe：Android/其它平台要走另一套 URL 形态，
  // 先渲染会先请求一次错误地址（多一次 404 日志噪音）。
  if (!platform) return <div style={S.hint} />;

  const base = pluginIframeBase(target.plugin, target.src, platform);
  const src = target.params ? `${base}?${target.params}` : base;
  return (
    <iframe
      title={`${target.plugin} overlay`}
      src={src}
      sandbox="allow-scripts allow-same-origin"
      style={S.frame}
    />
  );
}

const S = {
  frame: {
    width: "100vw",
    height: "100vh",
    border: "none",
    display: "block",
    margin: 0,
    background: "transparent",
  } as React.CSSProperties,
  hint: {
    padding: 12,
    font: "13px system-ui",
    color: "var(--fg-muted, #999)",
    background: "var(--bg-root, #0e0e12)",
    height: "100vh",
    boxSizing: "border-box",
  } as React.CSSProperties,
};

// 供单测/调试：确认 origin 校验与面板同源
export { isPluginFrameOrigin };
