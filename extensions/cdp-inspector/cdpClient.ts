/**
 * CDP (Chrome DevTools Protocol) client for connecting to a running Chrome/Edge
 * instance with --remote-debugging-port=9222.
 *
 * Uses Bun's built-in WebSocket and fetch — no additional dependencies needed.
 */

const CDP_HOST = process.env.CDP_HOST || 'http://localhost:9222';
const MAX_CONSOLE_BUFFER = 1000;

export interface PageInfo {
  id: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

export interface ConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
}

export interface NetworkEntry {
  requestId: string;
  method: string;
  url: string;
  status: number | null;
  statusText: string | null;
  mimeType: string | null;
  startTime: number;
  endTime: number | null;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function formatRemoteObject(obj: Record<string, unknown>): string {
  if (obj.type === 'object') {
    if (obj.value !== undefined && obj.value !== null) {
      try {
        return JSON.stringify(obj.value);
      } catch {
        return (obj.description as string) || '[Object]';
      }
    }
    return (obj.description as string) || '[Object]';
  }
  if (obj.type === 'function' || obj.type === 'symbol') {
    return (obj.description as string) || `[${obj.type}]`;
  }
  if (obj.type === 'undefined') return 'undefined';
  if (obj.type === 'null') return 'null';
  return String(obj.value ?? obj.description ?? '');
}

export class CdpConnection {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private consoleBuffer: ConsoleEntry[] = [];
  private networkBuffer: NetworkEntry[] = [];
  private pendingRequests = new Map<string, NetworkEntry>();
  private connected = false;
  currentPageId: string | null = null;

  async listPages(): Promise<PageInfo[]> {
    try {
      const resp = await fetch(`${CDP_HOST}/json`);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const pages = (await resp.json()) as Array<Record<string, unknown>>;
      return pages
        .filter((p) => p.type === 'page')
        .map((p) => ({
          id: p.id as string,
          url: p.url as string,
          title: p.title as string,
          webSocketDebuggerUrl: p.webSocketDebuggerUrl as string,
        }));
    } catch (err) {
      throw new Error(
        `Cannot connect to browser at ${CDP_HOST}. ` +
          `Make sure Chrome/Edge is running with '--remote-debugging-port=9222'. ` +
          `Example: chrome.exe --remote-debugging-port=9222`,
      );
    }
  }

