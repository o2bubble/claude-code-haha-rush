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
import type { IconKey, FloatingChrome } from "../types/layout";
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
        // payload 形状不可信 —— 各字段由 openPluginPanel / sanitizeChrome 各自校验
        void openPluginPanel(
          manifest.pluginName,
          (d.payload ?? {}) as {
            panelId?: string; params?: Record<string, unknown>;
            title?: string; width?: number; height?: number; chrome?: unknown;
          },
        ).catch(() => {});
        return;
      }
      if (d.kind === "float-drag-start") {
        void startPluginFloatDrag(
          e.source as Window | null,
          (d.payload ?? {}) as { x?: number; y?: number },
        ).catch(() => {});
        return;
      }
      // 能力类上行（on-overlay / chat-reference / desktop-image / …）走统一分派，
      // **必须在兜底之前** —— 兜底接的是"任意未识别 kind"，插件发个
      // {kind:"随便", payload:{head:"..."}} 就能往用户输入框塞文本。
      void dispatchPluginUplink(manifest.pluginName, d.kind, d.payload).then((handled) => {
        if (handled) return;
        // 面板入口独有：未识别的 kind 落到 git-viewer 那套 chip 兜底
        void sendPluginViewerChip(d).catch(() => {});
      }).catch(() => {});
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

// ── 插件上行「能力」消息 ──────────────────────────────────────────────
//
// ⚠️ payload 一律来自**第三方插件**（跨信任边界），每个都得过白名单校验，
//    照 sanitizeChrome 的写法：只认已知键 + 已知类型，其余丢弃；校验失败即静默忽略。
//
// ⚠️ 这些分支**必须加在 `sendPluginViewerChip` 兜底之前** —— 那个兜底接的是
//    "任意未识别 kind"，插件发个 {kind:"随便", payload:{head:"..."}} 就能往用户
//    输入框塞文本。

/** overlay 请求校验：src 的路径规则与面板 `content.src` 一致（禁绝对路径 /
 *  盘符 / 反斜杠 / `..` 穿越），monitor 必须是非负整数。
 *  `params` 是不透明查询串（宿主不解释，只透传）—— 长度设上限防滥用。 */
export function sanitizeOverlayRequest(
  raw: unknown,
): {
  src: string;
  monitor?: number;
  params?: string;
  hostPort?: number;
  transparent?: boolean;
  clickThrough?: boolean;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const src = typeof r.src === "string" ? r.src.trim() : "";
  if (!src) return null;
  if (src.startsWith("/") || src.includes("\\") || src.includes("..")) return null;
  if (/^[a-zA-Z]:/.test(src)) return null;
  const out: {
    src: string;
    monitor?: number;
    params?: string;
    hostPort?: number;
    transparent?: boolean;
    clickThrough?: boolean;
  } = { src };
  // 标注/教鞭类 overlay：透明背景 + 点击穿透（语义见 Rust 侧 open_plugin_overlay）。
  // 只认严格 true —— 传别的值一律当 false（即保持原有"不透明、收点击"行为）。
  if (r.transparent === true) out.transparent = true;
  if (r.clickThrough === true) out.clickThrough = true;
  if (typeof r.monitor === "number" && Number.isInteger(r.monitor) && r.monitor >= 0) {
    out.monitor = r.monitor;
  }
  if (typeof r.params === "string" && r.params.trim()) {
    out.params = r.params.trim().slice(0, 2048);
  }
  // 插件请求「overlay 关闭时通知我把让位过的宿主窗口还回去」时带上它的端口。
  // 只在插件真的让位过时才带（`restoreHostOnClose`），没有这个标记就完全不参与。
  if (r.restoreHostOnClose === true
      && typeof r.hostPort === "number" && Number.isInteger(r.hostPort)
      && r.hostPort > 0 && r.hostPort < 65536) {
    out.hostPort = r.hostPort;
  }
  return out;
}

/** 聊天引用校验：只允许 `file` 类型（插件不该能塞 `paste` 那种"内容即路径"的语义），
 *  path 必须非空且看起来是绝对文件路径。 */
export function sanitizeChatReference(raw: unknown): { path: string; label?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const path = typeof r.path === "string" ? r.path.trim() : "";
  if (!path) return null;
  const out: { path: string; label?: string } = { path };
  if (typeof r.label === "string" && r.label.trim()) {
    // label 会进 `@ref{...|<label>}` —— `|` 会把分段切错，`}` 会提前闭合。
    out.label = r.label.trim().replace(/[|}\n\r]/g, "-").slice(0, 120);
  }
  return out;
}

