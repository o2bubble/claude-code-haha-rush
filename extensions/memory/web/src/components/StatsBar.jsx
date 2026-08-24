import { useApp } from '../App';
import { useT } from '../lib/i18n';

const TYPE_KEYS = { fact: 'stats.type.fact', experience: 'stats.type.experience', lesson: 'stats.type.lesson' };

export default function StatsBar() {
  const { t } = useT();
  const { state } = useApp();
  const { stats } = state;

  if (!stats) {
    return (
      <div style={{ padding: '8px 20px', borderBottom: '1px solid var(--border)', color: 'var(--muted)' }}>
        {t('stats.loading')}
      </div>
    );
  }

  const items = [
    { label: t('stats.memories'), value: stats.total_memories },
    { label: t('stats.tags'), value: stats.total_tags },
    { label: t('stats.edges'), value: stats.total_associations },
    { label: t('stats.size'), value: stats.db_size_kb ? `${(stats.db_size_kb / 1024).toFixed(1)} MB` : '-' },
  ];

  return (
    <div style={{
      padding: '8px 20px', borderBottom: '1px solid var(--border)',
      display: 'flex', gap: 20, alignItems: 'center', fontSize: 13, fontWeight: 500,
    }}>
      {items.map((item) => (
        <div key={item.label} style={{ display: 'flex', gap: 4, alignItems: 'baseline' }}>
          <span style={{
            color: 'var(--meta)', fontSize: 11, fontFamily: 'var(--font-mono)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
          }}>
            {item.label}
          </span>
          <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{item.value}</span>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
        {Object.entries(TYPE_KEYS).map(([type, key]) =>
          (stats.by_type?.[type] || 0) > 0 && (
            <span key={type} className={`badge badge--${type}`}>
              {t(key)} {stats.by_type[type]}
            </span>
          )
        )}
      </div>
    </div>
  );
}
