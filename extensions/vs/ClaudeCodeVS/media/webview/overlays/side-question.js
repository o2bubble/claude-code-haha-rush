/* ═══════════════════════════════════════════════════
   SIDE QUESTION — Clarification dialog + Quick Ask overlay
   Reference: app.js — side_question / side_question_result
   ═══════════════════════════════════════════════════ */

var SideQuestion = (function () {

  /* ── AI asks user (clarification dialog) ── */

  var overlayEl = null;

  function open(question, callback) {
    close();
    overlayEl = createOverlay(question, callback);
    document.getElementById('overlay-root').appendChild(overlayEl);
    setTimeout(function () {
      var textarea = overlayEl.querySelector('textarea');
      if (textarea) textarea.focus();
    }, 50);
  }

  function close() {
    if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
  }

  function createOverlay(question, callback) {
    var backdrop = DOM.createElement('div', {
      className: 'modal-overlay',
      style: { position: 'fixed', top: '0', left: '0', right: '0', bottom: '0', background: 'rgba(0,0,0,0.5)', zIndex: '200', display: 'flex', alignItems: 'center', justifyContent: 'center' }
    });

    var modal = DOM.createElement('div', { className: 'modal', style: { maxWidth: '400px', width: '100%' } });
    var header = DOM.createElement('div', { className: 'modal-header' });
    header.innerHTML = '<span>Clarification Needed</span>';
    var closeBtn = DOM.createElement('span', { className: 'close' }, '\u00D7');
    closeBtn.addEventListener('click', close);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    var body = DOM.createElement('div', { className: 'modal-body' });
    body.appendChild(DOM.createElement('div', { style: { fontSize: '12px', color: 'var(--fg-3)', marginBottom: '10px' } }, question || ''));
    var textarea = DOM.createElement('textarea', {
      placeholder: 'Type your answer...',
      style: { width: '100%', minHeight: '60px', padding: '8px 10px', background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--fg)', fontSize: '12px', fontFamily: 'var(--font-sans)', resize: 'vertical', outline: 'none' }
    });
    body.appendChild(textarea);
    modal.appendChild(body);

    var footer = DOM.createElement('div', { className: 'modal-footer' });
    var skipBtn = DOM.createElement('button', { className: 'modal-btn' }, 'Skip');
    skipBtn.addEventListener('click', close);
    footer.appendChild(skipBtn);
    var sendBtn = DOM.createElement('button', { className: 'modal-btn primary' }, 'Send');
    sendBtn.addEventListener('click', function () {
      var answer = textarea.value.trim();
      if (answer && callback) callback(answer);
      close();
    });
    footer.appendChild(sendBtn);
    modal.appendChild(footer);

    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
      if (e.key === 'Escape') close();
    });

    backdrop.appendChild(modal);
    return backdrop;
  }

  /* ── User asks AI (quick ask overlay) ── */

  var quickEl = null;
  var quickInput = null;
  var quickResult = null;
  var quickSend = null;
  var _quickEscBound = null;
  var _quickClickBound = null;

  function openQuickAsk() {
    closeQuick();
    quickEl = createQuickOverlay();
    var root = document.getElementById('overlay-root');
    if (root) root.appendChild(quickEl);
    setTimeout(function () { if (quickInput) quickInput.focus(); }, 50);
  }

  function closeQuick() {
    if (_quickClickBound) { document.removeEventListener('click', _quickClickBound); _quickClickBound = null; }
    if (_quickEscBound) { document.removeEventListener('keydown', _quickEscBound); _quickEscBound = null; }
    if (quickEl && quickEl.parentNode) quickEl.parentNode.removeChild(quickEl);
    quickEl = null;
  }

  function createQuickOverlay() {
    var dropdown = DOM.createElement('div', { className: 'dropdown', style: { maxWidth: '360px' } });

    // Header
    dropdown.appendChild(DOM.createElement('div', {
      style: { padding: '10px 12px 0', fontSize: '12px', fontWeight: '600', color: 'var(--fg-2)' }
    }, __t('side_question.header') || 'Side Question'));

    var body = DOM.createElement('div', { style: { padding: '10px 12px 12px' } });

    // Input row
    var inputRow = DOM.createElement('div', { style: { display: 'flex', gap: '6px' } });
    quickInput = DOM.createElement('input', {
      type: 'text',
      placeholder: __t('side_question.placeholder') || 'Ask a quick question...',
      style: { flex: '1', padding: '6px 8px', background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--fg)', fontSize: '12px', fontFamily: 'var(--font-sans)', outline: 'none' }
    });
    quickInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); sendQuick(); }
      if (e.key === 'Escape') { e.preventDefault(); closeQuick(); }
    });
    inputRow.appendChild(quickInput);

    quickSend = DOM.createElement('button', {
      style: { padding: '4px 12px', background: 'var(--accent)', border: 'none', borderRadius: 'var(--radius-sm)', color: '#fff', fontSize: '11px', cursor: 'pointer', fontWeight: '500' }
    }, __t('side_question.ask') || 'Ask');
    quickSend.addEventListener('click', sendQuick);
    inputRow.appendChild(quickSend);
    body.appendChild(inputRow);

    // Result area
    quickResult = DOM.createElement('div', {
      style: { display: 'none', marginTop: '8px', padding: '8px', background: 'var(--surface-3)', borderRadius: 'var(--radius-sm)', fontSize: '11px', color: 'var(--fg-2)', maxHeight: '200px', overflowY: 'auto', lineHeight: '1.5', whiteSpace: 'pre-wrap' }
    });
    body.appendChild(quickResult);
    dropdown.appendChild(body);

    // Position
    var inputArea = document.querySelector('.input-area');
    if (inputArea) {
      var ir = inputArea.getBoundingClientRect();
      dropdown.style.position = 'fixed';
      dropdown.style.left = ir.left + 'px';
      dropdown.style.bottom = (window.innerHeight - ir.top + 6) + 'px';
      dropdown.style.top = 'auto';
      dropdown.style.zIndex = '100';
    }

    dropdown.addEventListener('click', function (e) { e.stopPropagation(); });
    setTimeout(function () {
      if (_quickClickBound) document.removeEventListener('click', _quickClickBound);
      _quickClickBound = closeQuick;
      document.addEventListener('click', _quickClickBound);
      if (_quickEscBound) document.removeEventListener('keydown', _quickEscBound);
      _quickEscBound = function (e) { if (e.key === 'Escape') { closeQuick(); } };
      document.addEventListener('keydown', _quickEscBound);
    }, 0);

    return dropdown;
  }

  function sendQuick() {
    if (!quickInput) return;
    var q = (quickInput.value || '').trim();
    if (!q) return;
    quickSend.disabled = true;
    quickSend.textContent = '...';
    quickResult.style.display = '';
    quickResult.textContent = __t('side_question.asking') || 'Asking...';
    API.send('side_question', { question: q });
  }

  function showResult(text) {
    if (quickResult) {
      quickResult.style.display = '';
      try {
        if (typeof marked !== 'undefined') {
          quickResult.innerHTML = marked.parse(text);
        } else {
          quickResult.textContent = text;
        }
      } catch (e) {
        quickResult.textContent = text;
      }
    }
    if (quickSend) { quickSend.disabled = false; quickSend.textContent = __t('side_question.ask') || 'Ask'; }
    if (quickInput) quickInput.value = '';
  }

  return { open: open, close: close, openQuickAsk: openQuickAsk, closeQuick: closeQuick, showResult: showResult };
})();
