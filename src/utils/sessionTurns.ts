/**
 * 会话 transcript 的「按轮删除」。
 *
 * ## 为什么是「轮」而不是「条」
 *
 * transcript 是 `parentUuid` 链表，中间删一条会让 `buildConversationChain`
 * 在 `messages.get(parentUuid) === undefined` 处**停止**，它之前的历史全部
 * 从加载结果里消失（文件里还在，但界面上没了）。
 *
 * 链表本身好修 —— `loadTranscriptFile` 的 `progressBridge` 就是同一套思路：
 * 因为 transcript 是 append-only（父在子前），可以记录「被移除的 uuid → 它的父」，
 * 再把子节点的 parentUuid 改指向那里。这里做的是同一件事，只是在**写盘时**
 * 一次做完，加载器不需要任何改动。
 *
 * 真正的风险在语义层：
 *   · 删掉 assistant 的 tool_use，后面的 tool_result 悬空 → resume 时 API 拒绝
 *   · 只删 user prompt，剩两个连续 assistant → 角色交替被破坏
 * 按「轮」删天然避开这两种：一轮 = 一条真实用户输入 + 它后面直到下一条真实
 * 用户输入的全部内容，tool 配对与角色交替都是完整的。
 *
 * ## 「真实用户输入」的判据
 *
 * transcript 里 `type: 'user'` 有两类：真正的人打的字，和工具返回结果
 * （content 全是 `tool_result` 块）。后者属于上一轮，不是新的一轮。
 * 另外压缩摘要（`isCompactSummary`）也是 user 类型，但它是上下文锚点，不能当轮起点。
 */

/** transcript 里的一条原始记录（保留未知字段，写回时原样输出）。 */
export interface TranscriptEntry {
  type?: string
  uuid?: string
  parentUuid?: string | null
  isMeta?: boolean
  isCompactSummary?: boolean
  isVisibleInTranscriptOnly?: boolean
  subtype?: string
  message?: { content?: unknown }
  [k: string]: unknown
}

export interface Turn {
  /** 轮标识 = 起点那条 user 消息的 uuid */
  id: string
  /** 起点在原始 entries 里的下标（便于按顺序展示） */
  startIndex: number
  /** 本轮包含的 entries 条数（含起点） */
  entryCount: number
  /** 起点那条 user 消息的纯文本预览 */
  preview: string
  /** 本轮涉及的 uuid（删除时用） */
  uuids: string[]
}

/** 是否参与 parentUuid 链 —— 与 sessionStorage 的 isTranscriptMessage 同口径。 */
export function isChainEntry(e: TranscriptEntry): boolean {
  return (
    e.type === 'user' ||
    e.type === 'assistant' ||
    e.type === 'attachment' ||
    e.type === 'system'
  )
}

/** 压缩边界：`parentUuid: null` + `logicalParentUuid`，是链的锚点。 */
function isCompactBoundary(e: TranscriptEntry): boolean {
  return e.type === 'system' && e.subtype === 'compact_boundary'
}

/**
 * 是不是「一轮的开始」—— 真实用户输入。
 *
 * 排除：
 *  · 只有 tool_result 的 user 消息（那是工具返回，属于当前轮）
 *  · isMeta / isCompactSummary / isVisibleInTranscriptOnly（程序生成的）
 *  · 压缩边界（system 条目，不是 user）
 */
export function isTurnStart(e: TranscriptEntry): boolean {
  if (e.type !== 'user') return false
  if (e.isMeta) return false
  if (e.isCompactSummary) return false
  if (e.isVisibleInTranscriptOnly) return false

  const content = e.message?.content
  if (typeof content === 'string') return content.trim().length > 0
  if (Array.isArray(content)) {
    // 全是 tool_result 的是工具返回，不是人打的字
    return content.some(
      b => !(b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result'),
    )
  }
  return false
}

/** 从消息体里抽一段纯文本做预览。 */
function previewOf(e: TranscriptEntry): string {
  const content = e.message?.content
  if (typeof content === 'string') return content.slice(0, 120)
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const b of content) {
      if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
        const t = (b as { text?: unknown }).text
        if (typeof t === 'string') texts.push(t)
      }
    }
    if (texts.length) return texts.join(' ').slice(0, 120)
  }
  return '(无文本内容)'
}

/**
 * 把 entries 切成「轮」。
 *
 * 第一个真实用户输入之前的内容（附件、system 提示等）归入一个**不可删**的
 * 前置段 —— 不给它 id，界面上不展示为可选轮次。
 */
