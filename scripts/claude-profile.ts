#!/usr/bin/env bun
/**
 * claude-profile — Manage API profiles per-project with user-default fallback
 *
 * Usage:
 *   claude-profile list                      List available profiles
 *   claude-profile create                    Create a new profile
 *   claude-profile switch <name>             Switch project-level profile
 *   claude-profile default <name>            Set user-default profile
 *   claude-profile <name>                    Switch shorthand (project)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { createInterface } from 'readline/promises'

const CLAUDE_DIR = join(homedir(), '.claude')
const PROFILES_DIR = join(CLAUDE_DIR, '.env.profiles')
const ACTIVE_FILE = join(CLAUDE_DIR, '.env.active')
const USER_PROFILE_ENV = join(CLAUDE_DIR, 'profile.env')
const USER_SETTINGS = join(homedir(), '.claude', 'settings.json')

const COMMON_DEFAULTS = [
  'API_TIMEOUT_MS=120000',
  'MAX_TOKENS=131072',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS=131072',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000',
  'DISABLE_TELEMETRY=1',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
  'CLAUDE_CODE_VIRTUAL_SCROLL_THRESHOLD=999999',
].join('\n')

/**
 * Profile-managed env keys — single source of truth shared with the GUI
 * (gui/src-tauri/src/lib.rs switch_model_profile / set_default_profile).
 * Keep in sync: scripts and Rust must clear/rewrite the same set so no
 * stale profile values survive in settings env files.
 */
const MANAGED_KEYS = [
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'API_TIMEOUT_MS', 'MAX_TOKENS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'DISABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_VIRTUAL_SCROLL_THRESHOLD',
]

// ── Paths ────────────────────────────────────────────────────────────────

function projectProfileEnv(): string {
  return join(process.cwd(), '.claude', 'profile.env')
}

function projectSettingsPath(): string {
  return join(process.cwd(), '.claude', 'settings.local.json')
}

function projectActiveMarker(): string {
  return join(process.cwd(), '.claude', 'active-profile')
}

function userProfileEnv(): string {
  return USER_PROFILE_ENV
}

function userActiveMarker(): string {
  return ACTIVE_FILE
}

// ── Helpers ──────────────────────────────────────────────────────────────

function rl() {
  return createInterface({ input: process.stdin, output: process.stdout })
}

function getActive(): string | null {
  try {
    return readFileSync(ACTIVE_FILE, 'utf-8').trim()
  } catch { return null }
}

function getProfiles(): { id: string; model: string }[] {
  if (!existsSync(PROFILES_DIR)) return []
  return readdirSync(PROFILES_DIR)
    .filter(f => f.endsWith('.env'))
    .map(f => {
      const id = f.slice(0, -4)
      const content = readFileSync(join(PROFILES_DIR, f), 'utf-8')
      const m = content.match(/^ANTHROPIC_MODEL=(.+)/m)
      return { id, model: m?.[1] ?? '' }
    })
}

/** Parse a profile .env file into a key-value record. */
function parseEnvFile(filePath: string): Record<string, string> {
  const content = readFileSync(filePath, 'utf-8')
  const vars: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx > 0) {
      const key = trimmed.slice(0, idx).trim()
      const val = trimmed.slice(idx + 1).trim()
      if (key) vars[key] = val
    }
  }
  return vars
}

