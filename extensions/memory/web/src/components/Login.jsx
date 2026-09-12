import { useState, useEffect, useRef } from 'react';
import { useT } from '../lib/i18n';

// 密码在构建时由部署流程注入（VITE_MEMORY_PASSWORD）——仓库源码不含明文，
// 值见内部凭据记录。未配置时为空串并拒绝一切登录（fail-closed，防"空密码放行"）。
const PASSWORD = import.meta.env.VITE_MEMORY_PASSWORD || '';
const STORAGE_KEY = 'memory_web_auth';

export function isAuthenticated() {
  return !!PASSWORD && localStorage.getItem(STORAGE_KEY) === PASSWORD;
}

export default function Login({ onLogin }) {
  const { t } = useT();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d');

    const particles = Array.from({ length: 50 }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 2 + 1,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
    }));

    let raf;
    function animate() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,117,222,0.15)';
        ctx.fill();
      }
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 120) {
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(0,117,222,${0.06 * (1 - dist / 120)})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }
      raf = requestAnimationFrame(animate);
    }
    animate();

    const onResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    await new Promise((r) => setTimeout(r, 300));
    if (!PASSWORD) {
      // 构建时未注入 —— 明确提示，避免被误判为"输错密码"
      setError(t('login.notConfigured'));
    } else if (value === PASSWORD) {
      localStorage.setItem(STORAGE_KEY, PASSWORD);
      onLogin();
    } else {
      setError(t('login.error'));
      setValue('');
    }
    setLoading(false);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 90,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)',
    }}>
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, zIndex: 0 }} />
      <div style={{
        position: 'relative', zIndex: 1,
        width: 380, maxWidth: '90vw',
        background: 'var(--bg)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)', boxShadow: 'var(--elev-deep)',
        padding: 40, textAlign: 'center',
      }}>
        <h1 style={{
          fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 700,
          letterSpacing: '-0.02em', marginBottom: 6,
        }}>
          {t('login.title')}
        </h1>
        <p style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 24 }}>
          {t('login.subtitle')}
        </p>
        <form onSubmit={handleSubmit} autoComplete="off">
          <label htmlFor="loginPwd" style={{
            position: 'absolute', width: 1, height: 1,
            overflow: 'hidden', clip: 'rect(0,0,0,0)',
          }}>
            {t('login.password')}
          </label>
          <input
            id="loginPwd"
            type="password"
            placeholder={t('login.password')}
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(''); }}
            autoFocus
            style={{
              width: '100%', padding: '10px 14px',
              border: '1px solid #ddd', borderRadius: 'var(--radius-sm)',
              fontSize: 15, color: 'var(--fg)', textAlign: 'center',
              letterSpacing: 2,
            }}
          />
          <div style={{ color: 'var(--danger)', fontSize: 13, marginTop: 10, minHeight: 20 }}>
            {error}
          </div>
          <button
            type="submit"
            className="primary"
            disabled={loading || !value}
            style={{ marginTop: 16, width: '100%' }}
          >
            {loading ? t('login.loading') : t('login.button')}
          </button>
        </form>
      </div>
    </div>
  );
}
