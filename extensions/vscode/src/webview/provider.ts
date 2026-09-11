/**
 * Chat Webview Provider
 *
 * Creates and manages the sidebar chat panel. Bridges messages between
 * the Claude Code process and the webview UI via postMessage.
 */

import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { ProcessManager } from '../processManager'
import type { FileTreeNode, IncomingMessage, OutgoingMessage } from '../protocol'

// Pre-load highlight.js bundle + CSS + marked + marked-highlight at module init
const hljsBundlePath = path.join(__dirname, '..', '..', 'webview-assets', 'highlight.bundle.js')
const hljsCssPath = path.join(__dirname, '..', '..', 'webview-assets', 'github-dark-dimmed.min.css')
const markedPath = path.join(__dirname, '..', '..', 'webview-assets', 'marked.umd.js')
const markedHighlightPath = path.join(__dirname, '..', '..', 'webview-assets', 'marked-highlight.umd.js')
const hljsBundle = fs.readFileSync(hljsBundlePath, 'utf8')
const hljsCss = fs.readFileSync(hljsCssPath, 'utf8')
const markedBundle = fs.readFileSync(markedPath, 'utf8').replace(/\/\/# sourceMappingURL=.*/, '')
const markedHighlightBundle = fs.readFileSync(markedHighlightPath, 'utf8').replace(/\/\/# sourceMappingURL=.*/, '')

// Pre-load webview template + CSS + JS at module init
const templatePath = path.join(__dirname, '..', '..', 'media', 'webview', 'template.html')
const tokensCssPath = path.join(__dirname, '..', '..', 'media', 'webview', 'tokens.css')
const appNewJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'app-new.js')
const localesDir = path.join(__dirname, '..', '..', 'media', 'webview', 'locales')
const template = fs.readFileSync(templatePath, 'utf8')
const tokensCSS = fs.readFileSync(tokensCssPath, 'utf8')
const appNewJS = fs.readFileSync(appNewJsPath, 'utf8')

// Pre-load new styles
const stylesNewCssPath = path.join(__dirname, '..', '..', 'media', 'webview', 'styles-new.css')
const stylesNewCSS = fs.readFileSync(stylesNewCssPath, 'utf8')

// Pre-load new UI utility modules (read into string for injection)
const stateJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'utils', 'state.js')
const domJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'utils', 'dom.js')
const apiJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'utils', 'api.js')
const localeJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'utils', 'locale.js')
const stateJS = fs.readFileSync(stateJsPath, 'utf8')
const domJS = fs.readFileSync(domJsPath, 'utf8')
const apiJS = fs.readFileSync(apiJsPath, 'utf8')
const localeJS = fs.readFileSync(localeJsPath, 'utf8')

// Pre-load new UI component modules
const sessionPanelJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'components', 'session-panel.js')
const messageStreamJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'components', 'message-stream.js')
const sessionPanelJS = fs.readFileSync(sessionPanelJsPath, 'utf8')
const messageStreamJS = fs.readFileSync(messageStreamJsPath, 'utf8')

// Pre-load S3 component modules
const inputAreaJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'components', 'input-area.js')
const contextBarJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'components', 'context-bar.js')
const selectionPreviewJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'components', 'selection-preview.js')
const inputAreaJS = fs.readFileSync(inputAreaJsPath, 'utf8')
const contextBarJS = fs.readFileSync(contextBarJsPath, 'utf8')
const selectionPreviewJS = fs.readFileSync(selectionPreviewJsPath, 'utf8')

// Pre-load S5 component modules
const statusBarJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'components', 'status-bar.js')
const tasksPanelJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'components', 'tasks-panel.js')
const planPanelJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'components', 'plan-panel.js')
const statusBarJS = fs.readFileSync(statusBarJsPath, 'utf8')
const tasksPanelJS = fs.readFileSync(tasksPanelJsPath, 'utf8')
const planPanelJS = fs.readFileSync(planPanelJsPath, 'utf8')
const queuePanelJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'components', 'queue-panel.js')
const queuePanelJS = fs.readFileSync(queuePanelJsPath, 'utf8')

