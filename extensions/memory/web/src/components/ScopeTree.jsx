import { useState, useMemo } from 'react';
import { useApp } from '../App';
import { useT } from '../lib/i18n';
import styles from '../App.module.css';

function buildTree(scopes) {
  const root = {};
  for (const [scope, count] of Object.entries(scopes)) {
    if (!scope || scope === 'global') continue;
    const parts = scope.split(':');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!node[p]) node[p] = { __count: 0, __children: {} };
      if (i === parts.length - 1) node[p].__count = count;
      node = node[p].__children;
    }
  }
  return root;
}

function TreeNode({ name, node, path, depth, onSelect, activeScope }) {
  const [open, setOpen] = useState(depth === 0);
  const children = Object.keys(node.__children || {});
  const scopePath = path ? `${path}:${name}` : name;

  return (
    <div>
      <div
        className={`${styles.sbRow} ${activeScope === scopePath ? styles.active : ''}`}
        style={{ paddingLeft: depth * 12 }}
        onClick={() => {
          if (children.length > 0) {
            setOpen(!open);
          } else {
            onSelect(scopePath);
          }
        }}
      >
        <span style={{ fontSize: 11 }}>{open && children.length > 0 ? '▾' : children.length > 0 ? '▸' : ' '}</span>
        <span>{name}</span>
        {node.__count > 0 && (
          <span className="cnt" style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--meta)' }}>
            {node.__count}
          </span>
        )}
      </div>
      {open &&
        children.map((child) => (
          <TreeNode
            key={child}
            name={child}
            node={node.__children[child]}
            path={scopePath}
            depth={depth + 1}
            onSelect={onSelect}
            activeScope={activeScope}
          />
        ))}
    </div>
  );
}

export default function ScopeTree() {
  const { t } = useT();
  const { state, dispatch } = useApp();
  const { stats } = state;

  const tree = useMemo(() => {
    if (!stats?.by_scope) return {};
    return buildTree(stats.by_scope);
  }, [stats?.by_scope]);

  const globalCount = stats?.by_scope?.global || 0;

  return (
    <div>
      {globalCount > 0 && (
        <div
          className={`${styles.sbRow} ${state.filters.scope === 'global' ? styles.active : ''}`}
          onClick={() => dispatch({ type: 'SET_FILTER', key: 'scope', value: '' })}
        >
          <span>{t('scope.global')}</span>
          <span className="cnt" style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--meta)' }}>
            {globalCount}
          </span>
        </div>
      )}
      {Object.keys(tree).map((name) => (
        <TreeNode
          key={name}
          name={name}
          node={tree[name]}
          path=""
          depth={0}
          onSelect={(scopePath) =>
            dispatch({ type: 'SET_FILTER', key: 'scope', value: state.filters.scope === scopePath ? '' : scopePath })
          }
          activeScope={state.filters.scope}
        />
      ))}
    </div>
  );
}
