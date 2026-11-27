// MCP 工具的 inputSchema 归一化（独立模块：client.ts 太大，测试不该拉起它）

import type { Tool } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'

/**
 * 把 MCP 服务器给的 `inputSchema` 归一成 Anthropic 能接受的形状。
 *
 * 我们直接把它当 `input_schema` 发给 API，而 API 要求它必须是 **object 类型**
 * 的 JSON Schema。MCP 服务器写错（漏 `type`、或给了 `string`）时，第三方
 * provider 会**静默丢掉整个工具** —— 表现为"这个工具不存在"，排查时看不出
 * 原因（官方 2.1.330 修的正是这个）。
 *
 * 处理：不是 object schema 就换成**宽松的 object schema**
 * （`additionalProperties: true`），至少让模型还能传参数调它。
 * 不包成 `{input: <原schema>}` —— 那会改变调用形状，服务器认不出来。
 */
export function normalizeMcpInputSchema(
  schema: unknown,
  serverName: string,
  toolName: string,
): Tool['inputJSONSchema'] {
  if (
    schema &&
    typeof schema === 'object' &&
    (schema as { type?: unknown }).type === 'object'
  ) {
    return schema as Tool['inputJSONSchema']
  }
  logForDebugging(
    `MCP 工具 ${serverName}/${toolName} 的 inputSchema 不是 object 类型` +
      `（${schema == null ? '缺失' : JSON.stringify(schema).slice(0, 120)}）` +
      ` → 已替换为宽松 object schema，避免 provider 丢弃该工具`,
    { level: 'warn' },
  )
  return { type: 'object', properties: {}, additionalProperties: true }
}
