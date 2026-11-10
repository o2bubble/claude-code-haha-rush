// ── claude 仓的构建入口 ──
//
// 只负责一件事：把 src/ 编译成 claude 二进制，并生成/更新发布 manifest 里的
// claude 组件。GUI、Python、Git、工具链那些全在 lumen-agent-desktop 仓。
//
// 单独用：
//   bun run build/build-claude.ts
//   bun run build/build-claude.ts --release 2026.11.05.1 --notes "..."
//
// 与 GUI 仓联合构建（产物完整、manifest 统一）：
//   bun run build/joint.ts --gui-repo ../lumen-agent-desktop --release 2026.11.05.1

import { existsSync, copyFileSync, mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { spawnSync } from 'bun'
import { generateRelease } from './engine'
import type { Platform } from './componentPlan'

const ROOT = resolve(import.meta.dir, '..')
const DIST = join(ROOT, 'dist')

const PLATFORM: Platform = process.platform === 'darwin' ? 'macos' : 'windows'
const QUICK = process.argv.includes('--quick')
const REBUILD = process.argv.includes('--rebuild')
const RELEASE_IDX = process.argv.indexOf('--release')
const RELEASE_VER = RELEASE_IDX >= 0 ? process.argv[RELEASE_IDX + 1] : null

function buildClaude(): string {
  const claudeBin = PLATFORM === 'windows' ? join(DIST, 'claude.exe') : join(DIST, 'claude')
  mkdirSync(DIST, { recursive: true })

  if (!REBUILD && QUICK && existsSync(claudeBin)) {
    console.log('  claude: 已存在，跳过 (quick)')
    return claudeBin
  }
  if (!REBUILD && existsSync(claudeBin) && !RELEASE_VER) {
    console.log('  claude: 使用已有产物（--rebuild 可强制重编）')
    return claudeBin
  }

  console.log(`  claude: bun compile (${PLATFORM})...`)
  const targetArg = PLATFORM === 'macos' ? ['--target=bun-darwin-arm64'] : []
  const compile = spawnSync(
    [
      'bun', 'build', '--compile', ...targetArg,
      '--outfile=' + claudeBin,
      join(ROOT, 'src', 'entrypoints', 'compiled-entry.ts'),
    ],
    { cwd: ROOT },
  )
  if (compile.exitCode !== 0) {
    console.error('[Error] 编译失败:', compile.stderr.toString())
    process.exit(1)
  }
  console.log('  OK:', claudeBin)
  return claudeBin
}

/** claude 仓拥有的组件 —— 只有这一个。 */
function componentSources() {
  return {
    claude: PLATFORM === 'windows'
      ? { kind: 'file' as const, path: 'claude.exe' }
      : { kind: 'file' as const, path: 'claude' },
  }
}

function main() {
  console.log('='.repeat(50))
  console.log('  Claude Code — CLI build')
  console.log(`  (platform: ${PLATFORM})`)
  console.log('='.repeat(50))
  console.log()

  const bin = buildClaude()

  if (RELEASE_VER) {
    console.log(`\n  生成 manifest (${RELEASE_VER})...`)
    const notesIdx = process.argv.indexOf('--notes')
    const notes = notesIdx >= 0 ? process.argv[notesIdx + 1] : ''
    generateRelease({
      dist: DIST,
      version: RELEASE_VER,
      notes,
      platform: PLATFORM,
      componentSet: new Set(['claude']),
      expectPrev: null,
      componentSources: componentSources(),
    })
  }

  console.log()
  console.log('  完成。产物:', bin)
  try {
    const ver = spawnSync([bin, '--version'], { cwd: DIST })
    console.log('  →', ver.stdout.toString().trim())
  } catch {
    console.log('  [Skip] 版本检查失败')
  }
}

main()
