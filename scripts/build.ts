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
 *     known components: gui, server, claude, bun, updater, tools, python, git, extensions
 *
 * --notes 写法（更新面板按 markdown 渲染，实现见 gui/src/utils/releaseNotesMarkdown.ts）：
 *   · 首行版本号；分节用 ###；条目用 -；版本之间用 --- 分隔
 *   · 每条一句话讲清「改了什么 + 为什么」；细节留给 commit，别堆长段
 *   · 只写本版内容 —— 历史由脚本自动拼接（见下方 MAX_RELEASE_NOTES）
 *   示例：
 *     v2026.09.10.2
 *
 *     ### 修复
 *     - 更新说明支持 markdown — 层级可读，**粗体** 不再是字面星号
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
const SERVERDIR = join(GUILDIR, 'server')   // GUI server daemon (独立二进制, 随 GUI 同目录分发)
const UPDDIR = join(ROOT, 'updater')
const BIN_DIR = join(ROOT, 'bin')

/**
 * 打印 `cargo tauri build` 的失败详情。
 *
 * **必须打 stdout**：cargo-tauri 把 `beforeBuildCommand`（前端 `tsc && vite build`）
 * 的报错写在 stdout，stderr 只有 "Info Looking up installed tauri packages..."
 * 这类进度噪声。只打 stderr 会让日志变成
 * `[Error] GUI build failed: Info Looking up...`，真正的类型错误全丢。
 *
 * 代价实例（2026-09-13）：.13.6 的 CI 失败，日志里看不到任何有用信息，
 * 排查一轮才从"快照分支有改名前的孤儿文件"定位到根因。
 *
 * 取 stdout 的**尾部**（前端错误在最后），避免把几千行 vite 输出全刷进日志。
 */
