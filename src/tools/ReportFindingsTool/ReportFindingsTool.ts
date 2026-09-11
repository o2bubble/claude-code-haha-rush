import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { REPORT_FINDINGS_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

const FindingSchema = z.object({
  file: z.string().describe('Repo-relative path of the file the finding is in'),
  line: z
    .number()
    .int()
    .optional()
    .describe('1-indexed line the finding anchors to'),
  summary: z.string().describe('One-sentence statement of the defect'),
  failure_scenario: z
    .string()
    .describe('Concrete inputs/state → wrong output/crash'),
  category: z
    .string()
    .max(40)
    .optional()
    .describe(
      'Short kebab-case slug of the finding type, e.g. "correctness", "simplification", "efficiency", "test-coverage"',
    ),
  verdict: z
    .enum(['CONFIRMED', 'PLAUSIBLE'])
    .optional()
    .describe('Set when a verify pass ran; absent on inline-only reviews'),
  outcome: z
    .enum(['fixed', 'skipped', 'no_change_needed'])
    .optional()
    .describe(
      'Set ONLY when re-reporting after applying fixes: what happened to this finding',
    ),
})

const inputSchema = lazySchema(() =>
  z.object({
    level: z
      .enum(['low', 'medium', 'high', 'xhigh', 'max'])
      .optional()
      .describe('Effort level the review ran at'),
    findings: z
      .array(FindingSchema)
      .max(32)
      .describe('Verified findings, most-severe first; empty if none survived'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const ReportFindingsTool = buildTool({
  name: REPORT_FINDINGS_TOOL_NAME,
  searchHint: 'report structured code-review findings',
  maxResultSizeChars: 100_000,

  userFacingName() {
    return 'ReportFindings'
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  isEnabled() {
    return true
  },

  isReadOnly() {
    return true
  },

  shouldDefer: false,

  async description() {
    return DESCRIPTION
  },

  async prompt() {
    return PROMPT
  },

  toAutoClassifierInput(input) {
    return `${input.findings.length} finding(s)${input.level ? ` (${input.level})` : ''}`
  },

  renderToolUseMessage() {
    return null
  },

  async call(input) {
    const { findings, level } = input

    return {
      data: {
        level: level ?? null,
        count: findings.length,
        findings,
      },
    }
  },

  mapToolResultToToolResultBlockParam(data, toolUseID) {
    const { level, count, findings } = data as {
      level: string | null
      count: number
      findings: Array<{ summary: string; file: string; line?: number }>
    }

    const lines = [
      count === 0
        ? 'No findings reported — review passed clean.'
        : `${count} finding(s) reported${level ? ` (effort: ${level})` : ''}:`,
    ]

    for (const f of findings) {
      const loc = f.file + (f.line ? `:${f.line}` : '')
      lines.push(`  [${loc}] ${f.summary}`)
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, { level: string | null; count: number; findings: Array<unknown> }>)
