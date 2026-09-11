"use strict";
/**
 * IDE context provider — collects active file, selection, and diagnostics
 * from VS Code APIs and sends them to the Claude Code process.
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
exports.ContextProvider = void 0;
const vscode = __importStar(require("vscode"));
class ContextProvider {
    processManager;
    enabled;
    onContextSent;
    disposables = [];
    debounceTimer = null;
    debounceMs = 500;
    constructor(processManager, enabled, onContextSent) {
        this.processManager = processManager;
        this.enabled = enabled;
        this.onContextSent = onContextSent;
        this.setupListeners();
    }
    setupListeners() {
        // Active editor changes
        this.disposables.push(vscode.window.onDidChangeActiveTextEditor(() => {
            this.scheduleContextUpdate();
        }));
        // Selection changes
        this.disposables.push(vscode.window.onDidChangeTextEditorSelection(() => {
            this.scheduleContextUpdate();
        }));
        // Document changes (for diagnostics refresh)
        this.disposables.push(vscode.workspace.onDidChangeTextDocument(() => {
            // Only update context for visible editors to avoid noise
            if (vscode.window.activeTextEditor) {
                this.scheduleContextUpdate();
            }
        }));
        // Diagnostics changes
        this.disposables.push(vscode.languages.onDidChangeDiagnostics(() => {
            this.scheduleContextUpdate();
        }));
    }
    /** Send current context immediately */
    async sendContext() {
        const context = await this.collectContext();
        if (context) {
            this.processManager.send(context);
            this.onContextSent?.(context);
        }
    }
    dispose() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        for (const d of this.disposables) {
            d.dispose();
        }
    }
    // ====================================================================
    // Internal
    // ====================================================================
    scheduleContextUpdate() {
        if (!this.enabled())
            return;
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.sendContext();
        }, this.debounceMs);
    }
    async collectContext() {
        const config = vscode.workspace.getConfiguration('claudeCode');
        const maxFiles = config.get('maxFilesInContext', 5);
        const files = await this.collectActiveFiles(maxFiles);
        const selection = this.collectSelection();
        const diagnostics = this.collectDiagnostics();
        if (files.length === 0 && !selection && diagnostics.length === 0) {
            return null;
        }
        return {
            type: 'ide_context',
            files: files.length > 0 ? files : undefined,
            selection,
            diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
        };
    }
    async collectActiveFiles(maxFiles) {
        const result = [];
        const seen = new Set();
        // Add active editor first
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            const doc = activeEditor.document;
            seen.add(doc.uri.fsPath);
            result.push({
                path: vscode.workspace.asRelativePath(doc.uri),
                content: doc.getText(),
                language: doc.languageId,
            });
        }
        // Add visible editors
        for (const editor of vscode.window.visibleTextEditors) {
            if (result.length >= maxFiles)
                break;
            const doc = editor.document;
            if (!seen.has(doc.uri.fsPath)) {
                seen.add(doc.uri.fsPath);
                result.push({
                    path: vscode.workspace.asRelativePath(doc.uri),
                    content: doc.getText(),
                    language: doc.languageId,
                });
            }
        }
        return result;
    }
    collectSelection() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty)
            return null;
        const sel = editor.selection;
        const doc = editor.document;
        return {
            path: vscode.workspace.asRelativePath(doc.uri),
            startLine: sel.start.line,
            startChar: sel.start.character,
            endLine: sel.end.line,
            endChar: sel.end.character,
            text: doc.getText(sel),
        };
    }
    collectDiagnostics() {
        const result = [];
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor)
            return result;
        const activeUri = activeEditor.document.uri;
        const diags = vscode.languages.getDiagnostics(activeUri);
        for (const d of diags.slice(0, 20)) {
            // Map VS Code severity
            let severity;
            switch (d.severity) {
                case vscode.DiagnosticSeverity.Error:
                    severity = 'error';
                    break;
                case vscode.DiagnosticSeverity.Warning:
                    severity = 'warning';
                    break;
                case vscode.DiagnosticSeverity.Information:
                    severity = 'info';
                    break;
                case vscode.DiagnosticSeverity.Hint:
                    severity = 'hint';
                    break;
                default:
                    severity = 'info';
            }
            result.push({
                path: vscode.workspace.asRelativePath(activeUri),
                line: d.range.start.line,
                column: d.range.start.character,
                message: d.message,
                severity,
                source: d.source,
            });
        }
        return result;
    }
}
exports.ContextProvider = ContextProvider;
//# sourceMappingURL=contextProvider.js.map