/** Write env vars to a .env file at the given path. */
function writeEnvFile(env: Record<string, string>, targetPath: string): void {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`)
  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, lines.join('\n') + '\n', 'utf-8')
}

/** Read a .env file or return null. */
function readEnvFile(path: string): Record<string, string> | null {
  try {
    return existsSync(path) ? parseEnvFile(path) : null
  } catch { return null }
}

/** Read the `env` section from a settings JSON file, or null. */
function readSettingsEnv(path: string): Record<string, string> | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (raw && typeof raw === 'object' && raw.env && typeof raw.env === 'object') {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(raw.env)) {
        if (typeof v === 'string') out[k] = v
      }
      return out
    }
    return null
  } catch { return null }
}

/**
 * Rewrite the `env` section of a settings JSON file: clear all
 * profile-managed keys, then write the given vars, preserving every other
 * field (e.g. disabledMcpjsonServers) untouched.
 */
function writeSettingsEnv(path: string, vars: Record<string, string>): void {
  let settings: Record<string, any> = {}
  try { settings = JSON.parse(readFileSync(path, 'utf-8')) } catch { settings = {} }
  if (typeof settings !== 'object' || settings === null) settings = {}
  if (typeof settings.env !== 'object' || settings.env === null) settings.env = {}
  const envObj = settings.env as Record<string, any>
  for (const key of MANAGED_KEYS) delete envObj[key]
  for (const [k, v] of Object.entries(vars)) envObj[k] = v
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
}

/** Write the given profile id to a marker file (creating parent dirs). */
function writeMarker(path: string, profileId: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, profileId, 'utf-8')
}

// ── Commands ─────────────────────────────────────────────────────────────

function cmdList(): void {
  const active = getActive()
  const profiles = getProfiles()
  if (profiles.length === 0) {
    console.log('No profiles found in .env.profiles/')
    console.log("Use 'claude-profile create' to add a profile.")
    return
  }
  console.log('Available profiles:')
  for (const p of profiles) {
    const marker = p.id === active ? ' *' : '   '
    const model = p.model ? `  (${p.model})` : ''
    console.log(`${marker} ${p.id}${model}`)
  }
  // Show current active profile(s) — user default from settings.json,
  // project override from settings.local.json (both are what the engine consumes).
  const userEnv = readSettingsEnv(USER_SETTINGS) || readEnvFile(userProfileEnv())
  const projEnv = readSettingsEnv(projectSettingsPath()) || readEnvFile(projectProfileEnv())
  console.log()
  if (userEnv) {
    console.log(`User default: ${userEnv['ANTHROPIC_MODEL'] || userEnv['ANTHROPIC_BASE_URL'] || '(custom)'}`)
    console.log(`  ${USER_SETTINGS} env section`)
  }
  if (projEnv) {
    const label = projEnv['ANTHROPIC_MODEL'] || projEnv['ANTHROPIC_BASE_URL'] || '(custom)'
    console.log(`Project override: ${label}`)
    console.log(`  ${projectSettingsPath()}`)
  } else if (userEnv) {
    console.log(`Project: (using user default)`)
  } else {
    console.log('No active profile. Use claude-profile switch <name> or claude-profile default <name>.')
  }
}

function cmdSwitch(profileId: string): void {
  const profilePath = join(PROFILES_DIR, `${profileId}.env`)
  if (!existsSync(profilePath)) {
    console.error(`Error: Profile '${profileId}' not found.`)
    console.log()
    cmdList()
    process.exit(1)
  }

  const env = parseEnvFile(profilePath)
  // Write to every consumer: legacy profile.env (launcher --env-file),
  // settings.local.json env (engine), and both active markers.
  writeEnvFile(env, projectProfileEnv())
  writeSettingsEnv(projectSettingsPath(), env)
  writeMarker(projectActiveMarker(), profileId)
  writeMarker(userActiveMarker(), profileId)

  console.log(`Switched to profile: ${profileId} (project)`)
  console.log(`  \u2191 wrote ${projectProfileEnv()}`)
  console.log(`  \u2191 wrote ${projectSettingsPath()} env`)
  const model = env['ANTHROPIC_MODEL']
  if (model) console.log(`  Model: ${model}`)
  console.log('  Restart Claude Code or start a new session for changes to take effect.')
}

function cmdDefault(profileId: string): void {
  const profilePath = join(PROFILES_DIR, `${profileId}.env`)
  if (!existsSync(profilePath)) {
    console.error(`Error: Profile '${profileId}' not found.`)
    console.log()
    cmdList()
    process.exit(1)
  }

  const env = parseEnvFile(profilePath)
  // Write to every consumer: settings.json env (engine user-level source),
  // profile.env (launcher --env-file), and the user active marker.
  writeSettingsEnv(USER_SETTINGS, env)
  writeEnvFile(env, userProfileEnv())
  writeMarker(userActiveMarker(), profileId)

  console.log(`Set default profile: ${profileId} (user)`)
  console.log(`  \u2191 wrote env section to ${USER_SETTINGS}`)
  console.log(`  \u2191 wrote ${userProfileEnv()}`)
  const model = env['ANTHROPIC_MODEL']
  if (model) console.log(`  Model: ${model}`)
  console.log('  This will be used in projects without their own profile override.')
}

// ── Profile Creation ─────────────────────────────────────────────────────

interface ProviderTemplate {
  label: string
  profileName: string
  vars: Record<string, string>
  requiresToken: boolean
}

const TEMPLATES: Record<string, ProviderTemplate[]> = {
  '1': [
    {
      label: 'DeepSeek v4 Pro',
      profileName: 'deepseek-v4-pro',
      vars: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
      },
      requiresToken: true,
    },
    {
      label: 'DeepSeek v4 Flash',
      profileName: 'deepseek-v4-flash',
      vars: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_MODEL: 'deepseek-v4-flash',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
      },
      requiresToken: true,
    },
    {
      label: 'DeepSeek v4 Flash Vision',
      profileName: 'deepseek-v4-flash-vision-exp',
      vars: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_MODEL: 'deepseek-v4-flash-vision-exp',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash-vision-exp',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash-vision-exp',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash-vision-exp',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
      },
      requiresToken: true,
    },
  ],
  '2': [
    {
      label: 'DeepSeek v4 Flash',
      profileName: 'deepseek-v4-flash',
      vars: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_MODEL: 'deepseek-v4-flash',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
      },
      requiresToken: true,
    },
    {
      label: 'DeepSeek v4 Pro',
      profileName: 'deepseek-v4-pro',
      vars: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
      },
      requiresToken: true,
    },
    {
      label: 'DeepSeek v4 Flash Vision',
      profileName: 'deepseek-v4-flash-vision-exp',
      vars: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_MODEL: 'deepseek-v4-flash-vision-exp',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash-vision-exp',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash-vision-exp',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash-vision-exp',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
      },
      requiresToken: true,
    },
  ],
  '3': [
    {
      label: 'Qwen 3.6 Plus',
      profileName: 'qwen-3.6-plus',
      vars: {
        ANTHROPIC_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        ANTHROPIC_MODEL: 'qwen3.6-plus',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.6-plus',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.6-plus',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.6-plus',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '256000',
      },
      requiresToken: true,
    },
  ],
}

function renderEnvFile(description: string, vars: Record<string, string>, token?: string): string {
  const lines = [`# ${description}`]
  for (const [k, v] of Object.entries(vars)) {
    lines.push(`${k}=${token && k === 'ANTHROPIC_AUTH_TOKEN' ? token : v}`)
  }
  // Always write AUTH_TOKEN if provided, even if not in template vars
  if (token && !('ANTHROPIC_AUTH_TOKEN' in vars)) {
    lines.push(`ANTHROPIC_AUTH_TOKEN=${token}`)
  }
  lines.push('', COMMON_DEFAULTS)
  return lines.join('\n')
}

