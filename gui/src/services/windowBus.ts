// ── EventBus — typed pub/sub ──

import { Events } from "./events";

/** 事件名的值类型（Events 枚举的值联合，如 "chat.stateChanged" | "settings.changed" ...） */
type EventName = (typeof Events)[keyof typeof Events];
type EventHandler = (data: any) => void;

interface StickyEntry {
  data: any;
  sticky: boolean;
}

class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private sticky = new Map<string, StickyEntry>();

  /** Subscribe to an event. Returns unsubscribe function. */
  on(event: EventName, handler: EventHandler): () => void {
    return this.onRaw(event, handler);
  }

  /**
   * Raw subscribe — 接受任意 string topic。T0 的类型收窄只保护内置事件名
   * (错拼 Events 枚举仍编译报错); 插件动态 topic (`plugin.<name>.*`) 无法进
   * Events 枚举, 走此通道——命名空间由 `plugin.` 前缀约定隔离(与 FloatingApp
   * 的跨窗 `plugin.*` 订阅同源一致)。
   */
  onRaw(event: string, handler: EventHandler): () => void {
    let set = this.handlers.get(event);
    if (!set) { set = new Set(); this.handlers.set(event, set); }
    set.add(handler);

    // Replay sticky value immediately
    const s = this.sticky.get(event);
    if (s) {
      try { handler(s.data); } catch {}
    }

    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.handlers.delete(event);
    };
  }

  /** Emit an event. If opts.sticky, new subscribers will immediately receive the latest value.
   *  opts.origin 标记来源（"app"=内置 / 插件名=插件）——为插件系统区分"谁发的"留位。 */
  emit(event: EventName, data?: any, opts?: { sticky?: boolean; origin?: string }): void {
    this.emitRaw(event, data, opts);
  }

  /** Raw emit — 任意 string topic(插件命名空间 plugin.*)。语义同 emit。 */
  emitRaw(event: string, data?: any, opts?: { sticky?: boolean; origin?: string }): void {
    if (opts?.sticky) {
      this.sticky.set(event, { data, sticky: true });
    }
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of set) {
      try { h(data); } catch {}
    }
  }

  /** Remove sticky value (e.g. when backend goes down) */
  clearSticky(event: EventName): void {
    this.sticky.delete(event);
  }

  /** Whether a sticky value exists — e.g. WORKSPACE_BOUND fired in this window
   *  (= a workspace is bound). Unlike a module flag this survives any consumer
   *  ordering, since sticky is set at emit time. */
  hasSticky(event: EventName): boolean {
    return this.sticky.has(event);
  }
}

// ── CommandRegistry — cross-panel actions ──

type CommandHandler = (...args: any[]) => void;

class CommandRegistry {
  private handlers = new Map<string, CommandHandler>();

  /** Register a command handler. Returns unregister function. Last registration wins for same command name. */
  register(command: string, handler: CommandHandler): () => void {
    this.handlers.set(command, handler);
    return () => {
      if (this.handlers.get(command) === handler) {
        this.handlers.delete(command);
      }
    };
  }

  /** Execute a command. Silent no-op if no handler registered. */
  execute(command: string, ...args: any[]): void {
    const h = this.handlers.get(command);
    if (h) {
      try { h(...args); } catch (e) { console.error(`[CommandRegistry] ${command}:`, e); }
    }
  }
}

// ── Module-level singletons ──

export const windowBus = new EventBus();
export const commandRegistry = new CommandRegistry();
