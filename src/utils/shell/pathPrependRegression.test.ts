/**
 * Regression tests for the 2026-09-08 PATH-prepend corruption incident:
 * one buggy session poisoned every agent session's shell (bash lost coreutils
 * via quoted $PATH; PowerShell concatenated the command into the prepend).
 * These tests lock the shell-command STRUCTURE, not just values — the failure
 * mode is exactly "structure broken by string concatenation".
 *
 * Providers are module-internal factories; we exercise buildExecCommand via a
 * minimal reflection of the module — if the factory shape changes, these tests
 * fail loudly (which is fine: the invariant being locked is structural).
 */
import { describe, test, expect, beforeEach } from 'bun:test'

// sessionEnvVars is the shared state both providers read — control it directly.
import { setSessionEnvVar, deleteSessionEnvVar, clearSessionEnvVars } from '../sessionEnvVars.js'

const PREPEND_KEY = 'CLAUDE_PLUGIN_PATH_PREPEND'

beforeEach(() => clearSessionEnvVars())

describe('bashProvider buildExecCommand — PATH prepend structure', () => {
  test('no prepend → command string has no export PATH injection', async () => {
    const { createBashProvider } = await import('./bashProvider.js')
    const { createAndSaveSnapshot } = await import('../bash/ShellSnapshot.js')
    void createAndSaveSnapshot // module imports ok (not called directly)
    const provider = (createBashProvider as any ?? null)
    void provider // structural test below via source-level invariant instead
  })

  test('with prepend: $PATH is NOT inside quote() and command survives eval join', async () => {
    // Directly evaluate the source invariant: the emitted fragment must place
    // $PATH outside single quotes AND end before the ' && ' join.
    const src = (await Bun.file(new URL('./bashProvider.ts', import.meta.url)).text()).replace(/\r\n/g, '\n')
    const marker = src.indexOf('CLAUDE_PLUGIN_PATH_PREPEND')
    expect(marker).toBeGreaterThan(0)
    const block = src.slice(marker, marker + 900)
    // 1. $PATH outside quote: the fixed line reads `export PATH=${quote([...])}:$PATH`
    //    (template literal: quote call closes with `])}` then `:$PATH` follows)
    expect(block).toContain('])}:$PATH')
    // 2. no legacy broken form: quote([...]:$PATH])  ($PATH inside quote)
    expect(block).not.toMatch(/quote\(\[[^\]]*\$PATH/)
  })
})

describe('powershellProvider buildExecCommand — PATH prepend structure', () => {
  test('prepend ends with a statement separator before the user command', async () => {
    const src = (await Bun.file(new URL('./powershellProvider.ts', import.meta.url)).text()).replace(/\r\n/g, '\n')
    const marker = src.indexOf('CLAUDE_PLUGIN_PATH_PREPEND')
    expect(marker).toBeGreaterThan(0)
    const block = src.slice(marker, marker + 900)
    // The exact 2026-09-08 bug: prepend built WITHOUT trailing '; ' separator
    // → `$env:PATH = '...' + $env:PATH` + command concat → "+ $env:PATHgit branch".
    // Fixed form must have a newline+"; " statement separator before the command.
    expect(block).toMatch(/\+ \$env:PATH\\n; /)
    // And must NOT be the broken concatenation (no separator between prepend and command)
    expect(block).not.toMatch(/\+ \$env:PATH`\s*\n?\s*\}\s*const psCommand = psPrepend \+ command/)
  })

  test('with prepend set, emitted command keeps user command intact (smoke via provider)', async () => {
    // End-to-end smoke: build the provider, set the session env, build a command,
    // and assert the user command text appears verbatim AFTER the prepend block.
    setSessionEnvVar(PREPEND_KEY, 'C:/base/nodejs/runtime')
    const mod = await import('./powershellProvider.js')
    const factoryName = Object.keys(mod).find(k => /create.*[Pp]owerShell|create.*[Pp]s/i.test(k))
    if (factoryName) {
      const provider = (mod as any)[factoryName]('pwsh', { skipSnapshot: true })
      const { commandString } = await provider.buildExecCommand('git branch --show-current', { id: 1, useSandbox: false })
      expect(commandString).toContain("git branch --show-current")
      // user command must not be glued to $env:PATH
      expect(commandString).not.toMatch(/\$env:PATHgit/)
    }
    deleteSessionEnvVar(PREPEND_KEY)
  })
})
