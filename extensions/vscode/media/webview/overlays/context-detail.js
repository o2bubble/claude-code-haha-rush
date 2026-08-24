/* ═══════════════════════════════════════════════════
   CONTEXT DETAIL — Status bar context window overlay card
   Design: design spec — "Status Bar — Context Window Detail"
   ═══════════════════════════════════════════════════ */

var ContextDetail = (function () {

  var overlayEl = null;

  function open() {
    close();

    // Close other overlays
    if (typeof FilePicker !== 'undefined') FilePicker.close();
    if (typeof SlashAutocomplete !== 'undefined') SlashAutocomplete.close();
    if (typeof EmojiPicker !== 'undefined') EmojiPicker.close();

    overlayEl = createOverlay();
    document.getElementById('overlay-root').appendChild(overlayEl);

    // Position above the context bar, right-aligned to context bar
    var ctxBar = document.querySelector('.context-bar-wrap');
    if (ctxBar) {
      var cr = ctxBar.getBoundingClientRect();
      var rightPx = window.innerWidth - cr.right;
      // If overlay would overflow left edge, clamp
      var inputLeft = document.querySelector('.input-area') ? document.querySelector('.input-area').getBoundingClientRect().left : 0;
      if (cr.right - 400 < inputLeft) rightPx = window.innerWidth - (inputLeft + 400);
      overlayEl.style.position = 'fixed';
      overlayEl.style.right = Math.max(0, rightPx) + 'px';
      overlayEl.style.left = 'auto';
      overlayEl.style.bottom = (window.innerHeight - cr.top + 4) + 'px';
      overlayEl.style.top = 'auto';
      overlayEl.style.maxHeight = Math.min(400, Math.max(200, cr.top - 12)) + 'px';
      overlayEl.style.zIndex = '100';
    }

    // Click inside stops propagation
    overlayEl.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    // Click outside closes
    setTimeout(function () {
      document.addEventListener('click', closeOut);
      document.addEventListener('keydown', escOut);
    }, 0);
  }

  function closeOut() { close(); }
  function escOut(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }

  function close() {
    document.removeEventListener('click', closeOut);
    document.removeEventListener('keydown', escOut);
    if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
  }

  function formatTokens(n) {
    if (!n) return '0';
    if (n >= 1000) {
      var k = n / 1000;
      return k >= 100 ? Math.round(k) + 'K' : parseFloat(k.toFixed(1)) + 'K';
    }
    return String(n);
  }

  function createOverlay() {
    var card = DOM.createElement('div', { className: 'dropdown' });
    card.style.maxWidth = '400px';
    card.style.width = '400px';

    // ── Header ──
    var header = DOM.createElement('div', {
      style: { padding: '10px 12px 0', fontSize: '12px', fontWeight: '600', color: 'var(--fg-2)' }
    }, __t('status.context_window') || 'Context Window');
    card.appendChild(header);

    var body = DOM.createElement('div', { style: { padding: '10px 12px 12px' } });

    // ── Bar section ──
    var barSec = DOM.createElement('div', {
      style: { background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px', marginBottom: '8px' }
    });

    // Token amounts
    var usedTokens = AppState.contextTokens || 0;
    var maxTokens = AppState.contextMaxTokens || 200000;
    var pct = AppState.contextPercent || 0;

    var tokenRow = DOM.createElement('div', {
      style: { display: 'flex', justifyContent: 'space-between', fontSize: '10px', marginBottom: '6px', color: 'var(--fg-2)' }
    });
    tokenRow.innerHTML =
      '<span>' + (__t('status.used_tokens') || 'Used') + '</span>' +
      '<span style="font-family:var(--font-mono);color:var(--fg-3);">' + formatTokens(usedTokens) + ' / ' + formatTokens(maxTokens) + '</span>';
    barSec.appendChild(tokenRow);

    // Gradient bar
    var barTrack = DOM.createElement('div', {
      style: { height: '6px', background: 'var(--border)', borderRadius: '3px', overflow: 'hidden', marginBottom: '4px' }
    });
    var barFill = DOM.createElement('div', {
      style: { height: '100%', width: pct + '%', borderRadius: '3px', background: getGradient(pct) }
    });
    barTrack.appendChild(barFill);
    barSec.appendChild(barTrack);

    // Legend
    var legend = DOM.createElement('div', {
      style: { display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: 'var(--fg-3)' }
    });
    legend.innerHTML =
      '<span style="color:var(--green);">\u25CF 0\u201350%</span>' +
      '<span style="color:var(--yellow);">\u25CF 50\u201375%</span>' +
      '<span style="color:var(--orange);">\u25CF 75\u201390%</span>' +
      '<span style="color:var(--red);">\u25CF 90%+</span>';
    barSec.appendChild(legend);

    // Compact action
    var compactAction = DOM.createElement('div', {
      style: { marginTop: '8px', fontSize: '10px', color: 'var(--accent)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }
    });
    compactAction.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h12v1H2V3zm0 3h12v1H2V6zm0 3h12v1H2V9zm0 3h10v1H2v-1z"/></svg> ' +
      (__t('status.compact_conversation') || 'Compact conversation');
    compactAction.addEventListener('click', function () {
      API.send('compact');
      close();
    });
    compactAction.addEventListener('mouseenter', function () {
      compactAction.style.textDecoration = 'underline';
    });
    compactAction.addEventListener('mouseleave', function () {
      compactAction.style.textDecoration = '';
    });
    barSec.appendChild(compactAction);

    body.appendChild(barSec);

    // ── Session token totals (not context window — that's already in the bar above) ──
    var sessTok = AppState.sessionTokens || { input: 0, output: 0 };
    var modelSec = DOM.createElement('div', {
      style: { background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px', display: 'flex', justifyContent: 'space-between' }
    });
    var modelLeft = DOM.createElement('div');
    modelLeft.innerHTML =
      '<div style="font-size:10px;color:var(--fg-3);margin-bottom:2px;">' + (__t('status.model_label') || 'Model') + '</div>' +
      '<div style="font-size:12px;color:var(--fg);font-weight:500;">' + (AppState.modelName || AppState.activeProfile || (__t('profile.default') || 'Default')) + '</div>';
    modelSec.appendChild(modelLeft);
    var modelRight = DOM.createElement('div', { style: { textAlign: 'right' } });
    modelRight.innerHTML =
      '<div style="font-size:10px;color:var(--fg-3);margin-bottom:2px;">' + (__t('status.session_tokens') || 'Session tokens') + '</div>' +
      '<div style="font-size:12px;color:var(--fg);font-family:var(--font-mono);">' +
      '\u2193 ' + formatTokens(sessTok.input) + '  \u2191 ' + formatTokens(sessTok.output) +
      '</div>';
    modelSec.appendChild(modelRight);
    body.appendChild(modelSec);

    card.appendChild(body);
    return card;
  }

  function getGradient(pct) {
    if (pct >= 90) return 'var(--red)';
    if (pct >= 75) return 'var(--orange)';
    if (pct >= 50) return 'var(--yellow)';
    return 'var(--green)';
  }

  return { open: open, close: close };
})();
