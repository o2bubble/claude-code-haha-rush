// ── pluginPanelBridge — 插件面板接入现有布局系统 ──
// T2: 把已解析的 PluginManifest 贡献的面板注册进 panelRegistry。
// id 前缀 `plugin:<name>:<panelId>` 防撞内置面板。render 双模式:
//   有 content.src 声明 → iframe 加载插件目录内文件(plugins:// 协议, 沙箱隔离);
//   无声明 → 声明式占位组件(插件信息页)。
// 沙箱后 postMessage 上行由 PluginIframePanel 监听(来源校验), 见 GV-T5 chip。

import { useEffect, useRef, useState, type ReactNode } from "react";
import { rerenderPanel, unregisterPanel, getAllPanels } from "../stores/panelRegistry";
import { removePanelsFromTree } from "../stores/pluginLayout";
import { getTree, setTree, getFloatingPanels, removeFloatingPanel } from "../stores/layoutStore";
import { pluginPanelId, getGuiPlatform, type GuiPlatform, type PluginManifest, type PluginPanel } from "./pluginRegistry";
import type { IconKey } from "../types/layout";
import { usePluginProcesses } from "./pluginProcessBridge";
import type { PanelView } from "../stores/panelRegistry";

/** 当前 GUI 平台（get_platform, Rust 编译结果; 模块级缓存由 getGuiPlatform 提供）。
 *  用于 iframe URL 的平台差异拼接 —— Windows/Android 用 https://<scheme>.localhost,
 *  其它平台用 <scheme>://localhost（tauri/wry 转换规则, 见 tauri webview::is_local_url）。 */
function useGuiPlatform(): GuiPlatform | null {
  const [p, setP] = useState<GuiPlatform | null>(null);
  useEffect(() => { void getGuiPlatform().then(setP); }, []);
  return p;
}

/** 平台正确的插件 iframe base URL（无端口 query）。导出供单测锁定回归。
 *  Windows: http://plugins.localhost/...  —— 直接 plugins:// 会被 WebView2
 *   当外部协议导航被 iframe 沙箱拦截（用户实测错误: "Navigation to external protocol
 *   blocked by sandbox ... allow-top-navigation-to-custom-protocols"）。用 http 是
 *   tauri use_https_scheme 默认 false（tauri.conf 未设）—— 且 http 页面 fetch
 *   http://127.0.0.1 无 mixed-content 问题。
 *  其它(mac/Linux): plugins://localhost/...。 */
export function pluginIframeBase(pluginName: string, src: string, platform: GuiPlatform | null): string {
  if (platform === "windows") {
    return `http://plugins.localhost/${pluginName}/${src}`;
  }
  return `plugins://localhost/${pluginName}/${src}`;
}

/** postMessage 来源校验: 仅接受插件面板 iframe 两种平台 origin 形态
 *  （mac/linux: plugins://localhost; windows: http(s)://plugins.localhost——
 *  防任意窗口注入 chip）。host 精确匹配(不是 startsWith——防 plugins.localhost.evil.com
 *  伪装)。导出供单测。 */
export function isPluginFrameOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    // mac/linux 形态: schemes://localhost
    if (u.protocol === "plugins:") return u.host === "localhost";
    // windows 形态: http(s)://plugins.localhost
    if (u.protocol === "http:" || u.protocol === "https:") {
      return u.host === "plugins.localhost";
    }
    return false;
  } catch {
    return false;
  }
}

/** 插件 manifest.icon(自由字符串) → 合法 IconKey 判定: 属于 IconKey 集合则用之,
 *  否则 undefined(注册方拿 grid3x3 兜底)。IconKey 集合静态列出(与 layout.ts 同步)。 */
const ICON_KEYS = new Set<string>([
  "editor", "workers", "plan", "subagents", "messages", "input",
  "sessions", "skills", "files", "settings", "terminal", "superDesktop",
  "askQuestion", "desktopItemView", "profileManager", "feedback", "update",
  "explorer", "search", "outline", "compoundGroup", "file", "notes",
  "quickPrompts", "help", "diagnostics", "default", "user",
  "folderKanban", "package", "grid3x3", "layoutGrid", "combine", "gitBranch",
]);
export function isIconKey(v: string | undefined): v is IconKey {
  return !!v && ICON_KEYS.has(v);
}

/** 当前主 UI 主题简化为插件可见值: "dark"|"light"（4 预设 dark/dark-a/dark-b 均 dark）。
 *  iframe 初始 URL query 与变更推送都用它 —— 插件按需适配。导出供单测。 */
export function pluginThemeValue(): "dark" | "light" {
  try {
    const t = document.documentElement.dataset.theme;
    if (t === "dark" || t === "dark-a" || t === "dark-b") return "dark";
    return "light";
  } catch {
    return "light";
  }
}

