#!/usr/bin/env bun
/**
 * install-tools — 跨平台安装开发辅助 CLI 工具
 *
 * 用法:
 *   bun run scripts/install-tools.ts
 *   OFFLINE_MODE=1 bun run scripts/install-tools.ts
 *
 * 工具清单: ripgrep, fd, jq, yq, shellcheck
 */
import { existsSync, mkdirSync, copyFileSync, chmodSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { arch, homedir, platform } from 'os'
import { $ } from 'bun'

const ROOT_DIR = dirname(import.meta.dirname ?? __dirname)
const PLATFORM = platform()
const ARCH = arch()
const OFFLINE_MODE = process.env.OFFLINE_MODE === '1'
const OFFLINE_DIR = process.env.OFFLINE_DIR || join(ROOT_DIR, 'offline-tools', PLATFORM)
const VENDOR_DIR = join(ROOT_DIR, 'src', 'utils', 'vendor', 'ripgrep')

interface ToolDef {
  name: string
  binary: string       // binary name (without platform suffix)
  checkCmd: string     // shell command that exits 0 if installed
  versionFlag?: string // e.g., '--version'
  /** Per-platform install strategies, tried in order until one succeeds */
  installStrategies: Partial<Record<NodeJS.Platform, (() => Promise<boolean>)[]>>
}

// ── Helpers ──────────────────────────────────────────────────────────────

function log(msg: string) { console.log(`\x1b[32m[OK]\x1b[0m ${msg}`) }
function warn(msg: string) { console.log(`\x1b[33m[--]\x1b[0m ${msg}`) }
function err(msg: string) { console.log(`\x1b[31m[!!]\x1b[0m ${msg}`) }

/** Bin suffix for the current platform */
function binSuffix(): string { return PLATFORM === 'win32' ? '.exe' : '' }

/** Map Node.js arch to the vendor directory naming convention */
function vendorArch(): string {
  const map: Record<string, string> = { x64: 'x64', arm64: 'arm64', ia32: 'ia32' }
  return map[ARCH] || ARCH
}

function vendorPlatform(): string {
  const map: Record<string, string> = { win32: 'win32', darwin: 'darwin', linux: 'linux' }
  return map[PLATFORM] || PLATFORM
}

function vendorDir(): string {
  return join(VENDOR_DIR, `${vendorArch()}-${vendorPlatform()}`)
}

async function isInstalled(binary: string): Promise<boolean> {
  try {
    const result = await $`which ${binary}`.quiet()
    return result.exitCode === 0
  } catch {
    try {
      // Windows fallback
      const result = await $`where ${binary}`.quiet()
      return result.exitCode === 0
    } catch { return false }
  }
}

async function runCapture(...cmd: string[]): Promise<string> {
  try {
    const result = await $`${cmd}`.quiet()
    return result.text().trim()
  } catch { return '' }
}

/** Install a tool via winget (Windows only) */
async function wingetInstall(pkgId: string): Promise<boolean> {
  try {
    const r = await $`winget install ${pkgId} --accept-package-agreements --accept-source-agreements`.nothrow()
    return r.exitCode === 0
  } catch { return false }
}

/** Install a tool via scoop (Windows only) */
async function scoopInstall(pkgName: string): Promise<boolean> {
  try {
    const r = await $`scoop install ${pkgName}`.nothrow()
    return r.exitCode === 0
  } catch { return false }
}

/** Install a tool via brew (macOS only) */
async function brewInstall(pkgName: string): Promise<boolean> {
  try {
    const r = await $`brew install ${pkgName}`.nothrow()
    return r.exitCode === 0
  } catch { return false }
}

/** Install via Linux package manager (apt/dnf/pacman) */
async function linuxInstall(pkgName: string, pkgMgr: string): Promise<boolean> {
  try {
    switch (pkgMgr) {
      case 'apt':
        return (await $`sudo apt-get update -qq`.nothrow()).exitCode === 0
          && (await $`sudo apt-get install -y ${pkgName}`.nothrow()).exitCode === 0
      case 'dnf':
        return (await $`sudo dnf install -y ${pkgName}`.nothrow()).exitCode === 0
      case 'pacman':
        return (await $`sudo pacman -S --noconfirm ${pkgName}`.nothrow()).exitCode === 0
      default:
        return false
    }
  } catch { return false }
}

/** Detect Linux package manager */
async function detectPkgMgr(): Promise<string | null> {
  if (await runCapture('which', 'apt-get')) return 'apt'
  if (await runCapture('which', 'dnf')) return 'dnf'
  if (await runCapture('which', 'pacman')) return 'pacman'
  return null
}

/** Install from offline-tools/<platform>/ directory */
async function offlineInstall(binary: string, toolName: string): Promise<boolean> {
  const exeName = `${binary}${binSuffix()}`
  const src = join(OFFLINE_DIR, exeName)
  if (!existsSync(src)) {
    warn(`${toolName}: 离线文件不存在: ${src}`)
    return false
  }

  // Determine target directory (must be on PATH)
  let targetDir = '/usr/local/bin'
  try {
    if (existsSync(targetDir) && (await runCapture('test', '-w', targetDir))) {
      // ok
    } else {
      targetDir = join(process.env.HOME || '', 'bin')
    }
  } catch {
    targetDir = join(process.env.HOME || '', 'bin')
  }

  mkdirSync(targetDir, { recursive: true })
  const dest = join(targetDir, exeName)
  copyFileSync(src, dest)
  try { chmodSync(dest, 0o755) } catch { /* Windows doesn't support chmod */ }
  log(`${toolName} 已从离线备份安装到 ${dest}`)
  return true
}

// ── Tool Definitions ─────────────────────────────────────────────────────

const TOOLS: ToolDef[] = [
  {
    name: 'ripgrep',
    binary: 'rg',
    checkCmd: '', // checked separately — we need it at src/utils/vendor/ripgrep/, not PATH
    installStrategies: {
      win32: [
        // 1. Copy from offline-tools directly to vendor
        async () => vendorDirectInstall('rg.exe', 'ripgrep'),
        // 2. Copy from system PATH to vendor
        async () => {
          const src = await runCapture('which', 'rg.exe')
          if (!src) return false
          vendorCopy(src, 'rg.exe')
          return true
        },
        // 3. winget install then copy to vendor
        async () => {
          if (!(await wingetInstall('BurntSushi.ripgrep.MSVC'))) return false
          const src = await runCapture('which', 'rg.exe')
          if (!src) return false
          vendorCopy(src, 'rg.exe')
          return true
        },
      ],
      darwin: [
        async () => {
          if (!(await brewInstall('ripgrep'))) return false
          const src = await runCapture('which', 'rg')
          if (!src) return false
          vendorCopy(src, 'rg')
          return true
        },
      ],
      linux: [
        async () => {
          const pkgMgr = await detectPkgMgr()
          if (!pkgMgr) return false
          if (!(await linuxInstall('ripgrep', pkgMgr))) return false
          const src = await runCapture('which', 'rg')
          if (!src) return false
          vendorCopy(src, 'rg')
          return true
        },
      ],
    },
  },
  {
    name: 'fd',
    binary: 'fd',
    checkCmd: 'fd --version',
    installStrategies: {
      win32: [
        () => offlineInstall('fd', 'fd'),
        () => wingetInstall('sharkdp.fd'),
        () => scoopInstall('fd'),
      ],
      darwin: [
        () => brewInstall('fd'),
      ],
      linux: [
        async () => {
          const pkgMgr = await detectPkgMgr()
          if (!pkgMgr) return false
          if (pkgMgr === 'apt') {
            const ok = await linuxInstall('fd-find', 'apt')
            if (ok) {
              // Debuntu packages the binary as fdfind; symlink to fd
              try { await $`sudo ln -sf ${await runCapture('which', 'fdfind')} /usr/local/bin/fd`.nothrow() } catch {}
            }
            return ok
          }
          return linuxInstall('fd', pkgMgr)
        },
      ],
    },
  },
  {
    name: 'jq',
    binary: 'jq',
    checkCmd: 'jq --version',
    installStrategies: {
      win32: [
        () => offlineInstall('jq', 'jq'),
        () => wingetInstall('jqlang.jq'),
        () => scoopInstall('jq'),
      ],
      darwin: [
        () => brewInstall('jq'),
      ],
      linux: [
        async () => {
          const pkgMgr = await detectPkgMgr()
          if (!pkgMgr) return false
          return linuxInstall('jq', pkgMgr)
        },
      ],
    },
  },
  {
    name: 'yq',
    binary: 'yq',
    checkCmd: 'yq --version',
    installStrategies: {
      win32: [
        () => offlineInstall('yq', 'yq'),
        () => wingetInstall('MikeFarah.yq'),
        () => scoopInstall('yq'),
      ],
      darwin: [
        () => brewInstall('yq'),
      ],
      linux: [
        async () => {
          const pkgMgr = await detectPkgMgr()
          if (!pkgMgr) return false
          if (pkgMgr === 'apt') {
            // apt's yq is Python yq (not MikeFarah/yq); download binary directly
            try {
              const url = 'https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64'
              await $`sudo wget -qO /usr/local/bin/yq ${url}`.nothrow()
              await $`sudo chmod +x /usr/local/bin/yq`.nothrow()
              return true
            } catch { return false }
          }
          return linuxInstall('yq', pkgMgr)
        },
      ],
    },
  },
  {
    name: 'shellcheck',
    binary: 'shellcheck',
    checkCmd: 'shellcheck --version',
    installStrategies: {
      win32: [
        () => offlineInstall('shellcheck', 'shellcheck'),
        () => wingetInstall('koalaman.shellcheck'),
        () => scoopInstall('shellcheck'),
      ],
      darwin: [
        () => brewInstall('shellcheck'),
      ],
      linux: [
        async () => {
          const pkgMgr = await detectPkgMgr()
          if (!pkgMgr) return false
          const pkgName = pkgMgr === 'dnf' ? 'ShellCheck' : 'shellcheck'
          return linuxInstall(pkgName, pkgMgr)
        },
      ],
    },
  },
]

// ── Vendor ripgrep helpers ───────────────────────────────────────────────

/** Install ripgrep from offline-tools directly to the vendor directory. */
async function vendorDirectInstall(exeName: string, toolName: string): Promise<boolean> {
  const src = join(OFFLINE_DIR, exeName)
  if (!existsSync(src)) {
    warn(`${toolName}: 离线文件不存在: ${src}`)
    return false
  }
  vendorCopy(src, exeName)
  return true
}

function vendorCopy(src: string, exeName: string): void {
  const dstDir = vendorDir()
  const dst = join(dstDir, exeName)

  if (existsSync(dst)) {
    log(`vendor ripgrep 已就绪: ${dst}`)
    return
  }

  mkdirSync(dstDir, { recursive: true })
  copyFileSync(src, dst)
  try { chmodSync(dst, 0o755) } catch {}
  log(`vendor ripgrep 已拷贝到: ${dst}`)
}

/** Check if ripgrep binary exists at the vendor path (not system PATH). */
function isVendorRgInstalled(): boolean {
  const exeName = `rg${binSuffix()}`
  return existsSync(join(vendorDir(), exeName))
}

// ── Inject tool instructions into global CLAUDE.md ────────────────

const TOOL_INSTRUCTIONS = `

## Preferred CLI Tools

When working in the shell, use these tools:

| Task | Tool | Instead of |
|------|------|------------|
| Code content search | \`rg\` (ripgrep) | \`grep\`, \`grep -r\` |
| File search | \`fd\` | \`find\`, \`ls -R\` |
| JSON processing | \`jq\` | \`python -c\`, manual parsing |
| YAML/TOML/JSON processing | \`yq\` | Manual parsing |
| Shell script validation | \`shellcheck\` | Running blindly |
`

async function injectGlobalInstructions(): Promise<void> {
  const claudeDir = join(homedir(), '.claude')
  const claudeMdPath = join(claudeDir, 'CLAUDE.md')

  mkdirSync(claudeDir, { recursive: true })

  const existing = existsSync(claudeMdPath)
    ? readFileSync(claudeMdPath, 'utf-8')
    : ''

  // Check if tool instructions are already present
  if (existing.includes('## Preferred CLI Tools')) {
    log('全局 ~/.claude/CLAUDE.md 中工具提示词已存在')
    return
  }

  // Append (or create with header)
  const content = existing
    ? existing + TOOL_INSTRUCTIONS
    : '# Global Claude Code Instructions\n\nThese instructions apply to ALL projects.\n' + TOOL_INSTRUCTIONS

  writeFileSync(claudeMdPath, content, 'utf-8')
  log(`已写入工具提示词到 ${claudeMdPath}`)
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log()
  console.log('==============================')
  console.log('  安装 Claude Code 开发工具')
  console.log('==============================')
  console.log()

  if (OFFLINE_MODE) {
    warn(`离线模式已启用，离线目录: ${OFFLINE_DIR}`)
  }

  let allSkipped = true
  let anyFailed = false

  for (const tool of TOOLS) {
    // ripgrep: check vendor path (src/utils/vendor/ripgrep/), not system PATH
    if (tool.name === 'ripgrep') {
      if (isVendorRgInstalled()) {
        log(`ripgrep 已存在于 vendor: ${join(vendorDir(), 'rg' + binSuffix())}`)
        continue
      }
    } else if (await isInstalled(tool.binary)) {
      const version = await runCapture(tool.binary, '--version').catch(() => 'ok')
      log(`${tool.name} 已安装: ${version.split('\n')[0] || 'ok'}`)
      continue
    }

    allSkipped = false
    warn(`安装 ${tool.name}...`)

    const strategies = tool.installStrategies[PLATFORM]
    if (!strategies || strategies.length === 0) {
      err(`${tool.name}: 当前平台 (${PLATFORM}) 不支持自动安装`)
      anyFailed = true
      continue
    }

    let installed = false
    for (const strategy of strategies) {
      if (await strategy()) { installed = true; break }
    }

    if (installed) {
      log(`${tool.name} 安装完成`)
    } else {
      err(`${tool.name} 安装失败，请手动安装`)
      anyFailed = true
    }
  }

  // ── 写入工具提示词到全局 ~/.claude/CLAUDE.md ──
  await injectGlobalInstructions()

  if (allSkipped) {
    log('所有工具已安装，无需操作')
  }

  console.log()
  console.log('==============================')
  console.log('  安装完成')
  console.log('==============================')
  console.log()
  console.log('已就绪的工具:')
  console.log('  rg    (ripgrep)     — 代码内容搜索（含内置 Grep/Glob）')
  console.log('  fd                  — 快速文件查找')
  console.log('  jq                  — JSON 数据处理')
  console.log('  yq                  — YAML/JSON/TOML 互转')
  console.log('  shellcheck          — Shell 脚本静态检查')
  console.log()
  console.log('提示词已写入 ~/.claude/CLAUDE.md，Claude Code 加载后自动生效')
  console.log()

  if (anyFailed) process.exit(1)
}

main().catch(e => { console.error('Error:', e); process.exit(1) })
