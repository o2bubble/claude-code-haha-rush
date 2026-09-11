/**
 * VS Code Extension Entry Point
 *
 * Spawns Claude Code in IDE mode and communicates via WebSocket.
 * All agent operations run in the Claude Code process.
 */
import * as vscode from 'vscode';
import type { IncomingMessage } from './protocol';
export type { IncomingMessage };
export declare function activate(context: vscode.ExtensionContext): void;
export declare function deactivate(): void;
//# sourceMappingURL=extension.d.ts.map