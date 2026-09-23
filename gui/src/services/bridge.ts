/**
 * Bridge — Tauri Event cross-window transport for DataBus.
 *
 * Two roles:
 *   Hub  — main window, connects WS, owns BridgeOut
 *   Leaf — floating window, receives data via BridgeIn
 *
 * Handshake (Leaf start):
 *   Leaf → hello { windowId, subscriptions }
 *   Hub  → init  { snapshots: { topic → value } }
 *   Leaf → ready
 *
 * After handshake, BridgeOut forwards DataBus publishes to all matching Leafs.
 */

import { crossWindowBus, type ChannelType, type PublishMeta } from "./crossWindowBus";
import { currentWindowLabel } from "../utils/tauriWindow";

// ── Wire format ──

export interface BridgeMessage {
  type: "data" | "hello" | "init" | "ready" | "ping" | "pong" | "goodbye";
  windowId?: string;
  subscriptions?: string[];
  snapshots?: Record<string, unknown>;
  topic?: string;
  payload?: unknown;
  channel?: ChannelType;
  mergeId?: number;
}

// ── Window mode detection ──

type WindowRole = "hub" | "leaf";

function detectRole(): WindowRole {
  // ⚠️ 必须用 currentWindowLabel() —— 手写路径在本版本恒为 undefined（见该工具注释）
  const label = currentWindowLabel();
  if (label.startsWith("float-")) return "leaf";
  // 聊天挂件也是 leaf —— 它没有后端 WS，全部数据靠 DataBus 从主窗镜像。
  // ⚠️ 漏判的后果很隐蔽：它会被当成 **hub**（发 hello 的那一侧），于是既拿不到
  // 镜像数据、上行命令也没人接。
  if (label.startsWith("widget-")) return "leaf";

  const hash = window.location.hash;
  if (hash.startsWith("#floating/")) return "leaf";
  if (hash.startsWith("#widget/")) return "leaf";

  return "hub";
}

function getWindowId(): string {
  // ⚠️ **这里曾是整个挂件不通的根因**：手写路径拿到 undefined → 退化成
  // `main-${Date.now()}`（每次调用都不同的假 ID）→ hub 用 emitTo(假ID) 投递时
  // Tauri 找不到窗口、静默失败 → 子窗口收不到任何数据。见 utils/tauriWindow.ts。
  return currentWindowLabel() || `main-${Date.now()}`;
}

// ── Tauri import (lazy, only in Tauri context) ──

let _tauriEmit: ((event: string, payload: unknown) => Promise<void>) | null = null;
let _tauriEmitTo: ((target: string, event: string, payload: unknown) => Promise<void>) | null = null;
let _tauriListen: ((event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>) | null = null;

async function ensureTauri(): Promise<boolean> {
  if (_tauriEmit && _tauriListen) return true;
  try {
    const mod = await import("@tauri-apps/api/event");
    _tauriEmit = mod.emit;
    _tauriEmitTo = mod.emitTo;
    _tauriListen = mod.listen;
    return true;
  } catch {
    return false;
  }
}

// ── Hub state ──

interface LeafEntry {
  windowId: string;
  subscriptions: string[];
  lastPong: number;
}

const _leafs = new Map<string, LeafEntry>();
let _hubStarted = false;
/** Leaf 启动的幂等守卫（见 startLeaf 的注释：StrictMode 会让 effect 跑两次）。 */
let _leafStart: Promise<void> | null = null;

/**
 * "本窗已作为 leaf 注册完成"（收到 hub 的 init）的回调列表。
 *
 * leaf 在 hub 侧注册（`_leafs`）**早于** init 发出，所以这个信号 = 可以安全上行请求了。
 * 见 handleLeafMessage 的 `case "init"` 注释（挂件历史回填踩过的竞态）。
 */
const _leafReadyCbs: Array<() => void> = [];
/** 是否已收到过 init（决定 onLeafReady 是"立即执行"还是"排队等信号"）。 */
let _leafReady = false;
/** init 是否已应用过（见 handleLeafMessage 的 case "init"：重复 init 必须忽略）。 */
let _initApplied = false;

// ── Subscription matching ──

function topicMatchesForBridge(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return topic === prefix || topic.startsWith(prefix + ".");
  }
  return false;
}

function shouldForwardTo(topic: string, leaf: LeafEntry): boolean {
  return leaf.subscriptions.some((pat) => topicMatchesForBridge(pat, topic));
}

// ── BridgeOut (Hub → Leafs) ──

/**
 * 挑出这条 topic 该推给哪些 leaf（按各自订阅的 pattern 匹配）。
 *
 * 抽成公开纯函数是为了**可测**：`bridgeOut` 内部依赖 Tauri 事件与模块私有的
 * leaf 表，端到端很难在单测里可靠驱动；而"发给谁"正是这里唯一有分支的逻辑。
 */
