#!/usr/bin/env bun
/**
 * inject-office-bridge — Install the Office COM Bridge AI guide
 *
 * Copies extensions/office/office-bridge.md to ~/.claude/office-bridge.md
 * and injects @office-bridge.md into ~/.claude/CLAUDE.md (if not already present).
 *
 * Usage:
 *   bun run scripts/inject-office-bridge.ts
 *   claude-haha inject-office-bridge
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

const ROOT = dirname(import.meta.dirname ?? __dirname)
const CLAUDE_DIR = join(homedir(), '.claude')
const CLAUDE_MD = join(CLAUDE_DIR, 'CLAUDE.md')
const BRIDGE_DST = join(CLAUDE_DIR, 'office-bridge.md')
const BRIDGE_SRC = join(ROOT, 'extensions', 'office', 'office-bridge.md')
const INJECT_LINE = '@office-bridge.md'

function ok(msg: string)  { console.log(`\x1b[32m[OK]\x1b[0m ${msg}`) }
function info(msg: string) { console.log(`\x1b[36m[*]\x1b[0m ${msg}`) }
function fail(msg: string) { console.error(`\x1b[31m[!!]\x1b[0m ${msg}`); process.exit(1) }

console.log('============================================================')
console.log('  Claude Code — Office COM Bridge Setup')
console.log('============================================================')
console.log()

// 1. Ensure ~/.claude exists
if (!existsSync(CLAUDE_DIR)) {
  mkdirSync(CLAUDE_DIR, { recursive: true })
  ok(`Created ${CLAUDE_DIR}`)
}

// 2. Copy office-bridge.md
if (!existsSync(BRIDGE_SRC)) {
  fail(`Source not found: ${BRIDGE_SRC}`)
}
copyFileSync(BRIDGE_SRC, BRIDGE_DST)
ok(`Installed: ${BRIDGE_DST}`)

// 3. Check if already injected
let content = ''
if (existsSync(CLAUDE_MD)) {
  content = readFileSync(CLAUDE_MD, 'utf8')
}

if (content.includes(INJECT_LINE)) {
  info('@office-bridge.md already present in CLAUDE.md, skipping')
} else {
  if (content) {
    content = content.trimEnd() + '\n\n' + INJECT_LINE + '\n'
  } else {
    content = '# Claude Code Global Instructions\n\n' + INJECT_LINE + '\n'
  }
  writeFileSync(CLAUDE_MD, content, 'utf8')
  ok('Injected @office-bridge.md into CLAUDE.md')
}

console.log()
console.log('============================================================')
console.log('  Setup complete. AI can now control Office/WPS apps.')
console.log('============================================================')
