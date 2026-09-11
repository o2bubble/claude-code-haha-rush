/* ═══════════════════════════════════════════════════
   CONTEXT BAR — File chips, selection, diagnostics
   Design: vs-code-agent-dark.html — .context-bar
   Spec: design-spec.html §3.9 Context Chip, §4.1 #05
   ═══════════════════════════════════════════════════ */

var ContextBar = (function () {

  var barEl = null;

  function render(container) {
    barEl = DOM.createElement('div', { className: 'context-bar', id: 'context-bar' });
    container.appendChild(barEl);

    // Subscribe to context changes
    AppState.subscribe('contextFiles', renderBar);
    AppState.subscribe('contextSelection', renderBar);
    AppState.subscribe('contextDiagnostics', renderBar);

    return barEl;
  }

  function renderBar() {
    if (!barEl) return;
    DOM.empty(barEl);

    var hasContent = false;

    // File chips
    var files = AppState.contextFiles || [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var chip = createFileChip(f.path || f.name || 'file', f.name);
      barEl.appendChild(chip);
      hasContent = true;
    }

    // Selection chip
    var sel = AppState.contextSelection;
    if (sel && sel.file) {
      var selChip = DOM.createElement('span', {
        className: 'context-chip',
        style: { borderColor: 'var(--accent)', background: 'var(--accent-bg)' }
      });
      selChip.innerHTML =
        '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" class="chip-icon"><path d="M1 4.5l6-3 6 3v6l-6 3-6-3v-6z"/></svg> ' +
        escapeHtml(sel.file) + ' (' + (sel.startLine || '') + ':' + (sel.endLine || '') + ')';
      barEl.appendChild(selChip);
      hasContent = true;
    }

    // Hidden when empty
    barEl.style.display = hasContent ? '' : 'none';
  }

  function createFileChip(path, name) {
    var chip = DOM.createElement('span', { className: 'context-chip' });
    chip.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" class="chip-icon"><path d="M2 1.5v13l1 .5h8l1-.5V4.5L9.5 1H3l-1 .5z"/></svg> ' +
      escapeHtml(name || path) +
      ' <span class="x">&times;</span>';

    chip.querySelector('.x').addEventListener('click', function () {
      chip.parentNode.removeChild(chip);
    });

    return chip;
  }

  function escapeHtml(text) {
    if (!text) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }

  return { render: render };
})();
