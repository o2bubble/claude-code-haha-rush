/**
 * Shared protocol type definitions for IDE mode.
 *
 * These types define the WebSocket message contract between the Claude Code
 * backend (ideMode.ts) and the VS Code extension host (provider.ts).
 *
 * Mirrors the corresponding interfaces in extensions/vscode/src/protocol.ts.
 */

// --- Context types ---

export interface IDEFileContext {
  path: string
  content: string
  language?: string
}

export interface IDESelection {
  path: string
  startLine: number
  startChar: number
  endLine: number
  endChar: number
  text: string
}

export interface IDEDiagnostic {
  path: string
  line: number
  column: number
  message: string
  severity: 'error' | 'warning' | 'info' | 'hint'
  source?: string
}

// --- Messages from IDE ---

interface IDEBaseMessage {
  type: string
}

export interface IDEUserMessage extends IDEBaseMessage {
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: string | null
  attachments?: { path: string; content: string; language?: string; mediaType?: string }[]
}

export interface IDEContextMessage extends IDEBaseMessage {
  type: 'ide_context'
  files?: IDEFileContext[]
  selection?: IDESelection | null
  diagnostics?: IDEDiagnostic[]
}

export interface IDEControlResponse extends IDEBaseMessage {
  type: 'control_response'
  request_id: string
  response: {
    allowed: boolean
    always?: boolean
    session?: boolean
    reason?: string
    updatedInput?: Record<string, unknown>
  }
}

export interface IDEInterruptMessage extends IDEBaseMessage {
  type: 'interrupt'
}

export interface IDESessionListRequest extends IDEBaseMessage {
  type: 'list_sessions'
}

export interface IDESessionLoadRequest extends IDEBaseMessage {
  type: 'load_session'
  session_id: string
}

export interface IDESessionResumeRequest extends IDEBaseMessage {
  type: 'resume_session'
  session_id: string
}

export interface IDESessionDeleteRequest extends IDEBaseMessage {
  type: 'delete_session'
  session_id: string
}

export interface IDESessionRenameRequest extends IDEBaseMessage {
  type: 'rename_session'
  session_id: string
  title: string
}

export interface IDESessionNewRequest extends IDEBaseMessage {
  type: 'new_session'
}

/**
 * Fork a session into a new one. `session_id` is the SOURCE session and may be
 * any session, not only the active one.
 */
export interface IDESessionForkRequest extends IDEBaseMessage {
  type: 'fork_session'
  session_id: string
}

export interface IDESessionPinRequest extends IDEBaseMessage {
  type: 'pin_session'
  session_id: string
  pinned: boolean
}

export interface IDETaskListRequest extends IDEBaseMessage {
  type: 'list_tasks'
}

export interface IDEKillTaskRequest extends IDEBaseMessage {
  type: 'kill_task'
  task_id: string
}

export interface IDELoadAgentTranscriptRequest extends IDEBaseMessage {
  type: 'load_agent_transcript'
  task_id: string
}

export interface IDESetPermissionMode extends IDEBaseMessage {
  type: 'set_permission_mode'
  mode: string
}

/** GUI 推送插件 runtime 目录（plugin-nodejs-runtime T3 通道 B）——重扫后调用,
 *  当前会话下一条 Bash 即生效。dirs = 绝对路径列表（GUI 已聚合/验序/存在性过滤）。 */
export interface IDESetPluginRuntimePaths extends IDEBaseMessage {
  type: 'set_plugin_runtime_paths'
  dirs: string[]
}

export interface IDECompactRequest extends IDEBaseMessage {
  type: 'compact'
}

export interface StdinSideQuestion extends IDEBaseMessage {
  type: 'side_question'
  question: string
  context_id: string
}

export interface IRewindPointsListRequest extends IDEBaseMessage {
  type: 'list_rewind_points'
}

export interface IRewindExecuteRequest extends IDEBaseMessage {
  type: 'execute_rewind'
  messageId: string
}

export type StdinMessage =
  | IDEUserMessage
  | IDEContextMessage
  | IDEControlResponse
  | IDEInterruptMessage
  | IDESessionListRequest
  | IDESessionLoadRequest
  | IDESessionResumeRequest
  | IDESessionDeleteRequest
  | IDESessionRenameRequest
  | IDESessionNewRequest
  | IDESessionForkRequest
  | IDESessionPinRequest
  | IDETaskListRequest
  | IDEKillTaskRequest
  | IDELoadAgentTranscriptRequest
  | IDESetPermissionMode
  | IDESetPluginRuntimePaths
  | IDECompactRequest
  | StdinSideQuestion
  | IRewindPointsListRequest
  | IRewindExecuteRequest

