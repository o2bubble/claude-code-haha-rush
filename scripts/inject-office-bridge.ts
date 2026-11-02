#!/usr/bin/env bun
/**
 * inject-office-bridge — Install the Office COM Bridge AI guide
 *
 * Installs `extensions/office/office-bridge.md` as a **skill**
 * (`~/.claude/skills/office-bridge/SKILL.md`), and migrates away from the old
 * `@office-bridge.md` import.
 *
 * ⚠️ 2026-11-02: 以前写 `~/.claude/office-bridge.md` 并在 CLAUDE.md 里
 * `@office-bridge.md` —— 7.6K 字符会进**每个**会话的上下文。改成技能后，
 * 技能列表里只常驻一行 description，正文按需加载。
 *
 * GUI 启动时也会自动做同一件事（`settings::sync_office_guide`）；这个脚本是
 * 无 GUI 环境（CLI-only 安装）的手动入口，两者行为必须一致。
 *
 * Usage:
 *   bun run scripts/inject-office-bridge.ts
 *   claude-haha inject-office-bridge
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

const ROOT = dirname(import.meta.dirname ?? __dirname)
const CLAUDE_DIR = join(homedir(), '.claude')
const CLAUDE_MD = join(CLAUDE_DIR, 'CLAUDE.md')
const SKILL_DST = join(CLAUDE_DIR, 'skills', 'office-bridge', 'SKILL.md')
const LEGACY_DOC = join(CLAUDE_DIR, 'office-bridge.md')
const BRIDGE_SRC = join(ROOT, 'extensions', 'office', 'office-bridge.md')
const LEGACY_REF = '@office-bridge.md'

function ok(msg: string)  { console.log(`\x1b[32m[OK]\x1b[0m ${msg}`) }
function info(msg: string) { console.log(`\x1b[36m[*]\x1b[0m ${msg}`) }
function fail(msg: string) { console.error(`\x1b[31m[!!]\x1b[0m ${msg}`); process.exit(1) }

console.log('============================================================')
console.log('  Claude Code — Office COM Bridge Setup')
console.log('============================================================')
console.log()

if (!existsSync(CLAUDE_DIR)) {
  mkdirSync(CLAUDE_DIR, { recursive: true })
  ok(`Created ${CLAUDE_DIR}`)
}

if (!existsSync(BRIDGE_SRC)) {
  fail(`Source not found: ${BRIDGE_SRC}`)
}

// 1. Install as skill
mkdirSync(dirname(SKILL_DST), { recursive: true })
copyFileSync(BRIDGE_SRC, SKILL_DST)
ok(`Installed skill: ${SKILL_DST}`)

// 2. Migrate: drop the old standalone doc
if (existsSync(LEGACY_DOC)) {
  try {
    unlinkSync(LEGACY_DOC)
    ok(`Removed legacy ${LEGACY_DOC}`)
  } catch (e) {
    console.log(`\x1b[33m[!]\x1b[0m Could not remove ${LEGACY_DOC}: ${e}`)
  }
}

// 3. Migrate: drop the @import line
if (existsSync(CLAUDE_MD)) {
  const content = readFileSync(CLAUDE_MD, 'utf8')
  if (content.includes(LEGACY_REF)) {
    const cleaned = content
      .split(/\r?\n/)
      .filter(line => line.trim() !== LEGACY_REF)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
    writeFileSync(CLAUDE_MD, cleaned, 'utf8')
    ok(`Removed ${LEGACY_REF} from CLAUDE.md (now a skill)`)
  } else {
    info('No legacy @office-bridge.md reference to remove')
  }
}

console.log()
console.log('============================================================')
console.log('  Setup complete. Ask about Office when you need it —')
console.log('  the skill loads on demand instead of on every turn.')
console.log('============================================================')
