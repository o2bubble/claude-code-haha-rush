// ── 两仓联合构建 ──
//
// 一条命令产出完整一套（CLI + GUI + Python + Git + 工具链），manifest 统一生成。
//
//   bun run build/joint.ts --gui-repo ../lumen-agent-desktop --release 2026.11.05.1
//
// 流程：
//   1. 本仓编译 claude → dist/claude.exe
//   2. GUI 仓跑构建，--claude-from 指向前一步产物
//   3. 把 GUI 仓的 release/<version>/ 与 manifest.json 同步回本仓
//
// GUI 仓路径由 --gui-repo 传入（相对本仓根或绝对路径），脚本本身不绑定任何机器。

import { existsSync, copyFileSync, mkdirSync, cpSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { spawnSync } from 'bun'

const ROOT = resolve(import.meta.dir, '..')
const DIST = join(ROOT, 'dist')

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}

const GUI_REPO = arg('gui-repo')
const RELEASE = arg('release')
const NOTES = arg('notes') ?? ''
const COMPONENTS = arg('components') ?? 'gui,claude'
const EXPECT_PREV = arg('expect-prev')

if (!GUI_REPO || !RELEASE) {
  console.error('用法: bun run build/joint.ts --gui-repo <path> --release <version> [--notes "..."] [--components gui,claude] [--expect-prev <ver>]')
  process.exit(1)
}

const GUI_ROOT = resolve(ROOT, GUI_REPO)
if (!existsSync(join(GUI_ROOT, 'build', 'build.ts'))) {
  console.error(`[Error] 不是 GUI 仓: ${GUI_ROOT}（缺 build/build.ts）`)
  process.exit(1)
}

const PLATFORM = process.platform === 'darwin' ? 'macos' : 'windows'
const CLAUDE_BIN = join(DIST, PLATFORM === 'windows' ? 'claude.exe' : 'claude')
const GUI_DIST = join(GUI_ROOT, 'dist')

function step(n: number, msg: string) {
  console.log(`\n[${n}/3] ${msg}`)
}

function runOrDie(cmd: string[], cwd: string, label: string) {
  const r = spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit', timeout: 3_600_000 })
  if (r.exitCode !== 0) {
    console.error(`[Error] ${label} 失败 (exit ${r.exitCode})`)
    process.exit(1)
  }
}

// ── 1. 编译 claude ──

step(1, '编译 claude…')
runOrDie(
  ['bun', 'run', join(ROOT, 'build', 'build-claude.ts'), '--rebuild'],
  ROOT,
  'claude 编译',
)
if (!existsSync(CLAUDE_BIN)) {
  console.error(`[Error] 编译产物缺失: ${CLAUDE_BIN}`)
  process.exit(1)
}
console.log(`  OK: ${CLAUDE_BIN}`)

// ── 1.5 把新产物推进 GUI 仓 ──
//
// ⚠️ **必须显式覆盖**。GUI 仓的 build.ts 里，`--claude-from` 只在
// `dist/claude.exe` **不存在**时才生效；文件已存在就打印「复用」直接跳过。
// 而 GUI 仓的 dist 在第二次联合构建之后一直有旧产物 —— 于是编了半天的新
// claude 根本没进包，manifest 里 claude 的 sha 和上一版一模一样，
// 发布的是一份**没有本轮改动**的引擎（2026-11-05 实测踩到）。
//
// 这里直接覆盖，不依赖对方的复用判断。
const guiClaudeBin = join(GUI_DIST, PLATFORM === 'windows' ? 'claude.exe' : 'claude')
mkdirSync(GUI_DIST, { recursive: true })
copyFileSync(CLAUDE_BIN, guiClaudeBin)
console.log(`  已推送到 GUI 仓: ${guiClaudeBin}`)

// ── 2. 复用基线 ──
//
// GUI 仓是独立 clone 时没有 dist/release —— 未选中的组件需要从上一版本
// 按 sha 复制。本仓有这个基线，缺就补过去（只在目标缺失时复制）。

if (EXPECT_PREV) {
  const dstRel = join(GUI_DIST, 'release', EXPECT_PREV)
  if (!existsSync(dstRel)) {
    const srcRel = join(DIST, 'release', EXPECT_PREV)
    if (!existsSync(srcRel)) {
      console.error(`[Error] 基线缺失：${srcRel} 与 ${dstRel} 都不存在。`)
      console.error('        先构建一次该版本，或从服务器拉取组件 zip。')
      process.exit(1)
    }
    console.log(`  复用基线 ← ${srcRel}`)
    mkdirSync(join(GUI_DIST, 'release'), { recursive: true })
    cpSync(srcRel, dstRel, { recursive: true })
  } else {
    console.log(`  复用基线已存在: ${dstRel}`)
  }
}

// ── 3. GUI 仓构建（含 gui.zip / manifest） ──

step(2, `GUI 仓构建 (${RELEASE})…`)
const guiArgs = [
  'bun', 'run', join(GUI_ROOT, 'build', 'build.ts'),
  '--release', RELEASE,
  '--claude-from', CLAUDE_BIN,
  '--components', COMPONENTS,
]
if (NOTES) guiArgs.push('--notes', NOTES)
if (EXPECT_PREV) guiArgs.push('--expect-prev', EXPECT_PREV)
runOrDie(guiArgs, GUI_ROOT, 'GUI 构建')

// ── 4. 同步回本仓 ──

step(3, '同步产物回本仓…')
const srcVersionDir = join(GUI_DIST, 'release', RELEASE)
if (!existsSync(srcVersionDir)) {
  console.error(`[Error] GUI 仓未产出 ${srcVersionDir}`)
  process.exit(1)
}
const dstVersionDir = join(DIST, 'release', RELEASE)
cpSync(srcVersionDir, dstVersionDir, { recursive: true })

const srcManifest = join(GUI_DIST, 'manifest.json')
if (existsSync(srcManifest)) copyFileSync(srcManifest, join(DIST, 'manifest.json'))

// 同步 dist 里被重建的可执行文件（后续发布/调试会用）
for (const f of readdirSync(GUI_DIST)) {
  const src = join(GUI_DIST, f)
  try {
    if (statSync(src).isFile()) copyFileSync(src, join(DIST, f))
  } catch { /* 占用或权限问题：产物已在 release zip 里，不影响发布 */ }
}

console.log(`\n  完成：dist/release/${RELEASE}/`)
console.log(`  基线：${EXPECT_PREV ?? '(未声明)'}；本次重建：${COMPONENTS}`)
