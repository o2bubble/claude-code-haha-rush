#!/usr/bin/env bun
/**
 * install — 跨平台安装脚本
 *
 * 功能: 检查环境、安装依赖、配置 API、验证安装
 * 用法:
 *   bun run scripts/install.ts
 *
 * CI/自动化环境可通过 OFFLINE_MODE=1 跳过交互:
 *   OFFLINE_MODE=1 bun run scripts/install.ts
 */
import { existsSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { platform, homedir } from 'os'
import { $ } from 'bun'
import { createInterface } from 'readline/promises'

const ROOT_DIR = dirname(import.meta.dirname ?? __dirname)
const PLATFORM = platform()
const BIN_DIR = join(ROOT_DIR, 'bin')
const OFFLINE_DIR = join(ROOT_DIR, 'offline-tools', PLATFORM)
const NODE_MODULES = join(ROOT_DIR, 'node_modules')
const ACTIVE_FILE = join(ROOT_DIR, '.env.active')
const BUN_USER_BIN = join(homedir(), '.bun', 'bin')

let _rl: ReturnType<typeof createInterface> | null = null
function rl(): ReturnType<typeof createInterface> {
  if (!_rl) _rl = createInterface({ input: process.stdin, output: process.stdout })
  return _rl
}

// ── Global state ──────────────────────────────────────────────────────────

let _offlineMode = false
function isOffline(): boolean { return _offlineMode }

// ── Helpers ──────────────────────────────────────────────────────────────

function log(msg: string) { console.log(`\x1b[32m[OK]\x1b[0m ${msg}`) }
function warn(msg: string) { console.log(`\x1b[33m[--]\x1b[0m ${msg}`) }
function err(msg: string) { console.log(`\x1b[31m[!!]\x1b[0m ${msg}`) }

async function which(bin: string): Promise<string | null> {
  try {
    const r = await $`which ${bin}`.quiet()
    return r.text().trim() || null
  } catch {
    try {
      const r = await $`where ${bin}`.quiet()
      return r.text().trim() || null
    } catch { return null }
  }
}

async function cmdExists(bin: string): Promise<boolean> {
  return (await which(bin)) !== null
}

async function run(...cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const r = await $`${cmd}`.nothrow().quiet()
  return { exitCode: r.exitCode, stdout: r.text().trim(), stderr: r.text().trim() }
}

function confirmDefault(label: string, defaultYes = true): Promise<string> {
  const prompt = defaultYes ? '(Y/n)' : '(y/N)'
  return rl().question(`${label} ${prompt}: `)
}

// ── Steps ────────────────────────────────────────────────────────────────

async function stepSelectMode(): Promise<void> {
  console.log('\n--- 安装模式 ---')

  // Env override (CI / automated installs)
  if (process.env.OFFLINE_MODE === '1') {
    _offlineMode = true
    log('离线模式 (OFFLINE_MODE=1)')
    return
  }

  // Show what offline tools are available (informational)
  const hasOfflineTools = existsSync(OFFLINE_DIR) && readdirSync(OFFLINE_DIR).length > 0
  if (hasOfflineTools) {
    const files = readdirSync(OFFLINE_DIR).filter(f => /\.(exe|zip)$/i.test(f))
    console.log(`  检测到离线工具包: ${OFFLINE_DIR}`)
    console.log(`  包含: ${files.join(', ')}`)
  } else {
    console.log('  未检测到离线工具包')
  }

  // Always ask user directly
  const answer = await confirmDefault('是否使用离线模式（无需联网）', hasOfflineTools)
  _offlineMode = !answer || /^[Yy]/.test(answer)
  log(_offlineMode ? '已选择离线模式' : '已选择在线模式')
}

async function stepPrerequisites(): Promise<boolean> {
  console.log('\n--- 检查前置依赖 ---')

  let ok = true

  // git
  const gitPath = await which('git')
  if (gitPath) {
    const v = await run('git', '--version')
    log(`git: ${v.stdout}`)
  } else {
    err('git 未安装。请先安装: https://git-scm.com')
    ok = false
  }

  // bun — offline: check bin/ first and add to PATH
  const bunPath = await which('bun')
  if (bunPath) {
    const v = await run('bun', '--version')
    log(`bun: ${v.stdout}`)
  } else if (existsSync(join(BIN_DIR, 'bun.exe'))) {
    // Offline bun in bin/ — prepend to PATH for this process
    process.env.PATH = `${BIN_DIR};${process.env.PATH}`
    log('bun: 使用离线备份 (bin/bun.exe)')
  } else {
    err('bun 未安装。请运行 install-tools.sh / install-tools.cmd 先安装 bun')
    ok = false
  }

  return ok
}

async function stepPathEnv(): Promise<void> {
  if (PLATFORM !== 'win32') return

  console.log('\n--- 添加 bin/ 到环境变量 ---')

  // Check current process PATH
  const hasBinInPath = process.env.PATH?.includes(BIN_DIR)
  const hasBunInPath = process.env.PATH?.includes(BUN_USER_BIN)

  if (hasBinInPath && hasBunInPath) {
    log('bin/ 已在 PATH 中')
    return
  }

  // Add to PATH for current process
  const addToPath: string[] = []
  if (!hasBunInPath) addToPath.push(BUN_USER_BIN)
  if (!hasBinInPath) addToPath.push(BIN_DIR)
  process.env.PATH = [...addToPath, process.env.PATH].join(';')

  // Try to persist via setx
  try {
    const userPath = (await run('reg', 'query', 'HKCU\\Environment', '/v', 'PATH')).stdout
    const currentUserPath = userPath.split('\n').pop()?.trim() || ''
    const newUserPath = [currentUserPath, ...addToPath.filter(p => !currentUserPath.includes(p))].join(';')
    if (newUserPath !== currentUserPath) {
      await $`setx PATH ${newUserPath}`.quiet()
      log(`已添加到 Windows 用户 PATH: ${addToPath.join(', ')}`)
    } else {
      log('bin/ 已在用户 PATH 中')
    }
  } catch {
    warn('无法自动修改 PATH，请手动添加以下路径:')
    for (const p of addToPath) console.log(`  ${p}`)
  }
}

async function stepBunInstall(): Promise<void> {
  console.log('\n--- 项目依赖 (bun install) ---')

  // Check if already installed
  const lockFiles = ['.bun', '.package-lock.json', 'package-lock.json', 'yarn.lock']
  const hasLock = lockFiles.some(f => existsSync(join(NODE_MODULES, f)))
  if (hasLock) {
    log('node_modules 已存在，跳过 (如需更新请手动运行 bun install)')
    return
  }

  if (isOffline()) {
    warn('离线模式：bun install 可能较慢或失败（请确保 node_modules 已预先就绪）')
  } else {
    warn('正在安装项目依赖...')
  }
  const r = await $`cd ${ROOT_DIR} && bun install`.nothrow()
  if (r.exitCode === 0) {
    log('bun install 完成')
  } else {
    err(`bun install 失败 (exit code ${r.exitCode})`)
  }
}

async function stepInstallTools(): Promise<void> {
  console.log('\n--- 辅助 CLI 工具 ---')
  console.log('  ripgrep (rg) — 代码内容搜索')
  console.log('  fd          — 快速文件查找')
  console.log('  jq          — JSON 数据处理')
  console.log('  yq          — YAML/JSON/TOML 互转')
  console.log('  shellcheck  — Shell 脚本静态检查')
  console.log('  这些工具让 AI 在协助你开发时更高效。')
  console.log()

  const answer = await confirmDefault('是否安装')
  if (answer && !/^[Yy]/.test(answer)) {
    warn('跳过工具安装')
    return
  }

  const env: Record<string, string> = { ...process.env as Record<string, string> }
  if (isOffline()) {
    env.OFFLINE_MODE = '1'
    env.OFFLINE_DIR = OFFLINE_DIR
    log('离线模式：优先使用离线二进制文件')
    console.log()
  }

  const r = await $`bun run ${join(ROOT_DIR, 'scripts', 'install-tools.ts')}`.env(env).nothrow()
  if (r.exitCode !== 0) {
    warn('工具安装未完全成功，可稍后单独运行: bun run scripts/install-tools.ts')
  }
}

async function stepApiProfile(): Promise<void> {
  console.log('\n--- API 配置 ---')
  console.log('  连接 AI 服务需要配置 API 密钥和模型参数。')
  console.log()

  const answer = await confirmDefault('是否创建 API profile')
  if (answer && !/^[Yy]/.test(answer)) {
    warn('跳过 (之后可运行: bun run scripts/claude-profile.ts create)')
    return
  }

  // Release stdin so the child process can read user input
  _rl?.close()
  _rl = null

  const r = await $`bun run ${join(ROOT_DIR, 'scripts', 'claude-profile.ts')} create`.nothrow()
  if (r.exitCode !== 0) {
    warn('API profile 创建未完成')
  }
}

async function stepVerify(): Promise<void> {
  console.log('\n==========================================')
  console.log('  安装验证')
  console.log('==========================================')
  console.log()

  let pass = 0
  let warnCount = 0

  // bun
  if (await cmdExists('bun')) {
    const v = await run('bun', '--version')
    log(`bun: ${v.stdout}`)
    pass++
  } else {
    err('bun: 未找到')
    warnCount++
  }

  // CLI tools
  for (const tool of ['rg', 'fd', 'jq', 'yq', 'shellcheck']) {
    if (await cmdExists(tool)) {
      const v = await run(tool, '--version')
      log(`${tool}: ${v.stdout.split('\n')[0]}`)
      pass++
    } else {
      warn(`${tool}: 未安装`)
      warnCount++
    }
  }

  // PATH (Windows)
  if (PLATFORM === 'win32') {
    if (process.env.PATH?.includes(BIN_DIR)) {
      log('PATH: bin/ 已就绪')
      pass++
    } else {
      warn('PATH: bin/ 待新终端生效')
      warnCount++
    }
  }

  // node_modules
  if (existsSync(NODE_MODULES)) {
    log('node_modules: 已安装')
    pass++
  } else {
    warn('node_modules: 未安装 (运行 bun install)')
    warnCount++
  }

  // .env / profile
  const envFile = join(ROOT_DIR, '.env')
  if (existsSync(envFile)) {
    const content = await Bun.file(envFile).text()
    const model = content.split('\n').find(l => l.startsWith('ANTHROPIC_MODEL='))?.split('=')[1]
    log(`.env: 已配置${model ? ` (model: ${model})` : ''}`)
    pass++
  } else if (existsSync(ACTIVE_FILE)) {
    const active = (await Bun.file(ACTIVE_FILE).text()).trim()
    log(`profile: ${active}`)
    pass++
  } else {
    warn('.env: 未配置 (运行 bun run scripts/claude-profile.ts create)')
    warnCount++
  }

  console.log()
  console.log('==========================================')
  console.log(`  安装完成!  (${pass} 就绪, ${warnCount} 待处理)`)
  console.log('==========================================')
  console.log()
  console.log('快速开始:')
  console.log('  claude-haha              # 启动交互式 TUI')
  console.log('  claude-haha -p "问题"     # 单次问答')
  console.log('  claude-profile list      # 查看 API 配置')
  console.log()

  if (warnCount > 0 && PLATFORM === 'win32') {
    warn('如果命令找不到，请重启终端使 PATH 生效')
    console.log()
  }

  _rl?.close()
  process.exit(0)
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log()
  console.log('==========================================')
  console.log('  Claude Code — 安装')
  console.log(`  平台: ${PLATFORM}`)
  console.log(`  目录: ${ROOT_DIR}`)
  console.log('==========================================')
  console.log()

  await stepSelectMode()

  if (!await stepPrerequisites()) {
    err('前置依赖不满足，无法继续')
    process.exit(1)
  }

  await stepPathEnv()
  await stepBunInstall()
  await stepInstallTools()
  await stepApiProfile()
  await stepVerify()
}

main().catch(e => { console.error('Error:', e); process.exit(1) })
