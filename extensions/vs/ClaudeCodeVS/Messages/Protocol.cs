using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace ClaudeCodeVS.Messages
{
    // =========================================================================
    // Context primitives — match extensions/vscode/src/protocol.ts L12-41
    // =========================================================================

    public class FileContext
    {
        [JsonProperty("path")] public string Path { get; set; }
        [JsonProperty("content")] public string Content { get; set; }
        [JsonProperty("language")] public string Language { get; set; }
    }

    public class Selection
    {
        [JsonProperty("path")] public string Path { get; set; }
        [JsonProperty("startLine")] public int StartLine { get; set; }
        [JsonProperty("startChar")] public int StartChar { get; set; }
        [JsonProperty("endLine")] public int EndLine { get; set; }
        [JsonProperty("endChar")] public int EndChar { get; set; }
        [JsonProperty("text")] public string Text { get; set; }
    }

    public class Diagnostic
    {
        [JsonProperty("path")] public string Path { get; set; }
        [JsonProperty("line")] public int Line { get; set; }
        [JsonProperty("column")] public int Column { get; set; }
        [JsonProperty("message")] public string Message { get; set; }
        [JsonProperty("severity")] public string Severity { get; set; } // "error" | "warning" | "info" | "hint"
    }

    // =========================================================================
    // Outgoing messages — IDE → Bun (match protocol.ts L47-158)
    // =========================================================================

    public class OutgoingMessage
    {
        [JsonProperty("type")] public string Type { get; set; }
    }

    public class UserMessage : OutgoingMessage
    {
        [JsonProperty("message")] public UserMessageBody Message { get; set; }
        [JsonProperty("parent_tool_use_id")] public string ParentToolUseId { get; set; }
    }

    public class UserMessageBody
    {
        [JsonProperty("role")] public string Role { get; set; } = "user";
        [JsonProperty("content")] public object Content { get; set; }
    }

    public class IdeContextMessage : OutgoingMessage
    {
        [JsonProperty("files")] public List<FileContext> Files { get; set; }
        [JsonProperty("selection")] public Selection Selection { get; set; }
        [JsonProperty("diagnostics")] public List<Diagnostic> Diagnostics { get; set; }
    }

    public class ControlResponseMessage : OutgoingMessage
    {
        [JsonProperty("request_id")] public string RequestId { get; set; }
        [JsonProperty("response")] public ControlResponseBody Response { get; set; }
    }

    public class ControlResponseBody
    {
        [JsonProperty("allowed")] public bool Allowed { get; set; }
        [JsonProperty("always")] public bool? Always { get; set; }
        [JsonProperty("session")] public bool? Session { get; set; }
        [JsonProperty("reason")] public string Reason { get; set; }
    }

    // =========================================================================
    // Incoming messages — Bun → IDE (match protocol.ts L164-446)
    // =========================================================================

    public class IncomingMessage
    {
        [JsonProperty("type")] public string Type { get; set; }
    }

    public class StatusMessage : IncomingMessage
    {
        [JsonProperty("status")] public string Status { get; set; }
    }

    public class AssistantMessage : IncomingMessage
    {
        [JsonProperty("message")] public JToken Message { get; set; }
        [JsonProperty("parent_tool_use_id")] public string ParentToolUseId { get; set; }
    }

    public class PartialAssistantMessage : IncomingMessage
    {
        [JsonProperty("message")] public JToken Message { get; set; }
        [JsonProperty("parent_tool_use_id")] public string ParentToolUseId { get; set; }
    }

    public class ResultMessage : IncomingMessage
    {
        [JsonProperty("subtype")] public string Subtype { get; set; } // "success" | "error"
        [JsonProperty("result")] public string Result { get; set; }
        [JsonProperty("error")] public string Error { get; set; }
    }

    public class ControlRequestMessage : IncomingMessage
    {
        [JsonProperty("request_id")] public string RequestId { get; set; }
        [JsonProperty("request")] public ControlRequestBody Request { get; set; }
    }

    public class ControlRequestBody
    {
        [JsonProperty("subtype")] public string Subtype { get; set; }
        [JsonProperty("tool_name")] public string ToolName { get; set; }
        [JsonProperty("tool_use_id")] public string ToolUseId { get; set; }
        [JsonProperty("input")] public JToken Input { get; set; }
        [JsonProperty("action_description")] public string ActionDescription { get; set; }
    }

    public class SessionMeta
    {
        [JsonProperty("sessionId")] public string SessionId { get; set; }
        [JsonProperty("title")] public string Title { get; set; }
        [JsonProperty("messageCount")] public int MessageCount { get; set; }
        [JsonProperty("timestamp")] public string Timestamp { get; set; }
        [JsonProperty("pinned")] public bool Pinned { get; set; }
    }

    public class SessionListMessage : IncomingMessage
    {
        [JsonProperty("sessions")] public List<SessionMeta> Sessions { get; set; }
    }

    public class ContextWindowMessage : IncomingMessage
    {
        [JsonProperty("context_window_size")] public int ContextWindowSize { get; set; }
        [JsonProperty("used_tokens")] public int UsedTokens { get; set; }
        [JsonProperty("used_percentage")] public double UsedPercentage { get; set; }
        [JsonProperty("remaining_percentage")] public double RemainingPercentage { get; set; }
        [JsonProperty("model")] public string Model { get; set; }
    }

    public class ErrorMessage : IncomingMessage
    {
        [JsonProperty("message")] public string Message { get; set; }
    }

    // =========================================================================
    // Helper: dispatch incoming messages by type field
    // =========================================================================

    public static class MessageTypes
    {
        // Outgoing (IDE → Bun)
        public const string User = "user";
        public const string IdeContext = "ide_context";
        public const string ControlResponse = "control_response";
        public const string Interrupt = "interrupt";
        public const string ListSessions = "list_sessions";
        public const string LoadSession = "load_session";
        public const string ResumeSession = "resume_session";
        public const string DeleteSession = "delete_session";
        public const string RenameSession = "rename_session";
        public const string NewSession = "new_session";
        public const string PinSession = "pin_session";
        public const string SetPermissionMode = "set_permission_mode";
        public const string SetThinkingMode = "set_thinking_mode";
        public const string SetModelProfile = "set_model_profile";
        public const string Compact = "compact";
        public const string SideQuestion = "side_question";
        public const string KillTask = "kill_task";
        public const string ListTasks = "list_tasks";
        public const string ListRewindPoints = "list_rewind_points";
        public const string ExecuteRewind = "execute_rewind";

        // Incoming (Bun → IDE)
        public const string Status = "status";
        public const string Assistant = "assistant";
        public const string PartialAssistant = "partial_assistant";
        public const string User_ = "user";
        public const string Result = "result";
        public const string Error = "error";
        public const string Log = "log";
        public const string ControlRequest = "control_request";
        public const string StreamEvent = "stream_event";
        public const string System = "system";
        public const string IdeContext_ = "ide_context";
        public const string SessionList = "session_list";
        public const string SessionLoaded = "session_loaded";
        public const string ContextWindow = "context_window";
        public const string TaskStarted = "task_started";
        public const string TaskProgress = "task_progress";
        public const string TaskCompleted = "task_completed";
        public const string TaskList = "task_list";
        public const string ToolProgress = "tool_progress";
        public const string FilePicked = "file_picked";
        public const string FillInput = "fill_input";
        public const string PermissionModeChanged = "permission_mode_changed";
        public const string PlanTasks = "plan_tasks";
        public const string RewindPoints = "rewind_points";
        public const string RewindCompleted = "rewind_completed";
        public const string SideQuestionResult = "side_question_result";
    }
}
