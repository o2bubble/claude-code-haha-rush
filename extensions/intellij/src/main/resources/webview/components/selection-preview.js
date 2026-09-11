/* ═══════════════════════════════════════════════════
   SELECTION PREVIEW — Inline code preview
   Design: vs-code-agent-dark.html — .sel-preview
   Spec: design-spec.html §3.9, §4.1 #06
   ═══════════════════════════════════════════════════ */

var SelectionPreview = (function () {

  var previewEl = null;
  var codeEl = null;
  var collapsed = false;

  function render(shell, scrollArea) {
    var wrap = DOM.createElement('div', {
      className: 'sel-preview',
      id: 'sel-preview',
      style: { display: 'none' }
    });

    // Header (collapsible)
    var header = DOM.createElement('div', { className: 'sel-header', id: 'sel-header' });
    header.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" class="chevron" style="transition:transform 0.15s;"><path d="M5.5 3l5 5-5 5"/></svg> ' +
      '<span id="sel-label"></span>';
    header.addEventListener('click', function () {
      collapsed = !collapsed;
      if (codeEl) codeEl.style.display = collapsed ? 'none' : '';
      header.querySelector('.chevron').style.transform = collapsed ? 'rotate(0deg)' : 'rotate(90deg)';
    });
    wrap.appendChild(header);

    // Code content
    codeEl = DOM.createElement('div', { className: 'sel-code', id: 'sel-code' });
    wrap.appendChild(codeEl);

    // Insert above input area (below scroll content) — doesn't scroll
    var inputArea = document.getElementById('input-area');
    shell.insertBefore(wrap, inputArea);
    previewEl = wrap;

    // Subscribe to selection changes
    AppState.subscribe('contextSelection', updatePreview);

    return wrap;
  }

  function updatePreview() {
    var sel = AppState.contextSelection;
    if (!sel || !sel.code || !sel.file) {
      if (previewEl) previewEl.style.display = 'none';
      return;
    }

    previewEl.style.display = '';
    var label = previewEl.querySelector('#sel-label');
    if (label) {
      label.textContent = (sel.file || '') + ' \u2014 lines ' + (sel.startLine || '') + '-' + (sel.endLine || '');
    }

    // Render code with line numbers and syntax highlighting (matches old app.js)
    DOM.empty(codeEl);
    var highlighted;
    try {
      if (typeof hljs !== 'undefined') {
        highlighted = hljs.highlightAuto(sel.code).value;
      } else {
        highlighted = escapeHtml(sel.code);
      }
    } catch (e) {
      highlighted = escapeHtml(sel.code);
    }
    var hlines = highlighted.split('\n');
    for (var i = 0; i < hlines.length; i++) {
      var lineNum = (sel.startLine || 1) + i;
      var lineSpan = DOM.createElement('span', {
        className: 'ln-hl',
        style: { display: 'block' }
      });
      lineSpan.innerHTML = '<span style="color:var(--fg-3);user-select:none;margin-right:8px;">' + lineNum + '</span>' + hlines[i];
      codeEl.appendChild(lineSpan);
    }

    collapsed = false;
    codeEl.style.display = '';
  }

  function escapeHtml(text) {
    if (!text) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }

  return { render: render };
})();
