import { useState, type FormEvent } from 'react'
import { adminApi, ApiError, setToken } from '../api/client'

/** 把后端英文 detail 映射成对用户有意义的话。 */
function friendly(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return '口令错误'
    if (err.status === 429) return '尝试过于频繁，请稍后再试'
    if (err.status === 503) return '服务端未配置 ADMIN_PASSWORD，请检查部署环境变量'
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

export default function Login({
  siteName,
  onSuccess,
}: {
  siteName: string
  onSuccess: () => void
}) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!password || loading) return
    setLoading(true)
    setError('')
    try {
      const res = await adminApi.login(password)
      setToken(res.token)
      onSuccess()
    } catch (err) {
      setError(friendly(err))
      setPassword('')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>发布平台管理</h1>
        <div className="sub">
          {siteName ? `实例：${siteName}` : '输入管理口令以继续'}
        </div>

        {error && <div className="banner banner-error">{error}</div>}

        <div className="field">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="管理口令"
            autoFocus
            autoComplete="current-password"
          />
        </div>

        <button type="submit" className="btn btn-primary" disabled={!password || loading}>
          {loading ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}
