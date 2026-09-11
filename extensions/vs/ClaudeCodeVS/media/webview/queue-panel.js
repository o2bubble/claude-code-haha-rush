/* ═══════════════════════════════════════════════════
   QUEUE PANEL — Shows queued prompts between scroll area and input
   ═══════════════════════════════════════════════════ */

var QueuePanel = (function () {

  var panelEl = null;
  var listEl = null;

  function render(container) {
    panelEl = DOM.createElement('div', { className: 'panel', id: 'panel-queue', style: { display: 'none' } });

    // Header
    var header = DOM.createElement('div', { className: 'panel-header' });
    var label = DOM.createElement('span', { className: 'label' });
    label.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 3v10l1 1h8l1-1V4.5l-.5-.5h-4l-1-1H5l-1 1z"/></svg> ' +
      (__t('queue.title') || '排队中') +
      ' <span class="badge" id="queue-count">0</span>';
    header.appendChild(label);

    // Clear button
    var clearBtn = DOM.createElement('span', { className: 'action-btn', id: 'queue-clear-btn', style: { display: 'none' } },
      __t('queue.clear') || '清除');
    clearBtn.addEventListener('click', function () {
      AppState.set('pendingQueue', []);
      AppState.set('streaming', false);
    });
    header.appendChild(clearBtn);
    panelEl.appendChild(header);

    // List
    listEl = DOM.createElement('div', { id: 'queue-panel-list' });
    panelEl.appendChild(listEl);

    container.appendChild(panelEl);

    // Subscribe to queue changes (frontend-local pendingQueue)
    AppState.subscribe('pendingQueue', function (queue) {
      renderQueue(queue || []);
    });
  }

  function renderQueue(queue) {
    if (!panelEl || !listEl) return;

    if (queue.length === 0) {
      panelEl.style.display = 'none';
      return;
    }

    panelEl.style.display = '';
    DOM.empty(listEl);

    var countEl = document.getElementById('queue-count');
    if (countEl) countEl.textContent = String(queue.length);

    var clearBtnEl = document.getElementById('queue-clear-btn');
    if (clearBtnEl) clearBtnEl.style.display = queue.length > 1 ? '' : 'none';

    for (var qi = 0; qi < queue.length; qi++) {
      var item = queue[qi];
      var row = DOM.createElement('div', { className: 'queue-item' });

      var idxSpan = DOM.createElement('span', { className: 'queue-idx' }, String(qi + 1) + '.');

      var textSpan = DOM.createElement('span', { className: 'queue-text' });
      textSpan.textContent = item.preview || '';

      var cancelBtn = DOM.createElement('span', { className: 'queue-del' }, '\u00D7');
      cancelBtn.title = 'Remove';
      (function (idx) {
        cancelBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          var q = (AppState.pendingQueue || []).slice();
          q.splice(idx, 1);
          AppState.set('pendingQueue', q);
          if (q.length === 0) AppState.set('streaming', false);
        });
      })(qi);

      row.appendChild(idxSpan);
      row.appendChild(textSpan);
      row.appendChild(cancelBtn);
      listEl.appendChild(row);
    }
  }

  return { render: render };
})();