/** 插件面板的声明式 render（无 content.src 声明时的默认：显示插件信息）。 */
function pluginPanelContent(manifest: PluginManifest, panel: PluginPanel) {
  return () => (
    <div data-plugin-panel={panel.id} style={{ padding: 12, fontFamily: "var(--font-sans)" }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{panel.title}</div>
      <div style={{ fontSize: 12, color: "var(--fg-muted)", marginBottom: 8 }}>
        {manifest.displayName} v{manifest.version}
      </div>
      {manifest.description ? (
        <div style={{ fontSize: 12, color: "var(--fg-secondary)", whiteSpace: "pre-wrap" }}>
          {manifest.description}
        </div>
      ) : null}
    </div>
  );
}

/** 插件面板 iframe 渲染 —— content.src 声明的面板加载插件目录内文件。
 *  沙箱: allow-scripts + allow-same-origin（弹窗/顶层导航/下载均不设权限；
 *  iframe 独立 origin, postMessage 上行跨源至宿主——来源由 message.origin 校验
 *  为本插件面板 iframe 的 plugins:// URL, 防止任意窗口注入）。
 *  URL: plugins://localhost/<pluginName>/<src>?port=<p> —— host 固定,
 *  pluginName 放路径段(host 有字符限制); 进程端口缺失则省略(面板自行降级)。 */
function PluginIframePanel({ manifest, panel }: { manifest: PluginManifest; panel: PluginPanel }) {
  const processes = usePluginProcesses();
  const platform = useGuiPlatform();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const port = panel.process
    ? processes.find((p) => p.processId === panel.process)?.port
    : undefined;
  const base = pluginIframeBase(manifest.pluginName, panel.content!.src, platform);
  // 初始 URL 带 theme（插件首帧就按主题配色）+ 面板参数（intent, 打开浮窗时由列表传入;
  // 首帧 postMessage 不可靠, URL query 最稳——params 是 base64(JSON)）。
  const theme = pluginThemeValue();
  const panelKey = `plugin:${manifest.pluginName}:${panel.id}`;
  // 参数意图: **挂载时捕获进 ref**（不能在 useEffect 里 consume —— port/platform 异步到达
  // 会触发重渲染重算 src, 若参数已从 map 删掉, 重算的 src 无 params → iframe 重载丢参
  // → 浮窗显示默认文案（用户实测"从列表选择文件"）。map 条目保留, 下次 open-panel 覆盖。）
  const intentRef = useRef<Record<string, unknown> | undefined>(panelIntents.get(panelKey));
  const query: string[] = [];
  if (port) query.push(`port=${port}`);
  query.push(`theme=${theme}`);
  if (intentRef.current) {
    try {
      query.push(`params=${encodePanelParams(intentRef.current)}`);
    } catch { /* 不可序列化参数忽略 */ }
  }
  const src = `${base}?${query.join("&")}`;

  // iframe 引用注册（宿主 → iframe 参数推送用）。
  // 注意: **不删除 intent** —— 见上方 intentRef 注释（重渲染重算 src 需要参数仍在）。
  useEffect(() => {
    const set = panelFrames.get(panelKey) ?? new Set<HTMLIFrameElement>();
    set.add(iframeRef.current!);
    panelFrames.set(panelKey, set);
    return () => {
      if (iframeRef.current) set.delete(iframeRef.current);
      if (set.size === 0) panelFrames.delete(panelKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelKey]);

  // 面板 postMessage 上行（来源校验 = plugins:// 两种形态, namespace 防误接）。两类:
  // ① open-panel（通用: 请求宿主打开本插件某个面板, payload 带参数）——列表→详情等场景
  // ② diff/commit（git-viewer 的发送到聊天的载荷）→ chip
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data;
      if (!d || typeof d !== "object") return;
      if (d.source !== `plugin:viewer:${manifest.pluginName}`) return;
      const origin = e.origin || String(e.origin);
      if (!isPluginFrameOrigin(origin)) return;
      if (d.kind === "open-panel") {
        void openPluginPanel(manifest.pluginName, (d.payload ?? {}) as { panelId?: string }).catch(() => {});
        return;
      }
      void sendPluginViewerChip(d).catch(() => {});
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [manifest.pluginName]);

  // 主题跟随主 UI: data-theme 变化 → 向 iframe postMessage 推送（插件监听切换配色）。
  // URL 只给首帧, 动态切换必须靠推送（主文档 data-theme 变更 iframe 不自动感知）。
  useEffect(() => {
    const pushTheme = () => {
      const t = pluginThemeValue();
      iframeRef.current?.contentWindow?.postMessage(
        { source: "plugin:host", kind: "theme", payload: { theme: t } },
        "*",
      );
    };
    pushTheme(); // 首次: iframe 可能未加载完成, 可重发; 加载后自己也读 URL theme 兜底
    const obs = new MutationObserver(pushTheme);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  return (
    <iframe
      ref={iframeRef}
      title={panel.title}
      src={src}
      sandbox="allow-scripts allow-same-origin"
      style={{ width: "100%", height: "100%", border: "none", display: "block" }}
    />
  );
}

/** 面板上行(chip)落地: diff/commit 内容以 paste 引用保存到 <workdir>/.claude/pasted/,
 *  chip = @ref{paste:<path>|label} 插入聊天输入（复用现有 CHAT_ADD_REFERENCE 机制,
 *  不新增全局 store —— 见记忆 feedback_data_system）。 */
async function sendPluginViewerChip(d: { kind: string; payload?: { file?: string; diff?: string; ref?: string; head?: string } }): Promise<void> {
  const { getSettings } = await import("../stores/settingsStore");
  const workDir = getSettings().workDir;
  if (!workDir) return;
  const isDiff = d.kind === "diff";
  const labelText = isDiff
    ? (d.payload?.file ?? "diff")
    : (d.payload?.ref ?? "commit");
  const body = d.payload?.diff ?? d.payload?.head ?? "";
  if (!body.trim()) return;
  const { saveClipboardItem } = await import("./clipboardService");
  const path = await saveClipboardItem(
    new Blob([body], { type: "text/plain" }),
    workDir,
    `git-${isDiff ? "diff" : "commit"}-${labelText.replace(/[\\/:*?"<>|]/g, "-")}.diff`,
  );
  if (!path) return;
  const { Events } = await import("./events");
  const { windowBus } = await import("./windowBus");
  windowBus.emit(Events.CHAT_ADD_REFERENCE, {
    reference: { type: "paste", path, label: `git ${isDiff ? "diff" : "commit"}: ${labelText}` },
  });
}

// ── 通用: 插件面板打开 + 参数传递（平台机制, 渲染归插件）──
// 插件 iframe 上行 { kind: "open-panel", payload: { panelId, params, title, width, height } }
// → 宿主以浮窗打开该插件声明的面板, 并把 params 传给目标 iframe（URL query 首帧 +
// postMessage 增量更新）。渲染 100% 在插件侧（平台不认识 diff/其它内容语义）。

/** 面板参数意图: 面板 id → 参数对象。目标 iframe 挂载时消费（拼 URL query）, 之后清空。 */
const panelIntents = new Map<string, Record<string, unknown>>();

/** 面板参数 → URL query 值（base64url JSON）。纯函数, 导出供单测。
 *  ⚠️ 必须 base64**url**: 普通 base64 的 `+` 会被 URLSearchParams 解成空格 → 静默丢参
 *  （实测: diff 浮窗显示默认文案而非内容）。插件侧对应 decodeBase64UrlParams。 */
export function encodePanelParams(params: Record<string, unknown>): string {
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(params))));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 解码（插件侧同逻辑的参考实现/宿主自测用）: base64url → JSON。 */
export function decodePanelParams(s: string): Record<string, unknown> {
  let std = s.replace(/-/g, "+").replace(/_/g, "/");
  while (std.length % 4) std += "=";
  return JSON.parse(decodeURIComponent(escape(atob(std))));
}

/** 设置面板参数（供打开时/复用浮窗时推送）。导出供单测。
 *  条目**保留不删**: 已挂载的 iframe 组件重渲染时需重算带参 src（见 PluginIframePanel）。 */
export function setPanelIntent(panelId: string, params: Record<string, unknown>): void {
  panelIntents.set(panelId, params);
}

/** 浮窗单例引用: 面板 id → 浮窗 id（同一插件面板复用同一浮窗, 连续点列表项不抖动） */
const floatRefs = new Map<string, string>();

/** 请求宿主打开插件面板（通用）: 已开 → 置顶 + 推送新参数; 未开 → 浮窗打开(居中)。 */
async function openPluginPanel(
  pluginName: string,
  payload: { panelId?: string; params?: Record<string, unknown>; title?: string; width?: number; height?: number },
): Promise<void> {
  const { panelId, params } = payload;
  if (!panelId) return;
  const fullId = `plugin:${pluginName}:${panelId}`;
  const { addFloatingPanel, bringFloatingToFront, getFloatingPanels } = await import("../stores/layoutStore");
  const { getPanel } = await import("../stores/panelRegistry");
  const def = getPanel(fullId);
  if (!def) return; // 插件声明的面板不存在（旧版/拼错）→ 静默忽略

  // 参数: 记 intent（新 iframe 挂载会消费）; 已有 iframe 则直接 postMessage 增量推送
  if (params) setPanelIntent(fullId, params);
  pushParamsToPanelFrames(pluginName, panelId, params);

  const existing = floatRefs.get(fullId);
  if (existing && getFloatingPanels().some((fp) => fp.id === existing)) {
    bringFloatingToFront(existing);
    return;
  }
  const W = payload.width ?? 560, H = payload.height ?? 460;
  const id = addFloatingPanel(
    {
      type: "group",
      id: `plugin-float-${crypto.randomUUID()}`,
      tabs: [{ id: `tab-${fullId}`, panelId: fullId, title: payload.title ?? def.title }],
      activeTabId: `tab-${fullId}`,
      tabStyle: "tabs",
    },
    Math.max(20, (window.innerWidth - W) / 2),
    Math.max(20, (window.innerHeight - H) / 2),
    W, H,
  );
  floatRefs.set(fullId, id);
}

/** 向"已挂载的该插件面板 iframe"推送参数（跨源 postMessage, 目标 = plugins:// iframe）。
 *  用 window 上存储的 iframe 引用（PluginIframePanel 注册）——避免全局 query 扫描。 */
function pushParamsToPanelFrames(pluginName: string, panelId: string, params?: Record<string, unknown>): void {
  if (!params) return;
  const key = `plugin:${pluginName}:${panelId}`;
  const frames = panelFrames.get(key);
  if (!frames) return;
  for (const f of frames) {
    try {
      f.contentWindow?.postMessage(
        { source: "plugin:host", kind: "params", payload: params },
        "*",
      );
    } catch { /* iframe 未就绪/已卸载 */ }
  }
}

/** 已挂载插件面板 iframe 注册表（参数推送用）。 */
const panelFrames = new Map<string, Set<HTMLIFrameElement>>();


/** 把 manifest 里贡献的面板注册进 panelRegistry。
 *  panelKind 语义: "in-main"=布局面板(用户可开进布局/下拉); "floating"=供插件用
 *  open-panel 上行请求宿主开浮窗的"浮窗面板"(本身不进布局, 一般 userManaged:false)。
 *  两者渲染统一(iframe/占位); 打开方式不同——浮窗由 openPluginPanel 触发。
 *  @param manifests 由 scanPlugins 解析出的插件清单（已容错）*/
export function registerPluginPanels(manifests: PluginManifest[]): void {
  for (const manifest of manifests) {
    for (const panel of manifest.contributes.panels) {
      // content.src 声明 → iframe 渲染；无声明 → 占位组件（插件信息页）。
      // render 签名 = () => ReactNode——pluginPanelContent 返回的正是这种函数。
      const render: () => ReactNode = panel.content
        ? () => <PluginIframePanel manifest={manifest} panel={panel} />
        : pluginPanelContent(manifest, panel);
      const views: PanelView[] = (panel.views?.length ? panel.views : [{ id: "main", title: panel.title }]).map((v) => ({
        id: v.id,
        title: v.title,
        render,
      }));
      // rerenderPanel(覆盖语义): 插件可能重装新版本——面板定义必须更新,
      // registerPanel 的 dup 保护会静默忽略(面板停留在旧版)。
      rerenderPanel({
        id: pluginPanelId(manifest.pluginName, panel.id),
        title: panel.title,
        // 图标: manifest.icon 若为合法 IconKey(如 gitBranch)用之; 否则 grid3x3 兜底
        // (插件 icon 是自由字符串如 "compass"/"git"/"grid3x3", 命名空间不属 IconKey)。
        icon: isIconKey(manifest.icon) ? manifest.icon : "grid3x3",
        defaultView: views[0]?.id ?? "main",
        views,
        userManaged: panel.userManaged !== false,
      });
    }
  }
}

/** 注销插件贡献的面板（禁用/卸载时调用）：
 *  ① panelRegistry 摘定义（图标栏/面板下拉即消失）
 *  ② 布局树移除已打开的实例（removePanelsFromTree 纯函数, T2 预留）
 *  ③ 浮窗形态的含该面板的窗口一并关闭 */
export function unregisterPluginPanels(pluginName: string): void {
  const panelIds = getAllPanels()
    .map((p) => p.id)
    .filter((id) => id.startsWith(`plugin:${pluginName}:`));
  if (panelIds.length === 0) return;
  for (const id of panelIds) unregisterPanel(id);

  setTree(removePanelsFromTree(getTree(), panelIds));
  for (const fw of getFloatingPanels()) {
    // FloatingWindow = { id, group: TabGroup } —— tabs 含被摘 panelId（compound
    // children 同理）→ 整个浮窗关闭
    const tabs = fw.group?.tabs ?? [];
    const hits = tabs.some((tb) =>
      panelIds.includes(tb.panelId ?? "") ||
      (tb.children ?? []).some((c) => panelIds.includes(c.panelId ?? "")));
    if (hits) removeFloatingPanel(fw.id);
  }
}
