#!/usr/bin/env bun
/**
 * codegraph-cleanup — Kill all codegraph processes and clean stale locks
 *
 * Usage: bun run scripts/codegraph-cleanup.ts
 */
import { existsSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { platform } from 'os'
import { $ } from 'bun'

const ROOT = dirname(import.meta.dirname ?? __dirname)

function log(msg: string) { console.log(`[OK] ${msg}`) }
function info(msg: string) { console.log(`[*] ${msg}`) }

async function killProcessUnix(): Promise<boolean> {
  const ps = await $`ps aux`.nothrow().quiet()
  if (ps.exitCode !== 0) return false
  let killed = false
  for (const line of ps.text().split('\n')) {
    if (line.includes('codegraph')) {
      const pid = line.trim().split(/\s+/)[1]
      if (pid) {
        await $`kill ${pid}`.nothrow().quiet()
        console.log(`    Killed PID ${pid}`)
        killed = true
      }
    }
  }
  return killed
}

async function killProcessWindows(): Promise<boolean> {
  // Use wmic to find codegraph-related node processes (PowerShell 5.1 compatible)
  const wmic = await $`wmic process where "name like '%node%'" get processid,commandline /format:csv`.nothrow().quiet()
  if (wmic.exitCode === 0) {
    let killed = false
    for (const line of wmic.text().split('\n')) {
      if (line.includes('codegraph')) {
        // CSV format: Node,CommandLine,ProcessId
        const parts = line.trim().split(',')
        const pid = parts[parts.length - 1]?.trim()
        if (pid) {
          await $`taskkill /F /PID ${pid}`.nothrow().quiet()
          console.log(`    Killed PID ${pid}`)
          killed = true
        }
      }
    }
    return killed
  }
  // Fallback: broad kill
  const r = await $`taskkill /F /IM node.exe /FI "WINDOWTITLE eq codegraph*"`.nothrow().quiet()
  return r.exitCode === 0
}

async function main(): Promise<void> {
  console.log('=== CodeGraph Cleanup ===\n')

  info('Killing codegraph processes...')
  const killed = platform() === 'win32' ? await killProcessWindows() : await killProcessUnix()
  if (!killed) console.log('    (none running)')

  console.log()
  info('Cleaning stale lock files...')
  for (const name of ['daemon.pid', 'daemon.log'] as const) {
    const file = join(ROOT, '.codegraph', name)
    if (existsSync(file)) { unlinkSync(file); log(`Removed ${name}`) }
  }

  console.log('\nDone.')
  console.log('You can now start Claude Code with a clean codegraph state.')
}

main().catch(e => { console.error('Error:', e); process.exit(1) })