/** 插件请求开全屏 overlay（通用能力；overlay HTML 由插件提供）。
 *  ⚠️ 敏感：插件借此可覆盖用户整个屏幕。 */
async function openPluginOverlay(pluginName: string, raw: unknown): Promise<void> {
  const req = sanitizeOverlayRequest(raw);
  if (!req) return;
  // 插件为截图**让位**过（最小化了宿主窗口），要我们在 overlay 关掉后通知它恢复。
  // 记在这里、由 closePluginOverlay / overlay-closed 事件消费 —— 见 restoreHostIfNeeded。
  if (req.hostPort) pendingHostRestore.set(pluginName, req.hostPort);
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_plugin_overlay", {
    plugin: pluginName,
    src: req.src,
    monitor: req.monitor ?? null,
    params: req.params ?? null,
    transparent: req.transparent ?? false,
    clickThrough: req.clickThrough ?? false,
  });
}

/** 插件请求关掉自己的全部 overlay 窗口。 */
async function closePluginOverlay(pluginName: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("close_plugin_overlay", { plugin: pluginName });
  // overlay 收起来了 → 把让位时最小化的窗口还回去。
  // 挂在这里是因为**所有**正常关闭路径都会走到它（截图完成、Esc 取消、
  // 插件禁用、退出清理）；Alt+F4 那种外部销毁走不到，由插件进程侧兜底
  // （下次让位前先恢复残留，见 server.cjs 的 hideHost）。
  await restoreHostIfNeeded(pluginName);
}

/** 让位过（还没恢复）的插件 → 它的进程端口。见 `restoreHostIfNeeded`。 */
const pendingHostRestore = new Map<string, number>();

// ── 小指示窗 ──────────────────────────────────────────────────────

/**
 * 指示窗请求的校验：**只允许相对定位的宽高**，坐标交给 Rust 侧兜底
 * （不给坐标 = 用缺省位置）。
 *
 * 不复用 `sanitizeOverlayRequest` —— 那个是给"铺满显示器"的 overlay 用的，
 * 语义（monitor 索引）与这里（像素坐标 + 尺寸）不同。
 */
export function sanitizeIndicatorRequest(
  raw: unknown,
): { src: string; params?: string; x?: number; y?: number; width?: number; height?: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const src = typeof r.src === "string" ? r.src.trim() : "";
  if (!src) return null;
  if (src.startsWith("/") || src.includes("\\") || src.includes("..")) return null;
  if (/^[a-zA-Z]:/.test(src)) return null;
  const out: { src: string; params?: string; x?: number; y?: number; width?: number; height?: number } = { src };
  if (typeof r.params === "string" && r.params.trim()) out.params = r.params.trim().slice(0, 2048);
  // 坐标：限个合理范围，避免插件传离谱的值把窗口丢到屏幕外
  const num = (v: unknown, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : undefined;
  out.x = num(r.x, -32000, 32000);
  out.y = num(r.y, -32000, 32000);
  out.width = num(r.width, 120, 2000);
  out.height = num(r.height, 60, 2000);
  return out;
}

/** 移动指示窗的载荷校验。 */
export function sanitizeIndicatorMove(raw: unknown): { x: number; y: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const x = typeof r.x === "number" && Number.isFinite(r.x) ? Math.round(r.x) : null;
  const y = typeof r.y === "number" && Number.isFinite(r.y) ? Math.round(r.y) : null;
  if (x === null || y === null) return null;
  if (Math.abs(x) > 32000 || Math.abs(y) > 32000) return null;
  return { x, y };
}

async function openPluginIndicator(pluginName: string, raw: unknown): Promise<void> {
  const req = sanitizeIndicatorRequest(raw);
  if (!req) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_plugin_indicator", {
    plugin: pluginName,
    src: req.src,
    params: req.params ?? null,
    x: req.x ?? null,
    y: req.y ?? null,
    width: req.width ?? null,
    height: req.height ?? null,
  });
}

async function closePluginIndicator(pluginName: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("close_plugin_indicator", { plugin: pluginName });
}

