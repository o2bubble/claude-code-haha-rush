/**
 * IDE Mode Entrypoint
 *
 * Bridges Claude Code with VS Code (or any IDE) extension over a local
 * WebSocket server. The IDE spawns:
 *
 *   bun --env-file=.env ./src/entrypoints/cli.tsx --ide-mode
 *
 * Claude Code starts a WebSocket server on 127.0.0.1 with a random port,
 * prints the port to stdout, then the IDE connects and communicates via
 * JSON messages over WebSocket.
 *
 * All agent operations (API calls, tool execution, permissions) run in
 * THIS process. The IDE extension is a frontend shell — it renders the
 * conversation and collects IDE context.
 *
 * ## Startup
 *
 * The server prints exactly one line to stdout before binding:
 *   CLAUDE_CODE_IDE_PORT=<port>
 * The IDE reads this line to discover the WebSocket endpoint.
 * stderr is used for all logging.
 *
 * ## Protocol (WebSocket messages, both directions)
 *
 * All messages are JSON objects with a `type` field.
 *
 * ### IDE → Claude Code
 *
 *   {"type":"user","message":{"role":"user","content":"..."},"parent_tool_use_id":null}
 *   {"type":"ide_context","files":[...],"selection":{...},"diagnostics":[...]}
 *   {"type":"control_response","request_id":"...","response":{"allowed":true}}
 *
 * ### Claude Code → IDE
 *
 *   {"type":"assistant","message":{...},"parent_tool_use_id":null}
 *   {"type":"user","message":{...},"parent_tool_use_id":null}    // tool results
 *   {"type":"result","subtype":"success","result":"..."}
 *   {"type":"control_request","request_id":"...","request":{...}}
 *   {"type":"status","status":"compacting|ready|error"}
 *   {"type":"error","message":"..."}
 */

import type { SDKMessage } from 'src/entrypoints/agentSdkTypes.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import type { AppState } from 'src/state/AppState.js'
import type { Message, AssistantMessage } from 'src/types/message.js'
import type { Tool, ToolPermissionContext, Tools, ToolUseContext } from 'src/Tool.js'
import { getEmptyToolPermissionContext } from 'src/Tool.js'
import { getTools } from 'src/tools.js'
import { transitionPermissionMode } from '../utils/permissions/permissionSetup.js'
import { createAbortController } from 'src/utils/abortController.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import { setCwd } from 'src/utils/Shell.js'
import { preconnectAnthropicApi } from '../utils/apiPreconnect.js'
import { applyExtraCACertsFromConfig } from '../utils/caCertsConfig.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { enableConfigs, recordFirstStartTime } from '../utils/config.js'
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js'
import { configureGlobalMTLS } from '../utils/mtls.js'
import {
  ensureScratchpadDir,
  isScratchpadEnabled,
} from '../utils/permissions/filesystem.js'
import { persistEditHistory } from '../utils/editHistory.js'
import { setShellIfWindows } from '../utils/windowsPaths.js'
import { setupGracefulShutdown } from '../utils/gracefulShutdown.js'
import { shutdownLspServerManager } from '../services/lsp/manager.js'
import { setOriginalCwd, setProjectRoot, switchSession, regenerateSessionId, getSessionId, getTotalOutputTokens, getTotalInputTokens, getTotalCacheReadInputTokens, getTotalCacheCreationInputTokens } from '../bootstrap/state.js'
import type { SessionId } from '../bootstrap/state.js'

import { hasPermissionsToUseTool } from 'src/utils/permissions/permissions.js'
import { persistPermissionUpdate } from 'src/utils/permissions/PermissionUpdate.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import type { PermissionDecision, PermissionUpdateDestination } from 'src/types/permissions.js'
import { QueryEngine } from 'src/QueryEngine.js'
import type { Command } from 'src/commands.js'
import { isCommandEnabled, getCommandName } from 'src/commands.js'
import type { MCPServerConnection } from 'src/services/mcp/types.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import { getAgentDefinitionsWithOverrides } from 'src/tools/AgentTool/loadAgentsDir.js'
import { clearServerCache, getMcpToolsCommandsAndResources } from 'src/services/mcp/client.js'
import { getAllMcpConfigs } from 'src/services/mcp/config.js'
import { createTwoFilesPatch } from 'diff'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { initBuiltinPlugins } from '../plugins/bundled/index.js'
import { initBundledSkills } from '../skills/bundled/index.js'
import { storeImage } from '../utils/imageStore.js'
import { markSlashLoaded, clearSlashLoaded } from '../utils/slashCommandState.js'
import type { Base64ImageSource, ContentBlockParam, ImageBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'



import { tmpdir, homedir } from 'os'
import { readdir, readFile, unlink, writeFile } from 'fs/promises'
import { existsSync, readFileSync, readdirSync, appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import {
  sanitizePath,
  getProjectsDir,
  readSessionLite,
  extractFirstPromptFromHead,
  extractLastJsonStringField,
  validateUuid,
} from 'src/utils/sessionStoragePortable.js'
import { getLogDisplayTitle } from 'src/utils/log.js'
import type { LogOption } from 'src/types/logs.js'
import { clearSessionMetadata, clearSessionMessagesCache, flushSessionStorage, recordTranscript, resetSessionFilePointer, saveAgentName, saveCustomTitle, saveTag } from 'src/utils/sessionStorage.js'
import { getCurrentUsage, tokenCountWithEstimation } from 'src/utils/tokens.js'
import { setOnFileWritten } from 'src/utils/file.js'
import {
  getContextWindowForModel,
  calculateContextPercentages,
} from 'src/utils/context.js'
import { getMainLoopModel } from 'src/utils/model/model.js'
import {
  parseEffortValue,
  convertEffortValueToLevel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  getDefaultEffortForModel,
  type EffortLevel,
  type EffortValue,
} from '../utils/effort.js'
import {
  modelSupportsThinking,
  modelSupportsAdaptiveThinking,
  modelSupportsReasoning,
} from '../utils/thinking.js'
import {
  compactConversation,
  buildPostCompactMessages,
} from 'src/services/compact/compact.js'
import type { CacheSafeParams } from 'src/utils/forkedAgent.js'
import { getSystemPrompt } from '../constants/prompts.js'
import { buildEffectiveSystemPrompt } from '../utils/systemPrompt.js'
import { getUserContext, getSystemContext } from '../context.js'
import { getMessagesAfterCompactBoundary } from '../utils/messages.js'
import { microcompactMessages } from '../services/compact/microCompact.js'
import { runSideQuestion } from '../utils/sideQuestion.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import { setLastSummarizedMessageId } from '../services/SessionMemory/sessionMemoryUtils.js'
import { runPostCompactCleanup } from '../services/compact/postCompactCleanup.js'
import { processSessionStartHooks } from '../utils/sessionStart.js'
import { executeStopHooks } from '../utils/hooks.js'
import { suppressCompactWarning } from '../services/compact/compactWarningState.js'
import { markPostCompaction } from '../bootstrap/state.js'
import { listTasks, getTaskListId, onTasksUpdated, isTodoV2Enabled } from '../utils/tasks.js'
import type { Task } from '../utils/tasks.js'
import {
  fileHistoryRewind,
  fileHistoryGetDiffStats,
  fileHistoryEnabled,
} from '../utils/fileHistory.js'

// ============================================================================
// IDE Protocol Types
// ============================================================================

import type {
  IDEFileContext,
  IDESelection,
  IDEDiagnostic,
  StdinMessage,
  StdoutMessage,
  IDEControlRequest,
  IDEControlResponse,
  IDESessionMeta,
  IDESessionListResponse,
  IDESessionLoadedResponse,
  IDETaskListMessage,
} from 'src/ide/protocol.js'

// ============================================================================
// Global state
// ============================================================================

let appState: AppState
let setAppStateFn: (f: (prev: AppState) => AppState) => void
let mutableMessages: Message[] = []
let readFileCache = createFileStateCacheWithSizeLimit(200)
let tools: Tools = []
let commands: Command[] = []
let mcpClients: MCPServerConnection[] = []
let agents: AgentDefinition[] = []
let currentEngine: QueryEngine | null = null
// Concurrency protection: only one user prompt at a time
let busy = false
let currentAbortController: AbortController | null = null
// Thinking mode toggle — user can enable/disable extended thinking
let thinkingEnabled = false
// GUI-set effort strength (drives `output_config.effort`; on reasoning-capable
// providers it also drives `reasoning:{effort}`). Undefined = follow model default.
let sessionEffort: EffortValue | undefined = undefined

function getThinkingConfig(): { type: 'disabled' } | { type: 'enabled'; budget_tokens: number } {
  if (!thinkingEnabled) return { type: 'disabled' }
  return { type: 'enabled', budget_tokens: 16000 }
}

/**
 * Resolve the `reasoning:{effort}` value for the current model/session.
 * - Not reasoning-capable (Claude-native) → undefined (claude.ts uses the
 *   `thinking` block instead).
 * - Thinking off → 'none'.
 * - Thinking on → the GUI effort strength, or 'high' when none chosen.
 */
function getReasoningEffortForModel(model: string): EffortLevel | 'none' | undefined {
  if (!modelSupportsReasoning(model)) return undefined
  if (!thinkingEnabled) return 'none'
  if (sessionEffort !== undefined) {
    // DeepSeek's `reasoning.effort` accepts none/low/high/max — no 'medium'.
    const level =
      typeof sessionEffort === 'string'
        ? sessionEffort
        : convertEffortValueToLevel(sessionEffort)
    return level === 'medium' ? 'high' : level
  }
  return 'high'
}

/** Recomputed whenever thinking/effort changes and written onto appState so
 *  every query path (query.ts:694 reads appState.effortValue) picks it up. */
function syncEffortAndReasoningState(): void {
  const model = getMainLoopModel()
  appState = {
    ...appState,
    effortValue: sessionEffort,
    reasoningEffort: getReasoningEffortForModel(model),
  }
}

/** Static per-model capabilities the GUI uses to decide which tiers to show. */
function getModelCapabilities(model: string) {
  return {
    effort: modelSupportsEffort(model),
    maxEffort: modelSupportsMaxEffort(model),
    thinking: modelSupportsThinking(model),
    adaptiveThinking: modelSupportsAdaptiveThinking(model),
    reasoning: modelSupportsReasoning(model),
    defaultEffort: getDefaultEffortForModel(model),
  }
}
// Track previous task state for detecting changes (background agent notifications)
const previousTaskSnapshots = new Map<string, { status: string; description: string; tool_uses: number; total_tokens: number; msg_count: number; last_tool?: string }>()

const pendingControlRequests: Map<
  string,
  { resolve: (result: unknown) => void; reject: (err: unknown) => void; toolName?: string }
> = new Map()

/**
 * Interactive command session — keeps the backend waiting for user input
 * from the webview while an interactive command is running.
 */

const sessionAllowedTools = new Set<string>()

let ideContext: {
  files: IDEFileContext[]
  selection: IDESelection | null
  diagnostics: IDEDiagnostic[]
} = { files: [], selection: null, diagnostics: [] }

// ============================================================================
// claude-mem direct bridge (bypasses hook registration issue in IDE mode)
// ============================================================================

function getClaudeMemPluginRoot(): string | null {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  // Check marketplace dir first, then cache
  const candidates = [
    join(configDir, 'plugins', 'marketplaces', 'thedotmack', 'plugin'),
  ]
  // Also check cache for latest version
  try {
    const cacheBase = join(configDir, 'plugins', 'cache', 'thedotmack', 'claude-mem')
    const versions = readdirSync(cacheBase)
    versions.sort().reverse() // latest first
    if (versions.length > 0) {
      candidates.push(join(cacheBase, versions[0], 'plugin'))
    }
  } catch {}
  for (const p of candidates) {
    const scriptPath = join(p, 'scripts', 'bun-runner.js')
    if (existsSync(scriptPath)) return p
  }
  return null
}

function runClaudeMemHook(
  action: string,
  hookInput: Record<string, unknown>,
): void {
  try {
    const pluginRoot = getClaudeMemPluginRoot()
    if (!pluginRoot) return
    const { spawn } = require('child_process') as typeof import('child_process')
    const workerScript = join(pluginRoot, 'scripts', 'worker-service.cjs')
    const runnerScript = join(pluginRoot, 'scripts', 'bun-runner.js')
    const child = spawn('node', [runnerScript, workerScript, 'hook', 'claude-code', action], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    })
    child.stdin.write(JSON.stringify(hookInput))
    child.stdin.end()
    child.on('error', () => { /* ignore spawn errors — fire and forget */ })
  } catch {
    // claude-mem not installed, node not in PATH, or plugin scripts missing
    // Silently skip — hooks are optional enhancements
  }
}

// Track connected WebSocket clients for broadcasting
const connectedClients = new Set<WebSocket>()
// Queue messages sent before any client connects (prevents lost ready/status events)
const preConnectQueue: StdoutMessage[] = []

// ============================================================================
// WebSocket broadcasting
// ============================================================================

function broadcastToAll(msg: StdoutMessage): void {
  const raw = jsonStringify(msg)
  for (const ws of connectedClients) {
    try {
      ws.send(raw)
    } catch {
      // Client may have disconnected between check and send
      connectedClients.delete(ws)
    }
  }
}

function broadcastToAllExcept(msg: StdoutMessage, exclude: WebSocket): void {
  const raw = jsonStringify(msg)
  for (const ws of connectedClients) {
    if (ws === exclude) continue
    try {
      ws.send(raw)
    } catch {
      connectedClients.delete(ws)
    }
  }
}

function broadcastSlashCommands(ws?: WebSocket) {
  const builtInIdeCommands = [
    { cmd: 'mcp-refresh', desc: 'Reload MCP servers from settings', type: 'local' as const },
  ]
  const slashCmds = [
    ...builtInIdeCommands,
    ...commands.filter(c => isCommandEnabled(c)).map(c => ({
      cmd: getCommandName(c),
      desc: (c as Record<string, unknown>).description as string || getCommandName(c),
      type: (c as Record<string, unknown>).type as string || 'local',
    })),
    ...agents.map(a => ({
      cmd: a.name,
      desc: (a as Record<string, unknown>).description as string || a.name,
      type: 'skill' as const,
    })),
  ]
  const msg = { type: 'system' as const, subtype: 'slash_commands' as const, commands: slashCmds }
  if (ws) {
    ws.send(jsonStringify(msg))
  } else {
    broadcastToAll(msg)
  }
}

/**
 * Detects file edit tool results from a user message event and sends
 * file_edit notifications to connected IDE clients for Timeline integration.
 *
 * FileEditTool:  "The file /path/to/file has been updated..."
 * FileWriteTool: "Wrote /path/to/file" or "File written to /path/to/file"
 */
function detectAndBroadcastFileEdits(event: { message?: Record<string, unknown> }): void {
  const content = event.message?.content;
  if (!Array.isArray(content)) return;

  const edits: Array<{ path: string; absPath: string }> = [];

  for (const block of content) {
    const tb = block as Record<string, unknown>;
    if (tb.type !== 'tool_result') continue;
    const text = (typeof tb.content === 'string' ? tb.content : '') ||
      (Array.isArray(tb.content) && (tb.content as Array<{ text?: string }>)[0]?.text) || '';

    let match = text.match(/^The file (.+?) has been updated/);
    if (!match) match = text.match(/^File created successfully at: (.+)$/);
    if (!match) match = text.match(/^File deleted: (.+)$/);
    if (!match) match = text.match(/^Deleted file (.+)$/);
    if (!match) match = text.match(/^The file (.+?) has been deleted/);
    if (match) edits.push({ path: match[1], absPath: match[1] });
  }

  if (edits.length === 0) return;

  const messageId = (event.message?.uuid as string) || crypto.randomUUID();

  for (const edit of edits) {
    const fileName = edit.absPath.split(/[/\\]/).pop() || edit.absPath;

    broadcastToAll({
      type: 'file_edit',
      path: edit.absPath,
      messageId,
      label: `AI 编辑: ${fileName}`,
      preEditContent: '',
    });
  }

  // Persist to shared edit-history.jsonl (used by both IDE and CLI)
  if (Array.isArray(content)) {
    persistEditHistory(
      content as Array<Record<string, unknown>>,
      process.cwd(),
      getSessionId(),
    );
  }
}

// ============================================================================
// Permission handling
// ============================================================================

function buildCanUseTool(): CanUseToolFn {
  return async (
    tool: Tool,
    input: Record<string, unknown>,
    toolUseContext: ToolUseContext,
    _assistantMessage: AssistantMessage,
    _toolUseID: string,
  ): Promise<PermissionDecision> => {
    const permissionResult = await hasPermissionsToUseTool(
      tool,
      input,
      toolUseContext,
      undefined,
    )

    if (
      permissionResult.behavior !== 'ask' &&
      permissionResult.behavior !== undefined
    ) {
      return permissionResult
    }

    // Check session-level allow (in-memory, user clicked "Session Allow")
    if (sessionAllowedTools.has(tool.name)) {
      return {
        behavior: 'allow',
        decisionReason: { type: 'other', reason: 'session_allow' },
      }
    }

    // Check if the current turn has been interrupted before waiting for user
    if (currentAbortController?.signal.aborted) {
      return {
        behavior: 'deny',
        message: 'Interrupted',
        decisionReason: { type: 'other', reason: 'interrupted' },
      }
    }

    const requestId = crypto.randomUUID()
    const request: IDEControlRequest = {
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: tool.name,
        tool_use_id: _toolUseID ?? '',
        input,
        action_description:
          tool.getActivityDescription?.(input) ??
          tool.getToolUseSummary?.(input) ??
          tool.name,
      },
    }

    broadcastToAll(request)

    try {
      const response = await new Promise<IDEControlResponse>(
        (resolve, reject) => {
          const onAbort = () => {
            pendingControlRequests.delete(requestId)
            reject(new Error('Interrupted'))
          }
          if (currentAbortController?.signal.aborted) {
            onAbort()
            return
          }
          currentAbortController?.signal.addEventListener('abort', onAbort, { once: true })
          pendingControlRequests.set(requestId, {
            resolve: r => {
              currentAbortController?.signal.removeEventListener('abort', onAbort)
              clearTimeout(timerHandle)
              resolve(r as IDEControlResponse)
            },
            reject: err => {
              currentAbortController?.signal.removeEventListener('abort', onAbort)
              clearTimeout(timerHandle)
              reject(err)
            },
            toolName: tool.name,
          })
          const timerHandle = setTimeout(() => {
            if (pendingControlRequests.has(requestId)) {
              pendingControlRequests.delete(requestId)
              reject(new Error('Permission request timed out'))
            }
          }, 300_000)
        },
      )

      if (response.response.allowed) {
        return {
          behavior: 'allow',
          decisionReason: {
            type: 'other',
            reason: response.response.reason ?? 'user',
          },
          updatedInput: response.response.updatedInput,
        }
      }
      return {
        behavior: 'deny',
        message: response.response.reason ?? 'Permission denied by user',
        decisionReason: {
          type: 'other',
          reason: response.response.reason ?? 'user',
        },
      }
    } catch {
      // If the abort signal was set (user clicked stop), propagate interrupted
      // reason instead of misleading 'timeout' so the engine can stop promptly
      if (currentAbortController?.signal.aborted) {
        return {
          behavior: 'deny',
          message: 'Interrupted',
          decisionReason: { type: 'other', reason: 'interrupted' },
        }
      }
      return {
        behavior: 'deny',
        message: 'Permission request timed out',
        decisionReason: { type: 'other', reason: 'timeout' },
      }
    }
  }
}

