"use strict";
/**
 * VS Code Extension Entry Point
 *
 * Spawns Claude Code in IDE mode and communicates via WebSocket.
 * All agent operations run in the Claude Code process.
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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const processManager_1 = require("./processManager");
const contextProvider_1 = require("./contextProvider");
const provider_1 = require("./webview/provider");
// Log at module load time so we know the extension was loaded
console.log('[claude-code] extension module loaded');
// ── Locale helpers (extension host) ────────────────────────────────────────
let localeData = {};
function loadLocale() {
    const config = vscode.workspace.getConfiguration('claudeCode');
    const configLang = config.get('language', 'auto');
    const vsCodeLang = vscode.env.language.toLowerCase();
    const lang = configLang === 'auto' ? vsCodeLang : configLang;
    const localesDir = path.join(__dirname, '..', 'media', 'webview', 'locales');
    function tryLoad(locale) {
        const p = path.join(localesDir, locale + '.json');
        try {
            if (fs.existsSync(p))
                return JSON.parse(fs.readFileSync(p, 'utf8'));
        }
        catch { }
        return null;
    }
    let data = tryLoad(lang);
    if (!data && lang.includes('-'))
        data = tryLoad(lang.split('-')[0]);
    if (!data)
        data = tryLoad('en');
    localeData = data || {};
}
function t(key, params) {
    let val = localeData[key];
    if (!val)
        return key;
    if (params) {
        for (const k of Object.keys(params)) {
            val = val.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]);
        }
    }
    return val;
}
const IDE_SCRIPT = process.platform === 'win32' ? 'claude-ide.cmd' : 'claude-ide';
function resolveIdeScriptPath(extensionUri, config) {
    // 1) User-configured repo path (contains bin/claude-ide.cmd)
    const cliPath = config.get('cliPath', '');
    if (cliPath) {
        const scriptInRepo = path.join(cliPath, 'bin', IDE_SCRIPT);
        if (fs.existsSync(scriptInRepo))
            return scriptInRepo;
    }
    // 2) Relative to extension install location
    const fromExtension = path.resolve(extensionUri.fsPath, '..', '..', 'bin', IDE_SCRIPT);
    if (fs.existsSync(fromExtension))
        return fromExtension;
    // 3) Relative to workspace root
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspace) {
        const fromWorkspace = path.join(workspace, 'bin', IDE_SCRIPT);
        if (fs.existsSync(fromWorkspace))
            return fromWorkspace;
    }
    // 4) Search system PATH
    const pathEnv = process.env.PATH ?? process.env.Path ?? '';
    for (const dir of pathEnv.split(path.delimiter)) {
        if (!dir)
            continue;
        const fromPath = path.join(dir, IDE_SCRIPT);
        if (fs.existsSync(fromPath))
            return fromPath;
    }
    throw new Error(t('ext.script_not_found', { script: IDE_SCRIPT }));
}
function activate(context) {
    const config = vscode.workspace.getConfiguration('claudeCode');
    // Resolve script path — show errors in Debug Console + message box
    let scriptPath;
    try {
        loadLocale();
        scriptPath = resolveIdeScriptPath(context.extensionUri, config);
        console.log(`[claude-code] IDE script: ${scriptPath}`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[claude-code] ${message}`);
        vscode.window.showErrorMessage(t('ext.claude_code_prefix', { message }));
        return;
    }
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const processManager = new processManager_1.ProcessManager({ scriptPath, workspacePath });
    let autoSendContext = config.get('autoSendContext', true);
    // derive repo root from the resolved claude-ide script path (<repo>/bin/claude-ide.cmd)
    const repoRoot = path.dirname(path.dirname(scriptPath));
    const chatProvider = new provider_1.ChatWebviewProvider(context.extensionUri, processManager, repoRoot);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('claude-code.chatView', chatProvider, {
        webviewOptions: { retainContextWhenHidden: true },
    }));
    const contextProvider = new contextProvider_1.ContextProvider(processManager, () => autoSendContext, (ctx) => {
        const files = ctx.files?.map(f => f.path) ?? [];
        const selection = ctx.selection ? { path: ctx.selection.path, lines: ctx.selection.endLine - ctx.selection.startLine + 1, text: ctx.selection.text } : null;
        const diags = ctx.diagnostics;
        const diagnostics = diags && diags.length > 0
            ? {
                errors: diags.filter(d => d.severity === 'error').length,
                warnings: diags.filter(d => d.severity === 'warning').length,
                info: diags.filter(d => d.severity === 'info' || d.severity === 'hint').length,
            }
            : null;
        chatProvider.sendToWebview({
            type: 'ide_context',
            files,
            selection,
            diagnostics,
        });
    });
    // ====================================================================
    // Commands
    // ====================================================================
    context.subscriptions.push(vscode.commands.registerCommand('claude-code.startChat', () => {
        processManager.start();
        chatProvider.show();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('claude-code.sendSelection', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
            vscode.window.showInformationMessage(t('ext.no_text_selected'));
            return;
        }
        const doc = editor.document;
        const startLine = editor.selection.start.line + 1; // 1-based for human readability
        const endLine = editor.selection.end.line + 1;
        const filePath = vscode.workspace.asRelativePath(doc.uri);
        const lineRef = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
        chatProvider.sendToWebview({
            type: 'fill_input',
            text: `[${filePath}:${lineRef}]`,
            selection: { filePath, startLine, endLine },
        });
        chatProvider.show();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('claude-code.sendFile', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage(t('ext.no_file_open'));
            return;
        }
        const doc = editor.document;
        chatProvider.sendToWebview({
            type: 'file_picked',
            files: [{
                    path: vscode.workspace.asRelativePath(doc.uri),
                    content: doc.getText(),
                    language: doc.languageId,
                }],
        });
        chatProvider.show();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('claude-code.addToChat', async (clickedUri, selectedUris) => {
        const uris = selectedUris && selectedUris.length > 0 ? selectedUris : [clickedUri];
        const files = [];
        for (const uri of uris) {
            const stat = await vscode.workspace.fs.stat(uri);
            const relativePath = vscode.workspace.asRelativePath(uri);
            if (stat.type === vscode.FileType.Directory) {
                files.push({ path: relativePath, isDir: true });
            }
            else if (stat.type === vscode.FileType.File) {
                const ext = relativePath.split('.').pop()?.toLowerCase();
                files.push({ path: relativePath, language: ext });
            }
        }
        if (files.length > 0) {
            chatProvider.sendToWebview({ type: 'file_picked', files });
            chatProvider.show();
        }
    }));
    const codeActions = [
        ['claude-code.explainCode', 'explain the following code from'],
    ];
    for (const [command, prefix] of codeActions) {
        context.subscriptions.push(vscode.commands.registerCommand(command, () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.selection.isEmpty)
                return;
            const doc = editor.document;
            processManager.send({
                type: 'user',
                message: {
                    role: 'user',
                    content: `Please ${t('ext.explain_code')} ${vscode.workspace.asRelativePath(doc.uri)}:\n\n\`\`\`${doc.languageId}\n${doc.getText(editor.selection)}\n\`\`\``,
                },
                parent_tool_use_id: null,
            });
            chatProvider.show();
        }));
    }
    // ====================================================================
    // Message routing
    // ====================================================================
    processManager.on('message', (msg) => {
        chatProvider.sendToWebview(msg);
        if (msg.type === 'result' && msg.subtype === 'success') {
            processManager.resetRestartCount();
        }
    });
    const logChannel = vscode.window.createOutputChannel('Claude Code', { log: true });
    context.subscriptions.push(logChannel);
    logChannel.info('[claude-code] Extension activated');
    processManager.on('log', (log) => {
        console.log(`[claude-code] ${log}`);
        logChannel.info(log);
        chatProvider.appendLog(log);
    });
    processManager.on('status', (status) => {
        chatProvider.sendToWebview({ type: 'status', status: status.status });
    });
    processManager.on('error', (err) => {
        vscode.window.showErrorMessage(t('ext.claude_code_prefix', { message: err.message }));
    });
    // ====================================================================
    // Config listener
    // ====================================================================
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeCode.autoSendContext')) {
            autoSendContext = config.get('autoSendContext', true);
        }
    }));
    // ====================================================================
    // Status bar
    // ====================================================================
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'claude-code.startChat';
    statusBarItem.text = '$(comment-discussion) Claude Code';
    statusBarItem.tooltip = t('ext.start_chat');
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();
    processManager.on('status', (status) => {
        switch (status.status) {
            case 'starting':
                statusBarItem.text = '$(sync~spin) Claude Code';
                break;
            case 'restarting':
                statusBarItem.text = '$(sync~spin) Claude Code';
                break;
            case 'connected':
                statusBarItem.text = '$(comment-discussion) Claude Code';
                break;
            case 'disconnected':
                statusBarItem.text = '$(warning) Claude Code';
                break;
            case 'exited':
                statusBarItem.text = '$(circle-slash) Claude Code';
                break;
        }
    });
    // ====================================================================
    // Cleanup
    // ====================================================================
    context.subscriptions.push({ dispose: () => processManager.stop() });
    context.subscriptions.push(contextProvider);
    context.subscriptions.push(chatProvider);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map