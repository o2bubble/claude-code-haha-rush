import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { useApp } from '../App';
import { useT } from '../lib/i18n';
import { useDebounce } from '../hooks/useDebounce';
import { getGraph } from '../lib/api';
import { renderGraph } from '../lib/d3-graph';
import styles from '../App.module.css';

export default function GraphView() {
  const { t } = useT();
  const { state, selectMemory } = useApp();
  const svgRef = useRef(null);
  const containerRef = useRef(null);
  const simRef = useRef(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  if (state.view !== 'graph') return null;

  const filters = state.filters;
  const debouncedQ = useDebounce(filters.q, 300);

  const activeFilters = useMemo(() => {
    const f = {};
    if (debouncedQ) f.q = debouncedQ;
    if (filters.type) f.type = filters.type;
    if (filters.scope) f.scope = filters.scope;
    if (filters.tags.length) f.tags = filters.tags;
    return f;
  }, [debouncedQ, filters.type, filters.scope, filters.tags]);

  const hasActiveFilters = Object.keys(activeFilters).length > 0;

  const updateSize = useCallback(() => {
    if (containerRef.current) {
      const { width, height } = containerRef.current.getBoundingClientRect();
      setSize({ width: Math.max(width, 400), height: Math.max(height, 400) });
    }
  }, []);

  useEffect(() => {
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, [updateSize]);

  useEffect(() => {
    let cancelled = false;
    load();

    async function load() {
      try {
        const data = await getGraph(undefined, undefined, hasActiveFilters ? activeFilters : null);
        if (cancelled || !svgRef.current) return;

        if (simRef.current) {
          simRef.current.stop();
        }

        const highlighted = data.highlighted_ids && data.highlighted_ids.length > 0
          ? new Set(data.highlighted_ids)
          : null;

        const cs = getComputedStyle(document.body);
        simRef.current = renderGraph(svgRef.current, {
          nodes: data.nodes || [],
          edges: data.edges || [],
          highlightedIds: highlighted,
          onNodeClick: selectMemory,
          getSize: () => size,
          colors: {
            typeColors: {
              fact: cs.getPropertyValue('--type-fact').trim(),
              experience: cs.getPropertyValue('--type-experience').trim(),
              lesson: cs.getPropertyValue('--type-lesson').trim(),
            },
            edgeColors: {
              related_to: cs.getPropertyValue('--edge-related').trim(),
              derived_from: cs.getPropertyValue('--edge-derived').trim(),
              contradicts: cs.getPropertyValue('--edge-contradicts').trim(),
              supports: cs.getPropertyValue('--edge-supports').trim(),
            },
            nodeStroke: cs.getPropertyValue('--bg').trim(),
            labelFill: cs.getPropertyValue('--fg').trim(),
          },
        });
      } catch (e) {
        console.error('graph:', e);
      }
    }

    return () => {
      cancelled = true;
      if (simRef.current) simRef.current.stop();
    };
  }, [size, selectMemory, hasActiveFilters, activeFilters]);

  return (
    <div
      ref={containerRef}
      className={`${styles.graphArea} ${state.view === 'graph' ? styles.show : ''}`}
      style={{ background: 'var(--bg)' }}
    >
      {/* Fullscreen button */}
      <button
        onClick={() => {
          const el = containerRef.current;
          if (!el) return;
          if (document.fullscreenElement) {
            document.exitFullscreen();
          } else {
            el.requestFullscreen();
          }
        }}
        style={{
          position: 'absolute', top: 12, right: 12, zIndex: 5,
          fontSize: 18, padding: '4px 8px', borderRadius: 'var(--radius-sm)',
          background: 'var(--bg)', border: '1px solid var(--border)',
          color: 'var(--muted)', cursor: 'pointer',
        }}
        title={t('graph.fullscreen')}
      >
        ⛶
      </button>
      <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
