# System Reminder — 系统消息注入机制

`<system-reminder>` 是 Claude Code 内部向后端/模型注入系统级上下文的标准通道。它确保系统生成的消息不会与用户真实输入混淆。

## 核心机制

### 包装函数

```ts
// src/utils/messages.ts:3096
export function wrapInSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`
}
```

### 消息结构中的位置

System-reminder 文本块会被**合并到相邻的 `tool_result` 块**中（`src/utils/messages.ts:1848, 2329`），而不是作为独立的用户消息发送。这样 API 消息结构保持正确：user → tool_result(含提醒) → assistant。

### GUI 过滤

```ts
// gui/src/components/chat/MessageItem.tsx:20
function stripSystemReminder(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
}
```

GUI 显示消息时用正则剥离所有 system-reminder 标签及内容，用户永远看不到。

### `isMeta: true`

部分 system-reminder 标记 `isMeta: true`，表示该消息不写入会话历史/转录，仅在当前 turn 有效。

## 所有类型一览

### 提醒类

| 类型 | 用途 |
|------|------|
| `todo_reminder` | 提醒 AI 定期更新 TodoWrite 任务列表 |
| `task_reminder` | 提醒 AI 使用 Task 工具进行任务管理 |
| `compaction_reminder` | 告知 AI 上下文压缩已启用，无需担心窗口耗尽 |
| `verify_plan_reminder` | 提醒验证当前计划是否仍然正确 |
| `context_efficiency` | 上下文效率优化提示 |

### 模式切换

| 类型 | 用途 |
|------|------|
| `plan_mode` | 通知 AI 进入计划模式 |
| `plan_mode_reentry` | 通知 AI 重新进入计划模式（已压缩后恢复） |
| `plan_mode_exit` | 通知 AI 退出计划模式 |
| `auto_mode` | 通知 AI 进入自动模式 |
| `auto_mode_exit` | 通知 AI 退出自动模式 |

### 记忆注入

| 类型 | 用途 |
|------|------|
| `nested_memory` | 注入嵌套记忆文件内容（如 CLAUDE.md, MEMORY.md 引用） |
| `relevant_memories` | 注入语义搜索匹配的记忆内容 |
| `agent_mention` | 注入 Agent 被 @ 提及时的关联数据 |

### 技能注入

| 类型 | 用途 |
|------|------|
| `invoked_skills` | 注入已被调用的技能内容 |
| `skill_listing` | 注入可用技能列表 |
| `skill_discovery` | 注入任务相关的技能推荐 |

### 环境变化

| 类型 | 用途 |
|------|------|
| `date_change` | 通知 AI 日期已变更 |
| `critical_system_reminder` | 关键系统消息（如安全性警告） |
| `output_style` | 控制 AI 输出格式/风格 |

### 文件附件

| 类型 | 用途 |
|------|------|
| `file` / `directory` | 注入文件/目录内容（用户拖放或 @ 引用） |
| `edited_text_file` | 注入编辑器当前内容 |
| `compact_file_reference` | 文件引用在压缩后的精简表示 |
| `pdf_reference` | PDF 文件引用 |
| `plan_file_reference` | 计划文件引用 |
| `selected_lines_in_ide` | IDE 中选中的代码行 |
| `opened_file_in_ide` | IDE 中打开的文件 |
| `already_read_file` | 标记文件已被读取（避免重复） |

### Hook 系统

| 类型 | 用途 |
|------|------|
| `async_hook_response` | 异步 hook 的响应结果 |
| `hook_blocking_error` | hook 阻塞错误 |
| `hook_success` | hook 成功执行 |
| `hook_additional_context` | hook 提供的额外上下文 |
| `hook_stopped_continuation` | hook 停止续写的通知 |
| `hook_cancelled` | hook 被取消 |
| `hook_error_during_execution` | hook 执行错误 |
| `hook_non_blocking_error` | hook 非阻塞错误 |
| `hook_system_message` | hook 系统消息 |
| `hook_permission_decision` | hook 权限决策 |

### 其他

| 类型 | 用途 |
|------|------|
| `todo_reminder` → `deferred_tools_delta` | Todo 任务变更增量通知 |
| `diagnostics` | 诊断信息 |
| `mcp_resource` | MCP 服务器资源内容 |
| `mcp_instructions_delta` | MCP 指令增量更新 |
| `task_status` | Task 状态更新 |
| `token_usage` / `output_token_usage` / `budget_usd` | Token / 预算使用统计 |
| `queued_command` | 排队命令（系统生成的任务通知等） |
| `team_context` | 团队协作上下文 |
| `companion_intro` | 同伴代理介绍 |
| `command_permissions` | 命令权限信息 |
| `structured_output` | 结构化输出要求 |

## 关键代码路径

| 文件 | 功能 |
|------|------|
| `src/utils/messages.ts` | `wrapInSystemReminder()`, `wrapMessagesInSystemReminder()`, attachment → system-reminder 转换（所有 case） |
| `src/utils/attachments.ts` | `reminderType: 'full' \| 'sparse'` 控制注入详细程度 |
| `gui/src/components/chat/MessageItem.tsx` | `stripSystemReminder()` 从显示内容中剥离标签 |

## 设计要点

1. **不污染用户输入** — system-reminder 包裹的内容不会被当成用户说的话
2. **可被压缩** — system-reminder 文本不参与 compaction/摘要
3. **GUI 透明** — 前端统一过滤，用户看到的是干净的消息
4. **full/sparse 循环** — 进入新模式时发 full 提醒（完整工具 schema），后续 turn 发 sparse（精简版），减少 token 消耗
