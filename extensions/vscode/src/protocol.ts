/**
 * Protocol types for IDE ↔ Claude Code communication over WebSocket.
 *
 * All messages are JSON objects with a `type` field. These types mirror
 * the corresponding interfaces in src/entrypoints/ideMode.ts.
 */

// ============================================================================
// Context types (IDE → Claude Code)
// ============================================================================

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

export interface FileTreeNode {
  name: string
  path: string
  isDir: boolean
  children?: FileTreeNode[]
}

// ============================================================================
// Messages FROM extension TO Claude Code (write to WebSocket)
// ============================================================================

export interface IDEUserMessage {
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: string | null
  attachments?: { path: string; content?: string; language?: string; mediaType?: string; kind?: string; isDir?: boolean }[]
}

export interface IDEContextMessage {
  type: 'ide_context'
  files?: IDEFileContext[]
  selection?: IDESelection | null
  diagnostics?: IDEDiagnostic[]
}

export interface IDEControlResponseMessage {
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

export interface IDEInterruptMessage {
  type: 'interrupt'
}

export interface IDESessionListRequest {
  type: 'list_sessions'
}

export interface IDESessionLoadRequest {
  type: 'load_session'
  session_id: string
}

export interface IDESessionResumeRequest {
  type: 'resume_session'
  session_id: string
}

export interface IDESessionDeleteRequest {
  type: 'delete_session'
  session_id: string
}

export interface IDESessionRenameRequest {
  type: 'rename_session'
  session_id: string
  title: string
}

export interface IDESessionNewRequest {
  type: 'new_session'
}

export interface IDESessionPinRequest {
  type: 'pin_session'
  session_id: string
  pinned: boolean
}

export interface IDETaskListRequest {
  type: 'list_tasks'
}

export interface IDEKillTaskRequest {
  type: 'kill_task'
  task_id: string
}

export interface IDESideQuestionMessage {
  type: 'side_question'
  question: string
  context_id: string
}

export interface IIDERewindPointsListRequest {
  type: 'list_rewind_points'
}

export interface IIDERewindExecuteRequest {
  type: 'execute_rewind'
  messageId: string
}

export interface IDESetPermissionModeRequest {
  type: 'set_permission_mode'
  mode: string
}

export type OutgoingMessage =
  | IDEUserMessage
  | IDEContextMessage
  | IDEControlResponseMessage
  | IDEInterruptMessage
  | IDESessionListRequest
  | IDESessionLoadRequest
  | IDESessionResumeRequest
  | IDESessionDeleteRequest
  | IDESessionRenameRequest
  | IDESessionNewRequest
  | IDESessionPinRequest
  | IDETaskListRequest
  | IDEKillTaskRequest
  | IDESetPermissionModeRequest
  | IDECompactRequestMessage
  | IDESideQuestionMessage
  | IIDERewindPointsListRequest
  | IIDERewindExecuteRequest

// ============================================================================
// Messages FROM Claude Code TO extension (read from WebSocket)
// ============================================================================

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

export interface IDELogMessage {
  type: 'log'
  message: string
}

export interface IDEConnectionStatusMessage {
  type: 'status'
  status: string | null
  code?: number
  reason?: string
}

export interface IDEControlRequestMessage {
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

export interface IDEContextDisplayMessage {
  type: 'ide_context'
  files: string[]
  selection?: { path: string; lines: number; text: string } | null
  diagnostics?: { errors: number; warnings: number; info: number } | null
}

export interface IDEFillInputMessage {
  type: 'fill_input'
  text: string
  selection?: {
    filePath: string
    startLine: number
    endLine: number
  }
}

export interface IDEFilePickedMessage {
  type: 'file_picked'
  files: { path: string; content?: string; language?: string; isDir?: boolean }[]
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

export interface IDESessionDeletedResponse {
  type: 'session_deleted'
  session_id: string
  was_current?: boolean
}

export interface IDESessionRenamedResponse {
  type: 'session_renamed'
  session_id: string
  title: string
}

export interface IDESessionCreatedResponse {
  type: 'session_created'
  session_id: string
}

export interface IDETaskStartedMessage {
  type: 'task_started'
  task_id: string
  description: string
  agent_type: string
}

export interface IDETaskProgressMessage {
  type: 'task_progress'
  task_id: string
  description: string
  status: string
  tool_uses: number
  total_tokens: number
}

export interface IDETaskCompletedMessage {
  type: 'task_completed'
  task_id: string
  description: string
  status: 'completed' | 'failed' | 'killed'
  error?: string
}

export interface IDETaskListMessage {
  type: 'task_list'
  tasks: Array<{
    task_id: string
    description: string
    agent_type: string
    status: string
  }>
}

export interface IDEPermissionModeChangedMessage {
  type: 'permission_mode_changed'
  mode: string
}

export interface IDEContextWindowMessage {
  type: 'context_window'
  context_window_size: number
  used_tokens: number
  used_percentage: number | null
  remaining_percentage: number | null
  model: string
}

export interface IDEPlanTasksMessage {
  type: 'plan_tasks'
  tasks: Array<{
    id: string
    subject: string
    description: string
    status: 'pending' | 'in_progress' | 'completed'
    owner?: string
    blockedBy: string[]
    blocks: string[]
    activeForm?: string
  }>
}

export interface IDESideQuestionResultMessage {
  type: 'side_question_result'
  context_id: string
  response?: string
  error?: string
}

export interface IDEClipboardMessage {
  type: 'clipboard'
  text: string
}

export interface IDEToolProgressMessage {
  type: 'tool_progress'
  data: {
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

export interface IDECompactRequestMessage {
  type: 'compact'
}

export interface IRewindPoint {
  messageId: string
  label: string
  timestamp: string
  filesChanged: number
  insertions: number
  deletions: number
}

export interface IRewindPointsMessage {
  type: 'rewind_points'
  points: IRewindPoint[]
}

export interface IRewindCompletedMessage {
  type: 'rewind_completed'
  messageId: string
  filesChanged: string[]
}

export type IncomingMessage =
  | IDEStatusMessage
  | IDEAssistantMessage
  | IDEToolResultMessage
  | IDEResultMessage
  | IDEErrorMessage
  | IDELogMessage
  | IDEConnectionStatusMessage
  | IDEControlRequestMessage
  | IDEStreamEventMessage
  | IDEPartialAssistantMessage
  | IDESystemMessage
  | IDEContextDisplayMessage
  | IDEFillInputMessage
  | IDEFilePickedMessage
  | IDESessionListResponse
  | IDESessionLoadedResponse
  | IDESessionDeletedResponse
  | IDESessionRenamedResponse
  | IDESessionCreatedResponse
  | IDETaskStartedMessage
  | IDETaskProgressMessage
  | IDETaskCompletedMessage
  | IDETaskListMessage
  | IDEPermissionModeChangedMessage
  | IDEContextWindowMessage
  | IDEPlanTasksMessage
  | IDEToolProgressMessage
  | IDESideQuestionResultMessage
  | IDEClipboardMessage
  | IRewindPointsMessage
  | IRewindCompletedMessage

// ============================================================================
// Type guard
// ============================================================================

export function isIncomingMessage(v: unknown): v is IncomingMessage {
  return typeof v === 'object' && v !== null && 'type' in v
}

/**
 * Parse a WebSocket message (always a JSON string) into a typed message.
 */
export function parseMessage(data: string): IncomingMessage | null {
  try {
    const parsed = JSON.parse(data)
    return isIncomingMessage(parsed) ? parsed : null
  } catch {
    return null
  }
}
