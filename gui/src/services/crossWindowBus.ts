/**
 * DataBus — Unified publish/subscribe bus for multi-window data flow.
 *
 * All components use the same API regardless of whether they run in
 * the Hub (main) window or a Leaf (child) window. Under the hood,
 * topics are auto-routed to one of four channels:
 *   Stream  — high-frequency deltas, RAF-batched
 *   State   — sticky snapshots, deduped (same value skipped)
 *   Bulk    — large one-shot payloads (session history, file content)
 *   Command — Leaf → Hub actions (send, interrupt, etc.)
 *
 * Single-window mode: publish → local subscribers (no IPC overhead).
 * Multi-window mode: Bridge calls bridgeReceive(), which re-publishes locally.
 */

// ── Types ──

export type ChannelType = "stream" | "state" | "bulk" | "command";

export type MergeStrategy = "concat-text" | "last-wins";

export interface RouteRule {
  channel: ChannelType;
  /** Prefix match. "chat.delta" matches "chat.delta.text", "chat.delta.thinking", etc. */
  prefix?: string;
  /** Exact topic match. */
  topic?: string;
  merge?: MergeStrategy;
  /** Sticky topics cache the latest value and replay to new subscribers. */
  sticky?: boolean;
}

export interface PublishMeta {
  /** Globally monotonic merge ID, assigned by Hub. */
  mergeId?: number;
  /** True when this publish originates from a remote Bridge. */
  fromBridge?: boolean;
  /** The topic being published. */
  topic?: string;
  /** 来源标识——区分内置("app") vs 插件贡献的发布。插件系统用它区分"谁发的"。 */
  origin?: string;
}

export type DataHandler = (payload: unknown, meta: PublishMeta) => void;

export type Unsubscribe = () => void;

interface QueuedDelta {
  topic: string;
  merge: MergeStrategy;
  payload: Record<string, unknown>;
}

// ── Topic Route Table ──

const ROUTES: RouteRule[] = [
  // Stream — high-frequency deltas
  { prefix: "chat.delta.text", channel: "stream", merge: "concat-text" },
  { prefix: "chat.delta.thinking", channel: "stream", merge: "concat-text" },
  { prefix: "terminal.delta", channel: "stream", merge: "last-wins" },
  { channel: "stream", merge: "last-wins", topic: "chat.context" },  // eslint-disable-line object-shorthand

  // Command — Leaf → Hub actions
  { prefix: "cmd.", channel: "command" },

  // Bulk — large one-shot payloads
  { channel: "bulk", topic: "chat.session.loaded" },   // eslint-disable-line object-shorthand
  // 挂件的历史回填应答（含最近 N 条消息，量可能不小 → bulk：立即发、不合并、不进 sticky）
  { channel: "bulk", topic: "widget.history" },        // eslint-disable-line object-shorthand

  // Everything else → State (default)
];

// Sticky topics replay the last value to new subscribers.
const STICKY_TOPICS = new Set([
  "chat.message", "chat.streaming", "chat.connected", "chat.context",
  "chat.model", "chat.sessions", "chat.activeSession", "chat.tasks",
  "chat.slashCommands", "chat.inputBlocked", "chat.skills.dialog",
  "chat.sessionsLoaded",
  "terminal.output",
  "plan.tasks",
  "subagents.list",
  "editor.tabs", "editor.activePath",
  "files.changed",
  "desktop.list", "desktop.items",
  "settings",
  "workers.status",
  "layout.mode",
]);

// ── Internal State ──

const _subscribers = new Map<string, Set<DataHandler>>();
const _stickyCache = new Map<string, { payload: unknown; mergeId?: number }>();
let _mergeIdCounter = 0;
let _externalPub: ((topic: string, payload: unknown, channel: ChannelType, meta: PublishMeta) => void) | null = null;

// ── Stream RAF Buffer ──

const _streamBuffer = new Map<string, QueuedDelta>();
let _streamPending = false;

