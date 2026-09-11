/**
 * Spawns `claude-ide.cmd` (Windows) or `claude-ide` (Unix) and connects via
 * WebSocket for messaging. The script is self-contained — it knows how to
 * launch Claude Code in IDE mode.
 */
import { EventEmitter } from 'events';
import type { IncomingMessage, OutgoingMessage } from './protocol';
export interface ProcessManagerOptions {
    /** Absolute path to claude-ide.cmd (Windows) or claude-ide (Unix) */
    scriptPath: string;
    /** Workspace directory to use as the working directory for Claude Code */
    workspacePath?: string;
}
export declare class ProcessManager extends EventEmitter {
    private process;
    private ws;
    private wsUrl;
    private options;
    private restartCount;
    private restartDelay;
    private started;
    private intentionalRestart;
    private outgoingQueue;
    constructor(options: ProcessManagerOptions);
    start(): void;
    stop(): void;
    send(message: OutgoingMessage): void;
    isConnected(): boolean;
    resetRestartCount(): void;
    /** Kill current process and restart with fresh env (used for profile switching) */
    restart(): void;
    private spawnProcess;
    private connectWebSocket;
}
export type { IncomingMessage, OutgoingMessage };
//# sourceMappingURL=processManager.d.ts.map