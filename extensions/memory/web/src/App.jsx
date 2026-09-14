import { useState, useEffect, useCallback, useRef, createContext, useContext, useReducer } from 'react';
import { getStats, getMemories, getMemory, getTags } from './lib/api';
import { useDebounce } from './hooks/useDebounce';
import Sidebar from './components/Sidebar';
import StatsBar from './components/StatsBar';
import MemoryList from './components/MemoryList';
import MemoryDetail from './components/MemoryDetail';
import GraphView from './components/GraphView';
import TagView from './components/TagView';
import Login, { isAuthenticated } from './components/Login';
import { clearToken, getToken, onUnauthorized, verifyToken } from './lib/auth';
import ThemeToggle, { getTheme, applyTheme } from './components/ThemeToggle';
import { useT } from './lib/i18n';
import styles from './App.module.css';

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

const initialState = {
  stats: null,
  memories: [],
  total: 0,
  tags: [],
  selectedMemory: null,
  loading: false,
  showCreate: false,
  theme: getTheme(),
  view: 'list', // 'list' | 'graph' | 'tags'
  filters: {
    q: '',
    type: '',
    scope: '',
    tags: [],
    sort: 'newest',
  },
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_STATS':
      return { ...state, stats: action.payload };
    case 'SET_MEMORIES':
      return { ...state, memories: action.payload.items, total: action.payload.total };
    case 'SET_TAGS':
      return { ...state, tags: action.payload };
    case 'SET_SELECTED':
      return { ...state, selectedMemory: action.payload };
    case 'SET_LOADING':
      return { ...state, loading: action.payload };
    case 'SET_VIEW':
      return { ...state, view: action.payload };
    case 'SET_FILTER':
      return { ...state, filters: { ...state.filters, [action.key]: action.value } };
    case 'SET_SHOW_CREATE':
      return { ...state, showCreate: action.payload };
    case 'SET_THEME':
      return { ...state, theme: action.payload };
    case 'RESET_FILTERS':
      return { ...state, filters: initialState.filters };
    default:
      return state;
  }
}