  async connect(pageId?: string): Promise<PageInfo> {
    // Already connected to the requested page — reuse it
    if (pageId && this.connected && this.currentPageId === pageId && this.ws) {
      const pages = await this.listPages();
      const match = pages.find((p) => p.id === pageId);
      if (match) return match;
    }

    this.disconnect();

    const pages = await this.listPages();
    if (pages.length === 0) {
      throw new Error(
        'No open pages/tabs found. Open a web page in the browser first, then try again.',
      );
    }

    const target = pageId ? pages.find((p) => p.id === pageId) : pages[0];

    if (!target) {
      const ids = pages.map((p) => p.id).join(', ');
      throw new Error(
        `Page '${pageId}' not found. Available page IDs: [${ids}]`,
      );
    }

    this.currentPageId = target.id;

    // Shared message handler
    const onMessage = (event: MessageEvent): void => {
      const msg = JSON.parse(event.data as string) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { message?: string };
      };

      if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          resolve(msg.result);
        }
      } else if (msg.method) {
        this.handleEvent(msg.method, msg.params || {});
      }
    };

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener(
        'error',
        () => reject(new Error('WebSocket connection failed to browser')),
        { once: true },
      );
      ws.addEventListener('message', onMessage);

      // If the WebSocket dies after connecting, reject anything still pending
      ws.addEventListener('close', () => {
        if (this.connected) {
          this.connected = false;
          this.ws = null;
          this.currentPageId = null;
          for (const [, { reject: r }] of this.pending) {
            r(new Error('WebSocket closed by browser'));
          }
          this.pending.clear();
        }
      });
      ws.addEventListener('error', () => {
        if (this.connected) {
          this.connected = false;
          this.ws = null;
          this.currentPageId = null;
          for (const [, { reject: r }] of this.pending) {
            r(new Error('WebSocket error'));
          }
          this.pending.clear();
        }
      });

      this.ws = ws;
    });

    // Mark as connected before sending CDP commands (cmd() checks this flag)
    this.connected = true;

    // Enable required CDP domains
    await this.cmd('DOM.enable');
    await this.cmd('CSS.enable');
    await this.cmd('Runtime.enable');
    await this.cmd('Log.enable');
    // Re-enable network on every connect (buffer is cleared)
    this.networkBuffer = [];
    this.pendingRequests.clear();
    await this.cmd('Network.enable');

    return target;
  }

  /**
   * Send a CDP command and wait for the response.
   * Rejects with a timeout error if the browser doesn't reply in time.
   */
  cmd(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (!this.connected || !this.ws) {
      return Promise.reject(new Error('Not connected to browser. Call connect() first.'));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      });
      this.ws!.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  private handleEvent(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Runtime.consoleAPICalled':
        this.onConsoleMessage(params);
        break;
      case 'Runtime.exceptionThrown':
        this.onException(params);
        break;
      case 'Log.entryAdded':
        this.onLogEntry(params);
        break;
      case 'Network.requestWillBeSent':
        this.onNetworkRequest(params);
        break;
      case 'Network.responseReceived':
        this.onNetworkResponse(params);
        break;
      case 'Network.loadingFinished':
        this.onNetworkFinished(params);
        break;
      case 'Network.requestFailed':
        this.onNetworkFailed(params);
        break;
    }
  }

  private onConsoleMessage(params: Record<string, unknown>): void {
    const type = (params.type as string) || 'log';
    const args = (params.args as Array<Record<string, unknown>>) || [];
    const timestamp = (params.timestamp as number) || Date.now();

    const text = args.map((a) => formatRemoteObject(a)).join(' ');

    this.pushConsole({ type, text, timestamp });
  }

  private onException(params: Record<string, unknown>): void {
    const details = params.exceptionDetails as Record<string, unknown> | undefined;
    const text =
      (details?.text as string) ||
      (details?.exception as Record<string, unknown>)?.description as string ||
      'Uncaught exception';

    this.pushConsole({
      type: 'error',
      text: `[Exception] ${text}`,
      timestamp: Date.now(),
    });
  }

  private onLogEntry(params: Record<string, unknown>): void {
    const entry = params.entry as Record<string, unknown> | undefined;
    if (!entry) return;

    // Skip console.* entries — already captured by Runtime.consoleAPICalled
    const source = entry.source as string;
    if (
      source === 'network' ||
      source === 'deprecation' ||
      source === 'intervention' ||
      source === 'recommendation' ||
      source === 'violation'
    ) {
      this.pushConsole({
        type: (entry.level as string) || 'info',
        text: `[${source}] ${entry.text}`,
        timestamp: (entry.timestamp as number) || Date.now(),
      });
    }
  }

  private pushConsole(entry: ConsoleEntry): void {
    this.consoleBuffer.push(entry);
    if (this.consoleBuffer.length > MAX_CONSOLE_BUFFER) {
      this.consoleBuffer.shift();
    }
  }

  // ── Network tracking ────────────────────────────────────────────────────

  private onNetworkRequest(params: Record<string, unknown>): void {
    const req = params.request as Record<string, unknown> | undefined;
    const requestId = params.requestId as string;
    const url = (req?.url as string) || '';
    const method = (req?.method as string) || '';

    // Skip data: URIs and blob URIs
    if (url.startsWith('data:') || url.startsWith('blob:')) return;

    const entry: NetworkEntry = {
      requestId,
      method,
      url,
      status: null,
      statusText: null,
      mimeType: null,
      startTime: Date.now(),
      endTime: null,
    };
    this.pendingRequests.set(requestId, entry);
    this.networkBuffer.push(entry);
  }

  private onNetworkResponse(params: Record<string, unknown>): void {
    const response = params.response as Record<string, unknown> | undefined;
    if (!response) return;
    const requestId = params.requestId as string;
    const existing = this.pendingRequests.get(requestId);
    if (existing) {
      existing.status = (response.status as number) || 0;
      existing.statusText = (response.statusText as string) || '';
      existing.mimeType = (response.mimeType as string) || null;
    }
  }

  private onNetworkFinished(params: Record<string, unknown>): void {
    const requestId = params.requestId as string;
    const existing = this.pendingRequests.get(requestId);
    if (existing) {
      existing.endTime = Date.now();
      this.pendingRequests.delete(requestId);
    }
  }

  private onNetworkFailed(params: Record<string, unknown>): void {
    const requestId = params.requestId as string;
    const existing = this.pendingRequests.get(requestId);
    if (existing) {
      existing.endTime = Date.now();
      existing.status = 0;
      existing.statusText = (params.errorText as string) || 'Failed';
      this.pendingRequests.delete(requestId);
    }
  }

  getNetworkLogs(limit?: number): NetworkEntry[] {
    const entries = [...this.networkBuffer];
    if (limit && limit > 0) {
      return entries.slice(-Math.min(limit, entries.length));
    }
    return entries;
  }

  getConsoleLogs(limit?: number): ConsoleEntry[] {
    if (!limit || limit <= 0) return [...this.consoleBuffer];
    return this.consoleBuffer.slice(-Math.min(limit, this.consoleBuffer.length));
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.currentPageId = null;

    // Reject all pending requests
    for (const [, { reject }] of this.pending) {
      reject(new Error('Connection closed'));
    }
    this.pending.clear();
  }

  isConnected(): boolean {
    return this.connected && this.ws !== null;
  }
}

/** Singleton — one active browser connection at a time. */
export const cdp = new CdpConnection();
