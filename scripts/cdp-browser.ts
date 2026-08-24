#!/usr/bin/env bun
/**
 * cdp-browser — Launch Chrome/Edge with CDP remote debugging port
 *
 * Usage:
 *   bun run scripts/cdp-browser.ts [chrome|edge]
 */
import { existsSync } from 'fs'
import { platform } from 'os'
import { join } from 'path'
import { spawn } from 'bun'

const PORT = 9222
const BROWSER = process.argv[2]?.toLowerCase() || 'chrome'

interface BrowserInfo {
  name: string
  candidates: string[]
}

function getBrowserInfo(): BrowserInfo {
  if (BROWSER === 'edge') {
    return {
      name: 'Edge',
      candidates: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ],
    }
  }
  // Default: Chrome
  return {
    name: 'Chrome',
    candidates: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
  }
}

function log(msg: string) { console.log(`[OK] ${msg}`) }
function info(msg: string) { console.log(`[*] ${msg}`) }
function warn(msg: string) { console.log(`[WARN] ${msg}`) }
function err(msg: string) { console.log(`[ERROR] ${msg}`) }

async function checkRunning(): Promise<boolean> {
  try {
    const r = await fetch(`http://localhost:${PORT}/json`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch { return false }
}

async function listPages(): Promise<void> {
  try {
    const r = await fetch(`http://localhost:${PORT}/json`)
    const pages = await r.json() as Array<{ id: string; title: string; url: string; type: string }>
    const tabs = pages.filter(p => p.type === 'page')
    console.log('Pages open:')
    for (const t of tabs) {
      console.log(`  ${t.id}  ${t.title}  ${t.url}`)
    }
  } catch {
    warn('(unable to list pages)')
  }
}

async function main(): Promise<void> {
  console.log('=== CDP Inspector — Launch Browser ===\n')

  // Check if already running
  if (await checkRunning()) {
    log(`Browser already running with debug port ${PORT}\n`)
    await listPages()
    return
  }

  // Edge requires special handling on Windows
  if (platform() !== 'win32' && (BROWSER === 'chrome' || BROWSER === 'edge')) {
    // On macOS/Linux, just try launching via command name
    info(`Launching ${BROWSER} with remote debugging on port ${PORT}...`)
    spawn([BROWSER, `--remote-debugging-port=${PORT}`, '--no-first-run', '--new-window', 'about:blank'], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
  } else {
    // Windows: find exact path
    const browserInfo = getBrowserInfo()
    let browserPath = browserInfo.candidates.find(existsSync)

    if (!browserPath) {
      err(`${browserInfo.name} not found in common locations.`)
      err(`Please launch manually with --remote-debugging-port=${PORT}`)
      process.exit(1)
    }

    info(`Launching ${browserInfo.name} with remote debugging on port ${PORT}...`)
    console.log(`    Path: ${browserPath}`)

    const userDataDir = join(process.env.TEMP || '', `${browserInfo.name}-debug`)
    spawn([browserPath, `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`, '--new-window'], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
  }

  // Wait and verify
  await Bun.sleep(3000)

  if (await checkRunning()) {
    log('Browser started successfully')
  } else {
    warn('Could not verify debug port. Open a new tab and try again.')
  }

  console.log()
  await listPages()
  console.log('\nDone. Set up .mcp.json with: cdp-setup')
}

main().catch(e => { console.error('Error:', e); process.exit(1) })
