/**
 * Chat Webview Provider
 *
 * Creates and manages the sidebar chat panel. Bridges messages between
 * the Claude Code process and the webview UI via postMessage.
 */
import * as vscode from 'vscode';
import type { ProcessManager } from '../processManager';
import type { IncomingMessage } from '../protocol';
export declare class ChatWebviewProvider implements vscode.Disposable, vscode.WebviewViewProvider {
    private extensionUri;
    private processManager;
    private repoRoot?;
    private view;
    private logBuffer;
    private messageQueue;
    private isWebviewReady;
    constructor(extensionUri: vscode.Uri, processManager: ProcessManager, repoRoot?: string | undefined);
    /** Show the chat panel */
    show(): void;
    /** Send a message to the webview */
    sendToWebview(msg: IncomingMessage): void;
    /** Append a log line from stderr */
    appendLog(log: string): void;
    private workspaceFilesCache;
    private workspaceFilesCacheTime;
    private workspaceFileTreeCache;
    private workspaceFileTreeCacheTime;
    /** Build a sorted file tree from flat file paths (dirs first, alphabetical) */
    private buildFileTree;
    /** Send workspace file tree to webview for @mention autocomplete */
    private sendWorkspaceFiles;
    /** Read a file or directory and send its content back for chip insertion */
    private handleFileContentRequest;
    /**
     * Apply saved profile env from the project-level .claude/settings.local.json
     * to process.env before spawning the backend.
     */
    private restoreIdeProfile;
    private getProfilesDir;
    /** Parse a simple .env file into a Record<string, string> */
    private parseEnvFile;
    /** Read available profiles and send to webview */
    private sendModelProfiles;
    /** Switch to a different model profile */
    private handleSetModelProfile;
    resolveWebviewView(webviewView: vscode.WebviewView): void;
    dispose(): void;
    private getHtmlContent;
    private loadLocaleData;
    private t;
}
//# sourceMappingURL=provider.d.ts.map