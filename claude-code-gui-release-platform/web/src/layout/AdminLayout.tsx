import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { setToken } from '../api/client'

const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')

const NAV = [
  { to: '', label: '总览', end: true },
  { to: 'packages', label: '技能 / 插件包', end: false },
  { to: 'feedback', label: '用户反馈', end: false },
  { to: 'updates', label: '程序更新', end: false },
]

export default function AdminLayout({ siteName }: { siteName: string }) {
  const navigate = useNavigate()

  const logout = () => {
    setToken('')
    navigate(0) // 重新挂载，清理各页面已拉取的缓存数据
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <h1>发布平台</h1>
          <span className="site">{siteName || '—'}</span>
        </div>

        <nav className="sidebar-nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to || 'index'}
              to={item.to ? `${base}/${item.to}` : base || '/'}
              end={item.end}
              className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot">
          <a href="/feedback" target="_blank" rel="noreferrer">
            公开反馈页 ↗
          </a>
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-sm" onClick={logout}>
              退出登录
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <Outlet context={{ siteName }} />
      </main>
    </div>
  )
}
