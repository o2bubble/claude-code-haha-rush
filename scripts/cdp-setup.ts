#!/usr/bin/env bun
/**
 * cdp-setup — CDP Inspector MCP config setup
 *
 * Usage:
 *   bun run scripts/cdp-setup.ts            # → .mcp.json (project scope)
 *   bun run scripts/cdp-setup.ts -User      # → ~/.claude/settings.json (user scope)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

const ROOT = dirname(import.meta.dirname ?? __dirname)

function log(msg: string) { console.log(`[OK] ${msg}`) }
function info(msg: string) { console.log(`[*] ${msg}`) }

function main(): void {
  const isUser = process.argv.includes('-User')

  if (isUser) {
    console.log('=== CDP Inspector — Setup User Config ===\n')
    const settingsFile = join(homedir(), '.claude', 'settings.json')
    const absEntry = join(ROOT, 'extensions', 'cdp-inspector', 'entry.ts').replace(/\\/g, '/')

    mkdirSync(dirname(settingsFile), { recursive: true })

    let settings: Record<string, unknown> = {}
    if (existsSync(settingsFile)) {
      try { settings = JSON.parse(readFileSync(settingsFile, 'utf-8')) } catch {}
    }

    const mcpServers = (settings.mcpServers as Record<string, unknown>) ?? {}
    mcpServers['cdp-inspector'] = { command: 'bun', args: [absEntry] }
    settings.mcpServers = mcpServers

    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
    log(`cdp-inspector added to ${settingsFile}`)
    console.log('\nThis config applies to all projects (user-level).')
    console.log('Start browser with: cdp-browser [chrome|edge]')
    console.log('Then restart Claude Code.')
    return
  }

  // Project-level .mcp.json
  console.log('=== CDP Inspector — Setup .mcp.json ===\n')
  const mcpFile = join(ROOT, '.mcp.json')
  const entry = './extensions/cdp-inspector/entry.ts'

  let config: Record<string, unknown> = {}
  if (existsSync(mcpFile)) {
    info('.mcp.json already exists, merging cdp-inspector config...')
    try { config = JSON.parse(readFileSync(mcpFile, 'utf-8')) } catch {}
  } else {
    info('Creating .mcp.json with cdp-inspector config...')
  }

  const mcpServers = (config.mcpServers as Record<string, unknown>) ?? {}
  mcpServers['cdp-inspector'] = { command: 'bun', args: [entry] }
  config.mcpServers = mcpServers

  writeFileSync(mcpFile, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  log('cdp-inspector added to .mcp.json')

  console.log('\nDone.')
  console.log('Start browser with: cdp-browser [chrome|edge]')
  console.log('Then start Claude Code as usual.')
}

main()