/**
 * 把让位过的宿主窗口还回去 —— 由插件进程执行（窗口句柄列表在它手里）。
 *
 * 为什么要绕这一圈：让位时最小化的是**该进程的全部可见窗口**（主窗 + 浮窗，
 * 插件分不清哪个是主窗），而宿主前端的窗口 API 只能操作自己那一个 →
 * 恢复只能由持有句柄列表的进程做，宿主只负责**时机**（overlay 关了）。
 *
 * 幂等：没有 pending 记录时直接返回（普通 overlay 不走让位，不参与）。
 */
export async function restoreHostIfNeeded(pluginName: string): Promise<void> {
  const port = pendingHostRestore.get(pluginName);
  if (!port) return;
  pendingHostRestore.delete(pluginName);
  try {
    await fetch(`http://127.0.0.1:${port}/restore-host`, { method: "POST" });
  } catch {
    // 插件进程已退出等 —— 窗口留在最小化状态，用户点任务栏即可。
    // 不重试：重试也无处可去（端口没了），且不该为此留住 pending 记录。
  }
}

/** 插件 → 聊天输入框：以 `file` 引用插入（图片走这条，chip 图标 📄，
 *  点击用编辑器/预览面板打开）。 */
async function sendPluginChatReference(raw: unknown): Promise<void> {
  const ref = sanitizeChatReference(raw);
  if (!ref) return;
  const { Events } = await import("./events");
  const { windowBus } = await import("./windowBus");
  const label = ref.label ?? ref.path.split(/[/\\]/).pop() ?? ref.path;
  windowBus.emit(Events.CHAT_ADD_REFERENCE, {
    reference: { type: "file", path: ref.path, label },
  });
}

/** 插件 → 超级桌面：新增一个图片块。
 *  ⚠️ `addItem` 在 desktopId 不存在时**静默失败**（返回一个看起来正常但没进 store
 *  的对象）—— 必须先 loadDesktops()，并在无桌面时兜底建一个。 */
async function sendPluginDesktopImage(raw: unknown): Promise<void> {
  const ref = sanitizeChatReference(raw); // 同样的 shape：path(+label)
  if (!ref) return;
  const store = await import("../stores/desktopStore");
  await store.loadDesktops();
  let desktop = store.getActiveDesktop();
  if (!desktop) desktop = store.createDesktop("Screenshots");
  const label = ref.label ?? ref.path.split(/[/\\]/).pop() ?? "image";
  const W = 400;
  const H = 300;
  const pos = store.findSmartPlace(desktop, W, H);
  store.addItem(desktop.id, {
    x: pos.x,
    y: pos.y,
    width: W,
    height: H,
    content: { type: "image", path: ref.path } as never,
    label,
  });
}

/** 插件 → 工作区文件：落盘到当前工作区内。
 *  ⚠️ **必须限制在 workDir 之内** —— 这是插件唯一能触达文件系统的宿主通道，
 *  不限制就是任意路径写入（`save_bytes` 本身不做沙箱）。 */
async function writeWorkspaceFile(raw: unknown): Promise<void> {
  if (!raw || typeof raw !== "object") return;
  const r = raw as Record<string, unknown>;
  const rel = typeof r.path === "string" ? r.path.trim().replace(/\\/g, "/") : "";
  const base64 = typeof r.base64 === "string" ? r.base64 : "";
  if (!rel || !base64) return;
  // 拒绝绝对路径与任何形式的目录穿越
  if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel) || rel.split("/").includes("..")) return;
  const { getSettings } = await import("../stores/settingsStore");
  const workDir = getSettings().workDir;
  if (!workDir) return;
  const abs = `${workDir.replace(/[\\/]+$/, "")}/${rel}`;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_bytes", { path: abs, base64Data: base64 });
}

/**
 * 插件上行消息的**统一分派**（面板 iframe 与 overlay 窗口的 iframe 共用）。
 *
 * 两个入口的差别只在"消息怎么到达主窗"：
 *   · 面板 iframe → 直接 `postMessage` 到主窗（`pluginPanelBridge` 的 onMessage）
 *   · overlay 窗口的 iframe → postMessage 只能到 overlay 窗（跨窗口），由
 *     `PluginOverlayApp` 转成 Tauri 事件，主窗再监听后调本函数
 * 分派逻辑本身必须只有一份，否则两条路径会逐渐跑偏。
 *
 * 返回 true 表示已处理（调用方不必再走兜底）。
 * ⚠️ 未识别的 kind 返回 false —— 面板入口据此走 `sendPluginViewerChip` 兜底
 * （overlay 入口没有那个兜底，未识别即忽略）。
 */