export default function App() {
  const { t } = useT();
  const [state, dispatch] = useReducer(reducer, initialState);
  // 'checking' until the stored token is verified against the server. A token
  // merely *existing* in localStorage is not proof it is still accepted.
  const [authState, setAuthState] = useState(isAuthenticated() ? 'checking' : 'none');
  const debouncedQ = useDebounce(state.filters.q, 300);
  const requestId = useRef(0);
  const authenticated = authState === 'ok';

  // ── Hash routing ──────────────────────────────────────
  function getHash() {
    const h = window.location.hash.slice(1) || '/';
    const m = h.match(/^\/memory\/([a-f0-9-]+)$/);
    if (m) return { view: 'list', memoryId: m[1] };
    const v = { '/': 'list', '/graph': 'graph', '/tags': 'tags' };
    return { view: v[h] || 'list', memoryId: null };
  }

  // Init from hash
  useEffect(() => {
    const { view, memoryId } = getHash();
    if (view !== initialState.view) dispatch({ type: 'SET_VIEW', payload: view });
    if (memoryId) {
      getMemory(memoryId).then((m) => {
        dispatch({ type: 'SET_SELECTED', payload: m });
      }).catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // State → hash
  useEffect(() => {
    const base = state.view === 'graph' ? '#/graph' : state.view === 'tags' ? '#/tags' : '#/';
    const hash = state.selectedMemory
      ? `#/memory/${state.selectedMemory.id}`
      : base;
    if (window.location.hash !== hash) {
      window.history.replaceState(null, '', hash);
    }
  }, [state.view, state.selectedMemory?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen browser back/forward
  useEffect(() => {
    const onHashChange = () => {
      const { view, memoryId } = getHash();
      dispatch({ type: 'SET_VIEW', payload: view });
      if (memoryId) {
        getMemory(memoryId).then((m) => {
          dispatch({ type: 'SET_SELECTED', payload: m });
        }).catch(() => {});
      } else {
        dispatch({ type: 'SET_SELECTED', payload: null });
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // ── Data loading ──────────────────────────────────────

  const loadStats = useCallback(async () => {
    try {
      const s = await getStats();
      dispatch({ type: 'SET_STATS', payload: s });
    } catch (e) {
      console.error('stats:', e);
    }
  }, []);

  const loadMemories = useCallback(async () => {
    const id = ++requestId.current;
    dispatch({ type: 'SET_LOADING', payload: true });
    try {
      const params = { sort: state.filters.sort, limit: 50 };
      if (debouncedQ) {
        params.q = debouncedQ;
        params.mode = 'hybrid';
      }
      if (state.filters.type) params.type = state.filters.type;
      if (state.filters.scope) params.scope = state.filters.scope;
      if (state.filters.tags.length) params.tags = state.filters.tags;
      const m = await getMemories(params);
      if (id !== requestId.current) return; // stale response
      dispatch({ type: 'SET_MEMORIES', payload: m });
    } catch (e) {
      if (id !== requestId.current) return;
      console.error('memories:', e);
    } finally {
      if (id === requestId.current) dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [debouncedQ, state.filters]);

  const loadTags = useCallback(async () => {
    try {
      const t = await getTags();
      dispatch({ type: 'SET_TAGS', payload: t.tags || [] });
    } catch (e) {
      console.error('tags:', e);
    }
  }, []);

  const selectMemory = useCallback(async (id) => {
    try {
      const m = await getMemory(id);
      dispatch({ type: 'SET_SELECTED', payload: m });
    } catch (e) {
      console.error('getMemory:', e);
    }
  }, []);

  // Verify the stored token before showing the app. On failure, drop it so the
  // login gate renders instead of the app loading data it has no access to.
  useEffect(() => {
    if (authState !== 'checking') return;
    let cancelled = false;
    verifyToken(getToken()).then((ok) => {
      if (cancelled) return;
      if (!ok) clearToken();
      setAuthState(ok ? 'ok' : 'none');
    });
    return () => { cancelled = true; };
  }, [authState]);

  // Any 401 raised later (token rotated out from under us) returns to the gate.
  useEffect(() => onUnauthorized(() => setAuthState('none')), []);

  // Initial load — skipped until authenticated, otherwise every request 401s.
  useEffect(() => {
    if (!authenticated) return;
    loadStats();
    loadTags();
  }, [authenticated, loadStats, loadTags]);

  // Reload when filters change
  useEffect(() => {
    if (!authenticated) return;
    loadMemories();
  }, [authenticated, loadMemories]);

  const ctx = { state, dispatch, selectMemory, reloadMemories: loadMemories, reloadStats: loadStats, reloadTags: loadTags };

  if (authState === 'checking') {
    return null; // brief; avoids flashing the login form for a valid token
  }

  if (!authenticated) {
    return <Login onLogin={() => setAuthState('ok')} />;
  }

  return (
    <AppContext.Provider value={ctx}>
      <div className={styles.layout}>
        <Sidebar />
        <main className={styles.main}>
          <StatsBar />
          <div className={styles.viewToolbar}>
            <button
              className={state.view === 'list' ? 'primary' : ''}
              onClick={() => dispatch({ type: 'SET_VIEW', payload: 'list' })}
            >
              {t('view.list')}
            </button>
            <button
              className={state.view === 'graph' ? 'primary' : ''}
              onClick={() => dispatch({ type: 'SET_VIEW', payload: 'graph' })}
            >
              {t('view.graph')}
            </button>
            <button
              className={state.view === 'tags' ? 'primary' : ''}
              onClick={() => dispatch({ type: 'SET_VIEW', payload: 'tags' })}
            >
              {t('view.tags')}
            </button>
            <div style={{ flex: 1 }} />
            <ThemeToggle />
          </div>
          {state.view === 'list' && <MemoryList />}
          {state.view === 'graph' && <GraphView />}
          {state.view === 'tags' && <TagView />}
        </main>
        <aside className={`${styles.detail} ${!state.selectedMemory && !state.showCreate ? styles.hidden : ''}`}>
          <MemoryDetail />
        </aside>
      </div>
    </AppContext.Provider>
  );
}
