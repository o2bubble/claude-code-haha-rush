// ── EventBus — typed pub/sub ──

type EventHandler = (data: any) => void;

interface StickyEntry {
  data: any;
  sticky: boolean;
}

class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private sticky = new Map<string, StickyEntry>();

  /** Subscribe to an event. Returns unsubscribe function. */
  on(event: string, handler: EventHandler): () => void {
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

  /** Emit an event. If opts.sticky, new subscribers will immediately receive the latest value. */
  emit(event: string, data?: any, opts?: { sticky?: boolean }): void {
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
  clearSticky(event: string): void {
    this.sticky.delete(event);
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

export const eventBus = new EventBus();
export const commands = new CommandRegistry();