export async function dispatchPluginUplink(
  pluginName: string,
  kind: unknown,
  payload: unknown,
): Promise<boolean> {
  if (typeof kind !== "string") return false;
  switch (kind) {
    case "open-overlay":
      await openPluginOverlay(pluginName, payload);
      return true;
    case "close-overlay":
      await closePluginOverlay(pluginName);
      return true;
    // ── 小指示窗（"AI 操作中"浮标那一类）──
    case "open-indicator":
      await openPluginIndicator(pluginName, payload);
      return true;
    case "move-indicator": {
      const mv = sanitizeIndicatorMove(payload);
      if (mv) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("move_plugin_indicator", { plugin: pluginName, x: mv.x, y: mv.y });
      }
      return true;
    }
    case "close-indicator":
      await closePluginIndicator(pluginName);
      return true;
    case "chat-reference":
      await sendPluginChatReference(payload);
      return true;
    case "desktop-image":
      await sendPluginDesktopImage(payload);
      return true;
    case "write-workspace-file":
      await writeWorkspaceFile(payload);
      return true;
    default:
      return false;
  }
}

/** 主窗监听 overlay 窗口转上来的消息（见 `dispatchPluginUplink` 注释）。
 *  在 App 启动时订阅一次。 */
export function startOverlayUplinkListener(): () => void {
  // ⚠️ **单例保护**：重复注册会让同一个 overlay 上行被执行多次 —— 表现是
  // 「拖一次框，往输入框插了 3 个同样的引用」。React StrictMode 的双调用、
  // HMR 重载都会造成多份监听，而且这种重复**不会报错**，只体现为重复插入。
  if (_overlayUplinkStop) return _overlayUplinkStop;

  let un: (() => void) | null = null;
  let stopped = false;
  void import("@tauri-apps/api/event").then(({ listen }) =>
    listen<{ plugin: string; kind: string; payload: unknown }>(
      "plugin-overlay-uplink",
      (e) => {
        const p = e.payload;
        if (!p || typeof p.plugin !== "string") return;
        void dispatchPluginUplink(p.plugin, p.kind, p.payload).catch(() => {});
      },
    ).then((fn) => {
      if (stopped) fn();
      else un = fn;
    }),
  ).catch(() => {});

  const stop = () => {
    stopped = true;
    un?.();
    _overlayUplinkStop = null;
  };
  _overlayUplinkStop = stop;
  return stop;
}

let _overlayUplinkStop: (() => void) | null = null;

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

/** 插件请求的浮窗外壳 → 白名单过滤后的 FloatingChrome。
 *
 *  **这是跨信任边界的输入**（payload 来自插件 iframe 的 postMessage）——
 *  只接受 5 个已知键的布尔值，其余键、非布尔值一律丢弃：插件能开关预设项，
 *  但灌不进任意值。全部非法/未声明 → undefined（= 传统浮窗，安全默认）。
 *  导出供单测。 */
export function sanitizeChrome(raw: unknown): FloatingChrome | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: FloatingChrome = {};
  let any = false;
  for (const k of ["titleBar", "background", "border", "shadow", "resizable"] as const) {
    if (typeof r[k] === "boolean") {
      out[k] = r[k];
      any = true;
    }
  }
  return any ? out : undefined;
}

/** 浮窗单例引用: 面板 id → 浮窗 id（同一插件面板复用同一浮窗, 连续点列表项不抖动） */
const floatRefs = new Map<string, string>();

/** 请求宿主打开插件面板（通用）: 已开 → 置顶 + 推送新参数 + 刷新外壳; 未开 → 浮窗打开(居中)。
 *  payload.chrome 经 sanitizeChrome 白名单过滤后才落到渲染层（见该函数注释）。 */
async function openPluginPanel(
  pluginName: string,
  payload: { panelId?: string; params?: Record<string, unknown>; title?: string; width?: number; height?: number; chrome?: unknown },
): Promise<void> {
  const { panelId, params } = payload;
  if (!panelId) return;
  const fullId = `plugin:${pluginName}:${panelId}`;
  const { addFloatingPanel, bringFloatingToFront, getFloatingPanels, updateFloatingChrome } =
    await import("../stores/layoutStore");
  const { getPanel } = await import("../stores/panelRegistry");
  const def = getPanel(fullId);
  if (!def) return; // 插件声明的面板不存在（旧版/拼错）→ 静默忽略

  // 参数: 记 intent（新 iframe 挂载会消费）; 已有 iframe 则直接 postMessage 增量推送
  if (params) setPanelIntent(fullId, params);
  pushParamsToPanelFrames(pluginName, panelId, params);

  const chrome = sanitizeChrome(payload.chrome);
  const existing = floatRefs.get(fullId);
  if (existing && getFloatingPanels().some((fp) => fp.id === existing)) {
    // 已开 → 按本次声明刷新外壳，使 open-panel 幂等（未声明 chrome 即恢复传统浮窗）
    updateFloatingChrome(existing, chrome);
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
    chrome,
  );
  floatRefs.set(fullId, id);
}