function reportGuiBuildFailure(build: { stdout: Buffer | string; stderr: Buffer | string; exitCode: number | null }) {
  const tail = (s: Buffer | string, n: number) =>
    s.toString().split('\n').filter((l) => l.trim()).slice(-n).join('\n')
  console.error(`[Error] GUI build failed (exit ${build.exitCode})`)
  console.error('--- stdout (tail) ---')
  console.error(tail(build.stdout, 40))
  const err = tail(build.stderr, 15)
  if (err) {
    console.error('--- stderr (tail) ---')
    console.error(err)
  }
}

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
  // --expect-prev <version>: 声明"上一发行版本号"（服务器上真正在跑的上一版）。
  // 复用未改动组件的 zip 时校验来源版本一致——防止本地 dist/release 缺失该版本时
  // 静默复用更老版本的包（2026.09.12.1 事故：bun/python 等被换成 09.04 的旧包，
  // sha 全变 → 用户端全量"有更新"）。
  const EXPECT_PREV_IDX = process.argv.indexOf('--expect-prev')
  const EXPECT_PREV = EXPECT_PREV_IDX >= 0 ? process.argv[EXPECT_PREV_IDX + 1] : null

  // ── Component selection ──
  // Known components: gui, claude, bun, updater (exe) + tools, python, git, extensions (dir).
  // --components <a,b,c> 只重建/重打这些组件，其余复用上一版本组件 zip 与现有 dist 产物。
  // 无 --components（且无 -only 旗标）时 = 全量构建，行为不变。
  const KNOWN_COMPONENTS = ['gui', 'server', 'claude', 'bun', 'updater', 'tools', 'python', 'git', 'extensions']
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

  // --expect-prev 前置校验（仅"部分构建+复用"场景相关）：本地 dist/release 里最"新"的
  // 版本目录必须就是声明的上一发行版——否则未选中组件会静默复用更老的包
  //（2026.09.12.1 事故：本地最新是 09.04.11，09.10.x 的 zip 缺失 → bun/python 等被换成
  //  09.04 的旧包，sha 全变，用户端全量"有更新"）。构建前快速失败，避免白跑编译。
  if (EXPECT_PREV && COMPONENT_SET !== null && RELEASE_VER) {
    const releasesDir = join(DIST, 'release')
    const localPrev = (() => {
      if (!existsSync(releasesDir)) return null
      const prevs = readdirSync(releasesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== RELEASE_VER && /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(d.name))
        .map((d) => d.name)
        .sort((a, b) => {
          const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const na = pa[i] ?? 0, nb = pb[i] ?? 0
            if (na !== nb) return na - nb
          }
          return 0
        })
      return prevs.length ? prevs[prevs.length - 1] : null
    })()
    if (localPrev !== EXPECT_PREV) {
      console.error(`[Error] --expect-prev ${EXPECT_PREV} but local prev release is ${localPrev ?? '(none)'}.`)
      console.error(`        Fetch that version's component zips into dist/release/${EXPECT_PREV}/ first,`)
      console.error(`        or omit --expect-prev (only needed when reusing unselected components).`)
      process.exit(1)
    }
  }

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
        // ⚠️ 必须打 **stdout**：cargo-tauri 把 beforeBuildCommand 的输出
        // （前端 `tsc && vite build` 的**类型错误**）写在 stdout，stderr 只有
        // "Info Looking up installed tauri packages..." 这类进度噪声。
        // 只打 stderr 会让 CI 日志变成 "GUI build failed: Info Looking up..."，
        // 真正的报错全丢 —— .13.6 的 CI 失败因此排查了一轮才定位到根因。
        reportGuiBuildFailure(build)
        process.exit(1)
      }
    } else {
      console.log('  GUI: cargo tauri build --no-bundle...')
      // --no-bundle: runs beforeBuildCommand (bun run build = 编译前端), compiles, skips MSI/DMG
      const build = spawnSync(['cargo', 'tauri', 'build', '--no-bundle'], { cwd: GUILDIR, timeout: 600000 })
      if (build.exitCode !== 0) {
        reportGuiBuildFailure(build)
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

  // 3b. Build GUI server (cargo) — 独立守护进程，GUI 从 exe 同目录发现(find_server_exe)。
  //     server 与 gui 强依赖：新 GUI 依赖新 server 的 publish/claim/ack RPC。上线时组件更新
  //     顺序 server 优先于 gui(见 update.rs 组件优先级)，保证"新 GUI+新 server"配套。
  const serverDistPath = join(DIST, isMac ? 'claude-gui-server' : 'claude-gui-server.exe')
  const serverExeName = isMac ? 'claude-gui-server' : 'claude-gui-server.exe'
  if (!selected('server') && existsSync(serverDistPath)) {
    console.log('[3b/10] GUI server not in components — reusing existing dist')
  } else {
    console.log('[3b/10] Building GUI server...')
    await smartRustBuild('GUI Server', SERVERDIR, serverExeName, serverExeName, [], 'server')
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
    'kill-claude.ts',
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
    'server.py', 'store.py', 'search_engine.py', 'api.py', 'auth.py', 'tokenizer.py', 'normalize.py',
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
  // macOS: 自包含 python —— 用 **python-build-standalone**（Astral 维护）。
  //
  // 为什么不用 python.org 的官方 .pkg（旧方案，2026-09-13 废弃）：
  //   pkg 装出来的是**框架式**安装，二进制里硬编码
  //   `/Library/Frameworks/Python.framework/Versions/3.12/Python`。ditto 拷走副本
  //   只能搬文件、**改不了二进制里的绝对路径** → 用户机器上系统框架一旦升到别的
  //   版本（如 3.14），那份 3.12 dylib 就没了，内置 python 直接
  //   `dyld: Library not loaded` 起不来。**"分发副本"从根上不成立**。
  //   （注意：重建 symlink 救不了 —— 问题不在链接，在 LC_LOAD_DYLIB 的绝对路径。）
  //
  // standalone 是**真自包含**：自身引用走 `@rpath` / `@executable_path/../lib`，
  // libpython3.12.dylib 随包分发；只依赖 /System/Library 下的系统库（永远存在）。
  // 顺带体积从 ~176MB 降到 ~24MB。
  if (PLATFORM === 'macos') {
    if (!selected('python') && existsSync(join(DIST, 'python'))) {
      console.log('[8/10] python not in components — reusing existing')
    } else {
      console.log('[8/10] Building self-contained Python (macOS)...')
      // 版本固定（可复现构建）。升级时改这两行 + 下面 pip 的版本约束一并复核。
      const PBS_TAG = '20260901'                     // release tag
      const PBS_PY = '3.12.14'                       // CPython 版本
      const PBS_ARCH = 'aarch64-apple-darwin'        // 只出 Apple Silicon（架构决策见 docs/macos-build-playbook.md）
      const PBS_NAME = `cpython-${PBS_PY}+${PBS_TAG}-${PBS_ARCH}-install_only.tar.gz`
      const PBS_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_NAME}`
      const PYTHON_DIR = join(DIST, 'python')
      const LOCAL_TGZ = join(ROOT, 'offline-tools', 'macos', PBS_NAME)

      if (!existsSync(LOCAL_TGZ)) {
        mkdirSync(dirname(LOCAL_TGZ), { recursive: true })
        console.log(`  Downloading ${PBS_NAME}...`)
        const dl = spawnSync(['curl', '-L', '-f', '-o', LOCAL_TGZ, PBS_URL], { cwd: ROOT, timeout: 600000 })
        if (dl.exitCode !== 0) {
          console.error(`[Error] python-build-standalone download failed: ${dl.stderr.toString()}`)
          process.exit(1)
        }
        console.log(`  Saved ${LOCAL_TGZ}`)
      } else {
        console.log(`  Using offline archive: ${LOCAL_TGZ}`)
      }

      // 解压 —— tarball 顶层就是 `python/`（内含 bin/ lib/ include/ share/），
      // 正好等于 dist/python 想要的结构，解到 DIST 即可，**无需再建 bin 链接**
      // （旧方案要手建 `python/bin/python3`，那步随 pkg 方案一起消失）。
      rmSync(PYTHON_DIR, { recursive: true, force: true })
      const ex = spawnSync(['tar', '-xzf', LOCAL_TGZ, '-C', DIST], { cwd: ROOT, timeout: 600000 })
      if (ex.exitCode !== 0) {
        console.error(`[Error] python archive extract failed: ${ex.stderr.toString()}`)
        process.exit(1)
      }
      const py3 = join(PYTHON_DIR, 'bin', 'python3')
      if (!existsSync(py3)) {
        // 下游契约：settings.rs 用 {exe}/python/bin/python3 注册 office MCP。
        // 布局变了必须在这里失败，而不是等用户装完发现 python 起不来。
        console.error(`[Error] expected interpreter missing after extract: ${py3}`)
        process.exit(1)
      }
      console.log('  Extracted python-build-standalone → dist/python/')

      // 安装 mcp SDK（office MCP server 依赖；mac 走 osascript，无 COM，不需要 pywin32）。
      console.log('  Installing mcp SDK...')
      // PYTHONNOUSERSITE=1：隔离 user site-packages，强制全部依赖装进 dist 自带
      // site-packages——否则构建机/user 有缓存依赖时 pip 跳过，发版打包丢依赖。
      const pipInstall = spawnSync([py3, '-m', 'pip', 'install', 'mcp==1.28.1'], { cwd: ROOT, timeout: 180000, env: { ...process.env, PYTHONNOUSERSITE: '1' } })
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
    'kill-claude.cmd': ['@echo off', 'chcp 65001 >nul', 'setlocal',
      '"%~dp0bun.exe" "%~dp0scripts\\kill-claude.ts" %*', ''],

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
  } else {
    // macOS launcher：Unix shebang，跟 claude 二进制平级放 dist/ 根。IDE 插件
    // （vscode/intellij：extension.ts IDE_SCRIPT / intellij ProcessManager）按平台找
    // 无扩展名 claude-ide，此前 mac 分支零 launcher → mac IDE 找不到启动脚本。
    // CLI 用 shebang 调 claude。claude/claude-haha 不生成（会与 mac 的 claude
    // 二进制同名冲突，命令行直接用二进制）。
    //
    // ⚠️ **不生成依赖 `$DIR/scripts/*.ts` 的那三个**（claude-profile / kill-claude /
    // memory-setup）：.app 的 Contents/MacOS/ 下**没有 `scripts/` 目录**
    // （embedDirs 只含 claude/bun/bin/python/extensions，scripts 不打进去），
    // 这几个 launcher 必然 `exec: .../scripts/xxx.ts: No such file` 跑不起来 ——
    // 是纯死文件。且这三个功能在 mac 上都由 GUI 界面提供（Profile 管理 / 杀进程 /
    // 记忆 MCP 配置），命令行入口对 mac 用户没有实际用途。
    // （真机验证时发现，见 docs/macos-build-playbook.md。）
    const unix: Record<string, string> = {
      'claude-ide': '#!/bin/sh\nDIR="$(cd "$(dirname "$0")" && pwd)"\nexec "$DIR/claude" --ide-mode "$@"\n',
      'cla': '#!/bin/sh\nDIR="$(cd "$(dirname "$0")" && pwd)"\nexec "$DIR/claude" "$@"\n',
      'cla-bypass': '#!/bin/sh\nDIR="$(cd "$(dirname "$0")" && pwd)"\nexec "$DIR/claude" --permission-mode bypassPermissions "$@"\n',
    };
    for (const [name, content] of Object.entries(unix)) {
      const p = join(DIST, name)
      writeFileSync(p, content)
      spawnSync(['chmod', '+x', p])
      console.log(`  ${name}`)
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

  // 读取 JSON（失败返回 null——调用方按可选处理，不中断构建）
  function readJsonSafe(path: string): { components?: Record<string, { sha256?: string; size?: number }> } | null {
    try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
  }

  // SHA256 for single files
  function sha256File(path: string): string {
    const buf = readFileSync(path)
    return new Bun.CryptoHasher('sha256').update(buf).digest('hex') as string
  }

  // Directory content fingerprint — metadata-only, fast (~1s for 100k files)
  // Hashes (relative_path, file_size) pairs so content=immaterial changes are ignored
  // ⚠️ 局限：size-only 摘要无法检出「内容变但大小恰好不变」的目录组件（如 mac 的
  //  Claude Code.app，前端嵌入 claude-code-gui 二进制 size 相同但内容不同）→ 客户端
  //  check_for_updates 只对比 sha 值，会漏提示更新。发布脚本需对 gui 组件用内容 hash
  //  覆盖（见 temp/release_mac_*.py dir_content_hash）。勿在此改为内容 hash——会让全部
  //  dir 组件 sha 算法突变，引发一次全量重下。
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
  // server 仅 Windows 作为独立组件分发；mac 上随 .app(embed)，不作为独立 manifest 组件
  // （mac 是整 .app 替换，独立 server 更新与时序冲突；GUI 从 exe 同目录 find_server_exe）。
  if (PLATFORM === 'windows') {
    componentSources.server = { kind: 'file', path: 'claude-gui-server.exe' }
  }
  const manifestSources = Object.fromEntries(
    Object.entries(componentSources).filter(([name]) => planActive.has(name)),
  )

  // macOS: 把全部组件合并进 Claude Code.app（Contents/MacOS/），出开箱即用的完整 .app。
  // 必须在 manifestComponents 计算之前——gui 的 sha 是 .app 目录 hash，embed 后才是最终形态，
  // 否则服务器 manifest 的 gui sha 与完整 .app 不符，客户端永远提示 gui 需更新。
  if (PLATFORM === 'macos') {
    const appMacOS = join(DIST, 'Claude Code.app', 'Contents', 'MacOS')
    // gui 自身是 .app，不嵌。
    //
    // ⚠️ `server` **不在** embedDirs 里 —— 它在 dist 下是**单文件**
    // `claude-gui-server`（见上面 serverDistPath），不是同名目录。早先把 'server'
    // 混在目录列表里 → `existsSync(dist/server)` 恒为假 → 只打一行 [Warn] 静默跳过
    // → .app 里没有 server 二进制 → GUI 的 find_server_exe()（找 current_exe 同目录）
    // 失败 → 诊断面板显示「GUI SERVER 已停止」。整个 GUI server 功能在 mac 上缺失。
    //
    // 教训：这里的"缺失"分支只 warn 不 fail，而 warn 混在长日志里没人看。
    // 所以下面给 server 单独做**硬校验**（它是必须存在的，不是可选组件）。
    const embedDirs = ['claude', 'bun', 'bin', 'python', 'extensions']
    for (const rel of embedDirs) {
      const srcP = join(DIST, rel)
      if (existsSync(srcP)) {
        console.log(`  embed ${rel} → .app/Contents/MacOS/`)
        const run = spawnSync(['ditto', srcP, join(appMacOS, rel)], { cwd: DIST, timeout: 600000 })
        if (run.exitCode !== 0) {
          console.error(`  [Error] embed ${rel} failed:`, run.stderr.toString())
          process.exit(1)
        }
      } else {
        console.warn(`  [Warn] embed ${rel}: dist/${rel} missing, skipping`)
      }
    }
    // server 单文件：必须嵌入（GUI 启动时从 exe 同目录 spawn 它）。
    {
      const src = join(DIST, 'claude-gui-server')
      if (!existsSync(src)) {
        console.error(`  [Error] 缺少 GUI server 二进制: ${src}`)
        console.error('          它在 dist 下叫 claude-gui-server（单文件，不是 server/ 目录）。')
        console.error('          检查 build.ts 第 8.5 步的 GUI Server 构建是否被 --components 跳过。')
        process.exit(1)
      }
      const run = spawnSync(['ditto', src, join(appMacOS, 'claude-gui-server')], { cwd: DIST, timeout: 600000 })
      if (run.exitCode !== 0) {
        console.error('  [Error] embed claude-gui-server failed:', run.stderr.toString())
        process.exit(1)
      }
      spawnSync(['chmod', '+x', join(appMacOS, 'claude-gui-server')])
      console.log('  embed claude-gui-server → .app/Contents/MacOS/')
    }
    // mac launcher 也复制进 .app 根（跟 claude 二进制平级）——IDE 插件按平台找
    // 无扩展名 claude-ide（extension.ts:57 IDE_SCRIPT / intellij ProcessManager），
    // 否则 .app 里只有 claude 没有 claude-ide，mac IDE 找不到启动脚本。
    // 列表与上面的 unix 生成清单保持一致（那三个依赖 scripts/*.ts 的已不再生成）。
    for (const name of ['claude-ide', 'cla', 'cla-bypass']) {
      const srcP = join(DIST, name)
      if (existsSync(srcP)) {
        copyFileSync(srcP, join(appMacOS, name))
        spawnSync(['chmod', '+x', join(appMacOS, name)])
        console.log(`  embed launcher ${name} → .app/Contents/MacOS/`)
      }
    }
  }

  const manifestComponents: Record<string, object> = {}
  for (const [name, src] of Object.entries(manifestSources)) {
    const path = join(DIST, src.path)
    manifestComponents[name] = src.kind === 'file'
      ? { sha256: sha256File(path), size: statSync(path).size }
      : { sha256: dirMetaHash(path), size: dirSize(path) }
  }

  // release_notes 叠加历史：本版(--notes)在前 + 上一版本(本地 dist/release 最新)的累积
  // 说明在后。客户端更新面板据此看到自上次更新以来的完整变更栈，而非单版孤岛。
  const prevNotes = (() => {
    const relDir = join(DIST, 'release')
    if (!existsSync(relDir)) return ''
    // 按版本号数值比较取"真正上一版"，而非字符串排序——字符串排序会把 .9 排在 .13 后
    // ("9" > "1")，导致累积 notes 基底错取远早版本。数值比较才能保证基底是紧邻上一版。
    const prevs = readdirSync(relDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== version && /^\d{4}\.\d{2}\.\d{2}/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => {
        const num = (s: string) => s.match(/\d+/g)?.map(Number) ?? []
        const aa = num(a), bb = num(b)
        const n = Math.max(aa.length, bb.length)
        for (let i = 0; i < n; i++) {
          const x = aa[i] ?? 0, y = bb[i] ?? 0
          if (x !== y) return x - y
        }
        return 0
      })
    if (!prevs.length) return ''
    try { return JSON.parse(readFileSync(join(relDir, prevs[prevs.length - 1], 'manifest.json'), 'utf8')).release_notes || '' } catch { return '' }
  })()
  // 只保留最新几条：累积拼接会让 note 页无限变长。本版在前 + 最近若干版在后。
  const MAX_RELEASE_NOTES = 5
  const release_notes = [NOTES.trim(), prevNotes.trim()]
    .filter(Boolean)
    .join('\n\n---\n\n')
    .split('\n\n---\n\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_RELEASE_NOTES)
    .join('\n\n---\n\n')

  const manifest = {
    version,
    release_notes,
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

  // 完整 .app 内置本地 manifest（组件 sha 已算好）——更新面板据此判定组件已安装，不重复下载
  if (PLATFORM === 'macos') {
    const appMacOS = join(DIST, 'Claude Code.app', 'Contents', 'MacOS')
    copyFileSync(join(RELEASE_DIR, 'manifest.json'), join(appMacOS, 'manifest.json'))
    console.log('  embed manifest.json → .app/Contents/MacOS/')
  }

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
  // 记录每个组件压缩后 zip 的实际字节数，用于 Manifest 的 size 字段。
  // 目录组件（mac 的 gui=.app、python/tools 等）之前用 dirSize()（未压缩目录总大小），
  // 与实际分发下载的压缩 zip 差数倍 —— 客户端据此显示"动辄上G"。改为 zip 实际大小。
  const zipSizes: Record<string, number> = {}
  // 复用组件的 sha 覆盖表：复用的 zip 来自 prevRelDir，其内容 sha 就是 prevManifest
  // 记录值——必须沿用。不能等会去算 dist/ 源文件（未重建组件的 dist/ 可能是本地
  // 遗留的其它版本 → sha 错误 → 用户端全量误提示更新，09.12.1 事故同类）。
  const reusedSha: Record<string, string> = {}
  const compress = (name: string, src: { kind: 'file' | 'dir'; path: string }) => {
    const srcPath = join(DIST, src.path)
    const zipPath = join(RELEASE_DIR, `${name}.zip`)
    if (!want(name)) {
      if (existsSync(zipPath)) {
        // 本版目录里已存在该组件的 zip（重复构建同一版本时会走到这里）。它的 sha
        // 同样必须沿用来源 manifest —— 不能留给后面的 fallback 去算 dist/ 源文件，
        // 那可能是本地遗留的其它版本（→ sha 错误 → 用户端全量误提示更新，
        // 2026.09.12.1 与 09.12.5 事故同因）。
        // 先看本版 manifest（上次构建写的），再回退到来源版本 —— 本版 manifest
        // 可能缺失（首次跑到这里）或本身已被写坏。
        const recorded =
          readJsonSafe(join(RELEASE_DIR, 'manifest.json'))?.components?.[name]?.sha256 ??
          (prevRelDir ? readJsonSafe(join(prevRelDir, 'manifest.json'))?.components?.[name]?.sha256 : undefined)
        if (recorded) {
          reusedSha[name] = recorded
          console.log(`  ${name}.zip (kept existing, sha from manifest)`)
        } else {
          // 无来源可依 —— 宁可报错也不要写出可能错误的 sha。
          console.error(`  [Error] ${name}.zip exists in ${version} but no manifest records its sha.`)
          console.error(`          Delete dist/release/${version}/ and rebuild so the source is unambiguous.`)
          process.exit(1)
        }
        zipSizes[name] = statSync(zipPath).size
        return
      }
      if (prevRelDir) {
        // 复用来源校验：声明了 --expect-prev 时，来源版本必须一致——否则本地缺该版本
        // 会静默复用更老的包（2026.09.12.1 事故根因），此处直接报错停止。
        if (EXPECT_PREV && prevLabel !== EXPECT_PREV) {
          console.error(`  [Error] --expect-prev ${EXPECT_PREV} but local prev release is ${prevLabel}.`)
          console.error(`          Fetch that version's component zips into dist/release/${EXPECT_PREV}/ first`)
          console.error(`          (or omit --expect-prev if a full build is intended).`)
          process.exit(1)
        }
        const prevZip = join(prevRelDir, `${name}.zip`)
        if (existsSync(prevZip)) {
          // 复用 zip 的完整性校验：zip 实际字节数必须与来源 manifest 记录的 size 一致
          // （manifest 的 size = zip 字节数）。挡住半途替换/损坏的脏包。
          const prevManifest = readJsonSafe(join(prevRelDir, 'manifest.json'))
          const recSize = prevManifest?.components?.[name]?.size
          const recSha = prevManifest?.components?.[name]?.sha256
          const zipSize = statSync(prevZip).size
          if (typeof recSize === 'number' && recSize !== zipSize) {
            console.error(`  [Error] ${name}.zip in ${prevLabel} is ${zipSize} bytes but manifest records ${recSize}.`)
            console.error(`          Refusing to reuse a mismatched component zip.`)
            process.exit(1)
          }
          if (recSha) reusedSha[name] = recSha
          copyFileSync(prevZip, zipPath)
          zipSizes[name] = statSync(zipPath).size
          console.log(`  ${name}.zip (reused from ${prevLabel})`)
          return
        }
      }
    }
    if (PLATFORM === 'macos') {
      // macOS: 目录组件用 ditto 打 zip——保留 symlink/权限（python framework 的
      //  symlink 不被解引用）。仅 gui 用 --keepParent（prepare_gui_update_mac
      //  walkdir_find 找顶层 Claude Code.app/）；其他目录组件必须内容入 zip 根
      //（try_install copy_dir_recursive(temp_dir, dst) 有顶层会复制出双层目录）。
      // 单文件组件（claude/bun）无 symlink，zip -j 打根文件即可。
      const keepParent = name === 'gui' ? ['--keepParent'] : []
      const run = src.kind === 'dir'
        ? spawnSync(['ditto', '-c', '-k', '--sequesterRsrc', ...keepParent, srcPath, zipPath], { cwd: DIST })
        : spawnSync(['zip', '-j', '-q', zipPath, srcPath], { cwd: DIST })
      if (run.exitCode !== 0) {
        console.error(`  [Error] zip failed for ${name}:`, run.stderr.toString())
        process.exit(1)
      }
    } else {
      const arg = src.kind === 'file' ? srcPath : `${srcPath}\\*`
      spawnSync(['powershell', '-NoProfile', '-Command',
        `Compress-Archive -Path '${arg}' -DestinationPath '${zipPath}' -Force`], { cwd: DIST })
    }
    const zipSize = statSync(zipPath).size
    zipSizes[name] = zipSize
    console.log(`  ${name}.zip (${Math.round(zipSize / 1024)} KB)`)
  }

  for (const [name, src] of Object.entries(manifestSources)) compress(name, src)

  // 回填 Manifest 各组件 size 为实际压缩 zip 字节数（目录组件在 848-852 处用 dirSize
  // 未压缩目录总大小，虚标数倍）。zip 此刻已全部生成，逐一改写 manifest 对象并重写
  // 三个副本：release/<ver>/、dist/、.app/Contents/MacOS/（mac 内嵌）。
  // 复用组件的 sha 同时覆盖为来源 manifest 的值（见 reusedSha 注释）——不能沿用
  // dist/ 源文件算出的 hash。
  let manifestRewritten = false
  for (const name of Object.keys(manifestComponents)) {
    if (zipSizes[name] !== undefined && manifestComponents[name] && typeof manifestComponents[name] === 'object') {
      ;(manifestComponents[name] as { size: number }).size = zipSizes[name]
      if (reusedSha[name]) {
        ;(manifestComponents[name] as { sha256: string }).sha256 = reusedSha[name]
        console.log(`  [manifest] ${name}: sha kept from reused zip (${reusedSha[name].slice(0, 16)})`)
      }
      manifestRewritten = true
    }
  }
  if (manifestRewritten) {
    writeFileSync(join(RELEASE_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    copyFileSync(join(RELEASE_DIR, 'manifest.json'), join(DIST, 'manifest.json'))
    if (PLATFORM === 'macos') {
      copyFileSync(join(RELEASE_DIR, 'manifest.json'), join(DIST, 'Claude Code.app', 'Contents', 'MacOS', 'manifest.json'))
      console.log('  [fix] manifest size → zip actual size (re-embedded into .app)')
    } else {
      console.log('  [fix] manifest size → zip actual size')
    }
  }

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
