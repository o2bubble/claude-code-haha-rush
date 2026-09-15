/**
 * Plugin runtime PATH registration (plugin-nodejs-runtime PRD, T3 channel A).
 *
 * Scans the GUI plugin directory for manifests declaring `runtimes` and exposes
 * the aggregated absolute dirs as a session-scoped PATH prepend that the shell
 * providers apply AFTER sourcing the shell snapshot (snapshot's `export PATH`
 * would otherwise clobber a PATH env override).
 *
 * Contract twin of gui/src/services/pluginRegistry.ts aggregateRuntimePaths —
 * both sides must resolve the same declaration the same way. Tolerant: missing
 * dir / broken manifest / wrong types are skipped silently (startup must never
 * fail because of a plugin).
 */
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

export const PLUGIN_PATH_PREPEND_VAR = 'CLAUDE_PLUGIN_PATH_PREPEND'

/**
 * GUI app data dir root for plugins — must mirror Tauri `app_data_dir()/plugins`
 * (identifier com.claudecode.gui): Windows %APPDATA%, macOS ~/Library/Application
 * Support, Linux $XDG_DATA_HOME|~/.local/share. Probes for the first existing;
 * falls back to the platform-canonical path (scan tolerates absence).
 */
export function pluginsBaseDir(): string {
  const id = 'com.claudecode.gui'
  const candidates: string[] = []
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, id))
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (home) {
    if (process.platform === 'darwin') candidates.push(join(home, 'Library', 'Application Support', id))
    if (process.platform === 'linux') {
      candidates.push(join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), id))
    }
    candidates.push(join(home, id))
  }
  for (const c of candidates) {
    const plugins = join(c, 'plugins')
    if (existsSync(plugins)) return plugins
  }
  return candidates.length > 0 ? join(candidates[0]!, 'plugins') : ''
}

function isRelativeInside(dir: string): boolean {
  if (/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(dir)) return false
  if (dir.split(/[\\/]/).includes('..')) return false
  return true
}

/** Pure: given (entries, disabled, existsFn, base) → absolute runtime dirs. */
export function aggregatePluginRuntimePaths(
  entries: Array<{ name: string; manifestJson?: string }>,
  disabledNames: ReadonlySet<string>,
  existsFn: (absPath: string) => boolean,
  base: string,
): string[] {
  const out: string[] = []
  for (const entry of entries) {
    if (disabledNames.has(entry.name)) continue
    if (!entry.manifestJson) continue
    let raw: unknown
    try {
      raw = JSON.parse(entry.manifestJson)
    } catch {
      continue
    }
    if (typeof raw !== 'object' || raw === null) continue
    const runtimes = (raw as Record<string, unknown>)['runtimes']
    if (!Array.isArray(runtimes)) continue
    for (const rt of runtimes) {
      if (typeof rt !== 'object' || rt === null) continue
      const id = (rt as Record<string, unknown>)['id']
      const path = (rt as Record<string, unknown>)['path']
      if (typeof id !== 'string' || !id) continue
      if (typeof path !== 'string' || !path) continue
      if (!isRelativeInside(path)) continue
      const abs = join(base, entry.name, path).replace(/\\/g, '/')
      if (!existsFn(abs)) continue

      // ⚠️ 声明目录 + 其 `bin/` 子目录**都注入**，让 node/npm/npx 在两种发行版
      // 布局下都能解析：
      //   · Windows 发行版：node.exe 在解压根          → `${abs}/node.exe` ✓
      //   · mac/Linux 发行版：Unix 惯例放 `bin/`        → `${abs}/bin/node` ✓
      //
      // **必须与 GUI 侧 `gui/src/services/pluginRegistry.ts` 的 aggregateRuntimePaths
      // 保持同一逻辑** —— 那两条通道（A 启动自扫 / B GUI 推送）覆盖同一个 PATH。
      // 2026-09-14 修 PATH 时**只改了 GUI 侧**，漏了这里 → A 通道仍只注入根 →
      // mac 上重启 GUI 后 node/npm/npx 依旧 not found（playwright-mcp 起不来）。
      //
      // 声明本身已以 `/bin` 结尾则不追加，防 `bin/bin`。
      if (!out.includes(abs)) out.push(abs)
      if (!abs.endsWith('/bin')) {
        const bin = `${abs}/bin`
        if (existsFn(bin) && !out.includes(bin)) out.push(bin)
      }
    }
  }
  return out
}

/**
 * Channel A: startup scan (I/O wrapper around the pure aggregator).
 * Returns the runtime dirs (empty when no plugins declare runtimes).
 * Per-plugin tolerance: a missing/broken plugin.json skips THAT plugin only —
 * one bad plugin must not abort registration for the rest.
 */
export function scanPluginRuntimePaths(
  base = pluginsBaseDir(),
  disabled: ReadonlySet<string> = new Set(),
): string[] {
  if (!base) return []
  let dirNames: string[] = []
  try {
    dirNames = readdirSync(base, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
  } catch {
    return [] // no plugins dir / unreadable — nothing to register
  }
  const entries: Array<{ name: string; manifestJson?: string }> = []
  for (const name of dirNames) {
    try {
      entries.push({ name, manifestJson: readFileSync(join(base, name, 'plugin.json'), 'utf8') })
    } catch {
      continue // missing/unreadable plugin.json — skip this plugin only
    }
  }
  return aggregatePluginRuntimePaths(entries, disabled, existsSync, base)
}

/**
 * Stored-format join: the session env var CLAUDE_PLUGIN_PATH_PREPEND holds dirs
 * joined with ';' — a LIST separator, not a PATH separator. Each consumer joins
 * with its own shell's PATH separator (bash ':', PowerShell ';', Rust process
 * spawn per-platform). Never use this value directly as a PATH.
 */
export function pathSep(): string {
  return ';' // stored-list separator (platform-independent)
}

/** Build the stored prepend value from dirs. */
export function buildPathPrepend(dirs: string[]): string | undefined {
  if (dirs.length === 0) return undefined
  return dirs.join(pathSep())
}
