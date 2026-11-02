/**
 * ListAgents —— 列出「可以发消息的对象」。
 *
 * ## 两类目标
 *
 * ① **本进程内的子 agent / 同队 teammate** —— 来自 AppState.tasks，可用
 *    `SendMessage({to: "<name>| <taskId>", message})` 继续对话。
 * ② **同机其他 Claude 会话** —— 来自 `~/.claude/sessions/*.json`（见
 *    utils/sessionPeers.ts），地址 `session-<pid>`。
 *
 * ## 与官方的差异
 *
 * 官方 2.1.316 的 ListAgents 还覆盖云端 / Remote Control 会话（`bridge:`），
 * 我们**不做跨机** —— 那部分保持不列出，避免给模型一个永远连不上的地址。
 */

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { describePeer, listPeerSessions } from '../../utils/sessionPeers.js'

const LIST_AGENTS_TOOL_NAME = 'ListAgents'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    agents: z.array(
      z.object({
        name: z.string(),
        kind: z.enum(['subagent', 'teammate']),
        status: z.string(),
        description: z.string(),
      }),
    ),
    sessions: z.array(
      z.object({
        address: z.string(),
        pid: z.number(),
        cwd: z.string(),
        status: z.string(),
        doing: z.string(),
        idleMs: z.number(),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type ListAgentsOutput = z.infer<OutputSchema>

const DESCRIPTION = `Lists agents you can SendMessage to: subagents and teammates running inside this session, plus other Claude sessions running on this machine.

Names are the address — send with SendMessage({to: "<name>", message: "..."}), copying the name exactly as a row prints it. Local sessions use the form "session-<pid>".`

export const ListAgentsTool = buildTool({
  name: LIST_AGENTS_TOOL_NAME,
  searchHint: 'list agents and sessions you can message',
  maxResultSizeChars: 40_000,
  shouldDefer: false,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return `${DESCRIPTION}

Use this before SendMessage when you are not sure the target still exists — addresses are cheap to re-read and a failed send costs a round trip.`
  },
  async call(_input, context) {
    const tasks = context.getAppState().tasks ?? {}

    const agents: ListAgentsOutput['agents'] = []
    for (const [taskId, task] of Object.entries(tasks)) {
      if (isLocalAgentTask(task)) {
        agents.push({
          name: task.agentId || taskId,
          kind: 'subagent',
          status: task.status,
          description: (task.description || task.prompt || '').slice(0, 80),
        })
        continue
      }
      if (isInProcessTeammateTask(task)) {
        agents.push({
          name: (task as { identity?: { name?: string } }).identity?.name || taskId,
          kind: 'teammate',
          status: task.status,
          description: (task.description || '').slice(0, 80),
        })
      }
    }

    const peers = await listPeerSessions()
    const sessions: ListAgentsOutput['sessions'] = peers.map(p => ({
      address: p.address,
      pid: p.pid,
      cwd: p.cwd ?? '',
      status: p.status ?? 'unknown',
      doing: p.waitingFor?.trim() || p.name?.trim() || '',
      idleMs: p.ageMs,
    }))

    return { data: { agents, sessions } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines: string[] = []

    if (output.agents.length > 0) {
      lines.push('Agents in this session:')
      for (const a of output.agents) {
        lines.push(`- ${a.name} (${a.kind}, ${a.status}) ${a.description}`)
      }
    } else {
      lines.push('No subagents or teammates are running in this session.')
    }

    if (output.sessions.length > 0) {
      lines.push('', 'Other Claude sessions on this machine:')
      for (const s of output.sessions) {
        const doing = s.doing ? ` — ${s.doing}` : ''
        lines.push(`- ${s.address} (${s.status}${doing}) ${s.cwd}`)
      }
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
    }
  },
  // 纯文本结果，终端里直接显示；不需要专门的 UI 渲染器。
  renderToolUseMessage: () => 'list agents',
  renderToolResultMessage: output =>
    `${output.agents.length} agent(s), ${output.sessions.length} session(s)`,
} satisfies ToolDef<InputSchema, ListAgentsOutput>)

export { LIST_AGENTS_TOOL_NAME }
