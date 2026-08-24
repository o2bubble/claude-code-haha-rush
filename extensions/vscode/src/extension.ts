/**
 * VS Code Extension Entry Point
 *
 * Spawns Claude Code in IDE mode and communicates via WebSocket.
 * All agent operations run in the Claude Code process.
 */

import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import type { IncomingMessage } from './protocol'
import { ProcessManager } from './processManager'
import { ContextProvider } from './contextProvider'
import { ChatWebviewProvider } from './webview/provider'

// Log at module load time so we know the extension was loaded
console.log('[claude-code] extension module loaded')

export type { IncomingMessage }

// ── Locale helpers (extension host) ────────────────────────────────────────

let localeData: Record<string, string> = {}

function loadLocale(): void {
  const config = vscode.workspace.getConfiguration('claudeCode')
  const configLang = config.get<string>('language', 'auto')
  const vsCodeLang = vscode.env.language.toLowerCase()
  const lang = configLang === 'auto' ? vsCodeLang : configLang

  const localesDir = path.join(__dirname, '..', 'media', 'webview', 'locales')
  function tryLoad(locale: string): Record<string, string> | null {
    const p = path.join(localesDir, locale + '.json')
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch {}
    return null
  }

  let data = tryLoad(lang)
  if (!data && lang.includes('-')) data = tryLoad(lang.split('-')[0])
  if (!data) data = tryLoad('en')
  localeData = data || {}
}

function t(key: string, params?: Record<string, string>): string {
  let val = localeData[key]
  if (!val) return key
  if (params) {
    for (const k of Object.keys(params)) {
      val = val.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k])
    }
  }
  return val
}

const IDE_SCRIPT = process.platform === 'win32' ? 'claude-ide.cmd' : 'claude-ide'

