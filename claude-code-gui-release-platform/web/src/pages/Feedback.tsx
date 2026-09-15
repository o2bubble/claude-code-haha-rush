import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { adminApi, formatTime, type FeedbackItem, type Paged } from '../api/client'

const PAGE_SIZE = 20

const STATUS_LABEL: Record<string, string> = {
  open: '待处理',
  in_progress: '处理中',
  resolved: '已解决',
  closed: '已关闭',
}

function FeedbackCard({
  item,
  onUpdated,
  onError,
}: {
  item: FeedbackItem
  onUpdated: (fb: FeedbackItem) => void
  onError: (msg: string) => void
}) {
  const [status, setStatus] = useState(item.status)
  const [note, setNote] = useState(item.note ?? '')
  const [saving, setSaving] = useState(false)
  const [zoomed, setZoomed] = useState(false)

  const dirty = status !== item.status || note !== (item.note ?? '')

  const save = async () => {
    setSaving(true)
    try {
      const updated = await adminApi.updateFeedback(item.id, { status, note })
      onUpdated(updated)
    } catch (e) {
      onError(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={`card fb-card fb-${item.status}`} style={{ marginBottom: 'var(--sp-4)' }}>
      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
          marginBottom: 8,
          fontSize: 12,
          color: 'var(--fg-muted)',
        }}
      >
        <span className={`badge badge-${item.type}`}>
          {item.type === 'bug' ? '问题' : '建议'}
        </span>
        <span className="mono">#{item.id}</span>
        <span className="mono">{item.app_version || '未上报版本'}</span>
        <span>{formatTime(item.created_at)}</span>
        {item.updated_at && <span>· 更新于 {formatTime(item.updated_at)}</span>}
      </div>

      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, marginBottom: 10 }}>
        {item.message}
      </div>

      {item.image_path && (
        <>
          <img
            className="img-preview"
            src={`/api/feedback/images/${item.image_path}`}
            alt="反馈截图"
            onClick={() => setZoomed(true)}
            style={{ cursor: 'zoom-in', marginBottom: 10 }}
          />
          {zoomed && (
            <div
              onClick={() => setZoomed(false)}
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.85)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000,
                cursor: 'zoom-out',
                padding: 24,
              }}
            >
              <img
                src={`/api/feedback/images/${item.image_path}`}
                alt="反馈截图"
                style={{ maxWidth: '95vw', maxHeight: '95vh', borderRadius: 4 }}
              />
            </div>
          )}
        </>
      )}

      {/* 操作区：状态用**左侧色条**扫视（见 .fb-card），这里只放"改"的动作 ——
          再摆一个状态徽章会和下拉重复显示同一件事 */}
      <div
        style={{
          marginTop: 12,
          paddingTop: 12,
          borderTop: '1px solid var(--border-light)',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>状态</span>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as FeedbackItem['status'])}
        >
          {Object.entries(STATUS_LABEL).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="处理备注（可选，仅内部可见）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          // 限宽：flex:1 会让它在宽屏下长到近千像素，一行备注不需要那么长
          style={{ flex: '1 1 260px', maxWidth: 520, minWidth: 200 }}
        />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!dirty || saving}
          onClick={save}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}

export default function Feedback() {
  const [params, setParams] = useSearchParams()
  const status = params.get('status') ?? ''
  const type = params.get('type') ?? ''
  const q = params.get('q') ?? ''
  const page = Math.max(1, Number(params.get('page') ?? 1))

  const [data, setData] = useState<Paged<FeedbackItem> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState(q)
  const [toast, setToast] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    adminApi
      .feedback({ status, type, q, page, page_size: PAGE_SIZE })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [status, type, q, page])

  useEffect(load, [load])
  useEffect(() => setSearch(q), [q])

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    if (!('page' in patch)) next.delete('page')
    setParams(next)
  }

  const onUpdated = () => {
    setToast('已保存')
    load()
  }

  return (
    <>
      <div className="page-head">
        <h2>用户反馈</h2>
        <span className="sub">{data ? `共 ${data.total} 条` : ''}</span>
      </div>

      <div className="page-body">
        <div className="toolbar">
          <input
            type="search"
            placeholder="搜索内容 / 备注…"
            value={search}
            style={{ width: 240 }}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') update({ q: search })
            }}
          />
          <button type="button" className="btn" onClick={() => update({ q: search })}>
            搜索
          </button>

          <select value={status} onChange={(e) => update({ status: e.target.value })}>
            <option value="">全部状态</option>
            {Object.entries(STATUS_LABEL).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>

          <select value={type} onChange={(e) => update({ type: e.target.value })}>
            <option value="">全部类型</option>
            <option value="bug">问题</option>
            <option value="suggestion">建议</option>
          </select>

          <span className="spacer" />
          <button type="button" className="btn" onClick={load}>
            刷新
          </button>
        </div>

        {error && <div className="banner banner-error">加载失败：{error}</div>}

        {loading ? (
          <div className="loading">加载中…</div>
        ) : !data || data.items.length === 0 ? (
          <div className="empty">没有匹配的反馈</div>
        ) : (
          data.items.map((item) => (
            <FeedbackCard
              key={item.id}
              item={item}
              onUpdated={onUpdated}
              onError={setToast}
            />
          ))
        )}

        {data && data.pages > 1 && (
          <div className="pager">
            <button
              type="button"
              className="btn btn-sm"
              disabled={page <= 1}
              onClick={() => update({ page: String(page - 1) })}
            >
              上一页
            </button>
            <span>
              第 {data.page} / {data.pages} 页
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={page >= data.pages}
              onClick={() => update({ page: String(page + 1) })}
            >
              下一页
            </button>
          </div>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
