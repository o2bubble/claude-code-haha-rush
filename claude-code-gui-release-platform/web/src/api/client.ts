/**
 * 后端 API 客户端。
 *
 * 认证：Bearer token 存 localStorage（不用 Cookie —— 后端 CORS 是
 * allow_origins=["*"] + credentials，Cookie 会立刻带来 CSRF 面，Bearer 头不会）。
 *
 * 401 统一处理：清 token 并通知上层回登录页（onUnauthorized）。
 */

const TOKEN_KEY = 'release-admin-token'

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* 隐私模式下 localStorage 可能不可用 —— 退化为本次会话内存态 */
  }
}

let unauthorizedHandler: (() => void) | null = null

/** 注册 401 回调（App 挂载时注册，用于跳回登录页）。 */
export function onUnauthorized(fn: () => void): void {
  unauthorizedHandler = fn
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const BASE = ''

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const resp = await fetch(BASE + path, { ...init, headers })

  if (resp.status === 401) {
    setToken('')
    unauthorizedHandler?.()
    throw new ApiError(401, '登录已失效，请重新登录')
  }

  const text = await resp.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }

  if (!resp.ok) {
    const detail =
      body && typeof body === 'object' && 'detail' in body
        ? String((body as { detail: unknown }).detail)
        : `HTTP ${resp.status}`
    throw new ApiError(resp.status, detail)
  }

  // 后端统一 {ok, data} 包装
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data
  }
  return body as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

// ── 类型（与后端 admin.py / models.py 的返回结构对应）──

export interface PackageItem {
  slug: string
  name: string
  description: string
  author: string
  version: string
  tags: string[]
  download_count: number
  skill_count: number
  type: 'skill' | 'plugin'
  created_at: string
  updated_at: string
}

export interface Paged<T> {
  items: T[]
  total: number
  page: number
  page_size: number
  pages: number
}

export interface FeedbackItem {
  id: number
  type: 'bug' | 'suggestion'
  message: string
  image_path: string | null
  app_version: string
  status: 'open' | 'in_progress' | 'resolved' | 'closed'
  created_at: string
  note: string
  updated_at: string
}

export interface UpdateVersion {
  version: string
  published_at: string
  release_notes: string
  components: Record<string, number>
  total_size: number
}

export interface Stats {
  site_name: string
  generated_at: string
  packages: {
    total: number
    by_type: Record<string, number>
    download_total: number
    skill_total: number
    top_downloads: Array<{ slug: string; name: string; type: string; download_count: number }>
    by_author: Array<{ author: string; c: number; dl: number }>
    zero_download: number
    recent_updated: Array<{ slug: string; name: string; type: string; version: string; updated_at: string }>
  }
  feedback: {
    total: number
    by_status: Record<string, number>
    by_type: Record<string, number>
    backlog: number
    with_image: number
    by_version: Array<{ version: string; c: number }>
    by_day: Array<{ day: string; c: number }>
    timezone: string
  }
  updates: {
    windows_versions: number
    macos_versions: number
    latest_windows: string | null
    latest_macos: string | null
    platforms_in_sync: boolean
    store_bytes: number
  }
}

export const adminApi = {
  login: (password: string) =>
    api.post<{ token: string; site_name: string }>('/api/admin/login', { password }),
  site: () => api.get<{ site_name: string }>('/api/admin/site'),
  stats: () => api.get<Stats>('/api/admin/stats'),
  packages: (params: Record<string, string | number>) =>
    api.get<Paged<PackageItem>>('/api/admin/packages?' + new URLSearchParams(
      Object.entries(params).reduce<Record<string, string>>((acc, [k, v]) => {
        if (v !== '' && v !== undefined && v !== null) acc[k] = String(v)
        return acc
      }, {}),
    )),
  deletePackage: (slug: string, purgeFiles: boolean) =>
    api.del<{ slug: string; purged_files: string[]; orphan_hint: string | null }>(
      `/api/admin/packages/${encodeURIComponent(slug)}?purge_files=${purgeFiles}`,
    ),
  feedback: (params: Record<string, string | number>) =>
    api.get<Paged<FeedbackItem>>('/api/admin/feedback?' + new URLSearchParams(
      Object.entries(params).reduce<Record<string, string>>((acc, [k, v]) => {
        if (v !== '' && v !== undefined && v !== null) acc[k] = String(v)
        return acc
      }, {}),
    )),
  updateFeedback: (id: number, body: { status?: string; note?: string }) =>
    api.patch<FeedbackItem>(`/api/admin/feedback/${id}`, body),
  versions: (platform: string) =>
    api.get<{ platform: string; versions: UpdateVersion[]; note: string }>(
      `/api/admin/updates/versions?platform=${platform}`,
    ),
}

/** 公开端点：反馈提交（无需认证） */
export async function submitFeedback(form: FormData): Promise<void> {
  const resp = await fetch('/api/feedback', { method: 'POST', body: form })
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`
    try {
      const body = await resp.json()
      if (body?.detail) detail = String(body.detail)
    } catch {
      /* 非 JSON 响应，保留状态码描述 */
    }
    throw new ApiError(resp.status, detail)
  }
}

// ── 展示辅助 ──

export function formatBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** 后端时间戳是 UTC（带 Z）—— 统一按 UTC 解析后再本地化显示。 */
export function formatTime(iso: string): string {
  if (!iso) return '-'
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z')
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
