/**
 * IDE context provider — collects active file, selection, and diagnostics
 * from VS Code APIs and sends them to the Claude Code process.
 */

import * as vscode from 'vscode'
import type { ProcessManager } from './processManager'
import type {
  IDEFileContext,
  IDESelection,
  IDEDiagnostic,
  IDEContextMessage,
} from './protocol'

export class ContextProvider implements vscode.Disposable {
  private disposables: vscode.Disposable[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private debounceMs = 500

  constructor(
    private processManager: ProcessManager,
    private enabled: () => boolean,
    private onContextSent?: (context: IDEContextMessage) => void,
  ) {
    this.setupListeners()
  }

  private setupListeners(): void {
    // Active editor changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.scheduleContextUpdate()
      }),
    )

    // Selection changes
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(() => {
        this.scheduleContextUpdate()
      }),
    )

    // Document changes (for diagnostics refresh)
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(() => {
        // Only update context for visible editors to avoid noise
        if (vscode.window.activeTextEditor) {
          this.scheduleContextUpdate()
        }
      }),
    )

    // Diagnostics changes
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics(() => {
        this.scheduleContextUpdate()
      }),
    )
  }

  /** Send current context immediately */
  async sendContext(): Promise<void> {
    const context = await this.collectContext()
    if (context) {
      this.processManager.send(context)
      this.onContextSent?.(context)
    }
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    for (const d of this.disposables) {
      d.dispose()
    }
  }

  // ====================================================================
  // Internal
  // ====================================================================

  private scheduleContextUpdate(): void {
    if (!this.enabled()) return

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.sendContext()
    }, this.debounceMs)
  }

  private async collectContext(): Promise<IDEContextMessage | null> {
    const config = vscode.workspace.getConfiguration('claudeCode')
    const maxFiles = config.get<number>('maxFilesInContext', 5)

    const files = await this.collectActiveFiles(maxFiles)
    const selection = this.collectSelection()
    const diagnostics = this.collectDiagnostics()

    if (files.length === 0 && !selection && diagnostics.length === 0) {
      return null
    }

    return {
      type: 'ide_context',
      files: files.length > 0 ? files : undefined,
      selection,
      diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
    }
  }

  private async collectActiveFiles(maxFiles: number): Promise<IDEFileContext[]> {
    const result: IDEFileContext[] = []
    const seen = new Set<string>()

    // Add active editor first
    const activeEditor = vscode.window.activeTextEditor
    if (activeEditor) {
      const doc = activeEditor.document
      seen.add(doc.uri.fsPath)
      result.push({
        path: vscode.workspace.asRelativePath(doc.uri),
        content: doc.getText(),
        language: doc.languageId,
      })
    }

    // Add visible editors
    for (const editor of vscode.window.visibleTextEditors) {
      if (result.length >= maxFiles) break
      const doc = editor.document
      if (!seen.has(doc.uri.fsPath)) {
        seen.add(doc.uri.fsPath)
        result.push({
          path: vscode.workspace.asRelativePath(doc.uri),
          content: doc.getText(),
          language: doc.languageId,
        })
      }
    }

    return result
  }

  private collectSelection(): IDESelection | null {
    const editor = vscode.window.activeTextEditor
    if (!editor || editor.selection.isEmpty) return null

    const sel = editor.selection
    const doc = editor.document

    return {
      path: vscode.workspace.asRelativePath(doc.uri),
      startLine: sel.start.line,
      startChar: sel.start.character,
      endLine: sel.end.line,
      endChar: sel.end.character,
      text: doc.getText(sel),
    }
  }

  private collectDiagnostics(): IDEDiagnostic[] {
    const result: IDEDiagnostic[] = []
    const activeEditor = vscode.window.activeTextEditor
    if (!activeEditor) return result

    const activeUri = activeEditor.document.uri
    const diags = vscode.languages.getDiagnostics(activeUri)

    for (const d of diags.slice(0, 20)) {
      // Map VS Code severity
      let severity: IDEDiagnostic['severity']
      switch (d.severity) {
        case vscode.DiagnosticSeverity.Error:
          severity = 'error'
          break
        case vscode.DiagnosticSeverity.Warning:
          severity = 'warning'
          break
        case vscode.DiagnosticSeverity.Information:
          severity = 'info'
          break
        case vscode.DiagnosticSeverity.Hint:
          severity = 'hint'
          break
        default:
          severity = 'info'
      }

      result.push({
        path: vscode.workspace.asRelativePath(activeUri),
        line: d.range.start.line,
        column: d.range.start.character,
        message: d.message,
        severity,
        source: d.source,
      })
    }

    return result
  }
}
