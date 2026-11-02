import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'

export const GREP_TOOL_NAME = 'Grep'

// ⚠️ 2026-11-02 精简（官方 2.1.316 同名工具 477 字符）。删掉的是与系统提示
// 重复的"别用 Bash 的 grep"细节；"多轮搜索改用 Agent"保留一句 —— 它决定工具选择。
// ⚠️ 反斜杠必须双写（`\\s`）：模板字符串里 `\s` 会退化成 `s`，示例就废了。
export function getDescription(): string {
  return `A powerful search tool built on ripgrep.

- ALWAYS use ${GREP_TOOL_NAME} for content search — never invoke \`grep\` or \`rg\` via Bash.
- Full regex syntax (e.g. "log.*Error", "function\\s+\\w+"). Literal braces need escaping (\`interface\\{\\}\` finds \`interface{}\` in Go).
- Filter with glob ("*.js", "**/*.tsx") or type ("js", "py", "rust").
- Output modes: "content" (matching lines), "files_with_matches" (paths, default), "count".
- Multiline: by default patterns match within a single line. For cross-line patterns use \`multiline: true\`.
- For open-ended searches needing several rounds of globbing and grepping, use ${AGENT_TOOL_NAME} instead.
`
}