// ============================================================================
// Build IDE-augmented user prompt
// ============================================================================

function buildIDEContextPrompt(): string | null {
  const parts: string[] = []

  if (ideContext.files.length > 0) {
    parts.push('## IDE Context - Open Files\n')
    for (const file of ideContext.files) {
      const lang = file.language ? ` (${file.language})` : ''
      parts.push(`### ${file.path}${lang}\n`)
      parts.push('```')
      if (file.language) parts.push(file.language)
      parts.push('\n')
      parts.push(file.content)
      parts.push('\n```\n')
    }
  }

  if (ideContext.selection) {
    const s = ideContext.selection
    parts.push('## IDE Context - Current Selection\n')
    parts.push(
      `File: ${s.path} (lines ${s.startLine + 1}:${s.startChar + 1} - ${s.endLine + 1}:${s.endChar + 1})\n`,
    )
    parts.push('```\n')
    parts.push(s.text)
    parts.push('\n```\n')
  }

  if (ideContext.diagnostics.length > 0) {
    parts.push('## IDE Context - Diagnostics\n')
    for (const d of ideContext.diagnostics.slice(0, 20)) {
      parts.push(
        `- ${d.severity.toUpperCase()}: ${d.path}:${d.line}:${d.column} - ${d.message}\n`,
      )
    }
  }

  // Edit history reference — injected on every turn so even old sessions see it
  const editHistoryPath = join(
    homedir(), '.claude', 'projects',
    sanitizePath(process.cwd()),
    'edit-history.jsonl',
  )
  parts.push(
    '## Edit History\n' +
    `Every file edit through the VS Code plugin is logged to \`${editHistoryPath}\`\n` +
    'in JSONL format (one JSON object per line, each with timestamp, filePath, label, and unified diff).\n' +
    '\n' +
    'When the user asks you to review/rollback recent edits:\n' +
    `1. Read the last 20 lines of \`${editHistoryPath}\` with \`tail -n 20\`\n` +
    '2. Summarize the edits to the user\n' +
    '3. If rollback is requested, read the full entry, reverse the diff, and restore the file\n' +
    '4. After restoring, mark the rollback in the edit history for traceability\n',
  )

  // Force Chinese thinking — system-level, obeyed stronger than system-reminder
  if (process.env.CLAUDE_CODE_GUI_FORCE_CHINESE) {
    parts.push(
      '# CRITICAL Language Rule\n' +
      'Your thinking/reasoning blocks (the internal monologue visible to the user)\n' +
      'MUST be written entirely in Chinese (中文). This is NOT optional — every\n' +
      'thinking block, every reasoning step, every analysis must use Chinese.\n' +
      'Do NOT use English in thinking under any circumstances.\n' +
      'This does NOT affect the language of your final response to the user.',
    )
  }

  return parts.length > 0 ? parts.join('\n') : null
}

// ============================================================================
// SDK message → WebSocket broadcast
// ============================================================================

function isSDKMessage(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && 'type' in v
}


async function forwardSDKEvent(event: SDKMessage): Promise<void> {
  if (!isSDKMessage(event)) return

  try {
    switch (event.type) {
      case 'assistant':
        broadcastToAll({
          type: 'assistant',
          message: event.message as Record<string, unknown>,
          parent_tool_use_id:
            (event as { parent_tool_use_id?: string | null })
              .parent_tool_use_id ?? null,
        })
        sendContextWindowStatus()
        break

      case 'user': {
        // Only forward tool results, not the user's own messages.
        // User messages are already rendered by the webview locally.
        const msg = event.message as Record<string, unknown>
        const content = msg.content
        if (
          Array.isArray(content) &&
          content.length > 0 &&
          (content[0] as Record<string, unknown>)?.type === 'tool_result'
        ) {
          broadcastToAll({
            type: 'user',
            message: msg,
            parent_tool_use_id:
              (event as { parent_tool_use_id?: string | null })
                .parent_tool_use_id ?? null,
          })
          // Refresh plan/task list after each tool completes
          // (covers TodoWrite, TaskCreate, TaskUpdate, etc.)
          void broadcastPlanTasks()

          // Detect file edits and notify IDE for Timeline entries
          detectAndBroadcastFileEdits(event)
        }
        break
      }

      case 'result':
        broadcastToAll({
          type: 'result',
          subtype: (event as { subtype?: string }).subtype ?? 'success',
          result: (event as { result?: string }).result,
          error: (event as { error?: string }).error,
        })
        break

      case 'status':
        broadcastToAll({
          type: 'status',
          status: (event as { status?: string | null }).status ?? null,
        })
        break

      case 'stream_event':
        broadcastToAll({
          type: 'stream_event',
          event: (event as { event?: unknown }).event,
          parent_tool_use_id:
            (event as { parent_tool_use_id?: string | null })
              .parent_tool_use_id ?? null,
        })
        break

      case 'partial_assistant':
        broadcastToAll({
          type: 'partial_assistant',
          message: event.message as Record<string, unknown>,
          parent_tool_use_id:
            (event as { parent_tool_use_id?: string | null })
              .parent_tool_use_id ?? null,
        })
        break

      case 'system':
      case 'compact_boundary':
        broadcastToAll({
          type: 'system',
          subtype: (event as { subtype?: string }).subtype ?? event.type,
          message: (event as { message?: string }).message,
        })
        break

      case 'tool_progress':
        broadcastToAll({
          type: 'tool_progress',
          data: (event as { data?: unknown }).data,
          tool_use_id:
            (event as { tool_use_id?: string }).tool_use_id ?? '',
          parent_tool_use_id:
            (event as { parent_tool_use_id?: string }).parent_tool_use_id ?? '',
        })
        break

      default:
        break
    }
  } catch {
    // Silently ignore broadcast failures so the stream doesn't break
  }
}

// ============================================================================
// Context window status
// ============================================================================

function sendContextWindowStatus(): void {
  try {
    broadcastToAll(buildContextWindowStatus())
  } catch {
    // Silently ignore
  }
}

/**
 * Build the context_window status message.
 *
 * Two distinct concepts:
 * - Window usage: how full the context window currently is. Taken from the
 *   last response's usage (every request re-sends the whole context, so its
 *   input+cache totals ARE the current window fill). Drives the progress bar.
 * - Session totals: cumulative tokens across every API call this session
 *   (STATE.modelUsage). Extra info — total in/out/cache read/cache creation.
 */
