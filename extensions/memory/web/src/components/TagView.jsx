import { useState } from 'react';
import { useApp } from '../App';
import { useT } from '../lib/i18n';
import { normalizeTags } from '../lib/api';

export default function TagView() {
  const { t } = useT();
  const { state, dispatch, reloadTags } = useApp();
  const { tags, stats } = state;
  const [filter, setFilter] = useState('');
  const [normalizing, setNormalizing] = useState(false);

  const filtered = filter
    ? tags.filter((tg) => tg.tag.toLowerCase().includes(filter.toLowerCase()))
    : tags;

  const handleNormalize = async () => {
    const ok = confirm(t('tags.normalize') + '将以语义相似度 (≥0.85) 合并相似的标签。是否继续？');
    if (!ok) return;
    setNormalizing(true);
    try {
      await normalizeTags({ dry_run: false });
      reloadTags();
    } catch (e) {
      alert(e.message);
    } finally {
      setNormalizing(false);
    }
  };

  const handleTagClick = (tag) => {
    dispatch({ type: 'SET_FILTER', key: 'tags', value: [tag] });
    dispatch({ type: 'SET_VIEW', payload: 'list' });
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <input
          type="text"
          placeholder={t('tags.search')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ padding: '7px 10px', border: '1px solid #ddd', borderRadius: 'var(--radius-sm)', fontSize: 14, width: 240 }}
        />
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          {t('tags.count', { filtered: filtered.length, total: tags.length })}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--meta)', padding: 40 }}>
          {filter ? t('tags.empty') : t('tags.emptyAll')}
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 12,
        }}>
          {filtered.map((tg) => {
            const scopes = [...new Set(
              (state.memories || [])
                .filter((m) => (m.tags || []).includes(tg.tag))
                .map((m) => m.scope)
            )];
            return (
              <div
                key={tg.tag}
                onClick={() => handleTagClick(tg.tag)}
                style={{
                  background: 'var(--bg)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-lg)', padding: 16,
                  cursor: 'pointer', boxShadow: 'var(--elev-raised)',
                  transition: 'border-color var(--motion-fast)',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = ''; }}
              >
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--accent)', marginBottom: 6 }}>
                  {tg.tag}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--muted)' }}>
                  {t('tags.memoryCount', { count: tg.count })}
                </div>
                {scopes.length > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--meta)', marginTop: 4 }}>
                    {scopes.slice(0, 3).join(' · ')}{scopes.length > 3 ? ' …' : ''}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 24, display: 'flex', gap: 8 }}>
        <button className="ghost" onClick={handleNormalize} disabled={normalizing}>
          {normalizing ? t('tags.normalizing') : t('tags.normalize')}
        </button>
      </div>
    </div>
  );
}
