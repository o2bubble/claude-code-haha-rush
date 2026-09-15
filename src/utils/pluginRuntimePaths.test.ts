import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  aggregatePluginRuntimePaths, buildPathPrepend, pathSep, PLUGIN_PATH_PREPEND_VAR,
  scanPluginRuntimePaths,
} from './pluginRuntimePaths'
// Contract twin on the GUI side (PRD: 契约对称性测试 — 同一 manifest 两侧结果一致)
import {
  aggregateRuntimePaths as guiAggregate,
  parsePluginManifest as guiParse,
} from '../../gui/src/services/pluginRegistry.ts'

const manifest = (runtimes: unknown) => JSON.stringify({ pluginName: 'x', version: '1', runtimes })

describe('aggregatePluginRuntimePaths — contract twin of GUI aggregateRuntimePaths', () => {
  const base = 'C:/base'

  test('collects existing runtime dirs for enabled plugins', () => {
    // exists 只认 runtime 根（不认 bin）→ 只输出根
    const out = aggregatePluginRuntimePaths(
      [{ name: 'nodejs', manifestJson: manifest([{ id: 'node', path: 'runtime' }]) }],
      new Set(),
      p => p === `${base}/nodejs/runtime`,
      base,
    )
    expect(out).toEqual([`${base}/nodejs/runtime`])
  })

  test('excludes disabled plugins and missing dirs', () => {
    const out = aggregatePluginRuntimePaths(
      [
        { name: 'nodejs', manifestJson: manifest([{ id: 'node', path: 'runtime' }]) },
        { name: 'py', manifestJson: manifest([{ id: 'py', path: 'rt' }]) },
      ],
      new Set(['py']),
      () => false,
      base,
    )
    expect(out).toEqual([])
  })

  test('skips broken manifest JSON and non-relative paths', () => {
    const out = aggregatePluginRuntimePaths(
      [
        { name: 'bad', manifestJson: '{ not json' },
        { name: 'abs', manifestJson: manifest([{ id: 'a', path: 'C:/Windows' }]) },
        { name: 'up', manifestJson: manifest([{ id: 'u', path: '../x' }]) },
        { name: 'ok', manifestJson: manifest([{ id: 'o', path: 'runtime' }]) },
      ],
      new Set(),
      p => !p.endsWith('/bin'),
      base,
    )
    expect(out).toEqual([`${base}/ok/runtime`])
  })

  // ── 回归：mac/Linux 的 node 在 `runtime/bin/`，只注入根会找不到 node/npm/npx ──
  // 2026-09-14 修 PATH 时只改了 GUI 侧、漏了这里 → A 通道（启动自扫）仍只注入根
  // → mac 上重启 GUI 后裸 node/npm/npx 依旧 not found（playwright-mcp 起不来）。
  // 这组测试是那次漏改的直接防线。

  test('mac/Linux 布局：bin/ 存在时一并注入', () => {
    const out = aggregatePluginRuntimePaths(
      [{ name: 'nodejs', manifestJson: manifest([{ id: 'node', path: 'runtime' }]) }],
      new Set(),
      p => p === `${base}/nodejs/runtime` || p === `${base}/nodejs/runtime/bin`,
      base,
    )
    expect(out).toEqual([`${base}/nodejs/runtime`, `${base}/nodejs/runtime/bin`])
  })

  test('根不存在时不注入（不去试 bin）', () => {
    const out = aggregatePluginRuntimePaths(
      [{ name: 'nodejs', manifestJson: manifest([{ id: 'node', path: 'runtime' }]) }],
      new Set(),
      p => p.endsWith('/bin'),
      base,
    )
    expect(out).toEqual([])
  })

  test('声明已指向 bin 时不产生 bin/bin', () => {
    const out = aggregatePluginRuntimePaths(
      [{ name: 'a', manifestJson: manifest([{ id: 'x', path: 'runtime/bin' }]) }],
      new Set(),
      () => true,
      base,
    )
    expect(out).toEqual([`${base}/a/runtime/bin`])
  })

  test('deduplicates identical dirs', () => {
    const out = aggregatePluginRuntimePaths(
      [
        { name: 'a', manifestJson: manifest([{ id: 'x', path: 'shared' }]) },
        { name: 'b', manifestJson: manifest([{ id: 'y', path: 'shared' }]) },
      ],
      new Set(),
      p => !p.endsWith('/bin'),
      base,
    )
    expect(out).toEqual([`${base}/a/shared`, `${base}/b/shared`])
  })
})