// Pre-load overlay components
const permPromptJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'overlays', 'permission-prompt.js')
const rewindPointsJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'overlays', 'rewind-points.js')
const toastJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'overlays', 'toast.js')
const filePickerJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'overlays', 'file-picker.js')
const emojiPickerJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'overlays', 'emoji-picker.js')
const slashAutocompleteJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'overlays', 'slash-autocomplete.js')
const markdownEditorJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'overlays', 'markdown-editor.js')
const quickCmdManagerJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'overlays', 'quick-command-manager.js')
const permPromptJS = fs.readFileSync(permPromptJsPath, 'utf8')
const rewindPointsJS = fs.readFileSync(rewindPointsJsPath, 'utf8')
const toastJS = fs.readFileSync(toastJsPath, 'utf8')
const filePickerJS = fs.readFileSync(filePickerJsPath, 'utf8')
const emojiPickerJS = fs.readFileSync(emojiPickerJsPath, 'utf8')
const slashAutocompleteJS = fs.readFileSync(slashAutocompleteJsPath, 'utf8')
const markdownEditorJS = fs.readFileSync(markdownEditorJsPath, 'utf8')
const quickCmdManagerJS = fs.readFileSync(quickCmdManagerJsPath, 'utf8')
const sideQuestionJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'overlays', 'side-question.js')
const sideQuestionJS = fs.readFileSync(sideQuestionJsPath, 'utf8')
const askQuestionJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'overlays', 'ask-question.js')
const askQuestionJS = fs.readFileSync(askQuestionJsPath, 'utf8')
const contextDetailJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'overlays', 'context-detail.js')
const contextDetailJS = fs.readFileSync(contextDetailJsPath, 'utf8')
const historyBrowserJsPath = path.join(__dirname, '..', '..', 'media', 'webview', 'overlays', 'history-browser.js')
const historyBrowserJS = fs.readFileSync(historyBrowserJsPath, 'utf8')

// Env vars managed by profile switching — cleaned up before applying a new profile
// to prevent stale values from the previous profile leaking into the new one.
const PROFILE_MANAGED_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'API_TIMEOUT_MS',
  'MAX_TOKENS',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'DISABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_CODE_VIRTUAL_SCROLL_THRESHOLD',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]