/** 插件 iframe 请求拖动其所在浮窗（上行 kind: "float-drag-start"，payload 带 iframe 内坐标）。
 *
 *  **为什么必须走协议**：iframe 是独立文档，其内部 mousedown **不冒泡到宿主文档**
 *  —— 宿主那份 `data-float-drag` 委托对 iframe 面板收不到事件。非 iframe 的
 *  浮窗（宿主自己渲染的内容）仍用 data-float-drag；iframe 面板只能显式上行请求。
 *
 *  **为什么要铺遮罩**：鼠标一停在 iframe 上方，mousemove 就归 iframe 文档，
 *  宿主的 document 监听会断流 → 拖动一顿一顿甚至停住。拖动期间盖一层全屏
 *  透明遮罩，把事件收归宿主，鼠标就始终"在宿主手里"。
 *
 *  坐标换算：iframe 元素在视口中的位置 + 插件报来的 iframe 内坐标。 */
async function startPluginFloatDrag(
  win: Window | null,
  payload?: { x?: number; y?: number },
): Promise<void> {
  if (!win) return;
  // 从 contentWindow 反查 iframe → 其所在的浮窗容器。不用 floatRefs：
  // 浮窗也可能由布局拖出等其它路径创建，未必登记在那里。
  const iframeEl = [...document.querySelectorAll("iframe")].find(
    (f) => f.contentWindow === win,
  );
  const panelEl = iframeEl?.closest("[data-floating-id]") as HTMLElement | null;
  const floatId = panelEl?.getAttribute("data-floating-id");
  if (!iframeEl || !panelEl || !floatId) return;

  const { getFloatingPanels, updateFloatingPosition, bringFloatingToFront } =
    await import("../stores/layoutStore");
  const fp = getFloatingPanels().find((f) => f.id === floatId);
  if (!fp) return;
  bringFloatingToFront(floatId);

  const rect = iframeEl.getBoundingClientRect();
  const startX = rect.left + (payload?.x ?? 0);
  const startY = rect.top + (payload?.y ?? 0);
  const ix = fp.x;
  const iy = fp.y;

  const mask = document.createElement("div");
  mask.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;cursor:grabbing;";
  document.body.appendChild(mask);

  const onMove = (ev: MouseEvent) => {
    // 拖动中只改 DOM —— 与标题栏拖动一致，避免每帧触发持久化
    panelEl.style.left = `${ix + ev.clientX - startX}px`;
    panelEl.style.top = `${iy + ev.clientY - startY}px`;
  };
  const onUp = () => {
    mask.remove();
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    const r = panelEl.getBoundingClientRect();
    updateFloatingPosition(floatId, r.left, r.top);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp, { once: true });
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

/**
 * 注销插件贡献的面板（禁用/卸载时调用）：
 *  ① panelRegistry 摘定义（图标栏/面板下拉即消失）
 *  ② 布局树移除已打开的实例（removePanelsFromTree 纯函数）
 *  ③ 浮窗形态的含该面板的窗口一并关闭
 *  ④ **关掉该插件开的指示窗与 overlay 窗口**
 *
 * ④ 的必要性：**宿主自己开的窗口该由宿主收拾**。此前只在插件**主动请求**关闭时
 * 才调 closePlugin*，禁用/卸载路径没有 —— 指示窗靠"插件进程没了就自愈"才没留下
 * 残骸，但那是插件侧的兜底，不该当主路径用。
 *
 * ④ 异步且**失败即忽略**：窗口清理失败不该影响"注销面板"这件正事。
 * 且它在 `panelIds.length === 0` 的早退**之前** —— 没贡献面板的插件
 * （如鼠标键盘只开指示窗）同样要关窗。
 */
export function unregisterPluginPanels(pluginName: string): void {
  // ④ 先发出去（不等结果）
  void closePluginIndicator(pluginName).catch(() => {});
  void closePluginOverlay(pluginName).catch(() => {});

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