// --- Messages to IDE ---

export interface IDEStatusMessage {
  type: 'status'
  status: string | null
}

export interface IDEAssistantMessage {
  type: 'assistant'
  message: Record<string, unknown>
  parent_tool_use_id: string | null
}

export interface IDEToolResultMessage {
  type: 'user'
  message: Record<string, unknown>
  parent_tool_use_id: string | null
}

export interface IDEResultMessage {
  type: 'result'
  subtype: 'success' | 'error'
  result?: string
  error?: string
}

export interface IDEErrorMessage {
  type: 'error'
  message: string
}

export interface IDEControlRequest {
  type: 'control_request'
  request_id: string
  request: {
    subtype: string
    tool_name: string
    tool_use_id: string
    input: Record<string, unknown>
    action_description: string
  }
}

export interface IDEStreamEventMessage {
  type: 'stream_event'
  event: unknown
  parent_tool_use_id: string | null
}

export interface IDEPartialAssistantMessage {
  type: 'partial_assistant'
  message: Record<string, unknown>
  parent_tool_use_id: string | null
}

export interface IDESystemMessage {
  type: 'system'
  subtype: string
  [key: string]: unknown
}

export interface IDESessionMeta {
  sessionId: string
  title: string
  messageCount: number
  timestamp: string
  gitBranch?: string
  tag?: string
  pinned?: boolean
}

export interface IDESessionListResponse {
  type: 'session_list'
  sessions: IDESessionMeta[]
}

export interface IDESessionLoadedResponse {
  type: 'session_loaded'
  session_id: string
  messages: Array<{
    uuid?: string
    type: string
    message: Record<string, unknown>
    parent_tool_use_id?: string | null
    timestamp?: string
  }>
}

export interface IDETaskIdentity {
  agent_name: string
  team_name: string
  agent_id: string
  color?: string
}

export interface IDETaskStartedMessage {
  type: 'task_started'
  task_id: string
  description: string
  agent_type: string
  identity?: IDETaskIdentity
}

export interface IDETaskProgressMessage {
  type: 'task_progress'
  task_id: string
  description: string
  status: string
  tool_uses: number
  total_tokens: number
  identity?: IDETaskIdentity
}

export interface IDETaskCompletedMessage {
  type: 'task_completed'
  task_id: string
  description: string
  status: 'completed' | 'failed' | 'killed'
  error?: string
  identity?: IDETaskIdentity
}

export interface IDETaskListMessage {
  type: 'task_list'
  tasks: Array<{
    task_id: string
    description: string
    agent_type: string
    status: string
    identity?: IDETaskIdentity
  }>
}

export interface IDEAgentTranscriptMessage {
  type: 'agent_transcript'
  task_id: string
  identity: IDETaskIdentity
  status: string
  description: string
  progress?: {
    tool_uses: number
    token_count: number
  }
  messages: Array<{
    role: 'user' | 'assistant'
    content: unknown
    timestamp?: number
  }>
}

export interface IDEToolProgressMessage {
  type: 'tool_progress'
  data?: {
    type: 'bash_progress'
    output: string
    fullOutput: string
    elapsedTimeSeconds: number
    totalLines: number
    totalBytes?: number
    taskId?: string
    timeoutMs?: number
  }
  tool_use_id: string
  parent_tool_use_id: string
}

export interface IDEFileEditMessage {
  type: 'file_edit'
  path: string
  messageId: string
  label: string
  preEditContent: string
}

export type StdoutMessage =
  | IDEStatusMessage
  | IDEAssistantMessage
  | IDEToolResultMessage
  | IDEResultMessage
  | IDEErrorMessage
  | IDEControlRequest
  | IDEStreamEventMessage
  | IDEPartialAssistantMessage
  | IDESystemMessage
  | IDESessionListResponse
  | IDESessionLoadedResponse
  | IDETaskStartedMessage
  | IDETaskProgressMessage
  | IDETaskCompletedMessage
  | IDETaskListMessage
  | IDEAgentTranscriptMessage
  | IDEToolProgressMessage
  | IDEFileEditMessage
