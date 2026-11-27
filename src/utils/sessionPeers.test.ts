import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LEGACY_PEER_STALE_MS,
  PEER_STALE_MS,
  isPeerStale,
  listPeerSessions,
} from './sessionPeers.js'

describe('isPeerStale', () => {
  it('刚好等于阈值不算过期（边界是 >，不是 >=）', () => {
    expect(isPeerStale(PEER_STALE_MS, PEER_STALE_MS)).toBe(false)
    expect(isPeerStale(PEER_STALE_MS + 1, PEER_STALE_MS)).toBe(true)
  })

  it('旧记录的阈值远宽于会心跳的记录', () => {
    // 这条锁的是"升级过渡期不能把还在跑的旧会话误判成已死"
    expect(LEGACY_PEER_STALE_MS).toBeGreaterThan(PEER_STALE_MS * 100)
    // 一个 90 分钟没写盘的旧会话必须仍然可见
    expect(isPeerStale(90 * 60_000, LEGACY_PEER_STALE_MS)).toBe(false)
    // 但它不能躲过"会心跳"记录的 3 分钟阈值
    expect(isPeerStale(90 * 60_000, PEER_STALE_MS)).toBe(true)
  })
})

// ── 端到端：真起一个进程当 peer ──
//
// 锁的核心行为：PID 活着 ≠ 这个会话还在。
// 一个 3 天前死掉的会话，它的 PID 可能已经被常驻进程（实测是 MSPCManager）
// 占用 —— 只判 pid 存活的话，ListAgents 会列出幽灵，往里发消息写进一个
// 永远没人读的信箱。
describe('listPeerSessions', () => {
  let home: string
  let sessionsDir: string
  let child: ChildProcess | null = null

  const writeRecord = (pid: number, extra: Record<string, unknown> = {}) => {
    const file = join(sessionsDir, `${pid}.json`)
    writeFileSync(
      file,
      JSON.stringify({
        pid,
        sessionId: `sess-${pid}`,
        cwd: '/tmp/proj',
        startedAt: Date.now(),
        kind: 'interactive',
        ...extra,
      }),
    )
    return file
  }

  /**
   * 把记录"变老" N 毫秒：mtime 和 startedAt 一起拨回去。
   *
   * 必须一起拨 —— `ageMs` 取 `max(mtime, updatedAt, startedAt)`，只拨 mtime
   * 而 startedAt 还是"现在"的话，max 会取到现在，等于没变老。
   * 真实幽灵也是这样：三天前启动、三天前的心跳。
   */
  const ageFile = (file: string, ms: number) => {
    const t = new Date(Date.now() - ms)
    utimesSync(file, t, t)
    const rec = JSON.parse(require('node:fs').readFileSync(file, 'utf8'))
    rec.startedAt = Date.now() - ms
    writeFileSync(file, JSON.stringify(rec))
    utimesSync(file, t, t)
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'peers-'))
    sessionsDir = join(home, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = home
  })

  afterEach(() => {
    child?.kill()
    child = null
    rmSync(home, { recursive: true, force: true })
    delete process.env.CLAUDE_CONFIG_DIR
  })

  const startPeer = async (): Promise<number> => {
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    })
    await new Promise<void>(r => child!.once('spawn', () => r()))
    return child.pid!
  }

  it('心跳新鲜的会话会被列出', async () => {
    const pid = await startPeer()
    writeRecord(pid, { heartbeat: true })
    const peers = await listPeerSessions()
    expect(peers.map(p => p.pid)).toContain(pid)
  })

  it('PID 活着但心跳停了 → 不列出（疑似 PID 被回收）', async () => {
    const pid = await startPeer()
    const file = writeRecord(pid, { heartbeat: true })
    ageFile(file, 10 * 60_000) // 10 分钟无心跳，远超 3 分钟阈值
    const peers = await listPeerSessions()
    expect(peers.map(p => p.pid)).not.toContain(pid)
    // 但**不删文件** —— 可能是休眠后心跳没追上，删了会把活会话弄丢
    expect(existsSync(file)).toBe(true)
  })

  it('旧记录（无 heartbeat 标记）用宽阈值，不会因"20 分钟没写盘"消失', async () => {
    const pid = await startPeer()
    const file = writeRecord(pid) // 不写 heartbeat
    ageFile(file, 90 * 60_000)
    const peers = await listPeerSessions()
    expect(peers.map(p => p.pid)).toContain(pid)
  })

  it('旧记录陈旧到一天以上 → 同样滤掉', async () => {
    const pid = await startPeer()
    const file = writeRecord(pid)
    ageFile(file, 3 * 24 * 60 * 60_000) // 3 天，正是实测幽灵的年龄
    const peers = await listPeerSessions()
    expect(peers.map(p => p.pid)).not.toContain(pid)
  })

  it('进程已退出 → 记录被删除（不留垃圾）', async () => {
    const pid = await startPeer()
    const file = writeRecord(pid, { heartbeat: true })
    child!.kill()
    await new Promise(r => setTimeout(r, 300))
    await listPeerSessions()
    expect(existsSync(file)).toBe(false)
  })
})
