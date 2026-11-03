/**
 * DeferredToolPlaceholder —— 官方 2.1.316 里的同名工具，**永远不该被调用**。
 *
 * ## 它解决什么
 *
 * `claude.ts` 原本的规则：延迟工具集合为空（且没有 MCP 还在连接）→ 把
 * tool search 整个关掉，连 `ToolSearch` 一起从 tools 里摘掉。
 *
 * 后果是 **tools 数组的形状会随 MCP 连接状态变化**：
 *
 *   MCP 全连上且有延迟工具 → [ …11 个内联工具, ToolSearch ]
 *   所有 MCP 断开        → [ …11 个内联工具 ]        ← 少了 ToolSearch
 *
 * tools 块在缓存前缀最前面，形状一变整个请求的 prompt cache 就作废。
 *
 * 这个占位符本身带 `defer_loading: true`，只要它在，延迟工具集合就不为空 ——
 * tool search 保持开启，tools 数组形状稳定。
 *
 * 描述里明确写着「never call this tool」，所以模型不会去用它。
 */

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

export const DEFERRED_TOOL_PLACEHOLDER_NAME = 'DeferredToolPlaceholder'

const DESCRIPTION =
  'Reserved placeholder that keeps deferred tool loading active; never call this tool.'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() => z.object({ unused: z.literal(true) }))
type OutputSchema = ReturnType<typeof outputSchema>
type PlaceholderOutput = z.infer<OutputSchema>

export const DeferredToolPlaceholder = buildTool({
  name: DEFERRED_TOOL_PLACEHOLDER_NAME,
  searchHint: '',
  // 空 schema + 固定短文本，占用可以忽略。
  maxResultSizeChars: 200,
  // 关键：让它进延迟工具集合（isDeferredTool 认这个字段），
  // 从而让 tool search 保持开启。见文件头说明。
  shouldDefer: true,
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
    return DESCRIPTION
  },
  async call(_args) {
    // 永远不该走到这里。真被调用了说明模型没遵守描述 —— 返回一行提示，
    // 不要抛错（抛错会在 UI 上留一条红色失败记录，反而干扰用户）。
    return { data: { unused: true as const } }
  },
  mapToolResultToToolResultBlockParam(_output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content:
        'DeferredToolPlaceholder is reserved and not callable. Ignore it and use ToolSearch to load tools, or just answer directly.',
    }
  },
  renderToolUseMessage: () => 'placeholder',
} satisfies ToolDef<InputSchema, PlaceholderOutput>)
