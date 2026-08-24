#!/usr/bin/env bun
/**
 * playwright-setup — Playwright MCP config setup
 *
 * Usage:
 *   bun run scripts/playwright-setup.ts            # → .mcp.json + Chrome (default)
 *   bun run scripts/playwright-setup.ts -Edge      # → .mcp.json + Edge
 *   bun run scripts/playwright-setup.ts -User      # → ~/.claude/settings.json + Chrome
 *   bun run scripts/playwright-setup.ts -User -Edge # → ~/.claude/settings.json + Edge
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'

const ROOT = dirname(import.meta.dirname ?? __dirname)

function log(msg: string) { console.log(`[OK] ${msg}`) }
function info(msg: string) { console.log(`[*] ${msg}`) }
function warn(msg: string) { console.log(`[!] ${msg}`) }

type Browser = 'chrome' | 'msedge'

function getBrowser(): Browser {
  return process.argv.includes('-Edge') ? 'msedge' : 'chrome'
}

function buildMCPEntry(browser: Browser) {
  return {
    command: 'npx',
    args: ['@playwright/mcp', '--browser', browser],
  }
}

const BROWSER_LABEL: Record<Browser, string> = {
  chrome: 'Chrome',
  msedge: 'Edge',
}

function checkBrowser(browser: Browser): boolean {
  try {
    const result = execSync('npx playwright install --list', {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf-8',
    })
    return result.includes(browser)
  } catch {
    return false
  }
}

function writeJson(filePath: string, updater: (config: Record<string, unknown>) => void): void {
  mkdirSync(dirname(filePath), { recursive: true })

  let config: Record<string, unknown> = {}
  if (existsSync(filePath)) {
    try { config = JSON.parse(readFileSync(filePath, 'utf-8')) } catch {
      info(`${filePath} exists but is not valid JSON, will overwrite`)
    }
  }

  updater(config)
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

function main(): void {
  const isUser = process.argv.includes('-User')
  const browser = getBrowser()
  const label = BROWSER_LABEL[browser]
  const mcpEntry = buildMCPEntry(browser)

  console.log(`=== Playwright MCP — Setup (${label}) ===\n`)

  // Check browser
  info(`Checking ${label} browser...`)
  if (checkBrowser(browser)) {
    log(`${label} browser is installed`)
  } else {
    warn(`${label} browser not detected`)
    console.log(`  Run: npx playwright install ${browser}`)
    console.log('  Then re-run this script.\n')
  }

  if (isUser) {
    // User-level config
    const settingsFile = join(homedir(), '.claude', 'settings.json')

    writeJson(settingsFile, (config) => {
      const mcpServers = (config.mcpServers as Record<string, unknown>) ?? {}
      mcpServers['playwright'] = mcpEntry
      config.mcpServers = mcpServers
    })

    log(`playwright (${label}) added to ${settingsFile}`)
    console.log('\nThis config applies to ALL projects (user-level).')
  } else {
    // Project-level .mcp.json
    const mcpFile = join(ROOT, '.mcp.json')

    writeJson(mcpFile, (config) => {
      const mcpServers = (config.mcpServers as Record<string, unknown>) ?? {}
      mcpServers['playwright'] = mcpEntry
      config.mcpServers = mcpServers
    })

    log(`playwright (${label}) added to ${mcpFile}`)
    console.log('\nThis config applies to this project only.')
  }

  console.log('\nNext steps:')
  console.log('  1. Restart Claude Code')
  console.log('  2. Try: "open browser to http://example.com and take a screenshot"')
  console.log('\nDocs: docs/playwright-mcp.md')
}

main()
