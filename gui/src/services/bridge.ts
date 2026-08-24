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

import { dataBus, type ChannelType, type PublishMeta } from "./dataBus";

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
  const label = (window as any).__TAURI_INTERNALS__?.webview?.label || "";
  if (label.startsWith("float-")) return "leaf";

  const hash = window.location.hash;
  if (hash.startsWith("#floating/")) return "leaf";

  return "hub";
}

function getWindowId(): string {
  return (window as any).__TAURI_INTERNALS__?.webview?.label || `main-${Date.now()}`;
}

// ── Tauri import (lazy, only in Tauri context) ──

let _tauriEmit: ((event: string, payload: unknown) => Promise<void>) | null = null;
let _tauriListen: ((event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>) | null = null;

async function ensureTauri(): Promise<boolean> {
  if (_tauriEmit && _tauriListen) return true;
  try {
    const mod = await import("@tauri-apps/api/event");
    _tauriEmit = mod.emit;
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

// ── BridgeOut (Hub → all Leafs) ──

async function bridgeOut(topic: string, payload: unknown, channel: ChannelType, meta: PublishMeta): Promise<void> {
  if (!_tauriEmit) return;

  for (const leaf of _leafs.values()) {
    if (!shouldForwardTo(topic, leaf)) continue;
    await _tauriEmit("bridge", {
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
      const allSticky = dataBus.getAllSticky();
      const snapshots: Record<string, unknown> = {};
      for (const [topic, value] of Object.entries(allSticky)) {
        if (msg.subscriptions.some((pat) => topicMatchesForBridge(pat, topic))) {
          snapshots[topic] = value;
        }
      }

      if (_tauriEmit) {
        await _tauriEmit("bridge", {
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
        dataBus.bridgeReceive(msg.topic, msg.payload, { mergeId: msg.mergeId, fromBridge: true });
      }
      break;
  }
}

// ── Leaf: handle incoming Bridge messages ──

async function handleLeafMessage(msg: BridgeMessage): Promise<void> {
  switch (msg.type) {
    case "init": {
      if (!msg.snapshots) return;
      // Apply all sticky snapshots locally
      for (const [topic, value] of Object.entries(msg.snapshots)) {
        dataBus.bridgeReceive(topic, value, { fromBridge: true });
      }
      // Acknowledge
      if (_tauriEmit) {
        const id = getWindowId();
        await _tauriEmit("bridge", { type: "ready", windowId: id } satisfies BridgeMessage);
      }
      console.log(`[Bridge Leaf] Init received: ${Object.keys(msg.snapshots).length} snapshots applied`);
      break;
    }

    case "data": {
      // Hub sent data — apply locally
      if (msg.topic && msg.payload !== undefined) {
        dataBus.bridgeReceive(msg.topic, msg.payload, { mergeId: msg.mergeId, fromBridge: true });
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
    dataBus.setBridgeOut(bridgeOut);

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

  /** Start Bridge as Leaf (called once in each floating window). */
  async startLeaf(subscriptions: string[]): Promise<void> {
    if (!(await ensureTauri())) {
      console.warn("[Bridge Leaf] Tauri unavailable");
      return;
    }

    // Listen for messages from Hub
    await _tauriListen!("bridge", (event) => {
      handleLeafMessage(event.payload as BridgeMessage);
    });

    // Subscribe to DataBus locally — commands go to Bridge
    dataBus.setBridgeOut(async (topic, payload, channel, meta) => {
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
    dataBus._reset();
  },
};
