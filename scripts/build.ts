/**
 * Build script — compiles all exes + bundles dist/ + optionally generates update manifest.
 *
 * Usage:
 *   bun run scripts/build.ts                        # full build
 *   bun run scripts/build.ts --rebuild              # force cargo build for gui + updater
 *   bun run scripts/build.ts --quick               # skip steps with existing output
 *   bun run scripts/build.ts --release 2026.07.31  # build + generate update manifest + component zips
 *   bun run scripts/build.ts --release 2026.07.31 --notes "fix: ..."  # + release notes shown in the GUI update panel
 *   bun run scripts/build.ts --release 2026.07.31 --gui-only  # only re-zip gui; reuse other component zips from previous release
 *   bun run scripts/build.ts --release 2026.08.21.10 --components claude,gui  # 只重建/重打列出的组件，其余复用上一版本 zip + 现有 dist
 *     known components: gui, claude, bun, updater, tools, python, git, extensions
 */

import { spawnSync } from 'bun'
import { existsSync, copyFileSync, mkdirSync, cpSync, writeFileSync, readdirSync, statSync, rmSync, readFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { homedir } from 'os'
import { planComponents, type Platform } from './componentPlan'

const ROOT = resolve(import.meta.dir, '..')
const DIST = join(ROOT, 'dist')
const DIST_BIN = join(DIST, 'bin')   // CLI tools only (rg, fd, jq, yq, shellcheck)
const GUILDIR = join(ROOT, 'gui', 'src-tauri')
const UPDDIR = join(ROOT, 'updater')
const BIN_DIR = join(ROOT, 'bin')

// 构建目标平台解析（macOS 移植 seam: planComponents 决定每组件怎么构建/是否打包）。
// 默认自动检测当前 OS（Windows 构建行为与引入前完全一致；macOS 走平台分支）。
// 可用 --platform <macos|windows> 显式覆盖——注意执行层命令平台绑定
// （mac 的 ditto/pkgutil/zip vs Windows 的 powershell/Compress-Archive），
// 显式指定与当前 OS 不符的平台时各 step 大概率执行失败，该参数适合 CI 声明/规划场景。
function resolvePlatform(): Platform {
  const auto: Platform = process.platform === 'darwin' ? 'macos' : 'windows'
  const idx = process.argv.indexOf('--platform')
  if (idx < 0) return auto
  const arg = process.argv[idx + 1]
  if (arg === 'macos' || arg === 'windows') {
    if (arg !== auto) {
      console.warn(`  [Warn] --platform=${arg} 与当前 OS (${process.platform}) 不符 — 平台构建命令互不兼容，执行将失败；此参数适合 CI 声明/规划预览`)
    }
    return arg
  }
  console.error(`[Error] Invalid --platform "${arg}" — must be "macos" or "windows"`)
  process.exit(1)
}

async function main() {
  const PLATFORM = resolvePlatform()
  const QUICK = process.argv.includes('--quick')
  const REBUILD = process.argv.includes('--rebuild')
  const GUI_ONLY = process.argv.includes('--gui-only')  // 只重打 gui 组件 zip，其余复用上一版本
  const UPDATE_ONLY = process.argv.includes('--update-only')  // 只重打 updater(Update.exe) 组件 zip, 其余复用
  const EXTENSIONS_ONLY = process.argv.includes('--extensions-only')  // 只重打 extensions 组件 zip, 其余复用
  const RELEASE_IDX = process.argv.indexOf('--release')
  const RELEASE_VER = RELEASE_IDX >= 0 ? process.argv[RELEASE_IDX + 1] : null
  const NOTES_IDX = process.argv.indexOf('--notes')
  const NOTES = NOTES_IDX >= 0 ? process.argv[NOTES_IDX + 1] : ''

  // ── Component selection ──
  // Known components: gui, claude, bun, updater (exe) + tools, python, git, extensions (dir).
  // --components <a,b,c> 只重建/重打这些组件，其余复用上一版本组件 zip 与现有 dist 产物。
  // 无 --components（且无 -only 旗标）时 = 全量构建，行为不变。
  const KNOWN_COMPONENTS = ['gui', 'claude', 'bun', 'updater', 'tools', 'python', 'git', 'extensions']
  const COMPONENTS_IDX = process.argv.indexOf('--components')
  const COMPONENTS_ARG = COMPONENTS_IDX >= 0 ? process.argv[COMPONENTS_IDX + 1] : null
  let COMPONENT_SET: Set<string> | null = null
  if (COMPONENTS_ARG) {
    COMPONENT_SET = new Set(COMPONENTS_ARG.split(',').map((s) => s.trim()).filter(Boolean))
    for (const c of COMPONENT_SET) {
      if (!KNOWN_COMPONENTS.includes(c)) {
        console.warn(`  [Warn] Unknown component "${c}" — known: ${KNOWN_COMPONENTS.join(', ')}`)
      }
    }
  } else if (GUI_ONLY) {
    COMPONENT_SET = new Set(['gui'])
  } else if (UPDATE_ONLY) {
    COMPONENT_SET = new Set(['updater'])
  } else if (EXTENSIONS_ONLY) {
    COMPONENT_SET = new Set(['extensions'])
  }
  // selected(name): 显式选中 → 强制重建；want(name): 产物该存在 → 未选中时复用现有/上一版本
  const selected = (name: string) => COMPONENT_SET !== null && COMPONENT_SET.has(name)
  const want = (name: string) => COMPONENT_SET === null || COMPONENT_SET.has(name)

  const TOTAL_STEPS = RELEASE_VER ? 11 : 10

  function step(n: number) {
    return `[${n}/${TOTAL_STEPS}]`
  }

  console.log('='.repeat(50))
  console.log('  Claude Code — Build')
  if (QUICK) console.log('  (quick mode — skip steps with existing output)')
  if (REBUILD) console.log('  (rebuild mode — force cargo rebuild)')
  if (RELEASE_VER) console.log(`  (release: ${RELEASE_VER})`)
  if (COMPONENT_SET !== null) console.log(`  (components: ${[...COMPONENT_SET].join(', ')} — 其余复用现有/上一版本)`)
  console.log(`  (platform: ${PLATFORM})`)
  console.log('='.repeat(50))
  console.log()

  // ── Helper: smart build for Rust projects ──
  // If --rebuild: always cargo build --release
  // If explicitly selected via --components: force cargo build (source changed)
  // If --quick and exe exists in dist: skip
  // If release exe exists: copy to dist
  // Otherwise: cargo build --release
  async function smartRustBuild(label: string, projectDir: string, exeName: string, distName: string, extraArgs: string[] = [], compName = '') {
    const releaseExe = join(projectDir, 'target', 'release', exeName)
    const distExe = join(DIST, distName)
    const force = compName ? selected(compName) : false

    if (!force && QUICK && !REBUILD && existsSync(distExe)) {
      console.log(`  ${label}: already in dist, skipping`)
      return
    }

    if (!force && !REBUILD && existsSync(releaseExe)) {
      console.log(`  ${label}: using existing release build`)
    } else {
      console.log(`  ${label}: cargo build --release...`)
      const build = spawnSync(['cargo', 'build', '--release', ...extraArgs], { cwd: projectDir, timeout: 600000 })
      if (build.exitCode !== 0) {
        console.error(`[Error] ${label} build failed:`, build.stderr.toString())
        process.exit(1)
      }
    }

    copyFileSync(releaseExe, distExe)
    console.log(`  OK: ${distExe}`)
  }

  // 1. Install deps
  if (!existsSync(join(ROOT, 'node_modules'))) {
    console.log('[1/10] Installing dependencies...')
    spawnSync(['bun', 'install'], { cwd: ROOT })
  } else {
    console.log('[1/10] Dependencies already installed, skipping')
  }

  // 2. Build claude (bun compile; macOS 用 bun-darwin 目标、产物无 .exe 后缀)
  const claudeBin = PLATFORM === 'windows' ? join(DIST, 'claude.exe') : join(DIST, 'claude')
  if (!selected('claude') && existsSync(claudeBin)) {
    console.log('[2/10] claude not in components — reusing existing')
  } else if (QUICK && existsSync(claudeBin)) {
    console.log('[2/10] claude already built, skipping (quick)')
  } else {
    console.log(`[2/10] Compiling claude (${PLATFORM})...`)
    const targetArg = PLATFORM === 'macos' ? ['--target=bun-darwin-arm64'] : []
    const compile = spawnSync(['bun', 'build', '--compile', ...targetArg, '--outfile=' + claudeBin, join(ROOT, 'src', 'entrypoints', 'compiled-entry.ts')], { cwd: ROOT })
    if (compile.exitCode !== 0) {
      console.error('[Error] Compile failed:', compile.stderr.toString())
      process.exit(1)
    }
    console.log('  OK:', claudeBin)
  }

  // 3. Build GUI (cargo tauri build — includes beforeBuildCommand: bun run build)
  console.log('[3/10] Building GUI...')
  const isMac = PLATFORM === 'macos'
  const guiReleasePath = isMac
    ? join(GUILDIR, 'target', 'release', 'bundle', 'macos', 'Claude Code.app')
    : join(GUILDIR, 'target', 'release', 'claude-code-gui.exe')
  const guiDistPath = isMac ? join(DIST, 'Claude Code.app') : join(DIST, 'claude-code-gui.exe')

  async function copyGuiArtifact() {
    if (isMac) {
      rmSync(guiDistPath, { recursive: true, force: true })
      cpSync(guiReleasePath, guiDistPath, { recursive: true })
    } else {
      copyFileSync(guiReleasePath, guiDistPath)
    }
  }

  async function buildGui() {
    if (isMac) {
      console.log('  GUI: cargo tauri build --bundles app...')
      // mac: 出 .app bundle（beforeBuildCommand 编译前端）；dmg 由 CI/分发单独出
      const build = spawnSync(['cargo', 'tauri', 'build', '--bundles', 'app'], { cwd: GUILDIR, timeout: 600000 })
      if (build.exitCode !== 0) {
        console.error('[Error] GUI build failed:', build.stderr.toString())
        process.exit(1)
      }
    } else {
      console.log('  GUI: cargo tauri build --no-bundle...')
      // --no-bundle: runs beforeBuildCommand (bun run build = 编译前端), compiles, skips MSI/DMG
      const build = spawnSync(['cargo', 'tauri', 'build', '--no-bundle'], { cwd: GUILDIR, timeout: 600000 })
      if (build.exitCode !== 0) {
        console.error('[Error] GUI build failed:', build.stderr.toString())
        process.exit(1)
      }
    }
    if (!existsSync(guiReleasePath)) {
      console.error(`[Error] GUI artifact not found: ${guiReleasePath}`)
      process.exit(1)
    }
    await copyGuiArtifact()
    console.log(`  OK: ${guiDistPath}`)
  }

  if (!selected('gui') && existsSync(guiDistPath)) {
    console.log(`  GUI: not in components — reusing existing dist ${isMac ? 'app' : 'exe'}`)
  } else if (selected('gui')) {
    // 显式选中 GUI → 前端/后端刚改过，target/release 是旧的，必须真构建否则改动丢失
    await buildGui()
  } else if (QUICK && !REBUILD && existsSync(guiDistPath)) {
    console.log('  GUI: already in dist, skipping (quick)')
  } else if (!REBUILD && existsSync(guiReleasePath)) {
    console.log('  GUI: using existing release build')
    await copyGuiArtifact()
  } else {
    await buildGui()
  }

  // 4. Build Updater (cargo) — macOS 无 Update.exe stager（.app 更新走整体替换），plan=skip
  if (PLATFORM === 'macos') {
    console.log('[4/10] Updater skipped on macOS')
  } else if (!selected('updater') && existsSync(join(DIST, 'Update.exe'))) {
    console.log('[4/10] Updater not in components — reusing existing')
  } else {
    console.log('[4/10] Building Updater...')
    await smartRustBuild('Updater', UPDDIR, 'Update.exe', 'Update.exe', [], 'updater')
  }

  // 5. Generate dist scripts
  console.log('[5/10] Generating dist scripts...')

  if (PLATFORM === 'windows') {
    writeFileSync(join(DIST, 'claude-ide.cmd'), `@echo off\r\nsetlocal\r\n"%~dp0claude.exe" --ide-mode %*\r\n`)
  }

  // Copy scripts/ directory (only .ts files needed at runtime)
  mkdirSync(join(DIST, 'scripts'), { recursive: true })
  const keepScripts = [
    'claude-profile.ts', 'install.ts', 'install-tools.ts',
    'cdp-browser.ts', 'cdp-setup.ts', 'kill-claude.ts',
    'memory-setup.ts', 'gui-profile.py', 'inject-office-bridge.ts',
  ]
  for (const f of keepScripts) {
    const src = join(ROOT, 'scripts', f)
    if (existsSync(src)) copyFileSync(src, join(DIST, 'scripts', f))
  }
  console.log('  scripts/ bundled')

  // bun.exe — needed for TypeScript scripts
  // macOS: 自包含 bun — 下载官方 darwin 二进制（arm64），非 brew。
  if (PLATFORM === 'macos') {
    if (!selected('bun') && existsSync(join(DIST, 'bun'))) {
      console.log('  bun not in components — reusing existing')
    } else {
      console.log('  Downloading bun (macOS, bun-v1.1.30)...')
      const BUN_URL = 'https://github.com/oven-sh/bun/releases/download/bun-v1.1.30/bun-darwin-aarch64.zip'
      const bunZip = join(DIST, '_bun_dl.zip')
      const dl = spawnSync(['curl', '-L', '-f', '-o', bunZip, BUN_URL], { cwd: ROOT, timeout: 600000 })
      if (dl.exitCode !== 0) {
        console.error(`[Error] bun download failed: ${dl.stderr.toString()}`)
        process.exit(1)
      }
      const tmp = join(DIST, '_bun_tmp')
      rmSync(tmp, { recursive: true, force: true })
      mkdirSync(tmp, { recursive: true })
      const uz = spawnSync(['unzip', '-q', bunZip, '-d', tmp], { cwd: ROOT })
      if (uz.exitCode !== 0) {
        console.error(`[Error] bun unzip failed: ${uz.stderr.toString()}`)
        process.exit(1)
      }
      const ex = spawnSync(['bash', '-c',
        `B=$(find '${tmp}' -type f -name bun | head -1); if [ -z "$B" ]; then echo 'bun binary not found' >&2; exit 1; fi; ditto "$B" '${join(DIST, 'bun')}'`], { cwd: ROOT })
      rmSync(tmp, { recursive: true, force: true })
      rmSync(bunZip, { force: true })
      if (ex.exitCode !== 0) {
        console.error(`[Error] bun extract failed: ${ex.stderr.toString()}`)
        process.exit(1)
      }
      console.log('  OK: dist/bun')
    }
  } else if (!selected('bun') && existsSync(join(DIST, 'bun.exe'))) {
    console.log('  bun.exe not in components — reusing existing')
  } else {
  const bunSources = [
    join(homedir(), '.bun', 'bin', 'bun.exe'),
    join(ROOT, 'offline-tools', 'windows', 'bun.exe'),
    join(BIN_DIR, 'bun.exe'),
  ]
  let bunCopied = false
  for (const bunSrc of bunSources) {
    if (existsSync(bunSrc)) {
      copyFileSync(bunSrc, join(DIST, 'bun.exe'))
      console.log(`  bun.exe copied from ${bunSrc}`)
      bunCopied = true
      break
    }
  }
  if (!bunCopied) {
    console.warn('  [Warn] bun.exe not found in any known location')
  }
  }

  // 6. Bundle shared UI + COM bridge
  console.log('[6/10] Bundling shared files...')
  const EXT_DST = join(DIST, 'extensions')

  if (!selected('extensions') && existsSync(EXT_DST)) {
    console.log('  extensions not in components — reusing existing')
  } else {

  function copy(srcRel: string, dstRel: string) {
    const src = join(ROOT, srcRel)
    const dst = join(EXT_DST, dstRel)
    if (!existsSync(src)) { console.warn('  [Warn] missing:', srcRel); return }
    mkdirSync(dst.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
    copyFileSync(src, dst)
  }

  function copyDir(srcRel: string, dstRel: string) {
    const src = join(ROOT, srcRel)
    const dst = join(EXT_DST, dstRel)
    if (!existsSync(src)) { console.warn('  [Warn] missing dir:', srcRel); return }
    mkdirSync(dst, { recursive: true })
    cpSync(src, dst, { recursive: true })
  }

  // Office bridge + MCP server (Python)
  // bridge.py = Windows win32com backend; bridge_mac.py = macOS AppleScript backend;
  // office_mcp_server.py = stdio MCP server auto-registered to ~/.claude.json by the GUI.
  copy('extensions/office/com/bridge.py', 'office/com/bridge.py')
  copy('extensions/office/com/bridge_mac.py', 'office/com/bridge_mac.py')
  copy('extensions/office/com/office_mcp_server.py', 'office/com/office_mcp_server.py')
  // CLAUDE.md @refs (office-bridge.md, python-env.md) — installer copies these to
  // ~/.claude/ and injects a single @-reference line into CLAUDE.md, so their
  // content is maintained here in one place instead of pasted into CLAUDE.md.
  copy('extensions/office/office-bridge.md', 'office/office-bridge.md')
  copy('extensions/python/python-env.md', 'python/python-env.md')

  // Memory MCP Server — Python source + frontend + skills
  // Skip wheels/ (183MB), model/ (88MB), docker images, temp files
  for (const f of [
    'server.py', 'store.py', 'search_engine.py', 'api.py', 'embeddings.py', 'normalize.py',
    'requirements.txt', 'Dockerfile', 'docker-compose.yml', 'config.example.json', '.dockerignore',
  ]) {
    copy(`extensions/memory/${f}`, `memory/${f}`)
  }
  copyDir('extensions/memory/web/dist', 'memory/web/dist')
  copyDir('extensions/memory/skills', 'memory/skills')
  console.log('  memory/ bundled')

  // handoff-compact 压缩提取脚本 — 随程序发布（自建技能，其他机器无 ~/.claude/skills）
  copyDir('extensions/handoff-compact', 'handoff-compact')
  console.log('  handoff-compact/ bundled')
  }

  // VS Code extension webview is self-contained in the VSIX — no need to duplicate here

  // 7. Copy offline CLI tools
  // macOS: 自包含 tools — 下载各工具 darwin arm64 资产（官方 GitHub release），非 brew。
  if (PLATFORM === 'macos') {
    if (!selected('tools') && existsSync(join(DIST, 'bin'))) {
      console.log('[7/10] tools not in components — reusing existing')
    } else {
      console.log('[7/10] Downloading CLI tools (macOS)...')
      mkdirSync(join(DIST, 'bin'), { recursive: true })
      const TOOL_SOURCES: Array<[string, string, 'raw' | 'tar.gz' | 'tar.xz']> = [
        ['rg', 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-aarch64-apple-darwin.tar.gz', 'tar.gz'],
        ['fd', 'https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-aarch64-apple-darwin.tar.gz', 'tar.gz'],
        ['jq', 'https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-macos-arm64', 'raw'],
        ['yq', 'https://github.com/mikefarah/yq/releases/download/v4.44.3/yq_darwin_arm64', 'raw'],
        ['shellcheck', 'https://github.com/koalaman/shellcheck/releases/download/v0.10.0/shellcheck-v0.10.0.darwin.aarch64.tar.xz', 'tar.xz'],
      ]
      for (const [name, url, kind] of TOOL_SOURCES) {
        console.log(`  ${name}...`)
        const dlPath = join(DIST, `_tool_${name}`)
        const dl = spawnSync(['curl', '-L', '-f', '-o', dlPath, url], { cwd: ROOT, timeout: 600000 })
        if (dl.exitCode !== 0) {
          console.error(`[Error] ${name} download failed: ${dl.stderr.toString()}`)
          process.exit(1)
        }
        const dst = join(DIST, 'bin', name)
        if (kind === 'raw') {
          spawnSync(['ditto', dlPath, dst], { cwd: ROOT })
        } else {
          const tmp = join(DIST, `_tool_tmp_${name}`)
          rmSync(tmp, { recursive: true, force: true })
          mkdirSync(tmp, { recursive: true })
          const tarArgs = kind === 'tar.gz'
            ? ['tar', 'xzf', dlPath, '-C', tmp]
            : ['tar', 'xJf', dlPath, '-C', tmp]
          const tar = spawnSync(tarArgs, { cwd: ROOT })
          if (tar.exitCode !== 0) {
            console.error(`[Error] ${name} extract failed: ${tar.stderr.toString()}`)
            process.exit(1)
          }
          const ex = spawnSync(['bash', '-c',
            `B=$(find '${tmp}' -type f -name '${name}' | head -1); if [ -z "$B" ]; then echo '${name} not found' >&2; exit 1; fi; ditto "$B" '${dst}'`], { cwd: ROOT })
          rmSync(tmp, { recursive: true, force: true })
          if (ex.exitCode !== 0) {
            console.error(`[Error] ${name} extract failed: ${ex.stderr.toString()}`)
            process.exit(1)
          }
        }
        rmSync(dlPath, { force: true })
        spawnSync(['chmod', '+x', dst], { cwd: ROOT })
        console.log(`    ${name} → dist/bin/${name}`)
      }
    }
  } else {
  console.log('[7/10] Copying offline CLI tools...')
  const TOOLS = ['rg.exe', 'fd.exe', 'jq.exe', 'yq.exe', 'shellcheck.exe']
  mkdirSync(DIST_BIN, { recursive: true })
  if (!selected('tools') && readdirSync(DIST_BIN).some((f) => f.endsWith('.exe'))) {
    console.log('  tools not in components — reusing existing')
  } else {
  for (const tool of TOOLS) {
    const src = join(BIN_DIR, tool)
    if (existsSync(src)) {
      copyFileSync(src, join(DIST_BIN, tool))
      console.log(`  ${tool}`)
    } else {
      console.warn(`  [Warn] ${tool} not found, skipping`)
    }
  }
  }
  }

  // 8. Setup full Python environment
  // macOS: 自包含 python — 下载官方 .pkg → pkgutil 解包 → 提取 Python.framework 到 dist/python
  if (PLATFORM === 'macos') {
    if (!selected('python') && existsSync(join(DIST, 'python'))) {
      console.log('[8/10] python not in components — reusing existing')
    } else {
      console.log('[8/10] Building self-contained Python (macOS)...')
      const PYTHON_PKG = 'python-3.12.10-macos11.pkg'
      const PKG_URL = `https://mirrors.huaweicloud.com/python/3.12.10/${PYTHON_PKG}`
      const PYTHON_DIR = join(DIST, 'python')
      const LOCAL_PKG = join(ROOT, 'offline-tools', 'macos', PYTHON_PKG)

      if (!existsSync(LOCAL_PKG)) {
        mkdirSync(dirname(LOCAL_PKG), { recursive: true })
        console.log(`  Downloading ${PKG_URL}...`)
        const dl = spawnSync(['curl', '-L', '-f', '-o', LOCAL_PKG, PKG_URL], { cwd: ROOT, timeout: 600000 })
        if (dl.exitCode !== 0) {
          console.error(`[Error] Python pkg download failed: ${dl.stderr.toString()}`)
          process.exit(1)
        }
        console.log(`  Saved ${LOCAL_PKG}`)
      } else {
        console.log(`  Using offline pkg: ${LOCAL_PKG}`)
      }

      const pkgRoot = join(DIST, '_pkg_tmp')
      rmSync(pkgRoot, { recursive: true, force: true })
      // pkgutil --expand-full 要求目标目录不存在（存在会报 "File exists"），
      // 由 pkgutil 自行创建。
      console.log('  Expanding .pkg (pkgutil --expand-full)...')
      const expand = spawnSync(['pkgutil', '--expand-full', LOCAL_PKG, pkgRoot], { cwd: ROOT, timeout: 600000 })
      if (expand.exitCode !== 0) {
        console.error(`[Error] pkgutil expand failed: ${expand.stderr.toString()}`)
        process.exit(1)
      }
      // 提取 Python.framework（递归查找）到 dist/python
      // find -L 跟随符号链接：pkg 展开后 framework 可能是 symlink，-type d 会漏掉。
      // 找不到时打印目录树诊断（framework 实际位置因 pkg 结构而异）。
      rmSync(PYTHON_DIR, { recursive: true, force: true })
      const extract = spawnSync(['bash', '-c',
        `FW=$(find -L '${pkgRoot}' -type d -name 'Python.framework' | head -1); ` +
        `if [ -z "$FW" ]; then echo 'Python.framework not found; pkgRoot tree:' >&2; ` +
        `find '${pkgRoot}' -maxdepth 5 \\( -type d -o -type l \\) | head -60 >&2; exit 1; fi; ` +
        `echo "FW: $FW"; ditto "$FW" '${PYTHON_DIR}'`], { cwd: ROOT, timeout: 300000 })
      if (extract.exitCode !== 0) {
        console.error(`[Error] Python.framework extract failed: ${extract.stderr.toString()}`)
        process.exit(1)
      }
      rmSync(pkgRoot, { recursive: true, force: true })
      console.log('  Extracted Python.framework → dist/python/')
      // 建 python3 兼容入口：settings.rs 注册 office MCP 用 {exe}/python/bin/python3，
      // 而 pkg 提取的 framework 顶层没有 bin/（python 在 Versions/<ver>/bin/ 下）。
      mkdirSync(join(PYTHON_DIR, 'bin'), { recursive: true })
      spawnSync(['ln', '-sf', '../Versions/Current/bin/python3', join(PYTHON_DIR, 'bin', 'python3')], { cwd: ROOT })
      // 安装 mcp SDK（office MCP server 依赖；mac 走 osascript，无 COM，不需要 pywin32）。
      const fwPy3 = join(PYTHON_DIR, 'Versions', 'Current', 'bin', 'python3')
      console.log('  Installing mcp SDK...')
      // PYTHONNOUSERSITE=1：隔离 user site-packages，强制全部依赖装进 dist 自带
      // site-packages——否则构建机/user 有缓存依赖时 pip 跳过，发版打包丢依赖。
      const pipInstall = spawnSync([fwPy3, '-m', 'pip', 'install', 'mcp==1.28.1'], { cwd: ROOT, timeout: 180000, env: { ...process.env, PYTHONNOUSERSITE: '1' } })
      if (pipInstall.exitCode !== 0) {
        console.warn(`  [Warn] mcp install failed: ${pipInstall.stderr.toString()}`)
      } else {
        console.log('  mcp installed')
      }
    }
  } else {
  console.log('[8/10] Setting up Python 3.12...')
  const PYTHON_ZIP_NAME = 'python-3.12.10-amd64.zip'
  const PYTHON_URL = `https://mirrors.huaweicloud.com/python/3.12.10/${PYTHON_ZIP_NAME}`
  const PYTHON_DIR = join(DIST, 'python')
  const LOCAL_ZIP = join(ROOT, 'offline-tools', 'windows', PYTHON_ZIP_NAME)

  // Component / quick mode: skip if Python already set up
  const pythonReady = existsSync(join(PYTHON_DIR, 'python.exe'))
  if (!selected('python') && pythonReady) {
    console.log('  Python not in components — reusing existing')
  } else if (QUICK && pythonReady) {
    console.log('  Python already set up, skipping (quick)')
  } else {
    // Use offline zip if available, otherwise download
    let zipPath = LOCAL_ZIP
    if (existsSync(LOCAL_ZIP)) {
      console.log(`  Using offline zip: ${LOCAL_ZIP}`)
    } else {
      console.log(`  Downloading ${PYTHON_URL}...`)
      const download = spawnSync(['powershell', '-NoProfile', '-Command',
        `Invoke-WebRequest -Uri '${PYTHON_URL}' -OutFile '${LOCAL_ZIP}'`], { cwd: ROOT, timeout: 180000 })
      if (download.exitCode !== 0) {
        console.error(`[Error] Python download failed: ${download.stderr.toString()}`)
        process.exit(1)
      }
      console.log('  Download complete')
      zipPath = LOCAL_ZIP
    }

    // Extract
    if (existsSync(PYTHON_DIR)) {
      rmSync(PYTHON_DIR, { recursive: true })
    }
    mkdirSync(PYTHON_DIR, { recursive: true })
    const unzip = spawnSync(['powershell', '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath}', '${PYTHON_DIR}')`], { cwd: ROOT })
    if (unzip.exitCode !== 0) {
      console.error(`[Error] Python unzip failed: ${unzip.stderr.toString()}`)
      process.exit(1)
    }
    console.log('  Extracted to dist/python/')

    // Install pywin32 (COM bridge) + mcp SDK (office MCP server) — pip is in Lib/site-packages/
    // mcp==1.28.1 锁定版本（官方 SDK，同 memory MCP server），装进 dist 自带 site-packages，
    // 随 python 组件打包——不依赖用户级 site-packages（发版不打包，会丢）。
    const pythonExe = join(PYTHON_DIR, 'python.exe')
    console.log('  Installing pywin32 + mcp SDK...')
    const pipInstall = spawnSync([pythonExe, '-m', 'pip', 'install', 'pywin32', 'mcp==1.28.1'], { cwd: ROOT, timeout: 180000, env: { ...process.env, PYTHONNOUSERSITE: '1' } })
    if (pipInstall.exitCode !== 0) {
      console.warn(`  [Warn] pywin32/mcp install failed: ${pipInstall.stderr.toString()}`)
    } else {
      console.log('  pywin32 + mcp installed')
    }
  }
  }

  // 9. Setup Git environment (PortableGit zip)
  // 9. Setup Git environment (macOS: 系统自带 git，plan=system 不打包)
  if (PLATFORM === 'macos') {
    console.log('[9/10] git skipped on macOS (system git)')
  } else {
  console.log('[9/10] Setting up Git...')
  const GIT_DIR = join(DIST, 'git')
  const GIT_ZIP = join(ROOT, 'offline-tools', 'windows', 'PortableGit.zip')

  // Component / quick mode: skip if already set up
  const gitReady = existsSync(join(GIT_DIR, 'usr', 'bin', 'bash.exe'))
  if (!selected('git') && gitReady) {
    console.log('  Git not in components — reusing existing')
  } else if (QUICK && gitReady) {
    console.log('  Git already set up, skipping (quick)')
  } else if (existsSync(GIT_ZIP)) {
    // Extract PortableGit.zip → dist/git/
    if (existsSync(GIT_DIR)) {
      rmSync(GIT_DIR, { recursive: true })
    }
    mkdirSync(GIT_DIR, { recursive: true })

    const gitTempDir = join(DIST, '_git_tmp')
    try {
      if (existsSync(gitTempDir)) rmSync(gitTempDir, { recursive: true })
      mkdirSync(gitTempDir, { recursive: true })

      console.log('  Extracting PortableGit.zip...')
      // Use .NET ZipFile — Expand-Archive hangs/OOMs on 155MB zips
      const unzip = spawnSync(['powershell', '-NoProfile', '-Command',
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${GIT_ZIP}', '${gitTempDir}')`], { cwd: ROOT, timeout: 120000 })
      if (unzip.exitCode !== 0) {
        console.error(`[Error] Git unzip failed:`, unzip.stderr.toString())
        process.exit(1)
      }

      // Move PortableGit/* → dist/git/
      const extracted = join(gitTempDir, 'PortableGit')
      if (existsSync(extracted)) {
        for (const f of readdirSync(extracted)) {
          const src = join(extracted, f)
          const dst = join(GIT_DIR, f)
          try {
            if (statSync(src).isDirectory()) {
              cpSync(src, dst, { recursive: true })
            } else {
              copyFileSync(src, dst)
            }
          } catch { /* skip locked */ }
        }
      }
      console.log('  PortableGit extracted')
    } finally {
      try { rmSync(gitTempDir, { recursive: true }) } catch {}
    }
  } else {
    console.warn(`  [Warn] PortableGit.zip not found at ${GIT_ZIP}`)
    console.warn('  [Warn] Download from https://github.com/git-for-windows/git/releases')
    console.warn('  [Warn] and save as offline-tools/windows/PortableGit.zip')
  }
  }

  // 10. Copy IDE extension packages + generate dist launcher scripts
  console.log('[10/10] Copying IDE extensions + generating launcher scripts...')
  const EXT_PKG = join(DIST, 'extensions')
  mkdirSync(EXT_PKG, { recursive: true })

  // IDE 插件复制 — 组件未选中且已有产物时复用，省时间
  if (!selected('extensions') && existsSync(join(EXT_PKG, 'vscode'))) {
    console.log('  IDE extensions not in components — reusing existing')
  } else {

  // VS Code
  const vscodeVsix = join(ROOT, 'extensions', 'vscode', 'claude-code-ide-0.2.37.vsix')
  if (existsSync(vscodeVsix)) {
    mkdirSync(join(EXT_PKG, 'vscode'), { recursive: true })
    copyFileSync(vscodeVsix, join(EXT_PKG, 'vscode', 'claude-code-ide-0.2.37.vsix'))
    console.log('  VS Code extension')
  } else { console.warn('  [Warn] VS Code VSIX not found') }

  // Visual Studio
  const vsVsix = join(ROOT, 'extensions', 'vs', 'ClaudeCodeVS-0.2.12.vsix')
  if (existsSync(vsVsix)) {
    mkdirSync(join(EXT_PKG, 'vs'), { recursive: true })
    copyFileSync(vsVsix, join(EXT_PKG, 'vs', 'ClaudeCodeVS-0.2.12.vsix'))
    console.log('  Visual Studio extension')
  } else { console.warn('  [Warn] VS VSIX not found') }

  // IntelliJ (pre-built copy first, gradle output as fallback)
  const intellijZip = (() => {
    const prebuilt = join(ROOT, 'extensions', 'intellij', 'claude-code-ide-0.2.12.zip')
    if (existsSync(prebuilt)) return prebuilt
    return join(ROOT, 'extensions', 'intellij', 'build', 'distributions', 'claude-code-ide-0.2.12.zip')
  })()
  if (existsSync(intellijZip)) {
    mkdirSync(join(EXT_PKG, 'intellij'), { recursive: true })
    copyFileSync(intellijZip, join(EXT_PKG, 'intellij', 'claude-code-ide-0.2.12.zip'))
    console.log('  IntelliJ extension')
  } else { console.warn('  [Warn] IntelliJ ZIP not found') }

  // CDP Inspector (MCP server for browser debugging)
  const cdpDir = join(ROOT, 'extensions', 'cdp-inspector')
  if (existsSync(cdpDir)) {
    mkdirSync(join(EXT_PKG, 'cdp-inspector'), { recursive: true })
    cpSync(cdpDir, join(EXT_PKG, 'cdp-inspector'), { recursive: true })
    console.log('  CDP Inspector')
  } else { console.warn('  [Warn] CDP Inspector not found') }

  }

  // launcher scripts — at dist/ root (Windows .cmd；macOS 用 bin/ shell 脚本 + .app 自带启动)
  if (PLATFORM === 'windows') {
  const launchers: Record<string, string[]> = {
    'claude.cmd': ['@echo off', 'chcp 65001 >nul', 'setlocal', '"%~dp0claude.exe" %*', ''],
    'claude-haha.cmd': ['@echo off', 'chcp 65001 >nul', 'setlocal', '"%~dp0claude.exe" %*', ''],
    'cla.cmd': ['@echo off', 'chcp 65001 >nul', 'setlocal', '"%~dp0claude.exe" %*', ''],
    'cla-bypass.cmd': ['@echo off', 'chcp 65001 >nul', 'setlocal', '"%~dp0claude.exe" --permission-mode bypassPermissions %*', ''],
    'claude-ide.cmd': ['@echo off', 'chcp 65001 >nul', 'setlocal', '"%~dp0claude.exe" --ide-mode %*', ''],
    'claude-profile.cmd': ['@echo off', 'chcp 65001 >nul', 'setlocal',
      'if exist "%~dp0bun.exe" (',
      '  "%~dp0bun.exe" "%~dp0scripts\\claude-profile.ts" %*',
      ') else (',
      '  echo [Error] bun.exe not found.',
      ')', ''],
    'cdp-browser.cmd': ['@echo off', 'chcp 65001 >nul', 'setlocal',
      '"%~dp0bun.exe" "%~dp0scripts\\cdp-browser.ts" %*', ''],
    'kill-claude.cmd': ['@echo off', 'chcp 65001 >nul', 'setlocal',
      '"%~dp0bun.exe" "%~dp0scripts\\kill-claude.ts" %*', ''],
    'cdp-setup.cmd': ['@echo off', 'chcp 65001 >nul', 'setlocal',
      '"%~dp0bun.exe" "%~dp0scripts\\cdp-setup.ts" %*', ''],

    'memory-setup.cmd': ['@echo off', 'chcp 65001 >nul', 'setlocal',
      '"%~dp0bun.exe" "%~dp0scripts\\memory-setup.ts" %*', ''],
  }
  for (const [name, lines] of Object.entries(launchers)) {
    writeFileSync(join(DIST, name), lines.join('\r\n'))
    console.log(`  ${name}`)
  }

  // Extra utility scripts
  const extraScripts = ['inject-office-bridge.cmd']
  for (const name of extraScripts) {
    const src = join(BIN_DIR, name)
    if (existsSync(src)) {
      copyFileSync(src, join(DIST, name))
      console.log(`  ${name}`)
    }
  }
  }

  // 11. Generate update manifest + component zips (only with --release <version>)
  if (RELEASE_VER) {
  console.log(`${step(11)} Generating update manifest...`)
  const pad = (n: number) => String(n).padStart(2, '0')
  const version = RELEASE_VER
  const now = new Date()
  const publishedAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z')

  // 平台构建计划（macOS 移植 seam）——决定哪些组件打包、哪些用系统/跳过。
  const buildPlan = planComponents({
    platform: PLATFORM,
    selected: COMPONENT_SET,
    prevRelease: (() => {
      const relDir = join(DIST, 'release')
      if (!existsSync(relDir)) return null
      const prevs = readdirSync(relDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== version && /^\d{4}\.\d{2}\.\d{2}/.test(d.name))
        .map((d) => d.name).sort()
      return prevs.length ? { zipExists: (n: string) => existsSync(join(relDir, prevs[prevs.length - 1], `${n}.zip`)) } : null
    })(),
  })
  const planActive = new Set(buildPlan.filter((p) => p.action !== 'system' && p.action !== 'skip').map((p) => p.name))
  for (const p of buildPlan) {
    console.log(`    ${p.name}: ${p.action}${p.artifact !== 'none' ? ` (${p.artifact})` : ''}${p.requiresMacTools ? ` — brew: ${p.requiresMacTools.join(' ')}` : ''}`)
  }

  // SHA256 for single files
  function sha256File(path: string): string {
    const buf = readFileSync(path)
    return new Bun.CryptoHasher('sha256').update(buf).digest('hex') as string
  }

  // Directory content fingerprint — metadata-only, fast (~1s for 100k files)
  // Hashes (relative_path, file_size) pairs so content=immaterial changes are ignored
  function dirMetaHash(dir: string): string {
    const entries: Array<{ path: string; size: number }> = []
    for (const e of readdirSync(dir, { recursive: true })) {
      const p = join(dir, e.toString())
      try { entries.push({ path: e.toString().replace(/\\/g, '/'), size: statSync(p).size }) } catch {}
    }
    entries.sort((a, b) => a.path.localeCompare(b.path))
    const content = entries.map(e => `${e.path}:${e.size}`).join('\n')
    return new Bun.CryptoHasher('sha256').update(Buffer.from(content)).digest('hex') as string
  }

  // Recursive directory size
  function dirSize(dir: string): number {
    if (!existsSync(dir)) return 0
    let total = 0
    for (const e of readdirSync(dir, { recursive: true })) {
      const p = join(dir, e.toString())
      try { total += statSync(p).size } catch {}
    }
    return total
  }

  // 组件源映射（按平台）——Windows gui/claude 是单文件 exe；macOS gui 是 .app bundle(dir)、
  // claude 无 .exe 后缀；bun/tools/python/git 用系统自带、updater 专属 Windows → 由 plan 过滤不打包。
  const componentSources: Record<string, { kind: 'file' | 'dir'; path: string }> = {
    gui: PLATFORM === 'windows' ? { kind: 'file', path: 'claude-code-gui.exe' } : { kind: 'dir', path: 'Claude Code.app' },
    claude: PLATFORM === 'windows' ? { kind: 'file', path: 'claude.exe' } : { kind: 'file', path: 'claude' },
    bun: PLATFORM === 'windows' ? { kind: 'file', path: 'bun.exe' } : { kind: 'file', path: 'bun' },
    updater: { kind: 'file', path: 'Update.exe' },
    tools: { kind: 'dir', path: 'bin' },
    python: { kind: 'dir', path: 'python' },
    git: { kind: 'dir', path: 'git' },
    extensions: { kind: 'dir', path: 'extensions' },
  }
  const manifestSources = Object.fromEntries(
    Object.entries(componentSources).filter(([name]) => planActive.has(name)),
  )

  const manifestComponents: Record<string, object> = {}
  for (const [name, src] of Object.entries(manifestSources)) {
    const path = join(DIST, src.path)
    manifestComponents[name] = src.kind === 'file'
      ? { sha256: sha256File(path), size: statSync(path).size }
      : { sha256: dirMetaHash(path), size: dirSize(path) }
  }

  const manifest = {
    version,
    release_notes: NOTES,
    published_at: publishedAt,
    components: manifestComponents,
  }

  // Write manifest + component zips to dist/release/<version>/
  const RELEASE_DIR = join(DIST, 'release', version)
  mkdirSync(RELEASE_DIR, { recursive: true })
  writeFileSync(join(RELEASE_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  // Also copy to dist/ root so installer can pick it up (updater reads {app}\manifest.json)
  copyFileSync(join(RELEASE_DIR, 'manifest.json'), join(DIST, 'manifest.json'))
  console.log(`  manifest.json → release/${version}/ + dist/`)

  // 组件选择 / GUI-only / update-only：复用上一版本组件 zip（只有目标组件变了），只重打对应 zip
  // 按语义版本排序（数值逐段比较）——字典序会让 2026.08.21.10 排在 .9 前面，取错复用源
  const prevRelDir = (() => {
    if (!GUI_ONLY && !UPDATE_ONLY && !EXTENSIONS_ONLY && COMPONENT_SET === null) return null
    const releasesDir = join(DIST, 'release')
    if (!existsSync(releasesDir)) return null
    const prevs = readdirSync(releasesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== version && /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => {
        const pa = a.split('.').map(Number)
        const pb = b.split('.').map(Number)
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const na = pa[i] ?? 0
          const nb = pb[i] ?? 0
          if (na !== nb) return na - nb
        }
        return 0
      })
    return prevs.length ? join(releasesDir, prevs[prevs.length - 1]) : null
  })()
  const prevLabel = prevRelDir ? prevRelDir.split(/[\\/]/).pop() : null

  // 压缩组件 zip —— 复用/重打逻辑与原来一致（want/prevRelDir），
  // 差异只在源（manifestSources 按平台）与 zip 工具（mac 用系统 zip，Windows 用 Compress-Archive）。
  const compress = (name: string, src: { kind: 'file' | 'dir'; path: string }) => {
    const srcPath = join(DIST, src.path)
    const zipPath = join(RELEASE_DIR, `${name}.zip`)
    if (!want(name)) {
      if (existsSync(zipPath)) { console.log(`  ${name}.zip (kept existing)`); return }
      if (prevRelDir) {
        const prevZip = join(prevRelDir, `${name}.zip`)
        if (existsSync(prevZip)) {
          copyFileSync(prevZip, zipPath)
          console.log(`  ${name}.zip (reused from ${prevLabel})`)
          return
        }
      }
    }
    if (PLATFORM === 'macos') {
      // macOS: 系统 zip（无 PowerShell）。file → 单文件入 zip 根；dir → 目录内容入 zip 根。
      const run = src.kind === 'file'
        ? spawnSync(['zip', '-j', '-q', zipPath, srcPath], { cwd: DIST })
        : spawnSync(['zip', '-r', '-q', zipPath, '.'], { cwd: srcPath })
      if (run.exitCode !== 0) {
        console.error(`  [Error] zip failed for ${name}:`, run.stderr.toString())
        process.exit(1)
      }
    } else {
      const arg = src.kind === 'file' ? srcPath : `${srcPath}\\*`
      spawnSync(['powershell', '-NoProfile', '-Command',
        `Compress-Archive -Path '${arg}' -DestinationPath '${zipPath}' -Force`], { cwd: DIST })
    }
    const sizeKB = Math.round(statSync(zipPath).size / 1024)
    console.log(`  ${name}.zip (${sizeKB} KB)`)
  }

  for (const [name, src] of Object.entries(manifestSources)) compress(name, src)

  console.log(`  Release ${version} ready: dist/release/${version}/`)

  } // end --release block

  // Summary
  let totalSize = 0
  function calcSize(dir: string) {
    if (!existsSync(dir)) return
    const entries = readdirSync(dir, { recursive: true })
    for (const e of entries) {
      const p = join(dir, e.toString())
      try { totalSize += statSync(p).size } catch {}
    }
  }
  calcSize(DIST)
  const sizeMB = Math.round(totalSize / 1024 / 1024)

  console.log()
  console.log('='.repeat(50))
  console.log('  Build complete!')
  console.log(`  Total size: ~${sizeMB} MB`)
  console.log()
  console.log(`  dist/*.exe                   — claude-code-gui.exe, claude.exe, Update.exe, bun.exe`)
  console.log(`  dist/*.cmd                   — Launcher scripts`)
  console.log(`  dist/bin/                    — CLI tools (rg, fd, jq, yq, shellcheck)`)
  console.log(`  dist/python/                 — Python 3.12 (full) + pywin32`)
  console.log(`  dist/git/                    — Git Bash + Git repo tools`)
  console.log(`  dist/extensions/             — IDE plugins (VS Code, VS, IntelliJ, CDP) + COM bridge`)
  if (RELEASE_VER) console.log(`  dist/release/${RELEASE_VER}/    — Update manifest + component zips`)
  console.log(`  dist/scripts/                — TypeScript tools`)
  console.log('='.repeat(50))
  console.log()
  console.log('  Test:', claudeBin, '--version')

  try {
    const ver = spawnSync([claudeBin, '--version'], { cwd: DIST })
    console.log('  →', ver.stdout.toString().trim())
  } catch {
    console.log('  [Skip] claude.exe not built yet')
  }
}

main().catch(e => { console.error('Build failed:', e); process.exit(1) })