function buildContextWindowStatus() {
  const model = getMainLoopModel()
  const contextWindowSize = getContextWindowForModel(model)
  const windowUsage = getCurrentUsage(mutableMessages)
  // compact 后压缩产物（boundary + summary + messagesToKeep）无 usage → getCurrentUsage 返回
  // null，前端因 remaining_percentage=null 不更新、停留压缩前旧值。用 tokenCountWithEstimation
  // 兜底估算窗口占用（有 usage 时与原来的 getCurrentUsage 精确值完全一致）。
  const windowTokens = windowUsage
    ? windowUsage.input_tokens +
      windowUsage.cache_creation_input_tokens +
      windowUsage.cache_read_input_tokens
    : tokenCountWithEstimation(mutableMessages)
  // 直接按 token 数算百分比（估算/精确两种情形都给出非 null 的 used/remaining，前端才会更新）。
  const usedPercentage =
    contextWindowSize > 0
      ? Math.min(100, Math.max(0, Math.round((windowTokens / contextWindowSize) * 100)))
      : null
  const percentages = {
    used: usedPercentage,
    remaining: usedPercentage !== null ? 100 - usedPercentage : null,
  }

  return {
    type: 'context_window' as const,
    context_window_size: contextWindowSize,
    used_tokens: windowTokens,
    used_percentage: percentages.used,
    remaining_percentage: percentages.remaining,
    // Session-cumulative totals (extra info, not window fill)
    session_input_tokens: getTotalInputTokens(),
    session_output_tokens: getTotalOutputTokens(),
    session_cache_read_tokens: getTotalCacheReadInputTokens(),
    session_cache_creation_tokens: getTotalCacheCreationInputTokens(),
    model,
  }
}

// ============================================================================
// Plan/Todo task list
// ============================================================================

async function broadcastPlanTasks(): Promise<void> {
  try {
    if (isTodoV2Enabled()) {
      // TodoV2: read task JSON files from disk
      const taskListId = getTaskListId()
      const tasks = await listTasks(taskListId)
      const visible = tasks.filter(t => !t.metadata?._internal)
      broadcastToAll({
        type: 'plan_tasks' as any,
        tasks: visible.map(t => ({
          id: t.id,
          subject: t.subject,
          description: t.description,
          status: t.status,
          owner: t.owner,
          blockedBy: t.blockedBy,
          blocks: t.blocks,
          activeForm: t.activeForm,
        })),
      })
    } else {
      // Legacy TodoWrite: read from appState.todos (in-memory)
      const todoKey = getSessionId()
      const todos = appState.todos[todoKey] ?? []
      broadcastToAll({
        type: 'plan_tasks' as any,
        tasks: todos.map((t, i) => ({
          id: String(i),
          subject: t.content,
          description: t.content,
          status: t.status,
          owner: undefined,
          blockedBy: [] as string[],
          blocks: [] as string[],
          activeForm: t.activeForm,
        })),
      })
    }
  } catch {
    // Silently ignore — task list should never block the main flow
  }
}

// ============================================================================
// Session persistence (used by compaction to overwrite stale JSONL)
// ============================================================================

async function rewriteSessionFile(messages: Message[]): Promise<void> {
  const sessionId = getSessionId()
  const projectsDir = getProjectsDir()
  const cwd = process.cwd()
  const projectDirName = sanitizePath(cwd)
  const projectDir = join(projectsDir, projectDirName)
  const filePath = join(projectDir, `${sessionId}.jsonl`)

  try {
    // Write all messages as JSONL, overwriting the old file entirely.
    // This prevents stale pre-compaction messages from reappearing when
    // the session is loaded after a restart.
    const lines = messages.map(m => jsonStringify(m)).join('\n')
    await writeFile(filePath, lines + '\n', 'utf8')
    clearSessionMessagesCache()
  } catch {
    // Fallback: transcript persistence is non-critical; compaction already
    // updated mutableMessages in memory.
  }
}

// ============================================================================
// Compaction
// ============================================================================

async function handleCompact(ws: WebSocket): Promise<void> {
  // Flush any in-flight writes from previous turns before compact overwrites the file
  try { await flushSessionStorage() } catch {}

  if (busy) {
    ws.send(
      jsonStringify({
        type: 'error',
        message: 'Cannot compact while a prompt is being processed',
      }),
    )
    return
  }

  if (mutableMessages.length === 0) {
    ws.send(
      jsonStringify({
        type: 'error',
        message: 'No messages to compact',
      }),
    )
    return
  }

  busy = true
  const abortController = new AbortController()
  currentAbortController = abortController

  broadcastToAll({ type: 'status', status: 'compacting', busy: true })

  try {
    const model = getMainLoopModel()

    const context: ToolUseContext = {
      options: {
        commands,
        debug: false,
        mainLoopModel: model,
        tools,
        verbose: false,
        thinkingConfig: getThinkingConfig(),
        mcpClients,
        mcpResources: {},
        isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: agents, allAgents: agents },
      },
      abortController,
      readFileState: readFileCache,
      getAppState: () => appState,
      setAppState: (f: (prev: AppState) => AppState) => {
        appState = f(appState)
      },
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
    }

    // Filter out snipped messages (match /compact command behavior)
    let messages = getMessagesAfterCompactBoundary(mutableMessages)
    if (messages.length === 0) {
      ws.send(
        jsonStringify({
          type: 'error',
          message: 'No messages to compact after boundary',
        }),
      )
      busy = false
      currentAbortController = null
      broadcastToAll({ type: 'status', status: 'ready', busy: false })
      return
    }

    // Skip session memory compaction (it produces summaries that omit user
    // message history). Always use the API-based compactConversation path.
    // Run microcompact first to reduce tokens before summarization
    const microcompactResult = await microcompactMessages(messages, context)
    messages = microcompactResult.messages

    // Build proper cache-sharing params with real context (match getCacheSharingParams)
    const defaultSysPrompt = await getSystemPrompt(
      context.options.tools,
      model,
      Array.from(
        appState.toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      mcpClients,
    )
    const systemPrompt = buildEffectiveSystemPrompt({
      mainThreadAgentDefinition: undefined,
      toolUseContext: context,
      customSystemPrompt: undefined,
      defaultSystemPrompt: defaultSysPrompt,
      appendSystemPrompt: undefined,
    })
    const [userContext, systemContext] = await Promise.all([
      getUserContext(),
      getSystemContext(),
    ])

    const cacheSafeParams: CacheSafeParams = {
      systemPrompt,
      userContext,
      systemContext,
      toolUseContext: context,
      forkContextMessages: messages,
    }

    const result = await compactConversation(
      messages,
      context,
      cacheSafeParams,
      true,
      undefined,
      false,
    )

    mutableMessages = buildPostCompactMessages(result)
    readFileCache = createFileStateCacheWithSizeLimit(200)

    // Reset session memory state since legacy compaction replaces all messages
    setLastSummarizedMessageId(undefined)

    suppressCompactWarning()
    getUserContext.cache.clear?.()
    runPostCompactCleanup()

    await rewriteSessionFile(mutableMessages)
    sendContextWindowStatus()

    // Refresh session list so compaction summary appears without reload
    await handleListSessions(ws)
    void broadcastPlanTasks()

    ws.send(
      jsonStringify({
        type: 'session_loaded',
        session_id: getSessionId(),
        messages: mutableMessages.map(m => ({
          uuid: (m as Record<string, unknown>).uuid as string | undefined,
          type: m.type,
          message:
            ((m as Record<string, unknown>).message as Record<string, unknown>) ??
            (m as unknown as Record<string, unknown>),
          parent_tool_use_id:
            ((m as Record<string, unknown>).parent_tool_use_id as
              | string
              | null) ?? null,
          timestamp: (m as Record<string, unknown>).timestamp as
            | string
            | undefined,
        })),
      }),
    )

    broadcastToAll({ type: 'status', status: 'ready', busy: false })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    broadcastToAll({ type: 'error', message: `Compaction failed: ${message}` })
    broadcastToAll({ type: 'status', status: 'ready', busy: false })
  } finally {
    busy = false
    currentAbortController = null
  }
}

// ============================================================================
// Background agent task monitoring
// ============================================================================

function broadcastTaskStateChanges(): void {
  const currentTasks = appState.tasks
  if (!currentTasks) return

  for (const [taskId, task] of Object.entries(currentTasks)) {
    const taskType = (task as Record<string, unknown>).type as string
    if (taskType !== 'local_agent' && taskType !== 'in_process_teammate') continue

    const t = task as {
      description: string
      agentType?: string
      status: string
      startTime?: number
      messages?: Array<{ role: string; content: unknown; timestamp?: number }>
      progress?: {
        toolUses?: number
        toolUseCount?: number
        tokenCount?: number
        lastActivity?: { toolName: string; activityDescription?: string }
      }
      identity?: { agentName: string; teamName: string; agentId: string; color?: string }
    }
    const prev = previousTaskSnapshots.get(taskId)

    // Build identity for in_process_teammate tasks
    const identity = t.identity ? {
      agent_name: t.identity.agentName,
      team_name: t.identity.teamName,
      agent_id: t.identity.agentId,
      color: t.identity.color,
    } : undefined

    const currentMsgCount = t.messages?.length ?? 0
    const currentLastTool = t.progress?.lastActivity?.activityDescription
      ?? t.progress?.lastActivity?.toolName

    if (!prev) {
      // New task created
      previousTaskSnapshots.set(taskId, {
        status: t.status,
        description: t.description,
        tool_uses: t.progress?.toolUses ?? t.progress?.toolUseCount ?? 0,
        total_tokens: t.progress?.tokenCount ?? 0,
        msg_count: currentMsgCount,
      })
      if (t.status === 'running') {
        broadcastToAll({
          type: 'task_started',
          task_id: taskId,
          description: t.description,
          agent_type: t.agentType ?? 'unknown',
          identity,
        })
      }
    } else if (prev.status !== t.status) {
      // Status changed
      if (t.status === 'completed' || t.status === 'failed' || t.status === 'killed') {
        broadcastToAll({
          type: 'task_completed',
          task_id: taskId,
          description: t.description,
          status: t.status,
          identity,
        })
      }
      // Update snapshot
      previousTaskSnapshots.set(taskId, {
        status: t.status,
        tool_uses: t.progress?.toolUses ?? t.progress?.toolUseCount ?? prev.tool_uses,
        total_tokens: t.progress?.tokenCount ?? prev.total_tokens,
        msg_count: currentMsgCount,
      })
      // Flush any messages appended since the last push (agent finished —
      // final transcript chunk must reach the panel without waiting for poll)
      if (currentMsgCount > prev.msg_count && t.messages) {
        broadcastToAll({
          type: 'task_messages',
          task_id: taskId,
          messages: t.messages.slice(prev.msg_count),
          total: currentMsgCount,
        })
      }
    } else if (t.status === 'running') {
      // Send progress updates for running tasks
      const newToolUses = t.progress?.toolUses ?? t.progress?.toolUseCount ?? prev.tool_uses
      const newTokens = t.progress?.tokenCount ?? prev.total_tokens
      // last_tool 无条件入快照(含 undefined): 若条件性存储, 工具间隙(last_tool 变
      // undefined)时 undefined !== 旧值永真 → 每次 setAppState 都广播(风暴)。
      if (newToolUses !== prev.tool_uses || newTokens !== prev.total_tokens || currentLastTool !== prev.last_tool) {
        broadcastToAll({
          type: 'task_progress',
          task_id: taskId,
          description: t.description,
          status: t.status,
          tool_uses: newToolUses,
          total_tokens: newTokens,
          last_tool: currentLastTool,
          start_time: t.startTime,
          identity,
        })
        previousTaskSnapshots.set(taskId, {
          ...prev,
          tool_uses: newToolUses,
          total_tokens: newTokens,
          last_tool: currentLastTool,
        })
      }
      // Push transcript deltas: messages the panel hasn't seen yet
      if (currentMsgCount > prev.msg_count && t.messages) {
        broadcastToAll({
          type: 'task_messages',
          task_id: taskId,
          messages: t.messages.slice(prev.msg_count),
          total: currentMsgCount,
        })
        previousTaskSnapshots.set(taskId, { ...prev, msg_count: currentMsgCount })
      }
    }
  }

  // Clean up tasks that were removed from appState.tasks.
  // If they were still running, broadcast completion before removing.
  for (const taskId of previousTaskSnapshots.keys()) {
    if (!currentTasks[taskId]) {
      const prev = previousTaskSnapshots.get(taskId)!
      if (prev.status === 'running') {
        broadcastToAll({
          type: 'task_completed',
          task_id: taskId,
          description: prev.description ?? '',
          status: 'completed',
        } as any)
      }
      previousTaskSnapshots.delete(taskId)
    }
  }
}

