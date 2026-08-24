/* ═══════════════════════════════════════════════════
   REWIND POINTS — Checkpoint / restore point list
   Design: vs-code-agent-dark.html — Rewind section
   Spec: design-spec.html §4.2 #15
   Reference: app.js — search "rewind" or "checkpoint"
   ═══════════════════════════════════════════════════ */

var RewindPoints = (function () {

  /** Render a list of restore points */
  function render(checkpoints) {
    var container = DOM.createElement('div', {
      style: { margin: '6px 12px 6px 28px' }
    });

    if (!checkpoints || checkpoints.length === 0) return container;

    var label = DOM.createElement('div', {
      style: { fontSize: '10px', color: 'var(--fg-3)', fontWeight: '600', marginBottom: '6px' }
    }, 'Restore Points');
    container.appendChild(label);

    for (var i = 0; i < checkpoints.length; i++) {
      var cp = checkpoints[i];
      var item = renderCheckpoint(cp, i, checkpoints.length);
      container.appendChild(item);
    }

    return container;
  }

  function renderCheckpoint(cp, idx, total) {
    var hasBorder = idx < total - 1;
    var item = DOM.createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 8px',
        borderBottom: hasBorder ? '1px solid var(--border)' : 'none',
        fontSize: '12px'
      }
    });

    var isLatest = cp.is_latest || cp.latest;
    var iconColor = isLatest ? 'var(--accent)' : 'var(--fg-3)';

    item.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="color:' + iconColor + ';flex-shrink:0;">' +
        '<path d="M8 1v2c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6c0-2.2 1.2-4.2 3-5.2V9h2V1H8z"/>' +
      '</svg>' +
      '<span style="color:' + (isLatest ? 'var(--fg)' : 'var(--fg-2)') + ';flex:1;">' +
        escapeHtml(cp.label || cp.name || 'Checkpoint') +
      '</span>' +
      '<span style="font-size:10px;color:var(--fg-3);">' + (cp.files || cp.file_count || '') + ' files</span>' +
      '<span style="font-size:10px;color:var(--fg-3);">' + (cp.time || cp.timestamp || '') + '</span>';

    // Restore button
    var restoreBtn = DOM.createElement('button', {
      className: 'modal-btn',
      style: { fontSize: '10px', padding: '2px 10px' }
    }, 'Restore');
    restoreBtn.addEventListener('click', function () {
      if (cp.id) {
        API.send('execute_rewind', { messageId: cp.id });
      }
    });
    item.appendChild(restoreBtn);

    return item;
  }

  function escapeHtml(text) {
    if (!text) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }

  return { render: render };
})();
