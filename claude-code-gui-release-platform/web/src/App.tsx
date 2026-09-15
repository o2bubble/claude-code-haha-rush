import { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { adminApi, getToken, onUnauthorized } from './api/client'
import AdminLayout from './layout/AdminLayout'
import Login from './pages/Login'
import Overview from './pages/Overview'
import Packages from './pages/Packages'
import Feedback from './pages/Feedback'
import Updates from './pages/Updates'
import PublicFeedback from './pages/PublicFeedback'

/**
 * 后台挂载前缀，来自 vite 的 base（阶段 2 试探期是 /admin-next，正式是 /admin）。
 *
 * 刻意**不用** BrowserRouter 的 basename：公网反馈页 /feedback 是顶层路径，
 * 不在后台前缀之下，basename 会把它的路径判为不匹配。改成把 base 拼进路由表，
 * 两条路径各自独立匹配。
 */
const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')

export default function App() {
  const [authed, setAuthed] = useState(() => !!getToken())
  const [siteName, setSiteName] = useState('')

  useEffect(() => {
    onUnauthorized(() => setAuthed(false))
    // 实例标识是公开端点 —— 登录前也要显示「你正在登录哪一台」
    adminApi
      .site()
      .then((s) => setSiteName(s.site_name))
      .catch(() => {})
  }, [])

  return (
    <Routes>
      <Route path="/feedback" element={<PublicFeedback siteName={siteName} />} />

      {authed ? (
        <Route path={base} element={<AdminLayout siteName={siteName} />}>
          <Route index element={<Overview />} />
          <Route path="packages" element={<Packages />} />
          <Route path="feedback" element={<Feedback />} />
          <Route path="updates" element={<Updates />} />
          <Route path="*" element={<Navigate to={base || '/'} replace />} />
        </Route>
      ) : (
        // 未登录：**保留原 URL** 显示登录页（而不是重定向到 base）。
        // 这样深链 /admin/packages 登录后会自动落到 packages，而不是被甩回总览。
        <>
          <Route
            path={base || '/'}
            element={<Login siteName={siteName} onSuccess={() => setAuthed(true)} />}
          />
          {/* base 为空时（vite base 配成 "/"）不能写 `/*` —— 那会连 /feedback 一起吞掉 */}
          {base && (
            <Route
              path={`${base}/*`}
              element={<Login siteName={siteName} onSuccess={() => setAuthed(true)} />}
            />
          )}
        </>
      )}

      <Route path="*" element={<Navigate to={base || '/'} replace />} />
    </Routes>
  )
}
