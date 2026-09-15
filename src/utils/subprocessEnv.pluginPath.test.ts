import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { delimiter } from 'path'
import { subprocessEnv } from './subprocessEnv'
import { setSessionEnvVar, deleteSessionEnvVar } from './sessionEnvVars'

/**
 * 回归：`subprocessEnv()` 必须把插件 runtime 目录前置进 PATH。
 *
 * 背景（2026-09-15 mac 实测）：MCP stdio server 由 `StdioClientTransport` 直接
 * spawn，env 走 `subprocessEnv()` → 继承 `process.env`。而插件 runtime 的 PATH
 * 前置此前**只在 bash/powershell provider 里拼进 shell 命令串**，不改本进程 env
 * → 引擎 PATH 只有 `.../nodejs/runtime` 根、没有 `runtime/bin` →
 * `{"command":"npx"}` 的 server（playwright-mcp）spawn 失败
 * （`env: npx: No such file or directory`）。
 *
 * 迷惑点：AI Bash 里 `npx` 却正常（那是 shell 命令串补的前置），容易误判成
 * "PATH 已修好"。这条测试锁的是**进程级** env，与 shell 命令串无关。
 */

const KEY = 'CLAUDE_PLUGIN_PATH_PREPEND'

describe('subprocessEnv — 插件 runtime 进 PATH（MCP/LSP 等直接 spawn 的子进程）', () => {
  beforeEach(() => deleteSessionEnvVar(KEY))
  afterEach(() => deleteSessionEnvVar(KEY))

  test('无 prepend 时不动 PATH', () => {
    const env = subprocessEnv()
    expect(env.PATH).toBe(process.env.PATH)
  })

  test('有 prepend 时前置到 PATH 最前', () => {
    const dirs = ['/plugins/nodejs/runtime', '/plugins/nodejs/runtime/bin']
    setSessionEnvVar(KEY, dirs.join(';'))
    const env = subprocessEnv()
    expect(env.PATH!.startsWith(dirs.join(delimiter) + delimiter)).toBe(true)
    // 原有 PATH 必须完整保留在后面（不能被覆盖 —— 否则系统命令全失效）
    expect(env.PATH!).toContain(process.env.PATH!.split(delimiter)[0])
  })

  test('幂等：重复调用不重复叠加', () => {
    const dirs = ['/plugins/nodejs/runtime', '/plugins/nodejs/runtime/bin']
    setSessionEnvVar(KEY, dirs.join(';'))
    const a = subprocessEnv().PATH!
    const b = subprocessEnv().PATH!
    expect(b).toBe(a)
    // 按**路径段**计数（不能 substring 计数：`.../runtime` 是 `.../runtime/bin`
    // 的子串，会在同一次前缀里被数两次）
    const segs = b.split(delimiter)
    expect(segs.filter(s => s === dirs[0]).length).toBe(1)
    expect(segs.filter(s => s === dirs[1]).length).toBe(1)
  })

  test('空 prepend（值存在但无目录）不动 PATH', () => {
    setSessionEnvVar(KEY, ';;')
    const env = subprocessEnv()
    expect(env.PATH).toBe(process.env.PATH)
  })

  test('同时设 PATH 与 Path 两种大小写（Windows/POSIX 兼容）', () => {
    setSessionEnvVar(KEY, '/plugins/nodejs/runtime/bin')
    const env = subprocessEnv()
    expect(env.PATH).toBe(env.Path)
  })

  test('不修改原 process.env（只返回副本）', () => {
    const before = process.env.PATH
    setSessionEnvVar(KEY, '/plugins/nodejs/runtime/bin')
    subprocessEnv()
    expect(process.env.PATH).toBe(before)
  })
})
