import { getInitialSettings } from '../settings/settings.js'

/**
 * Resolve the default shell for input-box `!` commands.
 *
 * Resolution order (docs/design/ps-shell-selection.md §4.2):
 *   settings.defaultShell → 'powershell' on Windows → 'bash'
 *
 * On Windows, defaults to PowerShell so users can leverage Windows-native
 * tooling without manual config. Override via settings.defaultShell.
 */
export function resolveDefaultShell(): 'bash' | 'powershell' {
  const fromSettings = getInitialSettings().defaultShell
  if (fromSettings) return fromSettings
  return process.platform === 'win32' ? 'powershell' : 'bash'
}