export class ChatWebviewProvider implements vscode.Disposable, vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null
  private logBuffer: string[] = []
  private messageQueue: IncomingMessage[] = []
  private isWebviewReady = false

  constructor(
    private extensionUri: vscode.Uri,
    private processManager: ProcessManager,
    private repoRoot?: string,
  ) {}

  /** Show the chat panel */
  show(): void {
    if (this.view) {
      this.view.show(true)
    }
  }

  /** Send a message to the webview */
  sendToWebview(msg: IncomingMessage): void {
    if (this.view && this.isWebviewReady) {
      // Flush queue first
      while (this.messageQueue.length > 0) {
        const queued = this.messageQueue.shift()!
        this.view.webview.postMessage(queued)
      }
      this.view.webview.postMessage(msg)
    } else {
      // Queue until webview is ready
      this.messageQueue.push(msg)
    }
  }

  /** Append a log line from stderr */
  appendLog(log: string): void {
    this.logBuffer.push(log.trim())
    if (this.logBuffer.length > 100) {
      this.logBuffer.shift()
    }
    if (this.view && this.isWebviewReady) {
      this.view.webview.postMessage({
        type: 'log',
        message: log.trim(),
      } as IncomingMessage)
    }
  }

  private workspaceFilesCache: string[] | null = null
  private workspaceFilesCacheTime = 0
  private workspaceFileTreeCache: FileTreeNode[] | null = null
  private workspaceFileTreeCacheTime = 0

  /** Build a sorted file tree from flat file paths (dirs first, alphabetical) */
  private buildFileTree(files: string[]): FileTreeNode[] {
    const root: Record<string, FileTreeNode> = {}
    for (const file of files) {
      const parts = file.split('/')
      let current = root
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        const isDir = i < parts.length - 1
        const currentPath = parts.slice(0, i + 1).join('/')
        if (!current[part]) {
          current[part] = { name: part, path: currentPath, isDir, children: isDir ? ({} as any) : undefined }
        }
        if (isDir && current[part].children) {
          current = current[part].children as unknown as Record<string, FileTreeNode>
        }
      }
    }
    function flatten(nodeMap: Record<string, FileTreeNode>): FileTreeNode[] {
      const result: FileTreeNode[] = []
      for (const key of Object.keys(nodeMap).sort()) {
        const node = nodeMap[key]
        if (node.children && typeof node.children === 'object' && !Array.isArray(node.children)) {
          node.children = flatten(node.children as unknown as Record<string, FileTreeNode>)
        }
        result.push(node)
      }
      result.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      return result
    }
    return flatten(root)
  }

  /** Send workspace file tree to webview for @mention autocomplete */
  private async sendWorkspaceFiles(webview: vscode.Webview): Promise<void> {
    const now = Date.now()
    if (this.workspaceFileTreeCache && now - this.workspaceFileTreeCacheTime < 60000) {
      webview.postMessage({ type: 'workspace_files', tree: this.workspaceFileTreeCache })
      return
    }
    try {
      const uris = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 500)
      const files: string[] = []
      for (const uri of uris) {
        files.push(vscode.workspace.asRelativePath(uri))
      }
      const tree = this.buildFileTree(files)
      this.workspaceFileTreeCache = tree
      this.workspaceFileTreeCacheTime = now
      webview.postMessage({ type: 'workspace_files', tree })
    } catch {
      webview.postMessage({ type: 'workspace_files', tree: [] })
    }
  }

  /** Read a file or directory and send its content back for chip insertion */
  private async handleFileContentRequest(webview: vscode.Webview, filePath: string, isDir = false): Promise<void> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders
      if (!workspaceFolders || workspaceFolders.length === 0) return
      const wsRoot = workspaceFolders[0].uri
      const fileUri = vscode.Uri.joinPath(wsRoot, filePath)
      if (isDir) {
        const entries = await vscode.workspace.fs.readDirectory(fileUri)
        const names = entries.map(([name]) => name)
        webview.postMessage({ type: 'file_picked', files: [{ path: filePath, content: names.join('\n'), isDir: true }] })
        return
      }
      const ext = filePath.split('.').pop()?.toLowerCase()
      webview.postMessage({ type: 'file_picked', files: [{ path: filePath, language: ext }] })
    } catch {
      // File not readable — silently ignore
    }
  }

  // ====================================================================
  // Model Profile Management
  // ====================================================================

  /**
   * Apply saved profile env from the project-level .claude/settings.local.json
   * to process.env before spawning the backend.
   */
  private restoreIdeProfile(): void {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath
    if (!wsRoot) return
    const localSettingsPath = path.join(wsRoot, '.claude', 'settings.local.json')
    try {
      const raw = JSON.parse(fs.readFileSync(localSettingsPath, 'utf8'))
      const env = raw?.env
      if (!env || typeof env !== 'object') return
      for (const key of PROFILE_MANAGED_KEYS) {
        delete process.env[key]
      }
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string') process.env[key] = value
      }
    } catch {
      // no local settings → nothing to restore
    }
  }

  private getProfilesDir(): string | null {
    // Priority 1: repoRoot derived from claude-ide script path (works everywhere)
    if (this.repoRoot) {
      const rp = path.join(this.repoRoot, '.env.profiles')
      if (fs.existsSync(rp)) return rp
    }

    // Priority 2: derivation from extension location (F5 debug mode)
    const extRoot = path.dirname(path.dirname(this.extensionUri.fsPath))
    const extProfiles = path.join(extRoot, '.env.profiles')
    if (fs.existsSync(extProfiles)) return extProfiles

    // Priority 3: workspace root
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (workspaceFolders && workspaceFolders.length > 0) {
      const wsProfiles = path.join(workspaceFolders[0].uri.fsPath, '.env.profiles')
      if (fs.existsSync(wsProfiles)) return wsProfiles
    }

    // Priority 4: user home (global profiles created by claude-profile / gui-profile.py)
    const homeProfiles = path.join(os.homedir(), '.claude', '.env.profiles')
    if (fs.existsSync(homeProfiles)) return homeProfiles

    return null
  }

  /** Parse a simple .env file into a Record<string, string> */
  private parseEnvFile(content: string): Record<string, string> {
    const result: Record<string, string> = {}
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx <= 0) continue
      result[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1)
    }
    return result
  }

  /** Read available profiles and send to webview */
  private sendModelProfiles(webview: vscode.Webview): void {
    try {
      const profilesDir = this.getProfilesDir()
      if (!profilesDir || !fs.existsSync(profilesDir)) {
        webview.postMessage({ type: 'model_profiles', profiles: [], active: null })
        return
      }
      const entries = fs.readdirSync(profilesDir)
      const profiles: { id: string; label: string; model: string }[] = []
      for (const entry of entries) {
        if (!entry.endsWith('.env')) continue
        const id = entry.replace(/\.env$/, '')
        const content = fs.readFileSync(path.join(profilesDir, entry), 'utf8')
        const env = this.parseEnvFile(content)
        profiles.push({
          id,
          label: id,
          model: env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
        })
      }
      // Read active profile from project-level storage
      let active: string | null = null
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath
      if (wsRoot) {
        const activePath = path.join(wsRoot, '.claude', 'active-profile')
        if (fs.existsSync(activePath)) {
          active = fs.readFileSync(activePath, 'utf8').trim()
        }
      }
      webview.postMessage({ type: 'model_profiles', profiles, active })
    } catch {
      webview.postMessage({ type: 'model_profiles', profiles: [], active: null })
    }
  }

  /** Switch to a different model profile */
  private handleSetModelProfile(webview: vscode.Webview, profileId: string): void {
    try {
      const profilesDir = this.getProfilesDir()
      if (!profilesDir) {
        vscode.window.showErrorMessage(this.t('ext.cannot_switch_profile'))
        return
      }
      const profilePath = path.join(profilesDir, profileId + '.env')
      if (!fs.existsSync(profilePath)) {
        vscode.window.showErrorMessage(this.t('ext.profile_not_found', { name: profileId }))
        return
      }
      const content = fs.readFileSync(profilePath, 'utf8')
      const env = this.parseEnvFile(content)

      // 1. Remove stale profile-managed env vars so old profile values don't leak
      for (const key of PROFILE_MANAGED_KEYS) {
        delete process.env[key]
      }

      // 2. Set new profile vars on process.env for the child process
      for (const [key, value] of Object.entries(env)) {
        process.env[key] = value
      }

      // 3. Persist to project-level .claude/settings.local.json env section
      // + active-profile marker. settings.local.json overrides user-level
      // ~/.claude/settings.json.env in the merge chain, so the backend's
      // applyConfigEnvironmentVariables() picks up the new vars.
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath
      if (wsRoot) {
        const claudeDir = path.join(wsRoot, '.claude')
        if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true })
        // Write env section to settings.local.json
        const localSettingsPath = path.join(claudeDir, 'settings.local.json')
        let localSettings: Record<string, any> = {}
        try { localSettings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf8')) } catch {}
        if (!localSettings.env || typeof localSettings.env !== 'object') localSettings.env = {}
        for (const key of PROFILE_MANAGED_KEYS) {
          delete localSettings.env[key]
        }
        for (const [key, value] of Object.entries(env)) {
          localSettings.env[key] = value
        }
        fs.writeFileSync(localSettingsPath, JSON.stringify(localSettings, null, 2) + '\n', 'utf8')
        // Write active profile marker
        fs.writeFileSync(path.join(claudeDir, 'active-profile'), profileId, 'utf8')
      }

      // 4. Broadcast to webview (include model name so label updates immediately)
      const modelName = env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || ''
      webview.postMessage({ type: 'model_profile_changed', profile: profileId, model: modelName })

      // 5. Interrupt any in-progress turn before restarting the backend process
      this.processManager.send({ type: 'interrupt' })

      // 6. Restart the backend process with updated env
      setTimeout(() => {
        this.processManager.restart()
      }, 300)
    } catch (err) {
      vscode.window.showErrorMessage(this.t('ext.switch_profile_failed', { error: err instanceof Error ? err.message : String(err) }))
    }
  }

  // ====================================================================
  // WebviewViewProvider implementation
  // ====================================================================

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView

    // Restore IDE-specific profile (isolated from CLI's .env)
    this.restoreIdeProfile()

    // Auto-start the Claude Code process when the panel is first opened
    this.processManager.start()

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    }

    webviewView.webview.html = this.getHtmlContent(webviewView.webview)

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case 'ready':
          this.isWebviewReady = true
          // Flush queued messages
          while (this.messageQueue.length > 0) {
            webviewView.webview.postMessage(this.messageQueue.shift()!)
          }
          // Flush buffered logs
          for (const log of this.logBuffer) {
            webviewView.webview.postMessage({ type: 'log', message: log } as IncomingMessage)
          }
          this.logBuffer = []
          // Send workspace files list for @mention autocomplete
          this.sendWorkspaceFiles(webviewView.webview)
          // Send model profiles list
          this.sendModelProfiles(webviewView.webview)
          break

        case 'user_message':
          this.processManager.send({
            type: 'user',
            message: { role: 'user', content: message.content },
            parent_tool_use_id: null,
            attachments: message.attachments,
          })
          break

        case 'control_response':
          this.processManager.send({
            type: 'control_response',
            request_id: message.request_id,
            response: {
              allowed: message.allowed,
              session: message.session,
              always: message.always,
              reason: message.reason,
              updatedInput: message.updatedInput,
            },
          })
          break

        case 'interrupt':
          this.processManager.send({ type: 'interrupt' })
          break

        case 'list_sessions':
          this.processManager.send({ type: 'list_sessions' } as OutgoingMessage)
          break

        case 'load_session':
          this.processManager.send({ type: 'load_session', session_id: message.session_id } as OutgoingMessage)
          break

        case 'resume_session':
          this.processManager.send({ type: 'resume_session', session_id: message.session_id } as OutgoingMessage)
          break

        case 'delete_session':
          this.processManager.send({ type: 'delete_session', session_id: message.session_id } as OutgoingMessage)
          break

        case 'rename_session':
          this.processManager.send({ type: 'rename_session', session_id: message.session_id, title: message.title } as OutgoingMessage)
          break

        case 'new_session':
          this.processManager.send({ type: 'new_session' } as OutgoingMessage)
          break

        case 'pin_session':
          this.processManager.send({ type: 'pin_session', session_id: message.session_id, pinned: message.pinned } as OutgoingMessage)
          break

        case 'list_tasks':
          this.processManager.send({ type: 'list_tasks' } as OutgoingMessage)
          break

        case 'kill_task':
          this.processManager.send({ type: 'kill_task', task_id: message.task_id } as OutgoingMessage)
          break

        case 'set_permission_mode':
          this.processManager.send({ type: 'set_permission_mode', mode: message.mode } as OutgoingMessage)
          break

        case 'compact':
          this.processManager.send({ type: 'compact' } as OutgoingMessage)
          break

        case 'request_file_pick':
          // Re-send workspace files so the inline dropdown can show
          this.sendWorkspaceFiles(webviewView.webview)
          break

        case 'request_file_content':
          this.handleFileContentRequest(webviewView.webview, message.path, message.isDir || false)
          break

        case 'set_model_profile':
          this.handleSetModelProfile(webviewView.webview, message.profile)
          break

        case 'request_model_profiles':
          this.sendModelProfiles(webviewView.webview)
          break

        case 'get_quick_cmds': {
          const qcPath = path.join(os.homedir(), '.claude', 'quick-cmds.json')
          let qcData: { name: string; command: string }[] = []
          try {
            if (fs.existsSync(qcPath)) {
              qcData = JSON.parse(fs.readFileSync(qcPath, 'utf8'))
            }
          } catch {}
          webviewView.webview.postMessage({ type: 'quick_cmds_data', commands: qcData })
          break
        }

        case 'save_quick_cmds': {
          const qcSavePath = path.join(os.homedir(), '.claude', 'quick-cmds.json')
          try {
            const dir = path.dirname(qcSavePath)
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(qcSavePath, JSON.stringify(message.commands, null, 2), 'utf8')
            webviewView.webview.postMessage({ type: 'quick_cmds_saved' })
          } catch (err) {
            webviewView.webview.postMessage({ type: 'quick_cmds_error', error: String(err) })
          }
          break
        }

        case 'open_file':
          Promise.resolve().then(() => {
            var p = message.path;
            // Resolve relative paths against workspace root
            if (p && !path.isAbsolute(p)) {
              var root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
              if (root) p = path.join(root, p);
            }
            return vscode.workspace.openTextDocument(vscode.Uri.file(p));
          })
            .then(doc => vscode.window.showTextDocument(doc))
            .catch(() => { /* file no longer exists or can't be opened */ })
          break

        case 'side_question':
          this.processManager.send({
            type: 'side_question',
            question: message.question,
            context_id: message.context_id,
          } as OutgoingMessage)
          break

        case 'list_rewind_points':
          this.processManager.send({ type: 'list_rewind_points' } as OutgoingMessage)
          break

        case 'execute_rewind':
          this.processManager.send({ type: 'execute_rewind', messageId: message.messageId } as OutgoingMessage)
          break
      }
    })

    webviewView.onDidDispose(() => {
      this.view = null
      this.isWebviewReady = false
    })

    // Refresh profiles when panel becomes visible (profiles may have been
    // created/removed while the panel was hidden). Needed because
    // retainContextWhenHidden=true means ready only fires once.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendModelProfiles(webviewView.webview)
      }
    })
  }

  dispose(): void {
    this.view = null
    this.isWebviewReady = false
  }

  // ====================================================================
  // HTML generation
  // ====================================================================

  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = getNonce()
    const faCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'fontawesome', 'css', 'all.min.css')
    )

    const localeData = this.loadLocaleData()

    return template
      .split('{{NONCE}}').join(nonce)
      .split('{{CSP_SOURCE}}').join(webview.cspSource)
      .split('{{FA_CSS_URI}}').join(faCssUri.toString())
      .split('{{LOCALE_DATA}}').join(JSON.stringify(localeData))
      .split('{{TOKENS_CSS}}').join(tokensCSS)
      .split('{{STYLES_NEW_CSS}}').join(stylesNewCSS)
      .split('{{HLJS_CSS}}').join(hljsCss.replace(/<\/style>/gi, '<\\/style>'))
      .split('{{HLJS_JS}}').join(hljsBundle)
      .split('{{MARKED_JS}}').join(markedBundle)
      .split('{{MARKED_HIGHLIGHT_JS}}').join(markedHighlightBundle)
      .split('{{APP_NEW_JS}}').join(
        localeJS + '\n' + stateJS + '\n' + domJS + '\n' + apiJS + '\n' +
        sessionPanelJS + '\n' + messageStreamJS + '\n' +
        inputAreaJS + '\n' + contextBarJS + '\n' + selectionPreviewJS + '\n' +
        statusBarJS + '\n' + tasksPanelJS + '\n' + planPanelJS + '\n' + queuePanelJS + '\n' +
        permPromptJS + '\n' + rewindPointsJS + '\n' + toastJS + '\n' +
        filePickerJS + '\n' + emojiPickerJS + '\n' + slashAutocompleteJS + '\n' +
        markdownEditorJS + '\n' + quickCmdManagerJS + '\n' + sideQuestionJS + '\n' + askQuestionJS + '\n' + contextDetailJS + '\n' + historyBrowserJS + '\n' + appNewJS
      )
  }

  private loadLocaleData(): Record<string, string> {
    const config = vscode.workspace.getConfiguration('claudeCode')
    const configLang = config.get<string>('language', 'auto')
    const vsCodeLang = vscode.env.language.toLowerCase()
    const lang = configLang === 'auto' ? vsCodeLang : configLang

    // Try to load the requested language, fall back to English
    const loadLocaleFile = (locale: string): Record<string, string> | null => {
      const localePath = path.join(localesDir, locale + '.json')
      try {
        if (fs.existsSync(localePath)) {
          return JSON.parse(fs.readFileSync(localePath, 'utf8'))
        }
      } catch {}
      return null
    }

    // Try exact match first, then prefix match (zh-cn → zh), then English
    let data = loadLocaleFile(lang)
    if (!data && lang.includes('-')) {
      data = loadLocaleFile(lang.split('-')[0])
    }
    if (!data) {
      data = loadLocaleFile('en')
    }
    return data || {}
  }

  private t(key: string, params?: Record<string, string>): string {
    const locale = this.loadLocaleData()
    let val = locale[key]
    if (!val) return key
    if (params) {
      for (const k of Object.keys(params)) {
        val = val.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k])
      }
    }
    return val
  }
}

function getNonce(): string {
  let text = ''
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}
