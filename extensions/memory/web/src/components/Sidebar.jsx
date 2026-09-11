import { useApp } from '../App';
import { useT } from '../lib/i18n';
import ScopeTree from './ScopeTree';
import styles from '../App.module.css';

const TYPES = [
  ['', 'sidebar.type.all'],
  ['fact', 'sidebar.type.fact'],
  ['experience', 'sidebar.type.experience'],
  ['lesson', 'sidebar.type.lesson'],
];

const hasActiveFilters = (filters) =>
  filters.q || filters.type || filters.scope || filters.tags.length > 0;

export default function Sidebar() {
  const { t } = useT();
  const { state, dispatch } = useApp();
  const { filters, tags, stats } = state;

  const topTags = tags.slice(0, 8);
  const totalMemories = stats?.total_memories || 0;
  const filtersActive = hasActiveFilters(filters);

  return (
    <nav className={styles.sidebar} aria-label="主导航">
      <div className={styles.sbSearch}>
        <input
          type="text"
          placeholder={t('sidebar.search')}
          value={filters.q}
          onChange={(e) => dispatch({ type: 'SET_FILTER', key: 'q', value: e.target.value })}
          autoComplete="off"
        />
        {filters.q && (
          <button
            className={styles.sbClearBtn}
            onClick={() => dispatch({ type: 'SET_FILTER', key: 'q', value: '' })}
            title={t('sidebar.clearSearch')}
          >
            ✕
          </button>
        )}
      </div>

      {filtersActive && (
        <div style={{ padding: '0 12px 8px' }}>
          <button
            onClick={() => dispatch({ type: 'RESET_FILTERS' })}
            style={{ fontSize: 11, padding: '3px 10px', width: '100%' }}
          >
            {t('sidebar.clearAll')}
          </button>
        </div>
      )}

      <div className={styles.sbSection}>
        <select
          value={filters.sort}
          onChange={(e) => dispatch({ type: 'SET_FILTER', key: 'sort', value: e.target.value })}
          style={{ width: '100%', marginBottom: 8, padding: '5px 8px', fontSize: 12 }}
        >
          <option value="newest">{t('sidebar.sort.newest')}</option>
          <option value="importance">{t('sidebar.sort.importance')}</option>
          <option value="access_count">{t('sidebar.sort.access')}</option>
        </select>
      </div>

      <div className={styles.sbSection}>
        <div className={styles.sbLabel}>{t('sidebar.types')}</div>
        {TYPES.map(([val, label]) => {
          const count = val ? (stats?.by_type?.[val] || 0) : totalMemories;
          return (
            <div
              key={val}
              className={`${styles.sbRow} ${filters.type === val ? styles.active : ''}`}
              onClick={() => dispatch({ type: 'SET_FILTER', key: 'type', value: filters.type === val ? '' : val })}
            >
              <span className="type-dot" style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: val === 'fact' ? 'var(--type-fact)' :
                            val === 'experience' ? 'var(--type-experience)' :
                            val === 'lesson' ? 'var(--type-lesson)' : 'var(--meta)',
              }} />
              <span>{t(label)}</span>
              <span className="cnt" style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--meta)' }}>
                {count}
              </span>
            </div>
          );
        })}
      </div>

      <div className={styles.sbSection}>
        <div className={styles.sbLabel}>{t('sidebar.scopes')}</div>
        <ScopeTree />
      </div>

      {topTags.length > 0 && (
        <div className={styles.sbTags}>
          <div className={styles.sbLabel}>{t('sidebar.tags')}</div>
          {topTags.map((t) => (
            <span
              key={t.tag}
              className={`${styles.sbTag} ${filters.tags.includes(t.tag) ? styles.active : ''}`}
              onClick={() => {
                const next = filters.tags.includes(t.tag) ? [] : [t.tag];
                dispatch({ type: 'SET_FILTER', key: 'tags', value: next });
              }}
            >
              {t.tag}
              <span style={{ fontSize: 10, marginLeft: 3, opacity: 0.7 }}>{t.count}</span>
            </span>
          ))}
          {tags.length > 8 && (
            <div style={{ marginTop: 6 }}>
              <a
                href="#"
                style={{ fontSize: 11, color: 'var(--accent)' }}
                onClick={(e) => {
                  e.preventDefault();
                  dispatch({ type: 'SET_VIEW', payload: 'tags' });
                }}
              >
                {t('sidebar.viewAllTags', { count: tags.length })}
              </a>
            </div>
          )}
        </div>
      )}

      <div className={styles.sbBottom}>
        <button
          className="primary"
          onClick={() => dispatch({ type: 'SET_SHOW_CREATE', payload: true })}
          style={{ width: '100%' }}
        >
          {t('sidebar.new')}
        </button>
        <div className={styles.sbStats}>
          {t('sidebar.statsFormat', { memories: totalMemories, tags: stats?.total_tags || 0, edges: stats?.total_associations || 0 })}
        </div>
      </div>
    </nav>
  );
}
