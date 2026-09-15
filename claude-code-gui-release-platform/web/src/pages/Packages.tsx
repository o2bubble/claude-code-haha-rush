import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { adminApi, formatTime, type PackageItem, type Paged } from '../api/client'

const PAGE_SIZE = 20

export default function Packages() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const type = params.get('type') ?? ''
  const sort = params.get('sort') ?? 'updated'
  const page = Math.max(1, Number(params.get('page') ?? 1))

  const [data, setData] = useState<Paged<PackageItem> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState(q)
  const [pending, setPending] = useState<PackageItem | null>(null)
  const [toast, setToast] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    adminApi
      .packages({ q, type, sort, page, page_size: PAGE_SIZE })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [q, type, sort, page])

  useEffect(load, [load])

  // 输入框与 URL 可能不同步（如从总览页带 q 跳进来）——同步一次
  useEffect(() => setSearch(q), [q])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 2600)
    return () => clearTimeout(t)
  }, [toast])

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    if (!('page' in patch)) next.delete('page') // 改筛选条件时回到第一页
    setParams(next)
  }

  const doDelete = async (pkg: PackageItem, purgeFiles: boolean) => {
    setPending(null)
    try {
      const res = await adminApi.deletePackage(pkg.slug, purgeFiles)
      setToast(
        purgeFiles
          ? `已删除 ${pkg.slug} 及其文件（${res.purged_files.length} 项）`
          : `已删除 ${pkg.slug} 的数据库记录`,
      )
      load()
    } catch (e) {
      setToast(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <>
      <div className="page-head">
        <h2>技能 / 插件包</h2>
        <span className="sub">{data ? `共 ${data.total} 个` : ''}</span>
      </div>

      <div className="page-body">
        <div className="toolbar">
          <input
            type="search"
            placeholder="搜索名称 / slug / 作者…"
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

          <select value={type} onChange={(e) => update({ type: e.target.value })}>
            <option value="">全部类型</option>
            <option value="skill">技能</option>
            <option value="plugin">插件</option>
          </select>

          <select value={sort} onChange={(e) => update({ sort: e.target.value })}>
            <option value="updated">按更新时间</option>
            <option value="created">按创建时间</option>
            <option value="download">按下载量</option>
            <option value="name">按名称</option>
          </select>

          <span className="spacer" />
          <button type="button" className="btn" onClick={load}>
            刷新
          </button>
        </div>

        {error && <div className="banner banner-error">加载失败：{error}</div>}

        {pending && (
          <div className="banner banner-warn">
            确认删除 <strong>{pending.slug}</strong>？
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => doDelete(pending, false)}
              >
                只删数据库记录
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => doDelete(pending, true)}
              >
                连磁盘文件一起删（不可恢复）
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setPending(null)}>
                取消
              </button>
            </div>
            <div style={{ marginTop: 6, fontSize: 11 }}>
              只删记录时，包目录与 zip/sig 会留在磁盘上成为不可达的孤儿文件。
            </div>
          </div>
        )}

        <div className="card card-flush">
          {loading ? (
            <div className="loading">加载中…</div>
          ) : !data || data.items.length === 0 ? (
            <div className="empty">没有匹配的包</div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th className="primary">名称</th>
                    <th>类型</th>
                    <th>版本</th>
                    <th>作者</th>
                    <th>技能数</th>
                    <th>下载</th>
                    <th>更新时间</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((pkg) => (
                    <tr key={pkg.slug}>
                      <td className="primary">
                        <div style={{ fontWeight: 500 }}>{pkg.name}</div>
                        <div className="mono" style={{ color: 'var(--fg-muted)', fontSize: 11 }}>
                          {pkg.slug}
                        </div>
                        {pkg.description && (
                          <div
                            className="clamp"
                            style={{ fontSize: 12, color: 'var(--fg-secondary)', marginTop: 2 }}
                          >
                            {pkg.description}
                          </div>
                        )}
                      </td>
                      <td className="nowrap">
                        <span className={`badge badge-${pkg.type}`}>
                          {pkg.type === 'skill' ? '技能' : '插件'}
                        </span>
                      </td>
                      <td className="mono nowrap">{pkg.version}</td>
                      <td className="nowrap">{pkg.author}</td>
                      <td className="num">{pkg.skill_count}</td>
                      <td className="num">{pkg.download_count}</td>
                      <td className="nowrap" style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>
                        {formatTime(pkg.updated_at)}
                      </td>
                      <td className="nowrap">
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => setPending(pkg)}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

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