function flushStream(): void {
  _streamPending = false;
  if (_streamBuffer.size === 0) return;

  const batch = Array.from(_streamBuffer.values());
  _streamBuffer.clear();

  for (const item of batch) {
    // Publish locally
    emitLocal(item.topic, item.payload, { mergeId: ++_mergeIdCounter, topic: item.topic });

    // Bridge out — each merged delta as a single bridge message
    if (_externalPub) {
      _externalPub(item.topic, item.payload, "stream", { mergeId: _mergeIdCounter });
    }
  }
}

function scheduleStreamFlush(): void {
  if (!_streamPending) {
    _streamPending = true;
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(flushStream);
    } else {
      // Fallback for non-browser environments
      setTimeout(flushStream, 16);
    }
  }
}

function applyStreamMerge(topic: string, merge: MergeStrategy, payload: Record<string, unknown>): void {
  const existing = _streamBuffer.get(topic);
  if (!existing) {
    _streamBuffer.set(topic, { topic, merge, payload: { ...payload } });
    scheduleStreamFlush();
    return;
  }

  switch (merge) {
    case "concat-text": {
      const prevText = (existing.payload.text as string) || "";
      const newText = (payload.text as string) || "";
      existing.payload.text = prevText + newText;
      if (typeof payload.index === "number") {
        existing.payload.index = payload.index;
      }
      break;
    }
    case "last-wins":
      existing.payload = { ...payload };
      break;
  }
}

// ── Channel Routing ──

function resolveChannel(topic: string): { channel: ChannelType; merge?: MergeStrategy; sticky: boolean } {
  for (const rule of ROUTES) {
    if (rule.topic && rule.topic === topic) {
      return { channel: rule.channel, merge: rule.merge, sticky: STICKY_TOPICS.has(topic) };
    }
    if (rule.prefix && topic.startsWith(rule.prefix)) {
      return { channel: rule.channel, merge: rule.merge, sticky: STICKY_TOPICS.has(topic) };
    }
  }
  // Default: state channel
  return { channel: "state", sticky: STICKY_TOPICS.has(topic) };
}

// ── Subscription Matching ──

function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return topic === prefix || topic.startsWith(prefix + ".");
  }
  return false;
}

// ── Publish / Subscribe ──

function emitLocal(topic: string, payload: unknown, meta: PublishMeta): void {
  for (const [pattern, handlers] of _subscribers) {
    if (topicMatches(pattern, topic)) {
      for (const fn of handlers) {
        try { fn(payload, meta); } catch { /* isolate handler errors */ }
      }
    }
  }
}

