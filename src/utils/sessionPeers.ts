/**
 * 同机其他 Claude 会话的发现与寻址。
 *
 * ## 现状（2026-11-02）
 *
 * `concurrentSessions.ts` 已经会在 `~/.claude/sessions/<pid>.json` 写一份
 * 自述（pid / sessionId / cwd / kind / startedAt …），但它原先只服务于
 * `claude ps` 的计数与 `ListPeers`，而 ListPeers 的实现文件在泄漏源码里
 * 根本不存在。这里补齐"发现"这一半，**不引入 UDS socket**：
 *
 * - 官方用 `<socket-path>` 寻址，需要每个进程起一个监听器（Windows 上虽然
 *   也能跑 AF_UNIX，但路径长度、权限、清理都是一堆坑）；
 * - 我们复用已有的**文件邮箱**（`teammateMailbox.ts`，带 proper-lockfile），
 *   `useInboxPoller` 每秒轮询一次，天然就是投递通道。
 *
 * 代价是多 1 秒延迟，换来零新增通信协议。跨机（`bridge:`）不在此范围。
 *
 * ## 地址格式
 *
 * `session-<pid>` —— 稳定、可读、与 `sessions/<pid>.json` 一一对应。
 * 也接受裸 pid 与 sessionId 前缀，见 `resolvePeerSession`。
 */

import { readdir, readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { isProcessRunning } from './genericProcessUtils.js'
import { jsonParse } from './slowOperations.js'

/** `~/.claude/sessions/` 下 `<pid>.json` 的结构（写入方见 concurrentSessions.ts）。 */
export type SessionRecord = {
  pid: number
  sessionId?: string
  cwd?: string
  startedAt?: number
  kind?: string
  entrypoint?: string
  /** 仅 UDS_INBOX 构建会写；我们不用它寻址，但保留以便识别官方会话。 */
  messagingSocketPath?: string
  name?: string
  /** busy / idle / waiting —— 需要对方也在跑本 fork 才会写。 */
  status?: string
  /** 自由文本，描述此刻在做什么（由 updateSessionActivity 写入）。 */
  waitingFor?: string
  updatedAt?: number
}

export type PeerSession = SessionRecord & {
  /** 寻址用的稳定名字：`session-<pid>`。 */
  address: string
  /** 存活判定结果。 */
  alive: boolean
  /** 毫秒级，最近一次自述距今多久。 */
  ageMs: number
}

function getSessionsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')
}

/** 会话地址（SendMessage 的 `to`）。 */
export function sessionAddress(pid: number): string {
  return `session-${pid}`
}

/**
 * 会话信箱的保留“团队”名。
 *
 * 复用 `teammateMailbox.ts` 的文件锁与读写（路径是
 * `~/.claude/teams/<team>/inboxes/<agent>.json`），但会话不是 team —— 用一个
 * 下划线开头的保留名，避免与用户真实团队重名（`sanitizePathComponent` 不会
 * 剥掉下划线，且真实团队名由用户起，极少以下划线开头）。
 */
export const SESSION_INBOX_TEAM = '_sessions'

/** 从 `session-<pid>` 里取 pid；不是该格式返回 null。 */
export function pidFromSessionAddress(to: string): number | null {
  const m = /^session-(\d+)$/.exec(to.trim())
  if (!m) return null
  const pid = parseInt(m[1], 10)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

/**
 * 列出同机其他会话（不含自己）。
 *
 * - 存活：`process.kill(pid, 0)` 成功
 * - 陈旧文件（进程已退）：直接删除，避免名单里堆死条目
 * - 读不出来 / 不再是数字文件名的：跳过（宁可漏，不误删）
 */
export async function listPeerSessions(): Promise<PeerSession[]> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  const now = Date.now()
  const selfPid = process.pid
  const selfSessionId = getSessionId()
  const out: PeerSession[] = []

  for (const file of files) {
    // 与 concurrentSessions.countConcurrentSessions 同样的严格文件名检查：
    // parseInt 的前缀解析会把 `2026-03-14_notes.md` 当成 pid 2026 并误删。
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)
    if (pid === selfPid) continue

    const alive = isProcessRunning(pid)
    const full = join(dir, file)
    if (!alive) {
      // await 而不是 fire-and-forget：短命的 `-p` 进程 / SDK 调用可能在清理
      // 完成前就退出事件循环，残留文件会一直堆在名单里。
      await unlink(full).catch(() => {})
      continue
    }

    let rec: SessionRecord
    try {
      rec = jsonParse(await readFile(full, 'utf8')) as SessionRecord
    } catch {
      continue
    }
    // 文件里写的 pid 与文件名不一致 —— 可疑，跳过（不删，交给 countConcurrentSessions）
    if (rec.pid !== pid) continue
    // 同一个 session 被别的进程 resume 过：两边都活着时以 pid 区分，但同一
    // sessionId 出现在多条记录里说明是同一份对话的两个进程，仍各自可寻址。
    void selfSessionId

    out.push({
      ...rec,
      address: sessionAddress(pid),
      alive,
      ageMs: now - (rec.updatedAt ?? rec.startedAt ?? now),
    })
  }

  // 最近活跃的排前面
  out.sort((a, b) => a.ageMs - b.ageMs)
  return out
}

/**
 * 把用户/模型给的地址解析成一个具体会话。
 *
 * 支持三种写法（都大小写不敏感）：
 *   · `session-1234`  —— 完整地址
 *   · `1234`          —— 裸 pid
 *   · `ab12cd34`      —— sessionId 前缀（至少 6 位，避免误配）
 *
 * 找不到返回 null；前缀命中多个也返回 null（要求唯一，避免发错会话）。
 */
export async function resolvePeerSession(
  to: string,
): Promise<{ session: PeerSession } | { error: string }> {
  const raw = to.trim()
  if (!raw) return { error: 'empty address' }

  const directPid = pidFromSessionAddress(raw) ?? (/^\d+$/.test(raw) ? parseInt(raw, 10) : null)
  const peers = await listPeerSessions()

  if (directPid !== null) {
    const hit = peers.find(p => p.pid === directPid)
    return hit ? { session: hit } : { error: `no live session with pid ${directPid}` }
  }

  const needle = raw.toLowerCase()
  if (needle.length < 6) {
    return { error: `session id prefix "${raw}" is too short (need ≥ 6 chars)` }
  }
  const matches = peers.filter(p => (p.sessionId ?? '').toLowerCase().startsWith(needle))
  if (matches.length === 0) return { error: `no live session matching "${raw}"` }
  if (matches.length > 1) {
    return {
      error: `"${raw}" matches ${matches.length} sessions (${matches
        .map(m => m.address)
        .join(', ')}) — use a longer prefix or the full address`,
    }
  }
  return { session: matches[0] }
}

/**
 * 人可读的一行摘要，供 ListAgents 输出。
 * 形如：`session-1234  忙  C:\proj\foo  (前端重构)  12s前`
 */
export function describePeer(p: PeerSession): string {
  const status =
    p.status === 'busy' ? '忙' : p.status === 'waiting' ? '等待中' : p.status === 'idle' ? '空闲' : '未知'
  const dir = (p.cwd ?? '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '(无目录)'
  const doing = p.waitingFor?.trim() || p.name?.trim() || ''
  const age = p.ageMs < 60_000 ? `${Math.round(p.ageMs / 1000)}s前` : `${Math.round(p.ageMs / 60_000)}m前`
  return `${p.address}  ${status}  ${dir}${doing ? `  (${doing})` : ''}  ${age}`
}