export function pickBridgeTargets(
  topic: string,
  leafs: Iterable<{ windowId: string; subscriptions: string[] }>,
): string[] {
  const out: string[] = [];
  for (const leaf of leafs) {
    if (leaf.subscriptions.some((pat) => topicMatchesForBridge(pat, topic))) {
      out.push(leaf.windowId);
    }
  }
  return out;
}

/**
 * 把 topic 推给每个订阅了它的 leaf。
 *
 * ⚠️ **必须用 `emitTo` 定向投递，不能用 `emit`**：`emit` 是**广播给所有窗口**的，
 * 而这个循环本来就对每个 leaf 各发一次 —— 一旦有 ≥2 个 leaf，每个 leaf 都会收到
 * N 份同一条消息。对 `chat.delta.text`（累加语义）而言那就是**文本重复**。
 * 这个缺陷在只有浮窗做 leaf 时很少暴露，加了常驻的聊天挂件后必然踩到。
 * （回归验证：同时开一个浮窗 + 挂件，看 AI 输出是否重复 —— 单测覆盖不到这行。）
 */
async function bridgeOut(topic: string, payload: unknown, channel: ChannelType, meta: PublishMeta): Promise<void> {
  if (!_tauriEmitTo) return;

  for (const windowId of pickBridgeTargets(topic, _leafs.values())) {
    await _tauriEmitTo(windowId, "bridge", {
      type: "data",
      topic,
      payload,
      channel,
      mergeId: meta.mergeId,
    } satisfies BridgeMessage);
  }
}

// ── Hub: handle incoming Bridge messages ──

async function handleHubMessage(msg: BridgeMessage): Promise<void> {
  switch (msg.type) {
    case "hello": {
      if (!msg.windowId || !msg.subscriptions) return;
      // Register or update the leaf
      _leafs.set(msg.windowId, {
        windowId: msg.windowId,
        subscriptions: msg.subscriptions,
        lastPong: Date.now(),
      });

      // Build init snapshot — collect all sticky values matching subscription patterns
      const allSticky = crossWindowBus.getAllSticky();
      const snapshots: Record<string, unknown> = {};
      for (const [topic, value] of Object.entries(allSticky)) {
        if (msg.subscriptions.some((pat) => topicMatchesForBridge(pat, topic))) {
          snapshots[topic] = value;
        }
      }

      // 定向投给刚注册的那个 leaf（理由同 bridgeOut：广播会让其它窗口重复应用快照）
      if (_tauriEmitTo) {
        await _tauriEmitTo(msg.windowId, "bridge", {
          type: "init",
          windowId: msg.windowId,
          snapshots,
        } satisfies BridgeMessage);
      }
      console.log(`[Bridge Hub] Leaf ${msg.windowId} registered, init with ${Object.keys(snapshots).length} snapshots`);
      break;
    }

    case "ready":
      // Leaf acknowledged init — subscription is now active
      console.log(`[Bridge Hub] Leaf ${msg.windowId} ready`);
      break;

    case "pong":
      if (msg.windowId) {
        const leaf = _leafs.get(msg.windowId);
        if (leaf) leaf.lastPong = Date.now();
      }
      break;

    case "goodbye":
      if (msg.windowId) {
        _leafs.delete(msg.windowId);
        // Also remove from layoutStore's TauriWindow registry
        import("../stores/layoutStore").then((m) => m.removeTauriWindow(msg.windowId!)).catch(() => {});
        console.log(`[Bridge Hub] Leaf ${msg.windowId} removed`);
      }
      break;

    case "data":
      // Leaf sent a command/data → re-publish locally via bridgeReceive
      if (msg.topic && msg.payload !== undefined) {
        crossWindowBus.bridgeReceive(msg.topic, msg.payload, { mergeId: msg.mergeId, fromBridge: true });
      }
      break;
  }
}

// ── Leaf: handle incoming Bridge messages ──

