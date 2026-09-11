import { useApp } from '../App';
import { useT } from '../lib/i18n';
import styles from '../App.module.css';

const TYPE_LABELS = { fact: 'sidebar.type.fact', experience: 'sidebar.type.experience', lesson: 'sidebar.type.lesson' };

export default function MemoryList() {
  const { t } = useT();
  const { state, selectMemory } = useApp();
  const { memories, loading, selectedMemory, view } = state;

  if (view !== 'list') return null;

  if (loading) {
    return <div style={{ flex: 1, padding: 16, color: 'var(--muted)' }}>{t('list.loading')}</div>;
  }

  if (memories.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--meta)', fontSize: 14,
      }}>
        {t('list.empty')}
      </div>
    );
  }

  return (
    <div className={styles.listArea}>
      {memories.map((m) => {
        const isSelected = selectedMemory && selectedMemory.id === m.id;
        return (
          <div
            key={m.id}
            className={`${styles.memCard} ${isSelected ? styles.selected : ''}`}
            onClick={() => selectMemory(m.id)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span className={`badge badge--${m.type}`}>{t(TYPE_LABELS[m.type] || m.type)}</span>
              <span style={{ fontWeight: 600, fontSize: 14 }}>{m.title}</span>
              {m.relevance !== undefined && m.relevance > 0 && (
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--meta)', fontFamily: 'var(--font-mono)' }} title="综合相关度">
                  {(m.relevance * 100).toFixed(0)}%
                </span>
              )}
            </div>
            {m.snippet && (
              <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 6, maxWidth: '56ch' }}>
                {m.snippet}
              </div>
            )}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {(m.tags || []).map((tg) => (
                <span key={tg} className="tag">{tg}</span>
              ))}
              {m.scope && m.scope !== 'global' && (
                <span style={{ fontSize: 11, color: 'var(--meta)' }}>{m.scope}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