export function groupTurns(entries: readonly TranscriptEntry[]): Turn[] {
  const starts: number[] = []
  for (let i = 0; i < entries.length; i++) {
    if (isTurnStart(entries[i])) starts.push(i)
  }

  const turns: Turn[] = []
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k]
    const end = k + 1 < starts.length ? starts[k + 1] : entries.length
    const slice = entries.slice(start, end)
    const startEntry = entries[start]
    const id = startEntry.uuid
    if (!id) continue // 没有 uuid 就没法定位，跳过
    turns.push({
      id,
      startIndex: start,
      entryCount: slice.length,
      preview: previewOf(startEntry),
      uuids: slice.map(e => e.uuid).filter((u): u is string => typeof u === 'string'),
    })
  }
  return turns
}

export interface DeleteResult {
  /** 写回用的 entries（保序，未删除的原样保留） */
  entries: TranscriptEntry[]
  /** 删掉了多少条 */
  removedCount: number
  /** 有多少条的 parentUuid 被改写 */
  repairedCount: number
  /** 被拒绝的 turn id（不存在 / 受保护） */
  rejected: string[]
}

/**
 * 删除指定轮次并修复 parentUuid 链。
 *
 * 链表修复：被删的 uuid 记为「→ 它的父」，连续被删时一路解析到最近的幸存祖先
 * （与 `loadTranscriptFile` 的 progressBridge 同一套做法）。
 */
export function deleteTurns(
  entries: readonly TranscriptEntry[],
  turnIds: readonly string[],
): DeleteResult {
  const turns = groupTurns(entries)
  const byId = new Map(turns.map(t => [t.id, t]))
  const rejected: string[] = []

  const removedUuids = new Set<string>()
  for (const id of turnIds) {
    const t = byId.get(id)
    if (!t) {
      rejected.push(id)
      continue
    }
    for (const u of t.uuids) removedUuids.add(u)
  }

  // 压缩边界是链的锚点（parentUuid=null），删了会让后续整段失去根
  for (const e of entries) {
    if (isCompactBoundary(e) && e.uuid && removedUuids.has(e.uuid)) {
      removedUuids.delete(e.uuid)
      for (const t of turns) {
        if (t.uuids.includes(e.uuid)) rejected.push(t.id)
      }
    }
  }

  if (removedUuids.size === 0) {
    return { entries: [...entries], removedCount: 0, repairedCount: 0, rejected }
  }

  // 被删条目的 parentUuid 映射（连续被删时链式解析到幸存祖先）
  const bridge = new Map<string, string | null>()
  for (const e of entries) {
    if (!e.uuid || !removedUuids.has(e.uuid)) continue
    const p = e.parentUuid ?? null
    bridge.set(e.uuid, p && bridge.has(p) ? (bridge.get(p) ?? null) : p)
  }

  let repairedCount = 0
  const kept: TranscriptEntry[] = []
  let removedCount = 0

  for (const e of entries) {
    if (e.uuid && removedUuids.has(e.uuid)) {
      removedCount++
      continue
    }
    if (e.parentUuid && bridge.has(e.parentUuid)) {
      kept.push({ ...e, parentUuid: bridge.get(e.parentUuid) ?? null })
      repairedCount++
      continue
    }
    kept.push(e)
  }

  return { entries: kept, removedCount, repairedCount, rejected }
}

/**
 * 校验删除结果是否会留下一个加载不出来的会话。
 *
 * `loadTranscriptFile` 在没有 leaf、或链上一片空白时会抛错。这里做**删除前**的
 * 预检，把"删完就打不开"挡在写盘之前。
 */
export function validateAfterDelete(
  entries: readonly TranscriptEntry[],
): { ok: true } | { ok: false; reason: string } {
  const chain = entries.filter(e => isChainEntry(e) && e.uuid)
  if (chain.length === 0) {
    return { ok: false, reason: '删完就没有任何消息了，这条会话会打不开' }
  }
  const uuids = new Set(chain.map(e => e.uuid as string))
  // 至少要有至少一条 parentUuid 为 null（链的根）—— 否则整条链悬空
  const hasRoot = chain.some(e => !e.parentUuid)
  if (!hasRoot) {
    return { ok: false, reason: '删除后找不到会话链的起点（parentUuid 全悬空）' }
  }
  // 所有 parentUuid 都必须指向存在的条目（压缩边界的 logicalParentUuid 除外）
  for (const e of chain) {
    if (e.parentUuid && !uuids.has(e.parentUuid)) {
      return {
        ok: false,
        reason: `删除后仍有条目指向不存在的消息（${e.parentUuid.slice(0, 8)}…）`,
      }
    }
  }
  return { ok: true }
}
