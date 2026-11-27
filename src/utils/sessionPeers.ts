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

import { readdir, readFile, stat, unlink } from 'fs/promises'
import { join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
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
  /**
   * 这个记录来自**会心跳**的版本（2026-11-23 起）。
   *
   * 有了它才能放心用"mtime 是否新鲜"判定存活；没有它的老记录只能退回
   * pid 存活判定（宽松得多），否则升级过渡期会把所有旧会话误判成已死。
   */
  heartbeat?: boolean
  /**
   * IDE 模式 WebSocket 端口。
   *
   * 让**别的进程**能连上来只读地看这个会话在说什么（GUI 的镜像面板）。
   * 写在记录里而不是只留在 spawn 方的内存里 —— 端口要能跨 GUI 重启存活，
   * 而且任何形态起的会话（GUI / 手工 / 后台唤醒）都该能被围观。
   */
  idePort?: number
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
 * 心跳多久没刷新就认定这个会话已经不在了。
 *
 * 正常心跳 60s 一次，取 3 倍余量吸收调度抖动。注意这里**不能**设得太短：
 * 笔记本休眠醒来后，所有会话的心跳都会同时"过期"几分钟，阈值太紧会让
 * 整个列表空一阵子（心跳恢复后会自动回来）。
 */
export const PEER_STALE_MS = 3 * 60_000

/**
 * 老记录（没有 `heartbeat` 标记）的容忍上限。
 *
 * 那些是**不支持心跳的旧版本**写的，只能靠"多久没写过文件"粗略判断。
 * 放得很宽是故意的：升级过渡期里仍在跑的旧会话不该因为"20 分钟没写盘"
 * 就从列表里消失 —— 那比看到幽灵会话更糟（用户会以为会话没了）。
 * 一天足够滤掉真正陈旧的残留，又不至于误伤。
 */
export const LEGACY_PEER_STALE_MS = 24 * 60 * 60_000

/**
 * 记录是否已经停止心跳。
 *
 * **纯函数**，便于单测。为什么需要它：`isProcessRunning(pid)` 会被 PID 回收
 * 骗到 —— 一个早已退出的会话，它的号码可能被别的常驻进程占用，于是记录
 * "看起来还活着"。心跳（见 concurrentSessions.startHeartbeat）让 mtime 成为
 * 可靠信号：真会话会一直刷新，幽灵不会。
 */
export function isPeerStale(ageMs: number, threshold = PEER_STALE_MS): boolean {
  return ageMs > threshold
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

    const full = join(dir, file)
    // mtime 是心跳信号（见 concurrentSessions.startHeartbeat）：
    // 任何写入（注册 / 改名 / 状态变化 / 心跳）都会刷新它。
    let mtimeMs: number
    try {
      mtimeMs = (await stat(full)).mtimeMs
    } catch {
      continue // 刚被别的进程清掉
    }

    const alive = isProcessRunning(pid)
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

    // PID 活着 ≠ 这就是那个会话：号码可能被回收给了别的进程。
    // 会心跳的会话一直在刷新 mtime；幽灵的记录停在最后一次写入。
    // **不删文件** —— 可能是休眠后心跳还没来得及追上，删了就把活会话弄丢了。
    const ageMs = now - Math.max(mtimeMs, rec.updatedAt ?? 0, rec.startedAt ?? 0)
    // 只有声明支持心跳的记录才用短阈值；旧版本写的记录退回宽阈值。
    const threshold = rec.heartbeat ? PEER_STALE_MS : LEGACY_PEER_STALE_MS
    if (isPeerStale(ageMs, threshold)) {
      logForDebugging(
        `[sessionPeers] 跳过 ${sessionAddress(pid)}：PID 活着但已 ${Math.round(
          ageMs / 60_000,
        )} 分钟没有活动（疑似 PID 被回收给别的进程）`,
      )
      continue
    }

    out.push({
      ...rec,
      address: sessionAddress(pid),
      alive,
      ageMs,
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
