// ── 发布引擎 —— 组件无关的那一半 ──
//
// 这个文件只知道「dist/ 里有哪些产物」和「要打包哪几个组件」，**不知道**它们
// 是怎么造出来的（bun compile / cargo tauri build / 下载解包都由调用方负责）。
//
// 拆分目的（见 .scratch/repo-split/DESIGN.md）：让同一份引擎能同时存在于
// claude 仓和 GUI 仓，各管各的组件清单。因此本文件**不得** import 任何
// src/ 或 gui/ 下的代码 —— 只能依赖 node 内建 + Bun API。
//
// 从 scripts/build.ts 的 806-1160 行抽取，逻辑逐行保持，只把闭包变量改成参数。

import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'bun'
import type { Platform } from './componentPlan'
import { planComponents } from './componentPlan'

export interface ReleaseOptions {
  /** dist 根目录（绝对路径） */
  dist: string
  version: string
  /** --notes 原文（会与上一版累积拼接） */
  notes: string
  platform: Platform
  /** null = 全量；否则只构建列出的组件，其余复用上一版 zip */
  componentSet: Set<string> | null
  /** --expect-prev：声明上一发行版号，复用时强校验来源 */
  expectPrev: string | null
  /** 组件名 → 产物在 dist 下的位置与形态 */
  componentSources: Record<string, { kind: 'file' | 'dir'; path: string }>
  /**
   * macOS 专用钩子：把各组件嵌入 `Claude Code.app`。
   * 必须在 manifest 计算**之前**执行 —— gui 的 sha 是 .app 目录 hash，
   * 嵌入后才是最终形态（否则服务器 manifest 与完整 .app 不符，客户端永远提示要更新）。
   */
  beforeManifest?: () => void
}

/**
 * 生成 `dist/release/<version>/`：manifest.json + 各组件 zip。
 *
 * 幂等：同一版本重跑会复用已存在的 zip 及其 manifest 记录的 sha。
 */
export function generateRelease(opts: ReleaseOptions): void {
  const { dist: DIST, version, notes: NOTES, platform: PLATFORM } = opts
  const COMPONENT_SET = opts.componentSet
  const EXPECT_PREV = opts.expectPrev
  const componentSources = opts.componentSources

  const pad = (n: number) => String(n).padStart(2, '0')
  const now = new Date()
  const publishedAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z')

  // want(name): 产物该存在 —— 未选中时复用现有/上一版本
  const want = (name: string) => COMPONENT_SET === null || COMPONENT_SET.has(name)

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
  const readJsonSafe = (path: string): { components?: Record<string, { sha256?: string; size?: number }> } | null => {
    try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
  }

  // SHA256 for single files
  const sha256File = (path: string): string => {
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
  const dirMetaHash = (dir: string): string => {
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
  const dirSize = (dir: string): number => {
    if (!existsSync(dir)) return 0
    let total = 0
    for (const e of readdirSync(dir, { recursive: true })) {
      const p = join(dir, e.toString())
      try { total += statSync(p).size } catch {}
    }
    return total
  }

  const manifestSources = Object.fromEntries(
    Object.entries(componentSources).filter(([name]) => planActive.has(name)),
  )

  // macOS: 把全部组件合并进 Claude Code.app。由调用方通过 beforeManifest 注入
  // （它知道各组件在 dist 下的实际布局，引擎不应假定）。
  opts.beforeManifest?.()

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
    if (COMPONENT_SET === null) return null
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
}
