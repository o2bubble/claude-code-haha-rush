#!/usr/bin/env bun
/**
 * kill-claude — Kill all running Claude Code processes
 *
 * Usage: bun run scripts/kill-claude.ts
 */
import { platform } from 'os'
import { $ } from 'bun'

async function main(): Promise<void> {
  console.log('=== Kill All Claude Code Processes ===\n')

  let count = 0

  if (platform() === 'win32') {
    // Windows: use wmic to find bun processes running cli.tsx
    const wmic = await $`wmic process where "name like '%bun%'" get processid,commandline /format:csv`.nothrow().quiet()
    if (wmic.exitCode === 0) {
      for (const line of wmic.text().split('\n')) {
        if (line.includes('cli.tsx')) {
          const parts = line.trim().split(',')
          const pid = parts[parts.length - 1]?.trim()
          if (pid) {
            await $`taskkill /F /PID ${pid}`.nothrow().quiet()
            console.log(`Killed PID ${pid}`)
            count++
          }
        }
      }
    }
  } else {
    // Unix: pgrep + kill
    const pgrep = await $`pgrep -f "cli\\.tsx"`.nothrow().quiet()
    if (pgrep.exitCode === 0) {
      for (const pid of pgrep.text().trim().split('\n')) {
        if (pid) {
          await $`kill -9 ${pid}`.nothrow().quiet()
          console.log(`Killed PID ${pid}`)
          count++
        }
      }
    }
  }

  console.log(`\nDone (${count} killed)`)
}

main().catch(e => { console.error('Error:', e); process.exit(1) })