async function handleLeafMessage(msg: BridgeMessage): Promise<void> {
  switch (msg.type) {
    case "init": {
      if (!msg.snapshots) return;
      // ⚠️ **init 只应用一次**：StrictMode 双挂载会让 startLeaf 被调两次 → hub 收到
      // 两次 hello → 回两次 init。第二次若原样重放全部快照，对"累加型"数据
      // （chat.delta.text）就是重复追加（2026-09-22 用户看到的词内重复）。
      // state 路由有值去重能兜住一部分，但两次 init 之间数据变化时就兜不住了。
      if (_initApplied) {
        console.log("[Bridge Leaf] 重复 init，已忽略");
        return;
      }
      _initApplied = true;
      // Apply all sticky snapshots locally
      for (const [topic, value] of Object.entries(msg.snapshots)) {
        crossWindowBus.bridgeReceive(topic, value, { fromBridge: true });
      }
      // Acknowledge
      if (_tauriEmit) {
        const id = getWindowId();
        await _tauriEmit("bridge", { type: "ready", windowId: id } satisfies BridgeMessage);
      }
      console.log(`[Bridge Leaf] Init received: ${Object.keys(msg.snapshots).length} snapshots applied`);
      // 通知调用方"桥接已就绪"。
      //
      // 为什么必须有这个信号（2026-09-22 用户实测："退出挂件再进来，消息列表是空的"）：
      // hub 是在处理 `hello` 时才把本窗注册进 `_leafs` 的，而 `init` 是在**注册之后**
      // 才发出的 —— 所以收到 init 就等于"我现在能收到定向投递了"。
      // 若不等这个信号、在 mount 时就急着上行请求（如挂件的历史回填），请求可能
      // 早于 hello 被 hub 处理 → 遍历 `_leafs` 时本窗还不在 → **应答发不出去**
      // → 窗口永远收不到数据。这个竞态是间歇性的，必须靠信号消除，
      // 不能靠"加个 setTimeout 等一下"（那是拿时序赌时序）。
      _leafReady = true;
      for (const cb of _leafReadyCbs) {
        try { cb(); } catch { /* 单个回调失败不影响其它 */ }
      }
      _leafReadyCbs.length = 0; // 一次性信号，避免重复触发
      break;
    }

    case "data": {
      // Hub sent data — apply locally
      if (msg.topic && msg.payload !== undefined) {
        crossWindowBus.bridgeReceive(msg.topic, msg.payload, { mergeId: msg.mergeId, fromBridge: true });
      }
      break;
    }

    case "ping":
      // Reply with pong
      if (_tauriEmit) {
        await _tauriEmit("bridge", { type: "pong", windowId: getWindowId() } satisfies BridgeMessage);
      }
      break;
  }
}

// ── Public API ──