async function handleSideQuestion(ws: WebSocket, question: string, context_id: string): Promise<void> {
  try {
    // Build lightweight params — translation doesn't need full context.
    // Skip systemPrompt, userContext, systemContext, and conversation history
    // to avoid wasting tokens on an unnecessary prompt cache prefix.
    const model = getMainLoopModel()
    const toolUseContext: ToolUseContext = {
      options: {
        tools: [],
        commands: [],
        debug: false,
        mainLoopModel: model,
        verbose: false,
        thinkingConfig: getThinkingConfig(),
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      abortController: createAbortController(),
      readFileState: createFileStateCacheWithSizeLimit(0),
      getAppState: () => appState,
      setAppState: setAppStateFn,
      messages: [],
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
    }

    const cacheSafeParams: CacheSafeParams = {
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      toolUseContext,
      forkContextMessages: [],
    }

    const result = await runSideQuestion({ question, cacheSafeParams })
    ws.send(jsonStringify({ type: 'side_question_result', context_id, response: result.response ?? undefined }))
  } catch (err) {
    ws.send(jsonStringify({
      type: 'side_question_result',
      context_id,
      error: err instanceof Error ? err.message : String(err),
    }))
  }
}

// ============================================================================
// Initialize
// ============================================================================

async function initialize(): Promise<void> {
  const cwd = process.cwd()
  setCwd(cwd)
  setOriginalCwd(cwd)
  setProjectRoot(cwd)

  // Set up git-bash on Windows: process.env.SHELL must point to Git Bash
  // so findSuitableShell() picks it instead of WSL's bash.exe
  setShellIfWindows()

  // Enable config reading (must happen before getTools / QueryEngine)
  enableConfigs()

  // Apply env vars, proxy, mTLS, and CA certs from settings (no trust dialog in IDE mode)
  applyConfigEnvironmentVariables()
  applyExtraCACertsFromConfig()
  configureGlobalMTLS()
  setupGracefulShutdown()
  registerCleanup(shutdownLspServerManager)
  recordFirstStartTime()
  preconnectAnthropicApi()
  if (isScratchpadEnabled()) {
    await ensureScratchpadDir()
  }

  // Initialize plugins and bundled skills before loading commands
  initBuiltinPlugins()
  initBundledSkills()

  appState = getDefaultAppState()
  setAppStateFn = (f: (prev: AppState) => AppState) => {
    appState = f(appState)
    broadcastTaskStateChanges()
  }

  const toolPermissionContext = getEmptyToolPermissionContext()
  tools = getTools(toolPermissionContext)

  try {
    const { getCommands } = await import('../commands.js')
    commands = await getCommands(cwd)
  } catch {
    commands = []
  }

  try {
    const agentDefs = await getAgentDefinitionsWithOverrides(cwd)
    agents = agentDefs.activeAgents
  } catch {
    // Use built-in agents only on failure
  }

  // Connect MCP servers so IDE mode has the same tooling as TUI
  try {
    await getMcpToolsCommandsAndResources(({ client, tools: mcpTools, commands: mcpCommands }) => {
      // Track connected MCP clients
      const existing = mcpClients.findIndex(c => c.name === client.name)
      if (existing >= 0) {
        mcpClients[existing] = client
      } else {
        mcpClients = [...mcpClients, client]
      }
      // Merge MCP tools (dedup by name)
      const toolNames = new Set(tools.map(t => t.name))
      for (const t of mcpTools) {
        if (!toolNames.has(t.name)) {
          tools = [...tools, t]
          toolNames.add(t.name)
        }
      }
      // Merge MCP commands (dedup by name)
      const cmdNames = new Set(commands.map(c => getCommandName(c)))
      for (const c of mcpCommands) {
        if (!cmdNames.has(getCommandName(c))) {
          commands = [...commands, c]
          cmdNames.add(getCommandName(c))
        }
      }
    })
  } catch (err) {
    console.error('[ideMode] MCP connection failed (non-fatal):', err instanceof Error ? err.message : String(err))
    // MCP connection failure is non-fatal — continue without MCP tools
  }

  readFileCache = createFileStateCacheWithSizeLimit(200)
}

/**
 * Refresh MCP connections for any servers not currently connected.
 * Used after loading/resuming a session to pick up new MCP configs from settings.
 */
async function refreshMcpTools(): Promise<void> {
  try {
    const { servers: mcpConfigs } = await getAllMcpConfigs()
    // Clear memo cache for failed/unconnected servers so they can retry
    for (const [name, config] of Object.entries(mcpConfigs)) {
      const existing = mcpClients.find(c => c.name === name)
      if (!existing || existing.type !== 'connected') {
        await clearServerCache(name, config)
        // Remove failed client so it gets replaced on reconnect
        if (existing) {
          mcpClients = mcpClients.filter(c => c.name !== name)
        }
      }
    }
    // Re-run MCP connection — already-connected servers are memoized and skipped
    await getMcpToolsCommandsAndResources(({ client, tools: mcpTools, commands: mcpCommands }) => {
      const existing = mcpClients.findIndex(c => c.name === client.name)
      if (existing >= 0) {
        mcpClients[existing] = client
      } else {
        mcpClients = [...mcpClients, client]
      }
      const toolNames = new Set(tools.map(t => t.name))
      for (const t of mcpTools) {
        if (!toolNames.has(t.name)) {
          tools = [...tools, t]
          toolNames.add(t.name)
        }
      }
      const cmdNames = new Set(commands.map(c => getCommandName(c)))
      for (const c of mcpCommands) {
        if (!cmdNames.has(getCommandName(c))) {
          commands = [...commands, c]
          cmdNames.add(getCommandName(c))
        }
      }
    })
  } catch (err) {
    console.error('[ideMode] Failed to refresh MCP tools:', err instanceof Error ? err.message : String(err))
  }
}

// ============================================================================
// Handle a single user prompt turn
// ============================================================================

// ============================================================================
// Slash command dispatcher for IDE mode
// ============================================================================

/** Persist slash command input/output to session transcript */
async function persistSlashResult(input: string, output: string): Promise<void> {
  try {
    const uuid = crypto.randomUUID()
    const now = new Date().toISOString()
    // Build simple user + assistant message pair
    const userMsg: Message = {
      uuid,
      type: 'user' as const,
      message: { role: 'user' as const, content: input },
      timestamp: now,
    } as Message
    const asstMsg: Message = {
      uuid: crypto.randomUUID(),
      type: 'assistant' as const,
      message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: output }] },
      parent_tool_use_id: null,
      timestamp: new Date().toISOString(),
    } as Message
    mutableMessages = [...mutableMessages, userMsg, asstMsg]
    await recordTranscript(mutableMessages)
    await flushSessionStorage()
    clearSessionMessagesCache()
  } catch {
    // Non-critical — session history is best-effort
  }
}