export const crossWindowBus = {
  /**
   * Subscribe to a topic. Supports wildcards:
   *   "chat.*"    → matches chat.message, chat.delta, chat.delta.text, etc.
   *   "chat.delta.*" → matches chat.delta.text, chat.delta.thinking, etc.
   *
   * Returns an unsubscribe function. Sticky topics immediately replay
   * the last published value (if any).
   */
  subscribe(topic: string, handler: DataHandler): Unsubscribe {
    let set = _subscribers.get(topic);
    if (!set) {
      set = new Set();
      _subscribers.set(topic, set);
    }
    set.add(handler);

    // Replay sticky value for exact-match or prefix subscriptions
    for (const [stickyTopic, cached] of _stickyCache) {
      if (topicMatches(topic, stickyTopic)) {
        handler(cached.payload, { mergeId: cached.mergeId, fromBridge: false });
      }
    }

    return () => {
      set?.delete(handler);
      if (set?.size === 0) _subscribers.delete(topic);
    };
  },

  /**
   * Publish data to a topic. The channel is auto-determined from the topic name.
   *
   * Stream topics are RAF-batched — multiple publishes in the same frame
   * are merged before delivery. State topics skip re-delivery if the value
   * hasn't changed. Command topics are forwarded to the Bridge.
   */
  publish(topic: string, payload: unknown, opts?: { sticky?: boolean; origin?: string }): void {
    const route = resolveChannel(topic);
    const sticky = opts?.sticky ?? route.sticky;
    const meta: PublishMeta = { mergeId: ++_mergeIdCounter, topic, ...(opts?.origin ? { origin: opts.origin } : {}) };

    switch (route.channel) {
      case "stream":
        if (route.merge) {
          applyStreamMerge(topic, route.merge, payload as Record<string, unknown>);
        } else {
          // No merge strategy → send immediately (shouldn't normally happen)
          emitLocal(topic, payload, meta);
          if (_externalPub) _externalPub(topic, payload, "stream", meta);
        }
        break;

      case "command":
        // Commands always go through Bridge (Leaf→Hub), then local
        if (_externalPub) {
          _externalPub(topic, payload, "command", meta);
        }
        // Also deliver locally so the sender can update UI optimistically
        emitLocal(topic, payload, meta);
        break;

      case "bulk":
        // Bulk: send immediately, no batching
        if (_externalPub) {
          _externalPub(topic, payload, "bulk", meta);
        }
        emitLocal(topic, payload, meta);
        break;

      case "state":
      default:
        // State: dedup by value (shallow compare on JSON)
        const cached = _stickyCache.get(topic);
        if (cached) {
          const prev = JSON.stringify(cached.payload);
          const next = JSON.stringify(payload);
          if (prev === next) return; // skip identical value
        }
        if (sticky) _stickyCache.set(topic, { payload, mergeId: meta.mergeId });
        emitLocal(topic, payload, meta);
        if (_externalPub) _externalPub(topic, payload, "state", meta);
        break;
    }
  },

  /**
   * Get the last sticky value for a topic, or undefined.
   */
  getSticky(topic: string): unknown {
    return _stickyCache.get(topic)?.payload;
  },

  /**
   * Get all sticky values (used for init snapshot in Bridge handshake).
   */
  getAllSticky(): Record<string, unknown> {
    const snap: Record<string, unknown> = {};
    for (const [topic, cached] of _stickyCache) {
      snap[topic] = cached.payload;
    }
    return snap;
  },

  /**
   * Receive data from a remote Bridge (Hub→Leaf or Leaf→Hub).
   * Re-publishes locally without re-triggering Bridge output (no echo).
   */
  bridgeReceive(topic: string, payload: unknown, meta: PublishMeta = {}): void {
    const route = resolveChannel(topic);
    const sticky = route.sticky;

    // State dedup — same logic as publish()
    if (route.channel === "state") {
      const cached = _stickyCache.get(topic);
      if (cached) {
        const prev = JSON.stringify(cached.payload);
        const next = JSON.stringify(payload);
        if (prev === next) return; // skip identical value
      }
    }

    if (sticky) {
      _stickyCache.set(topic, { payload, mergeId: meta.mergeId });
    }

    // Forward to local handlers (commands and data both deliver locally)
    emitLocal(topic, payload, { ...meta, fromBridge: true, topic });
  },

  /**
   * Register a hook that fires when data should be sent to remote windows.
   * The Bridge layer calls this once to connect Tauri events.
   */
  setBridgeOut(
    fn: ((topic: string, payload: unknown, channel: ChannelType, meta: PublishMeta) => void) | null,
  ): void {
    _externalPub = fn;
  },

  /** The next merge ID, for external use. */
  nextMergeId(): number {
    return ++_mergeIdCounter;
  },

  /** Current merge ID counter (for testing). */
  _getMergeIdCounter(): number {
    return _mergeIdCounter;
  },

  /** Flush the stream buffer immediately (for testing / teardown). */
  flush(): void {
    flushStream();
  },

  /** For testing: clear all state. */
  _reset(): void {
    _subscribers.clear();
    _stickyCache.clear();
    _streamBuffer.clear();
    _streamPending = false;
    _mergeIdCounter = 0;
    _externalPub = null;
  },
};