/** Ask a preset question with numbered choices + custom option. */
async function askPreset(
  prompt: ReturnType<typeof rl>,
  label: string,
  options: { label: string; value: string }[],
  defaultVal: string,
): Promise<string> {
  console.log()
  console.log(`${label}:`)
  for (let i = 0; i < options.length; i++) {
    const marker = options[i].value === defaultVal ? ' (default)' : ''
    console.log(`  [${i + 1}] ${options[i].label}${marker}`)
  }
  const choice = (await prompt.question(`Select [1-${options.length}]: `)).trim()
  const idx = parseInt(choice, 10) - 1
  if (idx >= 0 && idx < options.length) {
    const opt = options[idx]
    if (opt.value !== '') return opt.value
    // Custom: ask for value
    const custom = (await prompt.question(`  Enter custom value for ${label}: `)).trim()
    return custom || defaultVal
  }
  return defaultVal
}

async function cmdCreate(): Promise<void> {
  const prompt = rl()
  try {
    console.log('\n=== Create Profile ===\n')
    console.log('Templates:')
    console.log('  [1] DeepSeek v4 Pro/Flash/Vision (preset: only needs AUTH_TOKEN)')
    console.log('  [2] DeepSeek v4 Flash/Pro/Vision (preset: only needs AUTH_TOKEN)')
    console.log('  [3] Qwen 3.6 Plus     (preset: only needs AUTH_TOKEN)')
    console.log('  [4] Custom            (fill in all fields)')
    console.log()
    const choice = (await prompt.question('Choice (1/2/3/4): ')).trim()

    if (!['1', '2', '3', '4'].includes(choice)) {
      console.error('Invalid choice.')
      process.exit(1)
    }

    if (!existsSync(PROFILES_DIR)) mkdirSync(PROFILES_DIR, { recursive: true })

    if (choice === '4') {
      await cmdCreateCustom(prompt)
      return
    }

    // Preset templates (1-3)
    const templates = TEMPLATES[choice]
    if (!templates) { console.error('Invalid template'); process.exit(1) }

    console.log()
    console.log(`Templates: will create ${templates.map(t => t.profileName).join(', ')}`)
    console.log()

    let authToken = ''
    if (templates.some(t => t.requiresToken)) {
      authToken = (await prompt.question('ANTHROPIC_AUTH_TOKEN: ')).trim()
      if (!authToken) { console.error('ANTHROPIC_AUTH_TOKEN is required.'); process.exit(1) }
    }

    // Extra settings — MAX_TOKENS, MAX_CONTEXT, TIMEOUT
    const maxTokens = await askPreset(prompt, 'MAX_TOKENS (max output)', [
      { label: '64K', value: '65536' },
      { label: '128K', value: '131072' },
      { label: '256K', value: '262144' },
      { label: '384K', value: '393216' },
      { label: 'Custom', value: '' },
    ], '65536')
    const maxContext = await askPreset(prompt, 'MAX_CONTEXT (context window)', [
      { label: '128K', value: '128000' },
      { label: '256K', value: '256000' },
      { label: '512K', value: '512000' },
      { label: '1M', value: '1000000' },
      { label: 'Custom', value: '' },
    ], '1000000')
    const timeout = await askPreset(prompt, 'API_TIMEOUT_MS', [
      { label: '60s', value: '60000' },
      { label: '120s', value: '120000' },
      { label: '300s', value: '300000' },
      { label: 'Custom', value: '' },
    ], '120000')

    const extra: Record<string, string> = {}
    if (maxTokens) {
      extra.MAX_TOKENS = maxTokens
      extra.CLAUDE_CODE_MAX_OUTPUT_TOKENS = maxTokens
    }
    if (maxContext) extra.CLAUDE_CODE_MAX_CONTEXT_TOKENS = maxContext
    if (timeout) extra.API_TIMEOUT_MS = timeout

    for (const t of templates) {
      const ppath = join(PROFILES_DIR, `${t.profileName}.env`)
      if (existsSync(ppath)) {
        const ow = (await prompt.question(`Profile '${t.profileName}' already exists. Overwrite? (y/N): `)).trim().toLowerCase()
        if (ow !== 'y' && ow !== 'yes') {
          console.log(`  Skipped ${t.profileName}`)
          continue
        }
      }
      const content = renderEnvFile(`${t.profileName} (${t.label})`, { ...t.vars, ...extra }, authToken)
      writeFileSync(ppath, content, 'utf-8')
      console.log(`  Created ${t.profileName}`)
    }

    console.log()
    const active = getActive()
    if (!active) {
      await cmdSwitch(templates[0].profileName)
    } else {
      console.log("Use 'claude-profile switch <name>' to activate.")
    }
  } finally {
    prompt.close()
  }
}