async function tryHandleSlashCommand(input: string, ws?: WebSocket): Promise<boolean> {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return false

  const spaceIndex = trimmed.indexOf(' ')
  const rawName = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)
  const args = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim()

  if (!rawName) return false

  // Built-in IDE commands (not registered in the commands system)
  if (rawName === 'mcp-refresh') {
    broadcastToAll({ type: 'status', status: 'thinking', busy: true })
    await refreshMcpTools()
    broadcastToAll({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '✅ MCP tools refreshed from settings' }] },
    })
    broadcastToAll({ type: 'result', subtype: 'success' })
    return true
  }

  const matchingCommand = commands.find(cmd =>
    isCommandEnabled(cmd) &&
    (cmd.name === rawName || (cmd as any).aliases?.includes(rawName) || getCommandName(cmd) === rawName)
  )
  if (!matchingCommand) return false

  // 任意 slash 命令都会短暂占用后端（prompt/memory 会设 busy，local 也可能慢）。
  // 前端据此保守判忙（消息入队稍等）比误判空闲直发撞 busy 更安全 —— 结束的
  // ready/result 会把 backendBusy 清回 false。
  broadcastToAll({ type: 'status', status: 'thinking', busy: true })

  // Build minimal context
  const ctx: ToolUseContext = {
    options: {
      commands,
      tools,
      mcpClients,
      debug: false,
      verbose: false,
      mainLoopModel: getMainLoopModel(),
      agentDefinitions: appState?.agentDefinitions ?? { activeAgents: [], allAgents: [] },
    },
    // These are needed by some local commands (e.g. compact reads messages)
    abortController: new AbortController(),
    messages: mutableMessages,
    readFileCache,
    getAppState: () => appState,
    setAppState: (f: (prev: AppState) => AppState) => {
      appState = f(appState)
    },
  } as any

  try {
    // Prompt type: inject the skill prompt into the conversation
    if (matchingCommand.type === 'prompt') {
      const getPrompt = (matchingCommand as any).getPromptForCommand
      if (!getPrompt) return false
      const promptContent = await getPrompt(args, ctx)
      // Inject system-reminder for disableModelInvocation skills so the model
      // knows the skill is already loaded and has a path to read directly.
      if (matchingCommand.disableModelInvocation) {
        const skillPath = (matchingCommand as any).skillRoot
          ? `${(matchingCommand as any).skillRoot}/SKILL.md`
          : null
        const reminder = skillPath
          ? `<system-reminder>\nSkill "/${rawName}" has been loaded via slash command and is now active in context. Follow its instructions directly. Skill definition at: ${skillPath}\n</system-reminder>`
          : `<system-reminder>\nSkill "/${rawName}" has been loaded via slash command and is now active in context. Follow its instructions directly.\n</system-reminder>`
        promptContent.unshift({ type: 'text', text: reminder })
      }
      busy = true
      // Fix C: mark this skill as slash-loaded so SkillTool can intercept
      // re-invocation attempts instead of returning an error
      markSlashLoaded(rawName)
      try {
        await runPromptCommand(promptContent)
      } finally {
        clearSlashLoaded()
      }
      return true
    }

    // Block local commands that explicitly don't support non-interactive mode
    // (except /rewind /reload-plugins which have dedicated IDE handlers below)
    if (matchingCommand.type === 'local' && !matchingCommand.supportsNonInteractive) {
      if (rawName === 'rewind' || rawName === 'checkpoint' || rawName === 'reload-plugins') {
        // Handled below by dedicated handler
      } else {
        broadcastToAll({
          type: 'tui_only_notice',
          command: rawName,
        })
        broadcastToAll({ type: 'status', status: 'ready', busy: false })
        return true
      }
    }

    // Local type: execute JS function and return text result
    if (matchingCommand.type === 'local') {
      // compact: use IDE's built-in handler with a mock WebSocket that broadcasts
      if (rawName === 'compact') {
        const mockWs = { send: (msg: string) => { try { broadcastToAll(JSON.parse(msg)); } catch {} } }
        await handleCompact(mockWs as any)
        return true
      }

      // rewind: list file history restore points in the webview
      if (rawName === 'rewind' || rawName === 'checkpoint') {
        const mockWs = {
          send: (msg: string) => { try { broadcastToAll(JSON.parse(msg)); } catch {} },
        } as WebSocket
        void handleListRewindPoints(mockWs)
        return true
      }

      // reload-plugins: refresh plugins and commands, broadcast updated list
      if (rawName === 'reload-plugins') {
        try {
          const { refreshActivePlugins } = await import('../utils/plugins/refresh.js')
          await refreshActivePlugins(setAppStateFn)
          const { getCommands } = await import('../commands.js')
          const cwd = process.cwd()  // tryHandleSlashCommand has no cwd param
          commands = await getCommands(cwd)
          broadcastSlashCommands()
          broadcastToAll({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: '✅ Plugins and commands reloaded successfully.' }] },
            parent_tool_use_id: null,
          })
        } catch (e) {
          broadcastToAll({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: `❌ Failed to reload plugins: ${e instanceof Error ? e.message : String(e)}` }] },
            parent_tool_use_id: null,
          })
        }
        broadcastToAll({ type: 'result', subtype: 'success' })
        return true
      }

      const mod = await matchingCommand.load()
      const result = await mod.call(args, ctx as any)
      if (result && result.type === 'text') {
        broadcastToAll({
          type: 'assistant',
          message: { role: 'assistant', content: result.value },
          parent_tool_use_id: null,
        })
        void persistSlashResult(trimmed, result.value)
      }
      broadcastToAll({ type: 'status', status: 'ready', busy: false })
      return true
    }


    // Block TUI-only local-jsx commands (interactive Ink components)
    const tuiOnlyLocalJsx = [
      'diff', 'plan', 'tasks', 'agents', 'export', 'model',
      'hooks', 'btw', 'terminal-setup', 'passes', 'session',
      // TUI-specific commands that are useless in IDE
      'exit', 'sandbox', 'upgrade', 'mobile', 'login', 'logout',
      'add-dir', 'chrome', 'desktop', 'feedback',
      'output-style', 'think-back', 'thinkback-play',
      'ultrareview', 'remote-env', 'privacy-settings',
      'rate-limit-options', 'install-github-app', 'install', 'stickers',
    ]
    if (tuiOnlyLocalJsx.includes(rawName)) {
      broadcastToAll({
        type: 'tui_only_notice',
        command: rawName,
      })
      broadcastToAll({ type: 'status', status: 'ready', busy: false })
      return true
    }

    // === Dedicated IDE handlers for popular local-jsx commands ===
    if (rawName === 'skills') {
      const ideCommands: string[] = []
      const tuiOnlyCommands: string[] = []
      for (const cmd of commands) {
        const name = getCommandName(cmd)
        const desc = (cmd as any).description
        if (!desc) continue
        const typeLabel = (cmd as any).type || ''
        const srcLabel = (cmd as any).source
        const tag = srcLabel && srcLabel !== 'builtin' ? ` (${srcLabel})` : typeLabel ? ` (${typeLabel})` : ''
        const line = `- **\`/${name}\`**${tag} — ${desc}`
        const isTuiOnly =
          typeLabel === 'prompt' ||
          (typeLabel === 'local' && !(cmd as any).supportsNonInteractive &&
            name !== 'rewind' && name !== 'checkpoint') ||
          name === 'doctor' || name === 'diff' ||
          name === 'plan' || name === 'tasks' || name === 'agents' ||
          name === 'export' || name === 'model' || name === 'hooks' ||
          name === 'ide' || name === 'btw' ||
          name === 'exit' || name === 'fast' || name === 'sandbox' ||
          name === 'upgrade' || name === 'mobile' || name === 'login' ||
          name === 'logout' || name === 'passes' || name === 'branch' ||
          name === 'add-dir' || name === 'chrome' || name === 'desktop' ||
          name === 'feedback' || name === 'terminal-setup' ||
          name === 'output-style' || name === 'think-back' ||
          name === 'thinkback-play' || name === 'ultrareview' ||
          name === 'tag' || name === 'session' || name === 'remote-env' ||
          name === 'privacy-settings' || name === 'rate-limit-options' ||
          name === 'install-github-app' || name === 'install' ||
          name === 'stickers' || name === 'reload-plugins'
        if (isTuiOnly) {
          tuiOnlyCommands.push(line)
        } else {
          ideCommands.push(line)
        }
      }

      const lines: string[] = [`**Available commands in IDE mode (${ideCommands.length}):**\n`, ...ideCommands]
      if (tuiOnlyCommands.length > 0) {
        lines.push('')
        lines.push(`**TUI-only commands (${tuiOnlyCommands.length}) — require terminal mode:**\n`, ...tuiOnlyCommands)
      }
      lines.push('')
      lines.push('> `(prompt)` commands make API calls and only work in TUI. All other types (`local`, `local-jsx`, `bundled`, `plugin`) run in IDE.')
      const skillsText = lines.join('\n')
      broadcastToAll({
        type: 'assistant',
        message: { role: 'assistant', content: skillsText },
        parent_tool_use_id: null,
      })
      broadcastToAll({ type: 'status', status: 'ready', busy: false })
      void persistSlashResult(trimmed, skillsText)
      return true
    }

    if (rawName === 'status') {
      const modelStr = process.env.ANTHROPIC_MODEL || 'default'
      const modeStr = appState?.toolPermissionContext?.mode ?? 'default'
      const msgCount = mutableMessages.length
      const ctxInfo = readFileCache ? `${readFileCache.size} files` : 'N/A'
      const text = [
        `**IDE Status**`,
        ``,
        `- **Model:** ${modelStr}`,
        `- **Permission mode:** ${modeStr}`,
        `- **Messages in session:** ${msgCount}`,
        `- **Cached files:** ${ctxInfo}`,
        `- **MCP clients:** ${mcpClients.length}`,
        `- **Commands loaded:** ${commands.length}`,
        `- **Agents loaded:** ${agents.length}`,
      ].join('\n')
      broadcastToAll({
        type: 'assistant',
        message: { role: 'assistant', content: text },
        parent_tool_use_id: null,
      })
      broadcastToAll({ type: 'status', status: 'ready', busy: false })
      void persistSlashResult(trimmed, text)
      return true
    }

    if (rawName === 'stats') {
      const msgCount = mutableMessages.length
      const ctxInfo = readFileCache ? `${readFileCache.size} files` : 'N/A'
      const modelStr = process.env.ANTHROPIC_MODEL || 'default'
      const text = [
        `**IDE Usage Stats**`,
        ``,
        `- **Messages:** ${msgCount}`,
        `- **Cached files:** ${ctxInfo}`,
        `- **Commands loaded:** ${commands.length}`,
        `- **Agents loaded:** ${agents.length}`,
        `- **MCP clients:** ${mcpClients.length}`,
        `- **Model:** ${modelStr}`,
        `- **Permission mode:** ${appState?.toolPermissionContext?.mode ?? 'default'}`,
        `- **Session ID:** ${getSessionId()}`,
      ].join('\n')
      broadcastToAll({
        type: 'assistant',
        message: { role: 'assistant', content: text },
        parent_tool_use_id: null,
      })
      broadcastToAll({ type: 'status', status: 'ready', busy: false })
      void persistSlashResult(trimmed, text)
      return true
    }

    if (rawName === 'memory') {
      // Trigger memory recall via the conversation (send a prompt to the API)
      broadcastToAll({ type: 'status', status: 'thinking', busy: true })
      busy = true
      const promptContent: ContentBlockParam[] = [{ type: 'text', text: 'Please recall any saved memories about the user and this project. Use the memory tool to retrieve them, then summarize what you know.' }]
      await runPromptCommand(promptContent)
      return true
    }

    if (rawName === 'copy') {
      let outputText = ''
      try {
        // Collect recent assistant texts (same logic as src/commands/copy/copy.tsx)
        const texts: string[] = []
        for (let i = mutableMessages.length - 1; i >= 0 && texts.length < 20; i--) {
          const msg = mutableMessages[i]
          if (msg?.type !== 'assistant' || (msg as any).isApiErrorMessage) continue
          const content = (msg as AssistantMessage).message.content
          if (!Array.isArray(content)) continue
          const text = content
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text)
            .join('\n\n')
          if (text) texts.push(text)
        }

        if (texts.length === 0) {
          outputText = 'No assistant message to copy'
        } else {
          let age = 0
          const arg = args?.trim()
          if (arg) {
            const n = Number(arg)
            if (!Number.isInteger(n) || n < 1) {
              outputText = `Usage: /copy [N] where N is 1 (latest), 2, 3, ... Got: ${arg}`
            } else if (n > texts.length) {
              outputText = `Only ${texts.length} assistant ${texts.length === 1 ? 'message' : 'messages'} available to copy`
            } else {
              age = n - 1
            }
          }

          if (!outputText) {
            const text = texts[age]!
            const lineCount = text.split('\n').length
            const charCount = text.length

            // Send clipboard content via WebSocket (OSC 52 doesn't work in IDE mode)
            broadcastToAll({ type: 'clipboard', text })

            // Also write to temp file (fallback, same as copy.tsx)
            const copyDir = join(tmpdir(), 'claude')
            await writeFile(join(copyDir, 'response.md'), text, 'utf-8').catch(() => {})
            // mkdir is best-effort — writeFile will fail if dir doesn't exist, catch handles it

            outputText = `Copied to clipboard (${charCount} characters, ${lineCount} lines)`
            // Note: file path omitted — temp file is a secondary fallback in IDE mode
          }
        }
      } catch (err) {
        outputText = `Command '/copy' encountered an error: ${err instanceof Error ? err.message : String(err)}`
      }
      broadcastToAll({
        type: 'assistant',
        message: { role: 'assistant', content: outputText },
        parent_tool_use_id: null,
      })
      broadcastToAll({ type: 'status', status: 'ready', busy: false })
      void persistSlashResult(trimmed, outputText)
      return true
    }

    // local-jsx: render React component to text via staticRender's Ink renderToString
    if (matchingCommand.type === 'local-jsx') {
      let outputText = ''
      try {
        const mod = await matchingCommand.load()
        let onDoneResult: string | undefined

        const onDone = (result?: string, options?: { shouldQuery?: boolean }) => {
          if (result && !options?.shouldQuery) {
            onDoneResult = result
          }
        }

        const reactNode = await mod.call(onDone, ctx as any, args)

        // If we got a ReactNode, render it to plain text.
        if (reactNode) {
          const { renderToString } = await import('../utils/staticRender.js')
          outputText = await renderToString(reactNode, 80)
        } else if (onDoneResult) {
          outputText = onDoneResult
        }
      } catch (err) {
        outputText = `Command '/${getCommandName(matchingCommand)}' encountered an error: ${err instanceof Error ? err.message : String(err)}`
      }
      if (outputText) {
        broadcastToAll({
          type: 'assistant',
          message: { role: 'assistant', content: outputText },
          parent_tool_use_id: null,
        })
        void persistSlashResult(trimmed, outputText)
      }
      broadcastToAll({ type: 'status', status: 'ready', busy: false })
      return true
    }

    return false
  } catch (err) {
    broadcastToAll({
      type: 'error',
      message: `Command failed: ${err instanceof Error ? err.message : String(err)}`,
    })
    return true
  }
}

async function runPromptCommand(promptContent: ContentBlockParam[]): Promise<void> {
  const abortController = createAbortController()
  currentAbortController = abortController

  try {
    const ideContextPrompt = buildIDEContextPrompt()
    const engine = new QueryEngine({
      cwd: process.cwd(),
      tools,
      commands,
      mcpClients,
      agents,
      canUseTool: buildCanUseTool(),
      getAppState: () => appState,
      setAppState: setAppStateFn,
      initialMessages: mutableMessages,
      readFileCache,
      abortController,
      verbose: false,
      includePartialMessages: true,
      appendSystemPrompt: ideContextPrompt ?? undefined,
    })
    currentEngine = engine

    for await (const event of engine.submitMessage(promptContent)) {
      await forwardSDKEvent(event)
      if (abortController.signal.aborted) break
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    broadcastToAll({ type: 'error', message: msg })
  } finally {
    mutableMessages = [...currentEngine!.getMessages()]
    readFileCache = currentEngine!.getReadFileState()
    // Final broadcast: interval only fires while busy, so without this the
    // freshly-updated window fill + session totals would wait for next turn.
    sendContextWindowStatus()
    try { await recordTranscript(mutableMessages) } catch {}
    try { await flushSessionStorage() } catch {}
    clearSessionMessagesCache()
    void broadcastPlanTasks()
    broadcastToAll({
      type: 'result',
      subtype: abortController.signal.aborted ? 'error' : 'success',
      result: abortController.signal.aborted ? 'interrupted' : 'turn_complete',
    })
    currentEngine = null
    currentAbortController = null
    busy = false
  }
}

async function handleUserPrompt(userContent: string | ContentBlockParam[], ws?: WebSocket): Promise<void> {
  if (busy) {
    broadcastToAll({
      type: 'error',
      message: 'A prompt is already being processed. Interrupt it first.',
    })
    return
  }

  // Route slash commands to the dispatcher
  if (typeof userContent === 'string') {
    const handled = await tryHandleSlashCommand(userContent, ws)
    if (handled) return
  }

  busy = true
  const canUseTool = buildCanUseTool()
  const abortController = createAbortController()
  currentAbortController = abortController

  // Fire-and-forget: notify claude-mem worker of this user prompt (session-init)
  void runClaudeMemHook('session-init', {
    hook_event_name: 'UserPromptSubmit',
    prompt: typeof userContent === 'string' ? userContent : '',
    session_id: getSessionId(),
  })

  broadcastToAll({ type: 'status', status: 'thinking', busy: true })

  const ideContextPrompt = buildIDEContextPrompt()

  const engine = new QueryEngine({
    cwd: process.cwd(),
    tools,
    commands,
    mcpClients,
    agents,
    canUseTool,
    getAppState: () => appState,
    setAppState: setAppStateFn,
    initialMessages: mutableMessages,
    readFileCache,
    abortController,
    verbose: false,
    includePartialMessages: true,
    appendSystemPrompt: ideContextPrompt ?? undefined,
  })

  currentEngine = engine

  try {
    for await (const event of engine.submitMessage(userContent)) {
      await forwardSDKEvent(event)
      // Check if interrupted mid-stream
      if (abortController.signal.aborted) break
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    broadcastToAll({ type: 'error', message })
  } finally {
    mutableMessages = [...engine.getMessages()]
    readFileCache = engine.getReadFileState()

    // Final broadcast: interval only fires while busy, so without this the
    // freshly-updated window fill + session totals would wait for next turn.
    sendContextWindowStatus()

    // Persist session to JSONL for session history
    // await ensures messages are flushed to disk before the turn completes
    try { await recordTranscript(mutableMessages) } catch {}
    try { await flushSessionStorage() } catch {}
    clearSessionMessagesCache()

    // Refresh session list — new sessions now have a JSONL file on disk
    if (ws) await handleListSessions(ws)

    // Broadcast updated plan/task list after turn completion
    void broadcastPlanTasks()

    broadcastToAll({
      type: 'result',
      subtype: abortController.signal.aborted ? 'error' : 'success',
      result: abortController.signal.aborted ? 'interrupted' : 'turn_complete',
    })
    broadcastToAll({ type: 'status', status: 'ready', busy: false })

    busy = false
    currentAbortController = null
    currentEngine = null
  }
}

function interruptCurrentTurn(): void {
  // Abort the shared IDE-mode controller (now also passed to QueryEngine)
  if (currentAbortController && !currentAbortController.signal.aborted) {
    currentAbortController.abort()
    // Also hit the engine's own interrupt as a belt-and-suspenders measure
    currentEngine?.interrupt()
    broadcastToAll({
      type: 'status',
      status: 'interrupting',
      busy: true,
    })
  }
  // No-op when there's no active turn — avoids broadcasting a spurious
  // 'interrupting' status that would leave the webview stuck in that state.
}

// ============================================================================
// Session history handlers
// ============================================================================

async function handleListSessions(ws: WebSocket): Promise<void> {
  try {
    const cwd = process.cwd()
    const projectsDir = getProjectsDir()
    const projectDirName = sanitizePath(cwd)
    const projectDir = join(projectsDir, projectDirName)

    let files: string[]
    try {
      files = await readdir(projectDir)
    } catch {
      ws.send(jsonStringify({ type: 'session_list', sessions: [] }))
      return
    }

    const jsonlFiles = files.filter(f => f.endsWith('.jsonl') && validateUuid(f.slice(0, -6)))
    
    if (jsonlFiles.length === 0) {
      ws.send(jsonStringify({ type: 'session_list', sessions: [] }))
      return
    }

    const sessions: IDESessionMeta[] = []

    for (const file of jsonlFiles) {
      const filePath = join(projectDir, file)
      
      const lite = await readSessionLite(filePath)
      if (!lite || lite.size === 0) continue

      const sessionId = file.replace('.jsonl', '')

      // Read sidecar meta file as supplement — the JSONL tail buffer
      // (64KB) may not reach metadata entries buried by later messages
      const meta = await readSessionMetaFile(sessionId)

      const customTitle = (meta?.customTitle as string) || extractLastJsonStringField(lite.tail, 'customTitle')
      const agentName = (meta?.agentName as string) || extractLastJsonStringField(lite.tail, 'agentName')
      const summary = (meta?.summary as string) || extractLastJsonStringField(lite.tail, 'summary')
      const tag = (meta?.tag as string) || extractLastJsonStringField(lite.tail, 'tag')
      const gitBranch = extractLastJsonStringField(lite.tail, 'gitBranch')
      const firstPrompt = extractFirstPromptFromHead(lite.head)

      // Count messages by counting JSON lines
      let messageCount = 0
      const countLines = (text: string) => {
        for (const line of text.split('\n')) {
          if (line.startsWith('{') && line.includes('"type"')) {
            messageCount++
          }
        }
      }
      countLines(lite.head)
      if (lite.tail !== lite.head) {
        countLines(lite.tail)
      }

      const title = getLogDisplayTitle({
        sessionId,
        customTitle,
        agentName,
        summary,
        firstPrompt,
      } as LogOption)

      sessions.push({
        sessionId,
        title: title || sessionId.slice(0, 8),
        messageCount,
        timestamp: new Date(lite.mtime).toISOString(),
        gitBranch: gitBranch || undefined,
        tag: tag && tag !== 'pinned' ? tag : undefined,
        pinned: tag === 'pinned',
      })
    }

    // Sort: pinned first, then by mtime descending.
    // ⚠️ 全量返回，绝不截断：GUI 的会话文件夹孤儿清理会把「不在本次列表里」的会话
    // 归属当孤儿删掉。旧 slice(0,50) 截断 → 列表不完整 → 第 51+ 个真实存在的会话
    // 被误删归属（重新显示为未分类）且被挤出列表（找不到）。列表代表完整全集，
    // 前端孤儿清理才安全。
    sessions.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    })

    ws.send(jsonStringify({
      type: 'session_list',
      sessions,
      // 总会话数（= 返回数，因全量返回）。GUI 据此判断列表是否完整：截断/分页时
      // total > 返回数 → 前端跳过会话文件夹的孤儿清理，避免误删真实会话的归属。
      total: sessions.length,
    }))
  } catch (err) {
    ws.send(
      jsonStringify({
        type: 'error',
        message: `Failed to list sessions: ${err instanceof Error ? err.message : String(err)}`,
      }),
    )
  }
}