describe('buildPathPrepend / pathSep', () => {
  test('joins with platform separator; undefined for empty', () => {
    expect(buildPathPrepend([])).toBeUndefined()
    const out = buildPathPrepend(['a', 'b'])!
    expect(out).toBe(`a${pathSep()}b`)
  })

  test('exports the canonical env var name', () => {
    expect(PLUGIN_PATH_PREPEND_VAR).toBe('CLAUDE_PLUGIN_PATH_PREPEND')
  })
})

describe('contract symmetry — GUI aggregateRuntimePaths vs claude aggregatePluginRuntimePaths', () => {
  // 同一 manifest 输入, 两侧聚合必须一致（PRD Testing Decisions: 契约对称性）。
  // 路径分隔统一 '/'（两侧都归一化）; base 同值。
  // 前提（真实安装约定）: 目录名 == pluginName（Rust install 按 pluginName 建目录）。
  const mk = (name: string, runtimes: unknown) =>
    JSON.stringify({ pluginName: name, version: '1', runtimes })
  const manifests = [
    { name: 'nodejs', manifestJson: mk('nodejs', [{ id: 'node', path: 'runtime' }]) },
    { name: 'py', manifestJson: mk('py', [{ id: 'py', path: 'rt' }]) },
    { name: 'bad', manifestJson: '{ not json' },
    { name: 'escape', manifestJson: mk('escape', [{ id: 'e', path: '../up' }]) },
    { name: 'empty', manifestJson: mk('empty', []) },
  ]
  const disabled = new Set(['py'])
  // 只认 runtime 根（不认 bin）：两侧都不产生 bin 条目，便于比对纯聚合逻辑
  const exists = (p: string) => p === `${base}/nodejs/runtime`
  const base = 'C:/base'

  test('same input → same output on both sides', () => {
    const claudeOut = aggregatePluginRuntimePaths(manifests, disabled, exists, base)
    const guiOut = guiAggregate(
      // GUI 侧收的是强类型 manifest 数组 — 从同一 JSON 经 GUI parser 构造
      manifests.map(m => {
        const parsed = guiParse(m.manifestJson ?? '{}', m.name)
        return parsed.ok ? parsed.manifest : null
      }).filter(Boolean),
      disabled, exists, base,
    )
    expect(claudeOut).toEqual([`${base}/nodejs/runtime`])
    expect(guiOut).toEqual(claudeOut)
  })

  test('stored prepend format is ";"-joined on both sides', () => {
    expect(pathSep()).toBe(';')
    expect(buildPathPrepend(['a', 'b'])).toBe('a;b')
  })
})

describe('scanPluginRuntimePaths — 单坏目录容错（真实 fs 临时目录）', () => {
  test('a dir without plugin.json skips only itself, others still register', () => {
    const base = mkdtempSync(join(tmpdir(), 'plugin-scan-'))
    try {
      // nodejs: 合法且 runtime 存在
      mkdirSync(join(base, 'nodejs', 'runtime'), { recursive: true })
      writeFileSync(join(base, 'nodejs', 'plugin.json'), JSON.stringify({
        pluginName: 'nodejs', version: '1', runtimes: [{ id: 'node', path: 'runtime' }],
      }))
      // brokendir: 没有 plugin.json（旧实现会因它整个扫描中止）
      mkdirSync(join(base, 'brokendir'), { recursive: true })
      // py: 合法但 runtime 目录不存在 → 跳过
      mkdirSync(join(base, 'py'), { recursive: true })
      writeFileSync(join(base, 'py', 'plugin.json'), JSON.stringify({
        pluginName: 'py', version: '1', runtimes: [{ id: 'py', path: 'rt' }],
      }))
      const out = scanPluginRuntimePaths(base)
      const expected = join(base, 'nodejs', 'runtime').split('\\').join('/')
      expect(out).toEqual([expected])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