async function cmdCreateCustom(prompt: ReturnType<typeof rl>): Promise<void> {
  const profileName = (await prompt.question('Profile name: ')).trim()
  if (!profileName) { console.error('Profile name is required.'); process.exit(1) }

  const ppath = join(PROFILES_DIR, `${profileName}.env`)
  if (existsSync(ppath)) {
    const ow = (await prompt.question(`Profile '${profileName}' already exists. Overwrite? (y/N): `)).trim().toLowerCase()
    if (ow !== 'y' && ow !== 'yes') { console.log('Cancelled.'); return }
  }

  console.log()
  console.log('Custom profile — fill in the following fields:')
  console.log('  (press Enter to skip optional fields)')
  console.log()

  const authToken = (await prompt.question('ANTHROPIC_AUTH_TOKEN: ')).trim()
  if (!authToken) { console.error('ANTHROPIC_AUTH_TOKEN is required.'); process.exit(1) }

  const baseUrl = (await prompt.question('ANTHROPIC_BASE_URL: ')).trim()
  const model = (await prompt.question('ANTHROPIC_MODEL: ')).trim()
  const sonnetModel = (await prompt.question('ANTHROPIC_DEFAULT_SONNET_MODEL: ')).trim()
  const haikuModel = (await prompt.question('ANTHROPIC_DEFAULT_HAIKU_MODEL: ')).trim()
  const opusModel = (await prompt.question('ANTHROPIC_DEFAULT_OPUS_MODEL: ')).trim()
  // Extra settings with presets
  const maxTokens = await askPreset(prompt, 'MAX_TOKENS (max output)', [
    { label: '64K', value: '65536' },
    { label: '128K', value: '131072' },
    { label: '256K', value: '262144' },
    { label: 'Custom', value: '' },
  ], '65536')
  const maxContext = await askPreset(prompt, 'MAX_CONTEXT (context window)', [
    { label: '128K', value: '128000' },
    { label: '256K', value: '256000' },
    { label: '512K', value: '512000' },
    { label: '1M', value: '1000000' },
    { label: 'Custom', value: '' },
  ], '1000000')
  const timeout = await askPreset(prompt, 'API_TIMEOUT_MS', [
    { label: '60s', value: '60000' },
    { label: '120s', value: '120000' },
    { label: '300s', value: '300000' },
    { label: 'Custom', value: '' },
  ], '120000')

  const vars: Record<string, string> = {}
  vars.ANTHROPIC_AUTH_TOKEN = authToken
  if (baseUrl) vars.ANTHROPIC_BASE_URL = baseUrl
  if (model) vars.ANTHROPIC_MODEL = model
  if (sonnetModel) vars.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetModel
  if (haikuModel) vars.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuModel
  if (opusModel) vars.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel
  if (maxTokens) {
    vars.MAX_TOKENS = maxTokens
    vars.CLAUDE_CODE_MAX_OUTPUT_TOKENS = maxTokens
  }
  vars.CLAUDE_CODE_MAX_CONTEXT_TOKENS = maxContext
  if (timeout) vars.API_TIMEOUT_MS = timeout

  const content = renderEnvFile(`${profileName} (custom)`, vars)
  writeFileSync(ppath, content, 'utf-8')

  const active = getActive()
  if (!active) {
    await cmdSwitch(profileName)
  } else {
    console.log(`Profile created: ${profileName}`)
    console.log("Use 'claude-profile switch ${profileName}' to activate it.")
  }
}

function printUsage(): void {
  console.log('Usage:')
  console.log('  claude-profile list                      List available profiles')
  console.log('  claude-profile create                    Create a new profile')
  console.log('  claude-profile switch <name>             Switch project-level profile')
  console.log('  claude-profile default <name>             Set user-default profile')
  console.log('  claude-profile <name>                    Switch project-level profile (shorthand)')
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const cmd = args[0] ?? ''
  const arg = args[1] ?? ''

  switch (cmd) {
    case 'list':
      cmdList()
      break
    case 'switch':
      if (!arg) { printUsage(); console.log(); cmdList(); process.exit(1) }
      cmdSwitch(arg)
      break
    case 'default':
      if (!arg) { printUsage(); console.log(); cmdList(); process.exit(1) }
      cmdDefault(arg)
      break
    case 'create':
      await cmdCreate()
      break
    case 'help':
    case '--help':
    case '-h':
      printUsage()
      break
    default:
      if (cmd && existsSync(join(PROFILES_DIR, `${cmd}.env`))) {
        cmdSwitch(cmd)
      } else if (cmd) {
        console.error(`Unknown command: ${cmd}\n`)
        printUsage()
        process.exit(1)
      } else {
        printUsage()
        console.log()
        cmdList()
      }
  }
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
