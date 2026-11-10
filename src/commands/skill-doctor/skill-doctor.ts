/**
 * /skill-doctor —— 找出「占着上下文但没人用」的技能。
 *
 * 每个技能的 name + description + whenToUse 会随系统提示词**每一轮注入**。
 * 装得越多，固定开销越大；而用不上的技能平时完全看不出来。这个命令把
 * 「占用多少」和「用过几次」并排放，让用户自己决定删谁。
 *
 * 数据来源都是现成的，本命令只做聚合 + 排序 + 排版：
 *   · 占用量 —— `estimateSkillFrontmatterTokens()`（与 /context 同一算法）
 *   · 使用次数/最后使用 —— `getGlobalConfig().skillUsage`（SkillTool 调用时记录）
 */
import { getSkillToolCommands } from '../../commands.js'
import { estimateSkillFrontmatterTokens } from '../../skills/loadSkillsDir.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import type { LocalCommandCall } from '../../types/command.js'

/** 超过这么久没用，就算"陈旧"。30 天是经验值：覆盖—个月没碰的临时技能，
 *  又不至于把季度性任务（如月末报表）误判成垃圾。 */
const STALE_DAYS = 30
/** 从未使用且占用达到这个量级才值得单独拎出来建议删除 ——
 *  只有几十 token 的技能删了也没意义，反而让人以为系统在乱出主意。 */
const HIGH_COST_TOKENS = 200

type Row = {
  name: string
  tokens: number
  usageCount: number
  lastUsedAt: number | null
}

function daysSince(ts: number | null): number | null {
  if (ts === null) return null
  return Math.floor((Date.now() - ts) / 86_400_000)
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** 按「浪费度」分档：从没用过的大块头排最前，常用的小技能沉底。
 *  抽成纯函数是为了可测 —— 排序/分档规则错了用户会被误导去删有用的技能。 */
export function classifySkills(rows: readonly Row[], now = Date.now()): {
  neverUsed: Row[]
  stale: Row[]
  active: Row[]
} {
  const ageDays = (r: Row) =>
    r.lastUsedAt === null ? null : Math.floor((now - r.lastUsedAt) / 86_400_000)
  const byTokensDesc = (a: Row, b: Row) => b.tokens - a.tokens

  return {
    neverUsed: rows.filter(r => r.usageCount === 0).sort(byTokensDesc),
    stale: rows
      .filter(r => r.usageCount > 0 && (ageDays(r) ?? 0) >= STALE_DAYS)
      .sort(byTokensDesc),
    active: rows
      .filter(r => r.usageCount > 0 && (ageDays(r) ?? 0) < STALE_DAYS)
      .sort((a, b) => b.usageCount - a.usageCount),
  }
}

export const call: LocalCommandCall = async () => {
  const cwd = getCwd()
  const [skills, config] = await Promise.all([
    getSkillToolCommands(cwd),
    Promise.resolve(getGlobalConfig()),
  ])

  if (skills.length === 0) {
    return { type: 'text', value: '没有加载任何技能。' }
  }

  const usage = config.skillUsage ?? {}
  const rows: Row[] = skills.map(s => {
    const u = usage[s.name]
    return {
      name: s.name,
      tokens: estimateSkillFrontmatterTokens(s),
      usageCount: u?.usageCount ?? 0,
      lastUsedAt: u?.lastUsedAt ?? null,
    }
  })

  const totalTokens = rows.reduce((a, r) => a + r.tokens, 0)
  const { neverUsed, stale, active } = classifySkills(rows)

  const lines: string[] = []
  lines.push(
    `技能上下文开销：共 ${rows.length} 个，每轮固定占用约 ${formatTokens(totalTokens)} tokens`,
  )
  lines.push('')

  const detail = (r: Row): string => {
    const d = daysSince(r.lastUsedAt)
    const used =
      r.usageCount === 0
        ? '从未使用'
        : `${r.usageCount} 次，${d === 0 ? '今天' : `${d} 天前`}用过`
    return `  ${r.name.padEnd(28)} ${formatTokens(r.tokens).padStart(6)} tokens   ${used}`
  }

  // 每组最多列 10 条 —— 装了几十个技能时全列会刷屏，反而看不清重点。
  // 按 token 降序排，被折叠掉的一定是最不值钱的尾部。
  const MAX_ROWS = 10
  const group = (title: string, rows: Row[]) => {
    if (rows.length === 0) return
    lines.push(`${title}（${rows.length} 个）`)
    for (const r of rows.slice(0, MAX_ROWS)) lines.push(detail(r))
    if (rows.length > MAX_ROWS) {
      const restTokens = rows.slice(MAX_ROWS).reduce((a, r) => a + r.tokens, 0)
      lines.push(`  …还有 ${rows.length - MAX_ROWS} 个，合计 ${formatTokens(restTokens)} tokens`)
    }
    lines.push('')
  }

  group('从未使用', neverUsed)
  group(`${STALE_DAYS} 天以上未使用`, stale)

  if (active.length > 0) {
    lines.push(`近期在用（${active.length} 个）`)
    for (const r of active.slice(0, MAX_ROWS)) lines.push(detail(r))
    if (active.length > MAX_ROWS) lines.push(`  …还有 ${active.length - MAX_ROWS} 个`)
    lines.push('')
  }

  // 只建议删「从未使用且值得一删」的，不含长期未用的 ——
  // 后者可能是季节性任务，误删伤害大。让用户自己看上面的清单判断。
  const worthRemoving = neverUsed.filter(r => r.tokens >= HIGH_COST_TOKENS)
  if (worthRemoving.length > 0) {
    const saved = worthRemoving.reduce((a, r) => a + r.tokens, 0)
    lines.push(
      `建议：上面 ${worthRemoving.length} 个从未使用且单个占用 ≥${HIGH_COST_TOKENS} tokens，` +
        `移除可省约 ${formatTokens(saved)} tokens/轮。`,
    )
    lines.push(`  ${worthRemoving.map(r => r.name).join(', ')}`)
  } else if (neverUsed.length > 0) {
    lines.push('从未使用的技能占用都不大，删不删影响有限。')
  } else {
    lines.push('没有从未使用的技能 —— 当前配置很紧凑。')
  }

  return { type: 'text', value: lines.join('\n') }
}