async function handleLoadSession(
  ws: WebSocket,
  sessionId: string,
): Promise<void> {
  // Guard against non-session JSONL files (e.g., edit-history.jsonl)
  if (!validateUuid(sessionId)) {
    ws.send(jsonStringify({ type: 'error', message: `Invalid session ID: ${sessionId}` }))
    return
  }

  try {
    const projectsDir = getProjectsDir()
    const cwd = process.cwd()
    const projectDirName = sanitizePath(cwd)
    const projectDir = join(projectsDir, projectDirName)

    const filePath = join(projectDir, `${sessionId}.jsonl`)

    let raw: string
    try {
      const { readFile } = await import('fs/promises')
      // Read up to 10MB to protect memory
      const { size } = await import('fs/promises').then(
        ({ stat }) => stat(filePath),
      )
      if (size > 10 * 1024 * 1024) {
        const buf = Buffer.alloc(10 * 1024 * 1024)
        const { open } = await import('fs/promises')
        const fh = await open(filePath, 'r')
        // Read the LAST 10MB (newest messages), not the first 10MB.
        const readPos = Math.max(0, size - 10 * 1024 * 1024)
        const { bytesRead } = await fh.read(
          buf,
          0,
          10 * 1024 * 1024,
          readPos,
        )
        await fh.close()
        raw = buf.toString('utf8', 0, bytesRead)
        // Discard the first (potentially truncated) line
        const firstNl = raw.indexOf('\n')
        if (firstNl > 0) raw = raw.slice(firstNl + 1)
      } else {
        raw = await readFile(filePath, 'utf8')
      }
    } catch {
      ws.send(
        jsonStringify({
          type: 'error',
          message: `Session not found: ${sessionId}`,
        }),
      )
      return
    }

    const messages: IDESessionLoadedResponse['messages'] = []
    const lines = raw.split('\n')

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        const entryType = entry.type as string | undefined

        // Skip system entries (persistSession, file-history-snapshot, etc.)
        if (entryType === 'system') continue

        if (
          entryType === 'user' ||
          entryType === 'assistant'
        ) {
          messages.push({
            uuid: entry.uuid as string | undefined,
            type: entryType,
            message: (entry.message as Record<string, unknown>) ?? entry,
            parent_tool_use_id:
              (entry.parent_tool_use_id as string | null) ?? null,
            timestamp: entry.timestamp as string | undefined,
          })
        }
      } catch {
        // Skip unparseable lines
      }
    }

    ws.send(
      jsonStringify({
        type: 'session_loaded',
        session_id: sessionId,
        messages,
      }),
    )
  } catch (err) {
    ws.send(
      jsonStringify({
        type: 'error',
        message: `Failed to load session: ${err instanceof Error ? err.message : String(err)}`,
      }),
    )
  }
}

/**
 * Called on startup when CLAUDE_CODE_RESUME_SESSION env var is set
 * (profile/model switch restart). Loads the session file and prepares
 * messages so the WebSocket open handler can send session_loaded.
 */
async function handleResumeSession(
  ws: WebSocket,
  sessionId: string,
): Promise<void> {
  // Interrupt any in-progress turn to prevent token waste before switching sessions
  interruptCurrentTurn()
  // Clear session-scoped tool approvals so they don't leak across sessions
  sessionAllowedTools.clear()

  try {
    const projectsDir = getProjectsDir()
    const cwd = process.cwd()
    const projectDirName = sanitizePath(cwd)
    const projectDir = join(projectsDir, projectDirName)
    const filePath = join(projectDir, `${sessionId}.jsonl`)

    let raw: string
    try {
      const { readFile, stat } = await import('fs/promises')
      const stats = await stat(filePath)
      if (stats.size > 10 * 1024 * 1024) {
        const buf = Buffer.alloc(10 * 1024 * 1024)
        const { open } = await import('fs/promises')
        const fh = await open(filePath, 'r')
        const readPos = Math.max(0, stats.size - 10 * 1024 * 1024)
        const { bytesRead } = await fh.read(buf, 0, 10 * 1024 * 1024, readPos)
        await fh.close()
        raw = buf.toString('utf8', 0, bytesRead)
      } else {
        raw = await readFile(filePath, 'utf8')
      }
    } catch {
      ws.send(jsonStringify({
        type: 'error',
        message: `Session not found: ${sessionId}`,
      }))
      return
    }

    // Parse lines into message objects
    const rawMessages: Message[] = []
    const lines = raw.split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        const entryType = entry.type as string | undefined
        if (
          entryType === 'user' ||
          entryType === 'assistant' ||
          entryType === 'system'
        ) {
          rawMessages.push(entry as unknown as Message)
        }
      } catch {
        // Skip unparseable lines
      }
    }

    if (rawMessages.length === 0) {
      ws.send(jsonStringify({
        type: 'error',
        message: `Session ${sessionId} has no messages`,
      }))
      return
    }

    // Clean messages (filter unresolved tool uses, orphaned thinking, etc.)
    let cleanedMessages: Message[]
    try {
      const { deserializeMessages } = await import(
        '../utils/conversationRecovery.js'
      )
      cleanedMessages = deserializeMessages(rawMessages)
    } catch {
      cleanedMessages = rawMessages
    }

    // Switch the active session ID — all future recordTranscript calls
    // will append to the resumed session's JSONL
    // Flush pending writes for the old session before switching
    try { await flushSessionStorage() } catch {}
    switchSession(sessionId as SessionId)
    // Reset session file pointer so new writes go to the resumed session's file,
    // not the previous session's file (prevents messages from being written to
    // the wrong session when switching mid-process).
    try { await resetSessionFilePointer() } catch {}

    // Fire SessionStart('resume') hooks so plugins get notified of the session switch
    try {
      const hookMessages = await processSessionStartHooks('resume', { sessionId })
      if (hookMessages.length > 0) {
        cleanedMessages = [...hookMessages, ...cleanedMessages]
      }
    } catch (err) {
      console.error('[ide-mode] SessionStart(resume) hooks failed:', err)
    }

    // Set the message context so the next turn continues this session
    mutableMessages = cleanedMessages

    // Send loaded messages to webview for display
    const response: IDESessionLoadedResponse = {
      type: 'session_loaded',
      session_id: sessionId,
      messages: cleanedMessages.map(m => ({
        uuid: (m as Record<string, unknown>).uuid as string | undefined,
        type: m.type,
        message:
          ((m as Record<string, unknown>).message as Record<string, unknown>) ??
          (m as unknown as Record<string, unknown>),
        parent_tool_use_id:
          ((m as Record<string, unknown>).parent_tool_use_id as
            | string
            | null) ?? null,
        timestamp: (m as Record<string, unknown>).timestamp as
          | string
          | undefined,
      })),
    }
    ws.send(jsonStringify(response))

    // Update context window to reflect the newly loaded session
    sendContextWindowStatus()
    void broadcastPlanTasks()
  } catch (err) {
    ws.send(
      jsonStringify({
        type: 'error',
        message: `Failed to resume session: ${err instanceof Error ? err.message : String(err)}`,
      }),
    )
  }
}

async function handleDeleteSession(
  ws: WebSocket,
  sessionId: string,
): Promise<void> {
  try {
    const projectsDir = getProjectsDir()
    const cwd = process.cwd()
    const projectDirName = sanitizePath(cwd)
    const projectDir = join(projectsDir, projectDirName)
    const filePath = join(projectDir, `${sessionId}.jsonl`)

    await unlink(filePath)

    // Must read wasCurrent BEFORE regenerateSessionId() — afterwards
    // getSessionId() returns the new ID and the comparison would be wrong.
    const currentId = getSessionId()
    const wasCurrent = currentId === sessionId

    // If deleting the currently active session, start fresh
    if (wasCurrent) {
      const newId = regenerateSessionId({ setCurrentAsParent: true })
      // Reset Project singleton so next recordTranscript creates a new file
      // with the new session ID instead of reusing the old file path
      const { resetProjectForTesting } = await import('../utils/sessionStorage.js')
      resetProjectForTesting()
      mutableMessages = []
      readFileCache = createFileStateCacheWithSizeLimit(200)
      
      // Notify frontend of the new session ID so it stays in sync
      ws.send(jsonStringify({
        type: 'current_session',
        session_id: newId,
      }))
    }

    // Send deleted confirmation FIRST
    ws.send(jsonStringify({
      type: 'session_deleted',
      session_id: sessionId,
      was_current: wasCurrent,
    }))
    
    // THEN send updated session list to ensure frontend cache is correct
    await handleListSessions(ws)
  } catch (err) {
    ws.send(jsonStringify({
      type: 'error',
      message: `Failed to delete session: ${err instanceof Error ? err.message : String(err)}`,
    }))
  }
}

function getSessionMetaPath(sessionId: string): string {
  const projectsDir = getProjectsDir()
  const cwd = process.cwd()
  const projectDirName = sanitizePath(cwd)
  const projectDir = join(projectsDir, projectDirName)
  return join(projectDir, `${sessionId}.meta.json`)
}

async function writeSessionMetaFile(sessionId: string, meta: Record<string, unknown>): Promise<void> {
  try {
    // Merge with existing meta so partial updates don't clobber other fields
    const existing = await readSessionMetaFile(sessionId)
    const merged = { ...existing, ...meta }
    await writeFile(getSessionMetaPath(sessionId), jsonStringify(merged), 'utf8')
  } catch {
    // Non-fatal: metadata was also written via saveCustomTitle/saveTag
  }
}

