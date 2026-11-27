/**
 * 会话级互斥 —— 同一份对话（sessionId）同时只允许一个进程持有。
 *
 * ## 为什么必须有（2026-11-23）
 *
 * transcript 是 `appendFile` 到 `<sessionId>.jsonl`，但**内存里的对话状态**是
 * 每个进程各一份。两个进程 resume 同一会话时：
 *
 *   进程 A 拿到历史 → 说了一句 → 追加一行
 *   进程 B 也拿到（旧的）历史 → 说了一句 → 追加一行
 *   → 两边的上下文都已经和文件对不上了，后续每次 compact / rewind 都基于
 *     各自的错误快照，历史会被越写越乱
 *
 * 这不是体验问题，是**不可逆的数据损坏**。所以唤醒一个已退出的会话之前，
 * 必须先原子地确认没有别人正在用它。
 *
 * ## 为什么不能用"扫 sessions 目录找同 sessionId"代替
 *
 * 两个唤醒请求几乎同时到达时，两边都会扫到"没有人" → 都启动 → 撞车。
 * 只有 `open(..., 'wx')`（O_EXCL）能保证操作系统层面**最多一个**成功创建。
 *
 * ## 与 computerUseLock 的区别
 *
 * 那个是**全局单锁**（一次只能有一个会话用电脑）；这个是**按会话分锁**，
 * 不同会话互不影响。
 */

import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { isProcessRunning } from './genericProcessUtils.js'
import { logForDebugging } from './debug.js'
import { jsonParse, jsonStringify } from './slowOperations.js'

type SessionLock = {
  sessionId: string
  pid: number
  cwd: string
  startedAt: number
}

export type AcquireSessionLockResult =
  /** 首次拿到 */
  | { kind: 'acquired'; fresh: true }
  /** 本进程已经持有（切换会话前重复调用） */
  | { kind: 'acquired'; fresh: false }
  /** 别的活进程正在用这份对话 */
  | { kind: 'blocked'; by: { pid: number; cwd: string; startedAt: number } }

function getLockDir(): string {
  return join(getClaudeConfigHomeDir(), 'locks')
}

function lockPath(sessionId: string): string {
  // sessionId 是 UUID（或调用方给的字符串）。做个最小净化，防止路径穿越 ——
  // 这个值来自 WS 消息，不能无条件信任。
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_')
  return join(getLockDir(), `session-${safe}.lock`)
}

/** 本进程当前持有的锁的 sessionId（一次只有一个 —— 切换会话时换掉）。 */
let heldSessionId: string | null = null
let registeredCleanup = false

/** 本进程是否持有这个会话的锁（零 syscall 版本，供调用方快速判断）。 */
export function isSessionLockHeldBySelf(sessionId: string): boolean {
  return heldSessionId === sessionId
}

async function readLock(path: string): Promise<SessionLock | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const v = jsonParse(raw) as Partial<SessionLock>
    if (typeof v?.pid !== 'number' || typeof v?.sessionId !== 'string') return null
    return v as SessionLock
  } catch {
    return null
  }
}

/**
 * 尝试独占一份对话。
 *
 * `{kind:'acquired'}` —— 拿到（fresh=false 表示本进程早就持有）。
 * `{kind:'blocked'}` —— 另一个**活着的**进程正在用；调用方应当拒绝继续。
 *
 * 死进程留下的锁会被回收（unlink 后重试一次）—— 否则崩溃一次就再也打不开
 * 那个会话了。回收同样有竞态，但 `open('wx')` 保证只有一个赢家：
 * 两个进程都 unlink 再创建，后创建的那个拿到锁，先创建的会在下一次
 * 检查时发现文件里的 pid 不是自己……所以这里**不重试无限制**，只重试一次，
 * 且创建后立刻回读校验。
 */
