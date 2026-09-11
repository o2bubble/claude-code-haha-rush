/**
 * IDE context provider — collects active file, selection, and diagnostics
 * from VS Code APIs and sends them to the Claude Code process.
 */
import * as vscode from 'vscode';
import type { ProcessManager } from './processManager';
import type { IDEContextMessage } from './protocol';
export declare class ContextProvider implements vscode.Disposable {
    private processManager;
    private enabled;
    private onContextSent?;
    private disposables;
    private debounceTimer;
    private debounceMs;
    constructor(processManager: ProcessManager, enabled: () => boolean, onContextSent?: ((context: IDEContextMessage) => void) | undefined);
    private setupListeners;
    /** Send current context immediately */
    sendContext(): Promise<void>;
    dispose(): void;
    private scheduleContextUpdate;
    private collectContext;
    private collectActiveFiles;
    private collectSelection;
    private collectDiagnostics;
}
//# sourceMappingURL=contextProvider.d.ts.map