function resolveIdeScriptPath(extensionUri: vscode.Uri, config: vscode.WorkspaceConfiguration): string {
  // 1) User-configured repo path (contains bin/claude-ide.cmd)
  const cliPath = config.get<string>('cliPath', '')
  if (cliPath) {
    const scriptInRepo = path.join(cliPath, 'bin', IDE_SCRIPT)
    if (fs.existsSync(scriptInRepo)) return scriptInRepo
  }

  // 2) Relative to extension install location
  const fromExtension = path.resolve(extensionUri.fsPath, '..', '..', 'bin', IDE_SCRIPT)
  if (fs.existsSync(fromExtension)) return fromExtension

  // 3) Relative to workspace root
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (workspace) {
    const fromWorkspace = path.join(workspace, 'bin', IDE_SCRIPT)
    if (fs.existsSync(fromWorkspace)) return fromWorkspace
  }

  // 4) Search system PATH
  const pathEnv = process.env.PATH ?? process.env.Path ?? ''
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const fromPath = path.join(dir, IDE_SCRIPT)
    if (fs.existsSync(fromPath)) return fromPath
  }

  throw new Error(
    t('ext.script_not_found', { script: IDE_SCRIPT })
  )
}

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration('claudeCode')

  // Resolve script path — show errors in Debug Console + message box
  let scriptPath: string
  try {
    loadLocale()
    scriptPath = resolveIdeScriptPath(context.extensionUri, config)
    console.log(`[claude-code] IDE script: ${scriptPath}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[claude-code] ${message}`)
    vscode.window.showErrorMessage(t('ext.claude_code_prefix', { message }))
    return
  }

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

  const processManager = new ProcessManager({ scriptPath, workspacePath })

  let autoSendContext = config.get<boolean>('autoSendContext', true)

  // derive repo root from the resolved claude-ide script path (<repo>/bin/claude-ide.cmd)
  const repoRoot = path.dirname(path.dirname(scriptPath))

  const chatProvider = new ChatWebviewProvider(context.extensionUri, processManager, repoRoot)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claude-code.chatView', chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )
  const contextProvider = new ContextProvider(processManager, () => autoSendContext, (ctx) => {
    const files = ctx.files?.map(f => f.path) ?? []
    const selection = ctx.selection ? { path: ctx.selection.path, lines: ctx.selection.endLine - ctx.selection.startLine + 1, text: ctx.selection.text } : null
    const diags = ctx.diagnostics
    const diagnostics = diags && diags.length > 0
      ? {
          errors: diags.filter(d => d.severity === 'error').length,
          warnings: diags.filter(d => d.severity === 'warning').length,
          info: diags.filter(d => d.severity === 'info' || d.severity === 'hint').length,
        }
      : null
    chatProvider.sendToWebview({
      type: 'ide_context',
      files,
      selection,
      diagnostics,
    })
  })

  // ====================================================================
  // Commands
  // ====================================================================

  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code.startChat', () => {
      processManager.start()
      chatProvider.show()
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code.sendSelection', () => {
      const editor = vscode.window.activeTextEditor
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage(t('ext.no_text_selected'))
        return
      }
      const doc = editor.document
      const startLine = editor.selection.start.line + 1  // 1-based for human readability
      const endLine = editor.selection.end.line + 1
      const filePath = vscode.workspace.asRelativePath(doc.uri)
      const lineRef = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`
      chatProvider.sendToWebview({
        type: 'fill_input',
        text: `[${filePath}:${lineRef}]`,
        selection: { filePath, startLine, endLine },
      })
      chatProvider.show()
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code.sendFile', () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) {
        vscode.window.showInformationMessage(t('ext.no_file_open'))
        return
      }
      const doc = editor.document
      chatProvider.sendToWebview({
        type: 'file_picked',
        files: [{
          path: vscode.workspace.asRelativePath(doc.uri),
          content: doc.getText(),
          language: doc.languageId,
        }],
      })
      chatProvider.show()
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code.addToChat', async (clickedUri: vscode.Uri, selectedUris: vscode.Uri[]) => {
      const uris = selectedUris && selectedUris.length > 0 ? selectedUris : [clickedUri]
      const files: { path: string; content?: string; language?: string; isDir?: boolean }[] = []
      for (const uri of uris) {
        const stat = await vscode.workspace.fs.stat(uri)
        const relativePath = vscode.workspace.asRelativePath(uri)
        if (stat.type === vscode.FileType.Directory) {
          files.push({ path: relativePath, isDir: true })
        } else if (stat.type === vscode.FileType.File) {
          const ext = relativePath.split('.').pop()?.toLowerCase()
          files.push({ path: relativePath, language: ext })
        }
      }
      if (files.length > 0) {
        chatProvider.sendToWebview({ type: 'file_picked', files })
        chatProvider.show()
      }
    }),
  )

  const codeActions: [string, string][] = [
    ['claude-code.explainCode', 'explain the following code from'],
  ]
  for (const [command, prefix] of codeActions) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => {
        const editor = vscode.window.activeTextEditor
        if (!editor || editor.selection.isEmpty) return
        const doc = editor.document
        processManager.send({
          type: 'user',
          message: {
            role: 'user',
            content: `Please ${t('ext.explain_code')} ${vscode.workspace.asRelativePath(doc.uri)}:\n\n\`\`\`${doc.languageId}\n${doc.getText(editor.selection)}\n\`\`\``,
          },
          parent_tool_use_id: null,
        })
        chatProvider.show()
      }),
    )
  }

  // ====================================================================
  // Message routing
  // ====================================================================

  processManager.on('message', (msg: IncomingMessage) => {
    chatProvider.sendToWebview(msg)
    if (msg.type === 'result' && msg.subtype === 'success') {
      processManager.resetRestartCount()
    }
  })

  const logChannel = vscode.window.createOutputChannel('Claude Code', { log: true })
  context.subscriptions.push(logChannel)

  logChannel.info('[claude-code] Extension activated')

  processManager.on('log', (log: string) => {
    console.log(`[claude-code] ${log}`)
    logChannel.info(log)
    chatProvider.appendLog(log)
  })

  processManager.on('status', (status: { status: string; code?: number }) => {
    chatProvider.sendToWebview({ type: 'status', status: status.status } as IncomingMessage)
  })

  processManager.on('error', (err: Error) => {
    vscode.window.showErrorMessage(t('ext.claude_code_prefix', { message: err.message }))
  })

  // ====================================================================
  // Config listener
  // ====================================================================

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCode.autoSendContext')) {
        autoSendContext = config.get<boolean>('autoSendContext', true)
      }
    }),
  )

  // ====================================================================
  // Status bar
  // ====================================================================

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBarItem.command = 'claude-code.startChat'
  statusBarItem.text = '$(comment-discussion) Claude Code'
  statusBarItem.tooltip = t('ext.start_chat')
  context.subscriptions.push(statusBarItem)
  statusBarItem.show()

  processManager.on('status', (status: { status: string }) => {
    switch (status.status) {
      case 'starting': statusBarItem.text = '$(sync~spin) Claude Code'; break
      case 'restarting': statusBarItem.text = '$(sync~spin) Claude Code'; break
      case 'connected': statusBarItem.text = '$(comment-discussion) Claude Code'; break
      case 'disconnected': statusBarItem.text = '$(warning) Claude Code'; break
      case 'exited': statusBarItem.text = '$(circle-slash) Claude Code'; break
    }
  })

  // ====================================================================
  // Cleanup
  // ====================================================================

  context.subscriptions.push({ dispose: () => processManager.stop() })
  context.subscriptions.push(contextProvider)
  context.subscriptions.push(chatProvider)
}

export function deactivate(): void {}
