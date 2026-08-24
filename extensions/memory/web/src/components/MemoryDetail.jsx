import { useState } from 'react';
import { useApp } from '../App';
import { useT } from '../lib/i18n';
import { useEffect, useRef } from 'react';
import { createMemory, updateMemory, deleteMemory } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { renderSubGraph } from '../lib/d3-graph';
import ConfirmDialog from './ConfirmDialog';

const INITIAL = { type: 'fact', title: '', content: '', scope: 'global', tags: '', importance: 0.5 };
const TYPES = [
  ['fact', 'dialog.type.fact'],
  ['experience', 'dialog.type.experience'],
  ['lesson', 'dialog.type.lesson'],
];

export default function MemoryDetail() {
  const { t } = useT();
  const { state, dispatch, selectMemory, reloadMemories, reloadStats, reloadTags } = useApp();
  const { selectedMemory: m, showCreate } = state;
  const [editing, setEditing] = useState(!!showCreate);
  const [deleting, setDeleting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isNew = showCreate && !m;
  const [form, setForm] = useState(INITIAL);
  const [editingMemoryId, setEditingMemoryId] = useState(null);

  // Reset form when selected memory or showCreate changes
  useEffect(() => {
    if (showCreate) {
      setForm(INITIAL);
      setEditing(true);
      setEditingMemoryId(null);
    } else if (m) {
      setForm({
        type: m.type, title: m.title, content: m.content || '',
        scope: m.scope || 'global', tags: (m.tags || []).join(', '),
        importance: m.importance || 0.5,
      });
      setEditing(false);
      setEditingMemoryId(null);
    }
  }, [m?.id, showCreate]);

  const handleChange = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const data = {
        type: form.type,
        title: form.title,
        content: form.content,
        scope: form.scope,
        importance: form.importance,
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
      };
      if (isNew) {
        await createMemory(data);
      } else {
        await updateMemory(m.id, data);
      }
      reloadMemories();
      reloadStats();
      reloadTags();
      if (isNew) {
        dispatch({ type: 'SET_SHOW_CREATE', payload: false });
      }
      setEditing(false);
      if (m) {
        dispatch({ type: 'SET_SELECTED', payload: null });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteMemory(m.id);
      dispatch({ type: 'SET_SELECTED', payload: null });
      reloadMemories();
      reloadStats();
      reloadTags();
    } catch (err) {
      alert(err.message);
    } finally {
      setDeleting(false);
      setShowConfirm(false);
    }
  };

  const handleCancel = () => {
    if (isNew) {
      dispatch({ type: 'SET_SHOW_CREATE', payload: false });
    } else {
      setEditing(false);
      setForm({
        type: m.type, title: m.title, content: m.content || '',
        scope: m.scope || 'global', tags: (m.tags || []).join(', '),
        importance: m.importance || 0.5,
      });
    }
  };

  if (!m && !showCreate) return null;

  const formatDate = (s) => {
    if (!s) return '';
    try { return new Date(s).toLocaleString(); } catch { return s; }
  };

  const isReading = !editing && m;
  const isEditingForm = editing || isNew;
  const panelTitle = isNew ? t('dialog.newTitle') : (editing ? t('dialog.editTitle') : (m?.title || ''));

  return (
    <div style={{
      padding: 16, display: 'flex', flexDirection: 'column', height: '100%',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 8, margin: '-16px -16px 0',
      }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {panelTitle}
        </h3>
        <button
          onClick={() => {
            dispatch({ type: 'SET_SELECTED', payload: null });
            dispatch({ type: 'SET_SHOW_CREATE', payload: false });
          }}
          style={{ fontSize: 18, padding: 0, border: 'none', background: 'none', color: 'var(--muted)', lineHeight: 1 }}
          title={t('detail.close')}
        >
          ✕
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 16 }}>
        {/* Reading mode */}
        {isReading && (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
              <span className={`badge badge--${m.type}`}>{t(`sidebar.type.${m.type}`)}</span>
              {m.scope && m.scope !== 'global' && <span className="tag">{m.scope}</span>}
            </div>

            <div style={{ marginBottom: 12 }}>
              {(m.tags || []).map((tg) => (
                <span key={tg} className="tag" style={{ marginRight: 4, marginBottom: 4 }}>{tg}</span>
              ))}
            </div>

            <div style={{
              padding: 14, background: 'var(--surface)', borderRadius: 'var(--radius-md)',
              fontSize: 14, lineHeight: 1.6,
              marginBottom: 16, maxHeight: 240, overflowY: 'auto',
            }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) || t('detail.noContent') }}
            />

            {m.associations && m.associations.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div className="sbLabel" style={{ marginBottom: 8 }}>
                  {t('detail.associations', { count: m.associations.length })}
                </div>
                {m.associations.map((a, i) => (
                  <div key={i} style={{
                    fontSize: 13, padding: '7px 0',
                    borderBottom: '1px solid var(--border-soft)',
                    display: 'flex', alignItems: 'center', gap: 7,
                  }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background:
                        a.type === 'related_to' ? 'var(--edge-related)' :
                        a.type === 'derived_from' ? 'var(--edge-derived)' :
                        a.type === 'contradicts' ? 'var(--edge-contradicts)' : 'var(--edge-supports)',
                      flexShrink: 0,
                    }} />
                    <span style={{ color: 'var(--muted)', fontSize: 10 }}>{a.type}</span>
                    <span>{a.title || (a.target_id || a.source_id || '').slice(0, 8)}</span>
                    <span style={{ marginLeft: 'auto', color: 'var(--meta)', fontSize: 10 }}>
                      {(a.weight * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>
            )}

            {m.associations && m.associations.length > 0 && (
              <div
                ref={(el) => {
                  if (!el || !m || !m.associations) return;
                  if (el.clientWidth === 0 || el.clientHeight === 0) return;
                  const peerNodes = m.associations.map((a) => {
                    const peerId = a.direction === 'incoming' ? a.source_id : a.target_id;
                    return { id: peerId, title: a.title || '', type: 'fact' };
                  });
                  const allNodes = [{ id: m.id, title: m.title, type: m.type }, ...peerNodes];
                  const deduped = allNodes.filter((n, i, arr) => arr.findIndex((x) => x.id === n.id) === i);
                  const nodeIds = new Set(deduped.map((n) => n.id));
                  const edgeData = m.associations
                    .filter((a) => nodeIds.has(a.source_id) && nodeIds.has(a.target_id))
                    .map((a) => ({ source_id: a.source_id, target_id: a.target_id }));
                  if (edgeData.length === 0) return;
                  const cs = getComputedStyle(document.body);
                  renderSubGraph(el, {
                    nodes: deduped,
                    edges: edgeData,
                    onNodeClick: (id) => selectMemory && selectMemory(id),
                    colors: {
                      typeColors: {
                        fact: cs.getPropertyValue('--type-fact').trim(),
                        experience: cs.getPropertyValue('--type-experience').trim(),
                        lesson: cs.getPropertyValue('--type-lesson').trim(),
                      },
                      nodeStroke: cs.getPropertyValue('--border').trim(),
                      labelFill: cs.getPropertyValue('--muted').trim(),
                    },
                  });
                }}
                style={{
                  marginTop: 12, border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)', height: 140,
                }}
              />
            )}

            {(m.content_refs?.length > 0 || m.referenced_by?.length > 0) && (
              <div style={{ marginBottom: 16 }}>
                {m.content_refs?.length > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--meta)', marginBottom: 4 }}>
                    引用了: {m.content_refs.map((r) => r.title || r.id?.slice(0, 8)).join(', ')}
                  </div>
                )}
                {m.referenced_by?.length > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--meta)' }}>
                    被引用: {m.referenced_by.map((r) => r.title || r.id?.slice(0, 8)).join(', ')}
                  </div>
                )}
              </div>
            )}

            <div style={{ fontSize: 12, color: 'var(--meta)', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div>{t('detail.importance')}: {m.importance}</div>
              <div>{t('detail.accessed')}: {m.access_count} {t('detail.times')}</div>
              <div>{t('detail.created')}: {formatDate(m.created_at)}</div>
              <div>{t('detail.updated')}: {formatDate(m.updated_at)}</div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <button onClick={() => setEditing(true)} style={{ flex: 1 }}>{t('detail.edit')}</button>
              <button className="danger" onClick={() => setShowConfirm(true)} disabled={deleting} style={{ flex: 1 }}>
                {deleting ? t('detail.deleting') : t('detail.delete')}
              </button>
            </div>
          </>
        )}

        {/* Editing / Create form */}
        {isEditingForm && (
          <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="field" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{t('dialog.type')}</label>
              <select value={form.type} onChange={(e) => handleChange('type', e.target.value)}>
                {TYPES.map(([val, key]) => <option key={val} value={val}>{t(key)}</option>)}
              </select>
            </div>

            <div className="field" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{t('dialog.title')}</label>
              <input type="text" value={form.title} onChange={(e) => handleChange('title', e.target.value)} required />
            </div>

            <div className="field" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{t('dialog.scope')}</label>
              <input type="text" value={form.scope} onChange={(e) => handleChange('scope', e.target.value)} placeholder={t('dialog.scope.placeholder')} />
            </div>

            <div className="field" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{t('dialog.tags')}</label>
              <input type="text" value={form.tags} onChange={(e) => handleChange('tags', e.target.value)} placeholder={t('dialog.tags.placeholder')} />
            </div>

            <div className="field" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{t('dialog.content')}</label>
              <textarea value={form.content} onChange={(e) => handleChange('content', e.target.value)} rows={10} style={{ minHeight: 120 }} required />
            </div>

            <div className="field" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{t('dialog.importance')}: {form.importance}</label>
              <input type="range" min="0" max="1" step="0.1" value={form.importance} onChange={(e) => handleChange('importance', parseFloat(e.target.value))} />
            </div>

            {error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={handleCancel}>{t('dialog.cancel')}</button>
              <button type="submit" className="primary" disabled={saving}>
                {saving ? t('dialog.saving') : isNew ? t('dialog.create') : t('dialog.update')}
              </button>
            </div>
          </form>
        )}
      </div>

      <ConfirmDialog
        open={showConfirm}
        title={t('confirm.title')}
        message={t('detail.deleteConfirm')}
        confirmLabel={t('confirm.delete')}
        cancelLabel={t('confirm.cancel')}
        danger
        onConfirm={handleDelete}
        onCancel={() => setShowConfirm(false)}
      />
    </div>
  );
}
