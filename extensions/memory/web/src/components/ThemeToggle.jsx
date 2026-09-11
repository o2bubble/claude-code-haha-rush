import { useEffect } from 'react';
import { useApp } from '../App';
import { useT } from '../lib/i18n';

const STORAGE_KEY = 'memory_web_theme';

export function getTheme() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

export function applyTheme(mode) {
  if (mode === 'auto') {
    const system = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', system);
  } else {
    document.documentElement.setAttribute('data-theme', mode);
  }
}

const LABELS = { light: '☀', dark: '☾', auto: '◐' };
const ORDER = ['light', 'dark', 'auto'];

export default function ThemeToggle() {
  const { t } = useT();
  const { state, dispatch } = useApp();

  useEffect(() => {
    applyTheme(state.theme);
  }, [state.theme]);

  // Listen for system changes when in auto mode
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (state.theme === 'auto') applyTheme('auto');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [state.theme]);

  const cycle = () => {
    const idx = ORDER.indexOf(state.theme);
    const next = ORDER[(idx + 1) % 3];
    localStorage.setItem(STORAGE_KEY, next);
    dispatch({ type: 'SET_THEME', payload: next });
  };

  return (
    <button
      onClick={cycle}
      title={t('theme.' + state.theme)}
      style={{
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        padding: '4px 10px',
        fontSize: 16,
        lineHeight: 1,
        cursor: 'pointer',
        color: 'var(--muted)',
      }}
    >
      {LABELS[state.theme]}
    </button>
  );
}
