import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { adminApi, formatBytes, formatTime, type Stats } from '../api/client'

const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')

function Bars({ items }: { items: Array<{ label: string; value: number }> }) {
  if (items.length === 0) return <div className="empty">暂无数据</div>
  const max = Math.max(...items.map((i) => i.value), 1)
  const allZero = items.every((i) => i.value === 0)
  return (
    <div className="bars">
      {items.map((it) => (
        <div className="bar-row" key={it.label}>
          <span className="bar-label" title={it.label}>
            {it.label}
          </span>
          {/* 0 值不画空轨道 —— 一整条灰色空格看起来像组件坏了，不如只留数值 */}
          {it.value === 0 ? (
            <span className="bar-track bar-track-empty" />
          ) : (
            <span className="bar-track">
              <span className="bar-fill" style={{ width: `${(it.value / max) * 100}%` }} />
            </span>
          )}
          <span className="bar-value">{it.value}</span>
        </div>
      ))}
      {allZero && (
        <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>全部为 0，暂无下载记录</div>
      )}
    </div>
  )
}

/** 后端只返回有反馈的日期；这里补零成连续 30 天，趋势才看得出来。分桶是 UTC。 */
function fillDays(byDay: Array<{ day: string; c: number }>, days = 30) {
  const map = new Map(byDay.map((d) => [d.day, d.c]))
  const now = new Date()
  const out: Array<{ day: string; c: number }> = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i))
    const key = d.toISOString().slice(0, 10)
    out.push({ day: key, c: map.get(key) ?? 0 })
  }
  return out
}

export default function Overview() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    adminApi
      .stats()
      .then(setStats)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  if (error) return <div className="page-body"><div className="banner banner-error">加载失败：{error}</div></div>
  if (!stats) return <div className="page-body"><div className="loading">加载中…</div></div>

  const p = stats.packages
  const f = stats.feedback
  const u = stats.updates
  const days = fillDays(f.by_day)
  const dayMax = Math.max(...days.map((d) => d.c), 1)

  return (
    <>
      <div className="page-head">
        <h2>总览</h2>
        <span className="sub">
          数据生成于 {formatTime(stats.generated_at)}（UTC 存储，本地时区显示）
        </span>
      </div>

      <div className="page-body">
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          <div className="card">
            <div className="stat-label">包总数</div>
            <div className="stat-value">{p.total}</div>
            <div className="stat-hint">
              技能 {p.by_type.skill ?? 0} · 插件 {p.by_type.plugin ?? 0}
            </div>
          </div>
          <div className="card">
            <div className="stat-label">累计下载</div>
            <div className="stat-value">{p.download_total}</div>
            <div className="stat-hint">
              含 {p.zero_download} 个从未下载的包
            </div>
          </div>
          <div className="card">
            <div className="stat-label">用户反馈</div>
            <div className="stat-value">{f.total}</div>
            <div className="stat-hint">
              待处理 {f.backlog} · 带图 {f.with_image}
            </div>
          </div>
          <div className="card">
            <div className="stat-label">最新版本</div>
            <div className="stat-value" style={{ fontSize: 18 }}>
              {u.latest_windows || '—'}
            </div>
            <div className="stat-hint">
              {u.platforms_in_sync ? (
                <span style={{ color: 'var(--semantic-success)' }}>macOS 已同步</span>
              ) : u.latest_macos ? (
                <span style={{ color: 'var(--semantic-warning)' }}>macOS 停在 {u.latest_macos}</span>
              ) : (
                <span style={{ color: 'var(--semantic-warning)' }}>macOS 尚无发布</span>
              )}
              {' · '}
              存储 {formatBytes(u.store_bytes)}
            </div>
          </div>
        </div>

        <div className="grid grid-2" style={{ marginBottom: 16 }}>
          <div className="card">
            <h3 className="section-title">下载排行（Top 10）</h3>
            <Bars
              items={p.top_downloads.map((t) => ({
                label: `${t.name}`,
                value: t.download_count,
              }))}
            />
          </div>

          <div className="card">
            <h3 className="section-title">反馈状态分布</h3>
            <Bars
              items={[
                { label: '待处理', value: f.by_status.open ?? 0 },
                { label: '处理中', value: f.by_status.in_progress ?? 0 },
                { label: '已解决', value: f.by_status.resolved ?? 0 },
                { label: '已关闭', value: f.by_status.closed ?? 0 },
              ]}
            />
            <h3 className="section-title" style={{ marginTop: 18 }}>按类型</h3>
            <Bars
              items={[
                { label: '问题反馈', value: f.by_type.bug ?? 0 },
                { label: '改进建议', value: f.by_type.suggestion ?? 0 },
              ]}
            />
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <h3 className="section-title">近 30 天反馈量（UTC 分桶）</h3>
          {f.total === 0 ? (
            <div className="empty">暂无数据</div>
          ) : (
            <>
              <div className="spark-wrap">
                {/* 中部参考线 + 峰值标注：只有柱子时无法判断"这天算多还是少"，
                    给一个刻度基准才能读出量级 */}
                <div className="spark-grid" style={{ bottom: '50%' }}>
                  <span>{Math.round(dayMax / 2)} 条</span>
                </div>
                <div className="sparkline">
                  {days.map((d) => (
                    <div
                      key={d.day}
                      // 0 值柱渲染成浅色「桩」，有值的柱用实色 ——
                      // 否则稀疏数据下整个图看着像一条虚线，读不出趋势
                      className={'bar' + (d.c === 0 ? ' zero' : '')}
                      style={{ height: `${Math.max((d.c / dayMax) * 100, d.c > 0 ? 8 : 3)}%` }}
                      title={`${d.day}（UTC）：${d.c} 条`}
                    />
                  ))}
                </div>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 11,
                  color: 'var(--fg-muted)',
                  marginTop: 6,
                }}
              >
                <span>{days[0]?.day}</span>
                <span>峰值 {dayMax} 条 / 天</span>
                <span>{days[days.length - 1]?.day}</span>
              </div>
            </>
          )}
        </div>

        <div className="grid grid-2">
          <div className="card">
            <h3 className="section-title">反馈集中的版本</h3>
            {f.by_version.length === 0 ? (
              <div className="empty">暂无数据</div>
            ) : (
              <Bars items={f.by_version.map((v) => ({ label: v.version, value: v.c }))} />
            )}
          </div>

          <div className="card">
            <h3 className="section-title">最近更新的包</h3>
            {p.recent_updated.length === 0 ? (
              <div className="empty">暂无数据</div>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {p.recent_updated.map((r) => (
                      <tr key={r.slug}>
                        <td>
                          <Link to={`${base}/packages?q=${encodeURIComponent(r.slug)}`}>
                            {r.name}
                          </Link>
                        </td>
                        <td>
                          <span className={`badge badge-${r.type}`}>{r.type}</span>
                        </td>
                        <td className="mono">{r.version}</td>
                        <td style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
                          {formatTime(r.updated_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <p style={{ marginTop: 20, fontSize: 11, color: 'var(--fg-muted)' }}>
          说明：下载量为累计计数器，没有按次记录，因此无法做下载趋势与逐版本下载统计；
          更新版本列表只保留服务器上最近 3 版，不是完整发布历史。
        </p>
      </div>
    </>
  )
}
