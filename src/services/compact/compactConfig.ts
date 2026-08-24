import { dirname, join } from 'path'
import { expandPath } from '../../utils/path.js'
import { getSettingsForSource } from '../../utils/settings/settings.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

/** 压缩时提取脚本的默认路径：随程序打包在 extensions/ 下（自建技能，非人人有 ~/.claude/skills）。 */
const EXE_DIR = dirname(process.execPath || process.cwd())
export const DEFAULT_EXTRACT_SCRIPT = join(
  EXE_DIR,
  'extensions',
  'handoff-compact',
  'scripts',
  'handoff_extract.py',
)

export interface CustomCompactPrompt {
  mode: 'append' | 'replace'
  text: string
}

/**
 * 实时读 GUI 配置块（settings.json 的 gui 键，reset 缓存后改配置立即生效）。
 * GUI 的 saveSettings 把配置持久化到 gui 键下，这里从同一位置读取。
 */
function readGuiSettings(): Record<string, unknown> | null {
  resetSettingsCache()
  const settings = getSettingsForSource('userSettings') as Record<
    string,
    unknown
  > | null
  const gui = settings?.['gui']
  return gui && typeof gui === 'object'
    ? (gui as Record<string, unknown>)
    : null
}

/** 解析 `customCompactPrompt` 原始值；返回 null = 未配置。 */
export function parseCustomCompactPrompt(
  raw: unknown,
): CustomCompactPrompt | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const text = typeof obj['text'] === 'string' ? obj['text'].trim() : ''
  if (!text) return null
  return { mode: obj['mode'] === 'replace' ? 'replace' : 'append', text }
}

/** 解析提取脚本路径；未配置/空返回 ""（不跑脚本，保持内置行为）；展开 ~ 前缀。 */
export function parseCompactExtractScript(raw: unknown): string {
  return typeof raw === 'string' && raw.trim() ? expandPath(raw.trim()) : ''
}

/**
 * 读自定义压缩提示词配置 `customCompactPrompt: { mode, text }`。
 * 返回 null 表示未配置（用纯内置提示词）。
 */
export function getCustomCompactPrompt(): CustomCompactPrompt | null {
  return parseCustomCompactPrompt(readGuiSettings()?.['customCompactPrompt'])
}

/**
 * 解析压缩时提取脚本路径。
 * - 键不存在（从未配置）→ 用打包脚本作为预设默认，开箱即用
 * - 显式留空（""）→ 保持"不跑脚本"逻辑（用户主动关闭）
 * - 其他 → 按配置解析（展开 ~）
 */
export function resolveCompactExtractScript(raw: unknown): string {
  if (raw === undefined || raw === null) return DEFAULT_EXTRACT_SCRIPT
  return parseCompactExtractScript(raw)
}

/** 读压缩时提取脚本路径；显式留空 = 不跑脚本。 */
export function getCompactExtractScript(): string {
  return resolveCompactExtractScript(readGuiSettings()?.['compactExtractScript'])
}

/** 脚本产物在 summary 中的占位符（模型输出留占位，代码替换为脚本产物）。 */
export const RAW_DATA_PLACEHOLDER = '{{RAW_DATA}}'

/**
 * 把脚本产物拼进 summary：含占位符则全部替换，否则追加到末尾。
 * 产物为空（未配置/失败/空脚本）时剥掉残留占位符，避免 {{RAW_DATA}} 漏进摘要。
 */
export function mergeExtractOutputIntoSummary(
  summary: string,
  extractOutput: string,
): string {
  const out = extractOutput.trim()
  if (!out) return summary.split(RAW_DATA_PLACEHOLDER).join('')
  if (summary.includes(RAW_DATA_PLACEHOLDER)) {
    return summary.split(RAW_DATA_PLACEHOLDER).join(out)
  }
  return `${summary}\n\n${out}`
}
