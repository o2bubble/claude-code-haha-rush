"use strict";
/**
 * Spawns `claude-ide.cmd` (Windows) or `claude-ide` (Unix) and connects via
 * WebSocket for messaging. The script is self-contained — it knows how to
 * launch Claude Code in IDE mode.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProcessManager = void 0;
const child_process_1 = require("child_process");
const events_1 = require("events");
const path = __importStar(require("path"));
const protocol_1 = require("./protocol");
const MAX_RESTARTS = 5;
const INITIAL_RESTART_DELAY_MS = 2000;
const MAX_RESTART_DELAY_MS = 30000;
class ProcessManager extends events_1.EventEmitter {
    process = null;
    ws = null;
    wsUrl = null;
    options;
    restartCount = 0;
    restartDelay = INITIAL_RESTART_DELAY_MS;
    started = false;
    intentionalRestart = false;
    outgoingQueue = [];
    constructor(options) {
        super();
        this.options = options;
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        this.spawnProcess();
    }
    stop() {
        this.started = false;
        this.restartCount = 0;
        this.restartDelay = INITIAL_RESTART_DELAY_MS;
        if (this.ws) {
            this.ws.close(1000, 'Extension deactivated');
            this.ws = null;
            this.wsUrl = null;
        }
        if (this.process) {
            this.process.stdin?.end();
            const isWindows = process.platform === 'win32';
            if (isWindows && this.process.pid) {
                // spawnSync blocks until taskkill completes — critical during VS Code
                // shutdown. With async spawn, VS Code may exit before taskkill finishes,
                // leaving zombie bun processes.
                (0, child_process_1.spawnSync)('taskkill', ['/F', '/T', '/PID', String(this.process.pid)], {
                    stdio: 'ignore',
                    timeout: 10000, // 10s max wait
                });
            }
            else {
                this.process.kill('SIGTERM');
                // Synchronous kill on Unix: try SIGTERM, wait 3s, then SIGKILL
                try {
                    setTimeout(() => this.process?.kill('SIGKILL'), 3000);
                }
                catch { }
            }
            this.process = null;
        }
    }
    send(message) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            if (this.outgoingQueue.length < 50) {
                this.outgoingQueue.push(message);
            }
            else {
                this.emit('log', `[processManager] Outgoing queue full (50), dropping message: ${message.type}`);
            }
            return;
        }
        this.ws.send(JSON.stringify(message));
    }
    isConnected() {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }
    resetRestartCount() {
        this.restartCount = 0;
        this.restartDelay = INITIAL_RESTART_DELAY_MS;
    }
    /** Kill current process and restart with fresh env (used for profile switching) */
    restart() {
        this.resetRestartCount();
        this.intentionalRestart = true;
        if (this.ws) {
            this.ws.close(1000, 'Profile switch restart');
            this.ws = null;
            this.wsUrl = null;
        }
        if (this.process) {
            const oldProcess = this.process;
            oldProcess.stdin?.end();
            const isWindows = process.platform === 'win32';
            if (isWindows && oldProcess.pid) {
                (0, child_process_1.spawnSync)('taskkill', ['/F', '/T', '/PID', String(oldProcess.pid)], {
                    stdio: 'ignore',
                    timeout: 10000,
                });
            }
            else {
                oldProcess.kill('SIGTERM');
                try {
                    setTimeout(() => oldProcess?.kill('SIGKILL'), 3000);
                }
                catch { }
            }
            this.process = null;
        }
        this.emit('status', { status: 'restarting' });
        // Spawn a new process — will pick up updated process.env
        setTimeout(() => {
            this.intentionalRestart = false;
            this.spawnProcess();
        }, 500);
    }
    // ====================================================================
    // Internal
    // ====================================================================
    spawnProcess() {
        const scriptPath = this.options.scriptPath;
        // bunfig.toml with preload must be in cwd for Bun to auto-preload
        const repoRoot = path.dirname(path.dirname(scriptPath));
        const isWindows = process.platform === 'win32';
        const isCmd = scriptPath.endsWith('.cmd') || scriptPath.endsWith('.bat');
        // Command construction:
        // - Windows .cmd/.bat: use shell:true (Node wraps in cmd.exe /d /s /c).
        //   Pre-quote paths to handle spaces, since shell:true doesn't quote
        //   individual args.
        // - Windows .ps1:      run pwsh.exe directly (args array — no quoting needed)
        // - Unix:              run bash directly (args array — no quoting needed)
        let command;
        let args;
        if (isWindows && isCmd) {
            // Pre-quote paths for shell:true — Node wraps everything in outer "
            // for /s /c, but doesn't quote individual args, so paths with spaces
            // end up unquoted after cmd.exe strips the outer quotes.
            // Result: cmd.exe /d /s /c ""D:\path\with\spaces\claude-ide.cmd" --cwd "d:\workspace""
            // Cmd.exe /s strips first+last ": "D:\...\claude-ide.cmd" --cwd "d:\workspace""
            command = `"${scriptPath}"`;
            args = [];
            if (this.options.workspacePath) {
                args.push('--cwd', `"${this.options.workspacePath}"`);
            }
        }
        else if (isWindows) {
            command = 'pwsh.exe';
            args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
            if (this.options.workspacePath) {
                args.push('--cwd', this.options.workspacePath);
            }
        }
        else {
            command = 'bash';
            args = [scriptPath];
            if (this.options.workspacePath) {
                args.push('--cwd', this.options.workspacePath);
            }
        }
        this.emit('status', { status: 'starting' });
        this.emit('log', `Starting: ${command} ${args.join(' ')} (cwd: ${repoRoot})`);
        const proc = (0, child_process_1.spawn)(command, args, {
            cwd: repoRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: isWindows && isCmd,
            env: { ...process.env },
        });
        this.process = proc;
        // Discover WebSocket port from stdout
        let portBuffer = '';
        const portTimeout = setTimeout(() => {
            if (!this.wsUrl) {
                this.emit('error', new Error('Claude Code did not start within 30s. Check claudeCode.cliPath config.'));
            }
        }, 30_000);
        proc.stdout?.on('data', (chunk) => {
            const text = chunk.toString();
            portBuffer += text;
            const match = portBuffer.match(/CLAUDE_CODE_IDE_PORT=(\d+)/);
            if (match) {
                clearTimeout(portTimeout);
                this.wsUrl = `ws://127.0.0.1:${parseInt(match[1], 10)}`;
                portBuffer = '';
                this.connectWebSocket();
            }
        });
        proc.stderr?.on('data', (chunk) => {
            this.emit('log', chunk.toString().trim());
        });
        proc.on('exit', (code, signal) => {
            // Ignore stale exit events from old processes killed by restart()
            // After restart() sets this.process = null and spawnProcess()
            // assigns a new process, old exit handlers must not interfere.
            if (this.process !== proc)
                return;
            this.emit('status', { status: 'exited', code, signal });
            this.process = null;
            // Ensure no grandchildren survived. On Windows, taskkill /T is a
            // belt-and-suspenders safety net — cmd.exe /c should have waited
            // for the full chain, but rare edge cases (external kill signals,
            // detached child processes) can leave orphans.
            const isWindows = process.platform === 'win32';
            if (isWindows && proc.pid) {
                (0, child_process_1.spawnSync)('taskkill', ['/F', '/T', '/PID', String(proc.pid)], {
                    stdio: 'ignore',
                    timeout: 10000,
                });
            }
            // Skip auto-restart when intentional restart is in progress
            if (this.intentionalRestart)
                return;
            if (this.started && code !== 0 && this.restartCount < MAX_RESTARTS) {
                this.restartCount++;
                this.emit('log', `Exited (code=${code}), restarting in ${this.restartDelay}ms (${this.restartCount}/${MAX_RESTARTS})`);
                setTimeout(() => this.spawnProcess(), this.restartDelay);
                this.restartDelay = Math.min(this.restartDelay * 2, MAX_RESTART_DELAY_MS);
            }
        });
        proc.on('error', (err) => {
            this.emit('log', `Process error: ${err.message}`);
            this.emit('error', err);
        });
    }
    connectWebSocket() {
        if (!this.wsUrl)
            return;
        this.emit('log', `Connecting to ${this.wsUrl}/ws`);
        this.ws = new WebSocket(`${this.wsUrl}/ws`);
        this.ws.onopen = () => {
            this.emit('status', { status: 'connected' });
            this.emit('log', 'WebSocket connected');
            this.restartCount = 0;
            this.restartDelay = INITIAL_RESTART_DELAY_MS;
            while (this.outgoingQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify(this.outgoingQueue.shift()));
            }
        };
        this.ws.onmessage = (event) => {
            const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
            const msg = (0, protocol_1.parseMessage)(data);
            if (msg)
                this.emit('message', msg);
        };
        this.ws.onclose = (event) => {
            this.emit('status', { status: 'disconnected', code: event.code, reason: event.reason });
            // Only reconnect WebSocket if the process is still alive — if the process
            // has exited, the port is stale and we must wait for the new process to
            // announce a new port via stdout (which triggers a fresh connectWebSocket).
            if (this.started && this.process && event.code !== 1000) {
                this.emit('log', `WebSocket closed (${event.code}), reconnecting...`);
                setTimeout(() => this.connectWebSocket(), 1000);
            }
        };
        this.ws.onerror = (_event) => {
            this.emit('log', 'WebSocket error');
        };
    }
}
exports.ProcessManager = ProcessManager;
//# sourceMappingURL=processManager.js.map