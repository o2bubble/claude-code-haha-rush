import { Fragment, useEffect, useState } from 'react'
import { adminApi, formatBytes, formatTime, type UpdateVersion } from '../api/client'

/**
 * 版本列表用表格而非大卡片：服务器上最多留 3 版，卡片形式会让每版里
 * 只有一行有效信息、右侧整片留白。表格能横排比较（发布日期/组件数/体积），
 * 明细收进可展开行。
 */
export default function Updates() {
  const [platform, setPlatform] = useState<'windows' | 'macos'>('windows')
  const [versions, setVersions] = useState<UpdateVersion[]>([])
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError('')
    setExpanded(null)
    adminApi
      .versions(platform)
      .then((d) => {
        setVersions(d.versions)
        setNote(d.note)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [platform])

  const toggle = (version: string) =>
    setExpanded((cur) => (cur === version ? null : version))

  return (
    <>
      <div className="page-head">
        <h2>程序更新</h2>
        <span className="sub">{note}</span>
      </div>

      <div className="page-body">
        <div className="toolbar">
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value as 'windows' | 'macos')}
          >
            <option value="windows">Windows</option>
            <option value="macos">macOS</option>
          </select>
          <span className="spacer" />
          <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--fg-muted)' }}>
            共 {versions.length} 个版本
          </span>
        </div>

        {error && <div className="banner banner-error">加载失败：{error}</div>}

        <div className="card card-flush">
          {loading ? (
            <div className="loading">加载中…</div>
          ) : versions.length === 0 ? (
            <div className="empty">该平台暂无已发布的版本</div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th className="primary">版本</th>
                    <th>发布日期</th>
                    <th>组件</th>
                    <th>总体积</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v, idx) => {
                    const open = expanded === v.version
                    const names = Object.keys(v.components)
                    return (
                      <Fragment key={v.version}>
                        <tr
                          onClick={() => toggle(v.version)}
                          style={{ cursor: 'pointer' }}
                        >
                          <td className="primary">
                            <span className="mono" style={{ fontSize: 14, fontWeight: 600 }}>
                              {v.version}
                            </span>
                            {idx === 0 && (
                              <span
                                className="badge"
                                style={{
                                  marginLeft: 8,
                                  background: 'var(--semantic-success-subtle)',
                                  color: 'var(--semantic-success)',
                                }}
                              >
                                最新
                              </span>
                            )}
                          </td>
                          <td className="nowrap" style={{ color: 'var(--fg-secondary)' }}>
                            {formatTime(v.published_at)}
                          </td>
                          <td className="nowrap" style={{ color: 'var(--fg-secondary)' }}>
                            {names.length} 个
                          </td>
                          <td className="num">{formatBytes(v.total_size)}</td>
                          <td className="nowrap" style={{ color: 'var(--fg-muted)' }}>
                            {open ? '▾' : '▸'}
                          </td>
                        </tr>

                        {open && (
                          <tr>
                            <td colSpan={5} style={{ background: 'var(--bg-surface)' }}>
                              <div style={{ padding: 'var(--sp-2) 0' }}>
                                <div className="section-title" style={{ marginBottom: 'var(--sp-3)' }}>
                                  组件明细
                                </div>
                                <div
                                  style={{
                                    display: 'flex',
                                    gap: 'var(--sp-2)',
                                    flexWrap: 'wrap',
                                    marginBottom: v.release_notes ? 'var(--sp-5)' : 0,
                                  }}
                                >
                                  {names.map((name) => (
                                    <span
                                      key={name}
                                      className="badge"
                                      style={{
                                        background: 'var(--bg-hover)',
                                        color: 'var(--fg-secondary)',
                                        fontFamily: 'var(--font-mono)',
                                        fontWeight: 400,
                                        padding: '3px 10px',
                                      }}
                                    >
                                      {name} · {formatBytes(v.components[name])}
                                    </span>
                                  ))}
                                </div>

                                {v.release_notes && (
                                  <>
                                    <div className="section-title" style={{ marginBottom: 'var(--sp-3)' }}>
                                      更新说明
                                    </div>
                                    <div
                                      style={{
                                        whiteSpace: 'pre-wrap',
                                        fontSize: 'var(--fs-base)',
                                        lineHeight: 1.7,
                                        color: 'var(--fg-secondary)',
                                        maxWidth: 760,
                                      }}
                                    >
                                      {v.release_notes}
                                    </div>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