async function readSessionMetaFile(sessionId: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(getSessionMetaPath(sessionId), 'utf8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

async function handleRenameSession(
  ws: WebSocket,
  sessionId: string,
  title: string,
): Promise<void> {
  try {
    await saveCustomTitle(sessionId as SessionId, title)
    await saveAgentName(sessionId as SessionId, title)
    // Persist in sidecar file so session listing can find it regardless
    // of where the custom-title entry lands in the JSONL tail buffer
    await writeSessionMetaFile(sessionId, { customTitle: title })
    ws.send(jsonStringify({
      type: 'session_renamed',
      session_id: sessionId,
      title,
    }))
  } catch (err) {
    ws.send(jsonStringify({
      type: 'error',
      message: `Failed to rename session: ${err instanceof Error ? err.message : String(err)}`,
    }))
  }
}

async function handleNewSession(ws: WebSocket): Promise<void> {
  // Interrupt any in-progress turn to prevent token waste and free the engine
  interruptCurrentTurn()
  // Clear session-scoped tool approvals so they don't leak across sessions
  sessionAllowedTools.clear()
  try {
    // Clear old session metadata (title, tag, agent, mode) so it doesn't
    // leak into the new session's display in the frontend history bar.
    clearSessionMetadata()

    // Regenerate session ID (sets old as parent, creates new UUID)
    const newId = regenerateSessionId({ setCurrentAsParent: true })

    // Reset file pointer so recordTranscript writes to the new session file
    try { await resetSessionFilePointer() } catch {}

    // Clear message state
    mutableMessages = []
    readFileCache = createFileStateCacheWithSizeLimit(200)

    // Clear memoized context caches so the new session re-fetches
    // CLAUDE.md, git status, etc. instead of reusing stale values.
    getUserContext.cache.clear?.()
    getSystemContext.cache.clear?.()

    ws.send(jsonStringify({
      type: 'session_created',
      session_id: newId,
    }))
    sendContextWindowStatus()
    // Send updated session list so sidebar refreshes immediately
    await handleListSessions(ws)
  } catch (err) {
    ws.send(jsonStringify({
      type: 'error',
      message: `Failed to create session: ${err instanceof Error ? err.message : String(err)}`,
    }))
  }
}

async function handlePinSession(
  ws: WebSocket,
  sessionId: string,
  pinned: boolean,
): Promise<void> {
  try {
    await saveTag(sessionId as SessionId, pinned ? 'pinned' : '')
    await writeSessionMetaFile(sessionId, { tag: pinned ? 'pinned' : '' })
    // Send refreshed session list
    await handleListSessions(ws)
  } catch (err) {
    ws.send(jsonStringify({
      type: 'error',
      message: `Failed to pin session: ${err instanceof Error ? err.message : String(err)}`,
    }))
  }
}

async function handleListTasks(ws: WebSocket): Promise<void> {
  const tasks: IDETaskListMessage['tasks'] = []
  for (const [taskId, task] of Object.entries(appState.tasks ?? {})) {
    const t = task as {
      type?: string
      description?: string
      agentType?: string
      status?: string
      identity?: { agentName: string; teamName: string; agentId: string; color?: string }
    }
    if (t.type === 'local_agent' || t.type === 'in_process_teammate') {
      tasks.push({
        task_id: taskId,
        description: t.description ?? '',
        agent_type: t.agentType ?? 'unknown',
        status: t.status ?? 'unknown',
        identity: t.identity ? {
          agent_name: t.identity.agentName,
          team_name: t.identity.teamName,
          agent_id: t.identity.agentId,
          color: t.identity.color,
        } : undefined,
      })
    }
  }
  const msg: IDETaskListMessage = { type: 'task_list', tasks }
  ws.send(jsonStringify(msg))
}

async function handleKillTask(ws: WebSocket, taskId: string): Promise<void> {
  const task = appState.tasks?.[taskId]
  if (!task || (task as Record<string, unknown>).type !== 'local_agent') {
    // task_error, not the global error channel: the GUI resets `streaming` on
    // any `error` — a stale task lookup here (agent already finished) made the
    // webview show "ready" while the main turn was still busy, so the next
    // user prompt hit "A prompt is already being processed".
    ws.send(jsonStringify({ type: 'task_error', scope: 'kill_task', task_id: taskId, message: `Task not found: ${taskId}` }))
    return
  }
  const t = task as { abortController?: AbortController; description?: string; status?: string }
  if (t.status !== 'running') {
    ws.send(jsonStringify({ type: 'task_error', scope: 'kill_task', task_id: taskId, message: `Task is not running: ${t.description ?? taskId}` }))
    return
  }
  t.abortController?.abort()
}

async function handleLoadAgentTranscript(ws: WebSocket, taskId: string): Promise<void> {
  const task = appState.tasks?.[taskId]
  if (!task) {
    // task_error — same reason as handleKillTask: this fires routinely when the
    // transcript is fetched for a task that just finished and was cleaned up.
    ws.send(jsonStringify({ type: 'task_error', scope: 'load_agent_transcript', task_id: taskId, message: `Task not found: ${taskId}` }))
    return
  }

  const t = task as Record<string, unknown>
  if (t.type !== 'in_process_teammate' && t.type !== 'local_agent') {
    ws.send(jsonStringify({ type: 'task_error', scope: 'load_agent_transcript', task_id: taskId, message: `Task is not a sub-agent: ${taskId}` }))
    return
  }

  const typed = task as {
    type: string
    identity?: { agentName: string; teamName: string; agentId: string; color?: string }
    agentType?: string
    agentId?: string
    status: string
    description: string
    progress?: { toolUses?: number; toolUseCount?: number; tokenCount?: number }
    messages?: Array<{ role: string; content: unknown; timestamp?: number }>
  }

  const identity = typed.identity
    ? {
        agent_name: typed.identity.agentName,
        team_name: typed.identity.teamName,
        agent_id: typed.identity.agentId,
        color: typed.identity.color,
      }
    : {
        agent_name: typed.agentType || 'agent',
        team_name: 'local',
        agent_id: `${typed.agentType || 'agent'}@local`,
      }

  // Load messages: use in-memory if available, otherwise load from disk for local_agent
  let messages: Array<{ role: string; content: unknown; timestamp?: number }> = []
  let loadError: string | undefined
  const inMemory = typed.messages ?? []

  // Helper: extract role/content from Anthropic message format (nested under msg.message)
  const extractMsg = (m: Record<string, unknown>) => {
    const inner = (m.message as Record<string, unknown>) || m;
    return {
      role: (inner.role || m.role || m.type || "unknown") as string,
      content: (inner.content ?? m.content ?? ""),
      timestamp: (m.timestamp ?? inner.timestamp) as number | undefined,
    };
  };

  if (inMemory.length > 0) {
    messages = inMemory.map(m => extractMsg(m as Record<string, unknown>))
  } else if (typed.type === 'local_agent') {
    // Try to load transcript from the task's outputFile (absolute path on disk)
    const outputFile = (task as Record<string, unknown>).outputFile as string | undefined
    try {
      if (outputFile) {
        const fs = await import('node:fs/promises')
        const raw = await fs.readFile(outputFile, 'utf-8').catch(() => null)
        if (raw) {
          const lines = raw.trim().split('\n').filter(Boolean)
          messages = lines.map(line => {
            try {
              const parsed = JSON.parse(line)
              return extractMsg(parsed as Record<string, unknown>)
            } catch { return null }
          }).filter(Boolean) as typeof messages
        }
      }
      if (messages.length === 0) {
        // Fallback: try the sidechain JSONL path
        const lookupId = typed.agentId || taskId
        const { getAgentTranscriptPath } = await import('../utils/sessionStorage.js')
        const sidechainPath = getAgentTranscriptPath(lookupId as any)
        const raw = await (await import('node:fs/promises')).readFile(sidechainPath, 'utf-8').catch(() => null)
        if (raw) {
          const lines = raw.trim().split('\n').filter(Boolean)
          messages = lines.map(line => {
            try {
              const parsed = JSON.parse(line)
              return extractMsg(parsed as Record<string, unknown>)
            } catch { return null }
          }).filter(Boolean) as typeof messages
        }
      }
      if (messages.length === 0) {
        loadError = `No transcript data (outputFile: ${outputFile || 'none'})`
      }
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e)
    }
  }

  const response = {
    type: 'agent_transcript',
    task_id: taskId,
    identity,
    status: typed.status,
    description: typed.description,
    progress: typed.progress ? {
      tool_uses: typed.progress.toolUses ?? typed.progress.toolUseCount ?? 0,
      token_count: typed.progress.tokenCount ?? 0,
    } : undefined,
    messages,
    ...(loadError ? { error: loadError } : {}),
  }
  ws.send(jsonStringify(response))
}

// ============================================================================
// Rewind (code restore) handlers
// ============================================================================

async function handleListRewindPoints(ws: WebSocket): Promise<void> {
  if (!fileHistoryEnabled() || !appState.fileHistory) {
    ws.send(jsonStringify({ type: 'rewind_points', points: [] }))
    return
  }

  const { snapshots } = appState.fileHistory
  if (!snapshots || snapshots.length === 0) {
    ws.send(jsonStringify({ type: 'rewind_points', points: [] }))
    return
  }

  // Process snapshots in reverse chronological order (newest first)
  const reversed = [...snapshots].reverse()
  const points: Array<{
    messageId: string
    label: string
    timestamp: string
    filesChanged: number
    insertions: number
    deletions: number
  }> = []

  for (const snapshot of reversed) {
    // Find the corresponding user message for its preview text
    let label = ''
    for (const msg of mutableMessages) {
      if ((msg as Record<string, unknown>).uuid === snapshot.messageId && msg.type === 'user') {
        const content = (msg as any).message?.content
        if (typeof content === 'string') {
          label = content.slice(0, 80).replace(/\s+/g, ' ')
        } else if (Array.isArray(content)) {
          const textBlock = content.find((b: any) => b.type === 'text')
          if (textBlock?.text) label = textBlock.text.slice(0, 80).replace(/\s+/g, ' ')
        }
        break
      }
    }

    // Compute diff stats
    const stats = await fileHistoryGetDiffStats(appState.fileHistory, snapshot.messageId)
    const fc = stats?.filesChanged?.length ?? 0
    if (fc === 0) continue // skip snapshots with no file changes

    points.push({
      messageId: snapshot.messageId,
      label,
      timestamp: snapshot.timestamp instanceof Date
        ? snapshot.timestamp.toISOString()
        : String(snapshot.timestamp),
      filesChanged: fc,
      insertions: stats?.insertions ?? 0,
      deletions: stats?.deletions ?? 0,
    })
  }

  ws.send(jsonStringify({ type: 'rewind_points', points }))
}

async function handleExecuteRewind(ws: WebSocket, messageId: string): Promise<void> {
  if (!fileHistoryEnabled() || !appState.fileHistory) {
    ws.send(jsonStringify({ type: 'error', message: 'File history is not enabled' }))
    return
  }

  try {
    await fileHistoryRewind(
      (updater: (prev: any) => any) => {
        setAppStateFn(prev => ({ ...prev, fileHistory: updater(prev.fileHistory) }))
      },
      messageId,
    )
    ws.send(jsonStringify({ type: 'rewind_completed', messageId, filesChanged: [] }))
    broadcastToAll({ type: 'status', status: 'ready' })
  } catch (e: any) {
    ws.send(jsonStringify({
      type: 'error',
      message: `Failed to rewind: ${e?.message ?? e}`,
    }))
  }
}

// ============================================================================
// Handle WebSocket message from IDE
// ============================================================================

async function handleClientMessage(
  ws: WebSocket,
  raw: string,
): Promise<void> {
  let message: StdinMessage
  try {
    message = JSON.parse(raw) as StdinMessage
  } catch {
    ws.send(jsonStringify({
      type: 'error',
      message: `Failed to parse JSON: ${raw.slice(0, 100)}`,
    }))
    return
  }

  switch (message.type) {
    case 'user': {
      if (busy) {
        ws.send(jsonStringify({
          type: 'error',
          message: 'A prompt is already being processed. Interrupt it first.',
        }))
        return
      }
      let userContent: string | ContentBlockParam[] = message.message.content
      if (message.attachments && message.attachments.length > 0) {
        const textAttachments: typeof message.attachments = []
        const imageBlocks: ImageBlockParam[] = []
        const imagePaths: string[] = []
        let imageIdCounter = Date.now()
        for (const att of message.attachments) {
          if (att.language === 'image' && att.content) {
            // Save image to disk so model can access it via FileReadTool/bash
            const savedPath = await storeImage({
              id: imageIdCounter++,
              type: 'image',
              content: att.content,
              mediaType: att.mediaType || 'image/png',
              filename: att.path,
            })
            if (savedPath) {
              imagePaths.push(savedPath)
            }
            imageBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: (att.mediaType ||
                  'image/png') as Base64ImageSource['media_type'],
                data: att.content,
              },
            } as ImageBlockParam)
          } else {
            textAttachments.push(att)
          }
        }
        // Format text attachments in original insertion order (files and pastes
        // interleaved as the user placed them), instead of grouping by type.
        let textContent = message.message.content
        if (textAttachments.length > 0) {
          let attachBlock = '\n## User-attached files\n'
          for (const att of textAttachments) {
            if (att.kind === 'paste' && att.content) {
              attachBlock += `### ${att.path}\n`
              attachBlock += '```\n'
              attachBlock += att.content
              attachBlock += '\n```\n'
            } else {
              const lang = att.language ? ` (${att.language})` : ''
              attachBlock += `- \`${att.path}\`${lang}\n`
            }
          }
          textContent = attachBlock + '\n' + textContent
        }
        if (imagePaths.length > 0) {
          textContent =
            imagePaths.map(p => `[Image saved to: ${p}]`).join('\n') +
            '\n' +
            textContent
        }
        // Build ContentBlockParam[] if images are present
        if (imageBlocks.length > 0) {
          const blocks: ContentBlockParam[] = []
          if (textContent) {
            blocks.push({ type: 'text', text: textContent } as ContentBlockParam)
          }
          for (const img of imageBlocks) {
            blocks.push(img as ContentBlockParam)
          }
          userContent = blocks
        } else {
          userContent = textContent
        }
      }
      // If GUI tells us which session, ensure we're on it (lightweight switch, no reload)
      if (message.session_id && message.session_id !== getSessionId()) {
        switchSession(message.session_id as string)
        try { await resetSessionFilePointer() } catch {}
      }
      void handleUserPrompt(userContent, ws).catch(err => {
        const msg = err instanceof Error ? err.message : String(err)
        broadcastToAll({ type: 'error', message: msg })
      })
      break
    }

    case 'interrupt': {
      interruptCurrentTurn()
      break
    }

    case 'ide_context': {
      if (message.files) ideContext.files = message.files
      if (message.selection !== undefined)
        ideContext.selection = message.selection
      if (message.diagnostics) ideContext.diagnostics = message.diagnostics
      // Broadcast context to other clients so they stay in sync
      broadcastToAllExcept(message, ws)
      break
    }

    case 'control_response': {
      const pending = pendingControlRequests.get(message.request_id)
      if (pending) {
        pendingControlRequests.delete(message.request_id)
        // Handle session allow (in-memory)
        if (message.response.session && pending.toolName) {
          sessionAllowedTools.add(pending.toolName)
        }
        // Handle always allow (persist to settings)
        if (message.response.always && pending.toolName) {
          try {
            persistPermissionUpdate({
              type: 'addRules',
              destination: 'localSettings' as PermissionUpdateDestination,
              rules: [{ toolName: pending.toolName }],
              behavior: 'allow',
            })
          } catch (e) {
            console.error('[ideMode] Failed to persist permission rule:', e)
          }
        }
        pending.resolve(message)
      }
      break
    }

    case 'list_sessions': {
      void handleListSessions(ws)
      break
    }

    case 'load_session': {
      await handleLoadSession(ws, message.session_id)
      break
    }

    case 'resume_session': {
      await handleResumeSession(ws, message.session_id)
      break
    }

    case 'delete_session': {
      void handleDeleteSession(ws, message.session_id)
      break
    }

    case 'rename_session': {
      void handleRenameSession(ws, message.session_id, message.title)
      break
    }

    case 'refresh_mcp': {
      await refreshMcpTools()
      ws.send(jsonStringify({ type: 'refresh_mcp_ok', message: 'MCP tools refreshed from settings' }))
      break
    }

    case 'new_session': {
      void handleNewSession(ws)
      break
    }

    case 'pin_session': {
      void handlePinSession(ws, message.session_id, message.pinned)
      break
    }

    case 'list_tasks': {
      void handleListTasks(ws)
      break
    }

    case 'kill_task': {
      void handleKillTask(ws, message.task_id)
      break
    }

    case 'load_agent_transcript': {
      void handleLoadAgentTranscript(ws, message.task_id)
      break
    }

    case 'set_permission_mode': {
      const ctx = appState.toolPermissionContext
      const fromMode = ctx.mode
      const toMode = message.mode
      // Validate — must be a known permission mode
      const validModes = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk']
      if (!validModes.includes(toMode)) {
        ws.send(jsonStringify({ type: 'error', message: `Invalid permission mode: ${toMode}` }))
        break
      }
      if (fromMode === toMode) break
      const newCtx = transitionPermissionMode(fromMode, toMode, ctx as ToolPermissionContext) as ToolPermissionContext
      appState = { ...appState, toolPermissionContext: { ...newCtx, mode: toMode } }
      // Broadcast to all connected clients
      broadcastToAll({ type: 'permission_mode_changed', mode: toMode })
      break
    }

    case 'compact': {
      void handleCompact(ws)
      break
    }

    case 'plugin_refresh': {
      try {
        const { refreshActivePlugins } = await import('../utils/plugins/refresh.js')
        await refreshActivePlugins(setAppStateFn)
        const { getCommands } = await import('../commands.js')
        // handleClientMessage has no cwd param — derive it like every other handler
        const cwd = process.cwd()
        commands = await getCommands(cwd)
        try {
          const defs = await getAgentDefinitionsWithOverrides(cwd)
          agents = defs.activeAgents  // same as startup — defs is {activeAgents, inactiveAgents,...}
        } catch { /* agents reload is best-effort */ }
        broadcastSlashCommands()
        broadcastToAll({ type: 'status', status: 'ready' })
      } catch (e) {
        console.error('[ideMode] plugin_refresh failed:', e instanceof Error ? e.message : String(e))
      }
      break
    }

    case 'set_thinking_mode': {
      const enabled = message.enabled === true
      if (message.effort !== undefined) {
        sessionEffort = parseEffortValue(message.effort)
      }
      thinkingEnabled = enabled
      syncEffortAndReasoningState()
      broadcastToAll({
        type: 'thinking_mode_changed',
        enabled: thinkingEnabled,
        effort: sessionEffort,
      })
      break
    }

    case 'set_effort': {
      sessionEffort = parseEffortValue(message.level)
      syncEffortAndReasoningState()
      broadcastToAll({ type: 'effort_changed', value: sessionEffort })
      break
    }

    case 'get_model_capabilities': {
      try {
        const model = getMainLoopModel()
        ws.send(jsonStringify({
          type: 'model_capabilities',
          model,
          capability: getModelCapabilities(model),
        }))
      } catch (e) {
        console.error('[ideMode] get_model_capabilities failed:', e)
      }
      break
    }

    case 'side_question': {
      const { question, context_id } = message as StdinSideQuestion
      void handleSideQuestion(ws, question, context_id)
      break
    }

    case 'list_rewind_points': {
      void handleListRewindPoints(ws)
      break
    }

    case 'execute_rewind': {
      void handleExecuteRewind(ws, (message as IRewindExecuteRequest).messageId)
      break
    }



    default:
      ws.send(jsonStringify({
        type: 'error',
        message: `Unknown message type: ${(message as IDEBaseMessage).type}`,
      }))
  }
}

