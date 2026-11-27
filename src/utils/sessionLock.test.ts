import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findSessionHolder,
  releaseSessionLock,
  tryAcquireSessionLock,
} from './sessionLock.js'

// 会话级互斥。
//
// 这不是"锦上添花的并发保护"——两个进程 resume 同一会话会各自持有一份内存
// 快照并各自 append，context 与文件立刻分叉，后续每次 compact/rewind 都基于
// 错误快照，历史不可逆地被写乱。所以下面每条都在锁一个真实的失效场景。

let home: string
let lockDir: string
let holder: ChildProcess | null = null

const lockFile = (sid: string) => join(lockDir, `session-${sid}.lock`)

/** 起一个真正活着的进程（spawnSync 会等它退出，拿不到活 pid）。 */
const startLiveProcess = async (ms = 8000): Promise<number> => {
  holder = spawn(process.execPath, ['-e', `setTimeout(()=>{},${ms})`], { stdio: 'ignore' })
  await new Promise<void>(r => holder!.once('spawn', () => r()))
  return holder.pid!
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sesslock-'))
  lockDir = join(home, 'locks')
  mkdirSync(lockDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = home
})

afterEach(async () => {
  await releaseSessionLock()
  holder?.kill()
  holder = null
  rmSync(home, { recursive: true, force: true })
  delete process.env.CLAUDE_CONFIG_DIR
})

describe('tryAcquireSessionLock', () => {
  it('空锁位 → 拿到', async () => {
    const r = await tryAcquireSessionLock('sess-a')
    expect(r.kind).toBe('acquired')
    expect(existsSync(lockFile('sess-a'))).toBe(true)
  })

  it('同一会话重复获取 → reentrant，不报错', async () => {
    await tryAcquireSessionLock('sess-a')
    const again = await tryAcquireSessionLock('sess-a')
    expect(again).toEqual({ kind: 'acquired', fresh: false })
  })

  it('不同会话各拿各的，互不影响', async () => {
    expect((await tryAcquireSessionLock('sess-a')).kind).toBe('acquired')
    expect((await tryAcquireSessionLock('sess-b')).kind).toBe('acquired')
  })

  it('被别的活进程占着 → blocked，并带上占用者信息', async () => {
    const livePid = await startLiveProcess()
    writeFileSync(
      lockFile('sess-taken'),
      JSON.stringify({ sessionId: 'sess-taken', pid: livePid, cwd: '/other/proj', startedAt: Date.now() }),
    )
    const r = await tryAcquireSessionLock('sess-taken')
    expect(r.kind).toBe('blocked')
    if (r.kind === 'blocked') {
      expect(r.by.pid).toBe(livePid)
      // cwd 要能报给用户，否则他不知道是哪个窗口占着
      expect(r.by.cwd).toBe('/other/proj')
    }
  })

  it('死进程留下的锁 → 回收后拿到（否则崩一次就再也打不开该会话）', async () => {
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
    const deadPid = Number(dead.stdout.trim())
    writeFileSync(
      lockFile('sess-dead'),
      JSON.stringify({ sessionId: 'sess-dead', pid: deadPid, cwd: '/x', startedAt: 1 }),
    )
    const r = await tryAcquireSessionLock('sess-dead')
    expect(r.kind).toBe('acquired')
  })

  it('锁文件损坏（半截 JSON）→ 当作陈旧锁接管', async () => {
    writeFileSync(lockFile('sess-bad'), '{ 这不是 json')
    const r = await tryAcquireSessionLock('sess-bad')
    expect(r.kind).toBe('acquired')
  })

  it('sessionId 里的路径分隔符会被净化（值来自 WS 消息，不能信任）', async () => {
    const r = await tryAcquireSessionLock('../../evil')
    expect(r.kind).toBe('acquired')
    // 关键：不能写到 locks 目录之外。只断言"目录里恰好一个文件"，
    // 不猜具体的替换字符（净化规则可能调整，断言不该锁死实现细节）。
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const files = readdirSync(lockDir)
    expect(files).toHaveLength(1)
    expect(files[0]).not.toContain('/')
    expect(files[0]).not.toContain('\\')
    expect(files[0].startsWith('session-')).toBe(true)
  })
})

describe('切换会话时的锁所有权', () => {
  it('拿到新锁后释放旧锁（否则访问过的会话会被永久占着）', async () => {
    await tryAcquireSessionLock('sess-old')
    await tryAcquireSessionLock('sess-new')
    expect(existsSync(lockFile('sess-old'))).toBe(false)
    expect(existsSync(lockFile('sess-new'))).toBe(true)
  })

  it('新锁抢不到时**保留**旧锁（当前会话不能裸奔）', async () => {
    const livePid = await startLiveProcess()
    writeFileSync(
      lockFile('sess-taken'),
      JSON.stringify({ sessionId: 'sess-taken', pid: livePid, cwd: '/o', startedAt: Date.now() }),
    )
    await tryAcquireSessionLock('sess-mine')
    const blocked = await tryAcquireSessionLock('sess-taken')
    expect(blocked.kind).toBe('blocked')
    // 调用方会中止切换、继续用 sess-mine —— 那它必须还锁着
    expect(existsSync(lockFile('sess-mine'))).toBe(true)
  })
})

describe('releaseSessionLock / findSessionHolder', () => {
  it('释放后别人能拿到', async () => {
    await tryAcquireSessionLock('sess-x')
    await releaseSessionLock()
    expect(existsSync(lockFile('sess-x'))).toBe(false)
    const r = await tryAcquireSessionLock('sess-x')
    expect(r.kind).toBe('acquired')
  })

  it('findSessionHolder：别人的活锁 → 返回占用者', async () => {
    const livePid = await startLiveProcess()
    writeFileSync(
      lockFile('sess-h'),
      JSON.stringify({ sessionId: 'sess-h', pid: livePid, cwd: '/w', startedAt: Date.now() }),
    )
    const h = await findSessionHolder('sess-h')
    expect(h?.pid).toBe(livePid)
  })

  it('findSessionHolder：死锁 → 清掉并返回 null', async () => {
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
    writeFileSync(
      lockFile('sess-hd'),
      JSON.stringify({ sessionId: 'sess-hd', pid: Number(dead.stdout.trim()), cwd: '/w', startedAt: 1 }),
    )
    expect(await findSessionHolder('sess-hd')).toBeNull()
    expect(existsSync(lockFile('sess-hd'))).toBe(false)
  })

  it('findSessionHolder：自己持有的 → 返回 null（不算"别人占着"）', async () => {
    await tryAcquireSessionLock('sess-self')
    expect(await findSessionHolder('sess-self')).toBeNull()
  })

  it('释放时只删自己的锁（锁被别人回收过的话，不能删别人的）', async () => {
    await tryAcquireSessionLock('sess-r')
    // 模拟：本进程崩溃后被别的进程接管了这个会话
    const livePid = await startLiveProcess()
    writeFileSync(
      lockFile('sess-r'),
      JSON.stringify({ sessionId: 'sess-r', pid: livePid, cwd: '/o', startedAt: Date.now() }),
    )
    await releaseSessionLock()
    expect(existsSync(lockFile('sess-r'))).toBe(true)
    expect(JSON.parse(readFileSync(lockFile('sess-r'), 'utf8')).pid).toBe(livePid)
  })
})