export async function tryAcquireSessionLock(
  sessionId: string,
): Promise<AcquireSessionLockResult> {
  if (heldSessionId === sessionId) return { kind: 'acquired', fresh: false }

  const previousSessionId = heldSessionId

  const path = lockPath(sessionId)
  await mkdir(getLockDir(), { recursive: true, mode: 0o700 })
  const payload: SessionLock = {
    sessionId,
    pid: process.pid,
    cwd: process.cwd(),
    startedAt: Date.now(),
  }
  const body = jsonStringify(payload)

  for (let attempt = 0; attempt < 2; attempt++) {
    // O_EXCL：原子地"文件不存在才创建"。这是唯一的互斥保证。
    try {
      await writeFile(path, body, { flag: 'wx' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e

      const existing = await readLock(path)
      if (!existing) {
        // 读不出来（半截写入 / 被手改）—— 当作陈旧锁清掉重来
        await unlink(path).catch(() => {})
        continue
      }
      if (existing.pid === process.pid) {
        heldSessionId = sessionId
        return { kind: 'acquired', fresh: false }
      }
      if (isProcessRunning(existing.pid)) {
        return {
          kind: 'blocked',
          by: { pid: existing.pid, cwd: existing.cwd, startedAt: existing.startedAt },
        }
      }
      logForDebugging(
        `[sessionLock] 回收陈旧锁 session=${sessionId} pid=${existing.pid}（进程已退出）`,
      )
      await unlink(path).catch(() => {})
      continue
    }

    // 创建成功后回读一次，确认文件里是自己。
    // 不读的话，前面"回收陈旧锁"的竞态里可能已经被人覆盖。
    const check = await readLock(path)
    if (check && check.pid !== process.pid) {
      return {
        kind: 'blocked',
        by: { pid: check.pid, cwd: check.cwd, startedAt: check.startedAt },
      }
    }

    // 新锁到手之后才放旧的 —— 顺序反了的话，万一新锁抢不到，当前这份对话
    // 就裸奔了（调用方会中止切换、继续用旧会话，但已经没人占着它）。
    heldSessionId = sessionId
    if (previousSessionId) {
      // 直接删旧文件：heldSessionId 已改成新值，不能走 releaseSessionLock()
      const oldPath = lockPath(previousSessionId)
      const old = await readLock(oldPath)
      if (!old || old.pid === process.pid) {
        await unlink(oldPath).catch(() => {})
      }
    }
    ensureCleanup()
    return { kind: 'acquired', fresh: true }
  }

  // 两次都没成 —— 说明一直在和别的进程抢，保守地认为被人占着
  const existing = await readLock(path)
  return {
    kind: 'blocked',
    by: {
      pid: existing?.pid ?? -1,
      cwd: existing?.cwd ?? '',
      startedAt: existing?.startedAt ?? 0,
    },
  }
}

/**
 * 释放当前进程持有的锁。
 *
 * 只删**自己的**锁文件 —— 如果文件里的 pid 已经不是自己（锁被别人回收过），
 * 删掉会把别人的锁弄丢。
 */
export async function releaseSessionLock(): Promise<void> {
  const id = heldSessionId
  heldSessionId = null
  if (!id) return
  const path = lockPath(id)
  const existing = await readLock(path)
  if (existing && existing.pid !== process.pid) return
  await unlink(path).catch(() => {})
}

function ensureCleanup(): void {
  if (registeredCleanup) return
  registeredCleanup = true
  // registerCleanup 在正常退出 / 信号处理路径上都会跑
  void import('./cleanupRegistry.js').then(({ registerCleanup }) => {
    registerCleanup(async () => {
      await releaseSessionLock()
    })
  })
}

/**
 * 查询某会话是否被**别的活进程**占用（不获取，只判断）。
 *
 * 唤醒流程用它做前置检查：已经被占用就别再 spawn 第二个进程。
 * 死进程留下的锁会被顺手清掉。
 */
export async function findSessionHolder(
  sessionId: string,
): Promise<{ pid: number; cwd: string; startedAt: number } | null> {
  if (heldSessionId === sessionId) return null
  const path = lockPath(sessionId)
  const existing = await readLock(path)
  if (!existing) return null
  if (existing.pid === process.pid) return null
  if (!isProcessRunning(existing.pid)) {
    await unlink(path).catch(() => {})
    return null
  }
  return { pid: existing.pid, cwd: existing.cwd, startedAt: existing.startedAt }
}