// ============================================================================
// Main entrypoint
// ============================================================================

export async function runIdeMode(workspaceDir?: string): Promise<void> {
  process.env.CLAUDE_CODE_IDE = '1'
  // Enable file history snapshots so /rewind (code restore) works.
  // IDE mode is non-interactive (no Ink TUI), so fileHistoryEnabled()
  // requires this env var per src/utils/fileHistory.ts:63-71.
  process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1'

  // Try workspace dir from arg, then env var fallback, then keep current cwd
  const targetCwd = workspaceDir || process.env.CLAUDE_CODE_CWD
  const beforeCwd = process.cwd()
  if (targetCwd) {
    try {
      process.chdir(targetCwd)
      console.error(`[ide-mode] CWD changed: "${beforeCwd}" → "${process.cwd()}"`)
    } catch (err) {
      console.error(`[ide-mode] CWD change FAILED: "${targetCwd}" — ${err instanceof Error ? err.message : String(err)}. Staying at "${beforeCwd}".`)
    }
  } else {
    console.error(`[ide-mode] No workspaceDir or CLAUDE_CODE_CWD — staying at "${beforeCwd}"`)
  }

  // Catch unhandled rejections/exceptions so the process doesn't crash silently
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[ide-mode] UNHANDLED REJECTION:', reason)
  })
  process.on('uncaughtException', (err) => {
    console.error('[ide-mode] UNCAUGHT EXCEPTION:', err.message || err)
  })

  await initialize()

  // Execute SessionStart hooks for plugin context injection (e.g. claude-mem)
  // Also directly notify claude-mem worker to ensure session context is retrieved
  try {
    const hookMessages = await processSessionStartHooks('startup')
    if (hookMessages.length > 0) {
      mutableMessages = [...hookMessages, ...mutableMessages]
    }
  } catch (err) {
    console.error('[ide-mode] SessionStart hooks failed:', err)
  }
  // Direct fire-and-forget to claude-mem worker (supplements hook system)
  void runClaudeMemHook('context', {
    hook_event_name: 'SessionStart',
    source: 'startup',
    session_id: getSessionId(),
  })

  // Bind to a random port on localhost only
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',

    fetch(req, server) {
      const url = new URL(req.url)

      // Health check endpoint
      if (url.pathname === '/health') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            clients: connectedClients.size,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        )
      }

      // WebSocket upgrade
      if (url.pathname === '/ws') {
        const upgraded = server.upgrade(req)
        if (!upgraded) {
          return new Response('WebSocket upgrade failed', { status: 426 })
        }
        return undefined as unknown as Response // Bun expects undefined for WS upgrade
      }

      return new Response('Claude Code IDE mode', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    },

    websocket: {
      open(ws) {
        try {
          connectedClients.add(ws)

          // Send session list after a short delay (let webview init complete first)
          setTimeout(() => { void handleListSessions(ws) }, 500)

          // Send current state to new client
          ws.send(jsonStringify({
            type: 'status',
            status: 'ready',
            model: getMainLoopModel(),
          }))

          // Send current session ID so the client can track it (e.g. for
          // delete-session detecting whether it's the active session).
          ws.send(jsonStringify({
            type: 'current_session',
            session_id: getSessionId(),
          }))

        // Send current IDE context so the new client is in sync
        if (
          ideContext.files.length > 0 ||
          ideContext.selection ||
          ideContext.diagnostics.length > 0
        ) {
          ws.send(jsonStringify({
            type: 'ide_context',
            files: ideContext.files.length > 0 ? ideContext.files : undefined,
            selection: ideContext.selection ?? undefined,
            diagnostics:
              ideContext.diagnostics.length > 0
                ? ideContext.diagnostics
                : undefined,
          }))
        }

        // Send current permission mode so the dropdown stays in sync
        ws.send(jsonStringify({
          type: 'permission_mode_changed',
          mode: appState.toolPermissionContext.mode,
        }))

        // Send current thinking mode state to new client
        ws.send(jsonStringify({
          type: 'thinking_mode_changed',
          enabled: thinkingEnabled,
          effort: sessionEffort,
        }))

        // Send model capabilities so the GUI knows which thinking/effort tiers
        // are available for the active model
        try {
          const model = getMainLoopModel()
          ws.send(jsonStringify({
            type: 'model_capabilities',
            model,
            capability: getModelCapabilities(model),
          }))
        } catch { /* best-effort */ }

        // Send available slash commands (skills, plugins, bundled) for autocomplete
        broadcastSlashCommands(ws)

        // Send current context window status (fire-and-forget, errors are noisy during connect)
        try {
          ws.send(jsonStringify(buildContextWindowStatus()))
        } catch { /* ignore */ }
        } catch (_err) {
          console.error('[ide-mode] open handler error:', _err)
        }
      },

      message(ws, data) {
        const raw = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer)
        void handleClientMessage(ws, raw)
      },

      close(ws) {
        connectedClients.delete(ws)
      },
    },
  })

  // Announce port to stdout so the IDE can discover the server
  // This is the ONLY stdout output — everything else goes over WebSocket
  process.stdout.write(`CLAUDE_CODE_IDE_PORT=${server.port}\n`)

  // Log to stderr for debugging
  const log = (...args: unknown[]) =>
    process.stderr.write(
      `[ide-mode] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`,
    )
  log(`WebSocket server listening on ws://127.0.0.1:${server.port}`)

  // Hook file writes to notify GUI clients (editor refresh, file tree refresh)
  setOnFileWritten((filePath: string) => {
    broadcastToAll({
      type: 'file_edit',
      path: filePath,
      messageId: '',
      label: `文件变更: ${filePath.split(/[/\\]/).pop() || filePath}`,
    })
  })

  // Periodically broadcast context window + token usage while agent is busy
  setInterval(() => {
    if (busy) sendContextWindowStatus()
  }, 500)

  // Subscribe to plan/todo task list changes and broadcast to all clients
  const unsubTasks = onTasksUpdated(() => {
    void broadcastPlanTasks()
  })
  // Also broadcast initial task state (in case tasks exist from a previous session)
  void broadcastPlanTasks()

  // Keep the process alive. Bun.serve() keeps the event loop running, but
  // handle signals for graceful shutdown.
  const runStopHooks = async () => {
    try {
      if (mutableMessages.length === 0) return
      for await (const _result of executeStopHooks(
        appState.toolPermissionContext.mode,
        undefined,
        60000,
        false,
        undefined,
        undefined,
        mutableMessages,
      )) {
        // Drain the async generator — hook side effects run during iteration
      }
    } catch (err) {
      log('Stop hooks failed:', err)
    }
  }
  process.on('SIGTERM', () => {
    unsubTasks()
    log('Received SIGTERM, shutting down')
    void runStopHooks().finally(() => server.stop())
  })
  process.on('SIGINT', () => {
    unsubTasks()
    log('Received SIGINT, shutting down')
    void runStopHooks().finally(() => server.stop())
  })
}