export const bridge = {
  /** Start Bridge as Hub (called once in main window). */
  async startHub(): Promise<void> {
    if (_hubStarted) return;
    if (!(await ensureTauri())) {
      console.warn("[Bridge Hub] Tauri unavailable — running single-window");
      return;
    }
    _hubStarted = true;

    // Listen for messages from Leaf windows
    await _tauriListen!("bridge", (event) => {
      handleHubMessage(event.payload as BridgeMessage);
    });

    // Rust emits this when a floating window is actually destroyed — the JS
    // "goodbye" from React unmount is unreliable (webview torn down on close),
    // so the Hub would otherwise keep the tauriWindows entry and recreate the
    // window on restart. Drop it immediately.
    await _tauriListen!("floating-window-closed", (event) => {
      const label = String(event.payload ?? "");
      if (label) {
        import("../stores/layoutStore").then((m) => m.removeTauriWindow(label)).catch(() => {});
      }
    });

    // Register BridgeOut hook on DataBus
    crossWindowBus.setBridgeOut(bridgeOut);

    // Heartbeat: ping all leafs every 5 seconds, cleanup stale ones
    setInterval(() => {
      bridge.sendPing();
      const dead = bridge.cleanupStaleLeafs(15000);
      for (const id of dead) {
        console.log(`[Bridge Hub] Leaf ${id} timed out — cleaned up`);
      }
    }, 5000);

    console.log("[Bridge Hub] Started");
  },

  /** Start Bridge as Leaf (called once in each sub window). */
  async startLeaf(subscriptions: string[]): Promise<void> {
    // ⚠️ **必须幂等**（与 startHub 的 `_hubStarted`、crossWindowBusLeaf 的 `_started` 同理）。
    //
    // React StrictMode 会把 effect 跑两遍（mount→unmount→mount），而这里每次都
    // `listen` 注册一个**新**监听器 → 同一份 payload 被 `handleLeafMessage` 处理两次。
    // 后果是叶子端把增量**追加两遍**：AI 回复出现"词内重复"
    // （「看起来起来起来起来」）。2026-09-22 用户实测就是这个 —— 且**浮窗同样中招**，
    // 只是没人盯着浮窗看流式输出。
    //
    // 用 promise 缓存而不是 bool：两次调用若在 `await` 处并发，bool 标志会双双通过检查。
    if (_leafStart) return _leafStart;
    _leafStart = (async () => {
      if (!(await ensureTauri())) {
        console.warn("[Bridge Leaf] Tauri unavailable");
        return;
      }

      // Listen for messages from Hub
      await _tauriListen!("bridge", (event) => {
        handleLeafMessage(event.payload as BridgeMessage);
      });

      // Subscribe to DataBus locally — commands go to Bridge
      crossWindowBus.setBridgeOut(async (topic, payload, channel, meta) => {
        if (_tauriEmit) {
          await _tauriEmit("bridge", {
            type: "data",
            topic,
            payload,
            channel,
            mergeId: meta.mergeId,
          } satisfies BridgeMessage);
        }
      });

      // Send hello
      const id = getWindowId();
      if (_tauriEmit) {
        await _tauriEmit("bridge", {
          type: "hello",
          windowId: id,
          subscriptions,
        } satisfies BridgeMessage);
      }

      console.log(`[Bridge Leaf] Connected as ${id}, subscribed: ${subscriptions.join(", ")}`);
    })();
    return _leafStart;
  },

  /**
   * 注册"桥接就绪"回调（收到 hub 的 init 时触发一次）。
   *
   * 用途：需要**上行请求**的 leaf（如聊天挂件要历史回填）必须等这个信号 ——
   * 否则请求可能跑在 hello 被 hub 处理之前，应答因"本窗尚未注册"而发不出去。
   * 见 _leafReadyCbs 的注释。
   *
   * 若 init 早已到达（回调注册晚了），会立即执行一次 —— 调用方不必关心时序。
   */
  onLeafReady(cb: () => void): void {
    if (_leafReady) {
      try { cb(); } catch { /* ignore */ }
      return;
    }
    _leafReadyCbs.push(cb);
  },

  /**
   * 重置 leaf 侧的一次性状态（**窗口关闭时必须调**）。
   *
   * 为什么必需（2026-09-22 用户实测："退出挂件再进来，消息列表是空的"）：
   * 同一个 GUI 进程内所有窗口**共享一个 WebView2 数据目录**（`EBWebView-{PID}`），
   * 子窗口关闭后模块级状态**不会**随 webview 清掉。而 `startLeaf` 有幂等守卫
   * （`_leafStart`）—— 不重置的话第二次 `startLeaf` 直接 return，**监听器与 hello
   * 全都不会再注册** → 新窗口收不到任何数据（历史、增量、状态全无）。
   *
   * ⚠️ `crossWindowBusLeaf` 的 `_started` 也要一并重置（它守着全部订阅注册）。
   */
  resetLeaf(): void {
    _leafStart = null;
    _leafReady = false;
    _leafReadyCbs.length = 0;
    _initApplied = false;
  },

  /** Get current window role. */
  getRole(): WindowRole {
    return detectRole();
  },

  /** Get window ID. */
  getWindowId(): string {
    return getWindowId();
  },

  /** Heartbeat: Hub sends ping to all Leafs. Call from Hub on a 5s interval. */
  async sendPing(): Promise<void> {
    if (!_tauriEmit) return;
    await _tauriEmit("bridge", { type: "ping" } satisfies BridgeMessage);
  },

  /**
   * Leaf 侧**自驱**心跳：窗口自己定期喂一次 pong（hub 的 pong 处理只刷 `lastPong`，
   * 不要求刚收到过 ping，所以这样是成立的）。
   *
   * 为什么需要：聊天挂件模式下**主窗被 hide**，而 Chromium 对隐藏页的 `setInterval`
   * 会节流（5 分钟后进入加强节流，约 1 分钟一次）→ hub 的「5s ping + 15s 无 pong 就
   * 清理 leaf」会把**活着的**挂件判死并从 `_leafs` 删掉 → 之后所有镜像数据都不再转发，
   * 挂件彻底静默（表现为"放着不动一会儿就不更新了"）。
   * 挂件自己是可见窗口（不被节流），由它主动喂心跳最可靠。
   */
  async selfPong(): Promise<void> {
    if (!_tauriEmit) return;
    await _tauriEmit("bridge", { type: "pong", windowId: getWindowId() } satisfies BridgeMessage);
  },

  /** Cleanup leafs that haven't ponged within timeout (ms). Returns dead window IDs. */
  cleanupStaleLeafs(timeoutMs: number = 15000): string[] {
    const now = Date.now();
    const dead: string[] = [];
    for (const [id, leaf] of _leafs) {
      if (now - leaf.lastPong > timeoutMs) {
        dead.push(id);
        _leafs.delete(id);
      }
    }
    // Clean up corresponding TauriWindow registry entries
    for (const id of dead) {
      import("../stores/layoutStore").then((m) => m.removeTauriWindow(id)).catch(() => {});
    }
    return dead;
  },

  /** Send goodbye from Leaf (called on window close). */
  async sendGoodbye(): Promise<void> {
    if (!_tauriEmit) return;
    await _tauriEmit("bridge", { type: "goodbye", windowId: getWindowId() } satisfies BridgeMessage);
  },

  /** Leaf count (for testing/debugging). */
  leafCount(): number {
    return _leafs.size;
  },

  /** For testing: reset all state. */
  _reset(): void {
    _leafs.clear();
    _hubStarted = false;
    crossWindowBus._reset();
  },
};
