/* ═══════════════════════════════════════════════════
   HISTORY BROWSER — Searchable conversation history overlay
   Opens from filter bar, shows messages with live search,
   closes without affecting the main message area.
   ═══════════════════════════════════════════════════ */

var HistoryBrowser = (function () {

  var overlayEl = null;
  var searchInput = null;
  var resultEl = null;
  var resultsWrapper = null;
  var searchTimer = null;
  var docEscapeBound = null;
  var _currentQuery = '';
  var _matchCount = 0;
  var _currentMatchIdx = -1;

  function open() {
    close();

    // Close other overlays
    if (typeof FilePicker !== 'undefined') FilePicker.close();
    if (typeof MarkdownEditor !== 'undefined') MarkdownEditor.close();
    if (typeof SlashAutocomplete !== 'undefined') SlashAutocomplete.close();
    if (typeof EmojiPicker !== 'undefined') EmojiPicker.close();
    if (typeof SideQuestion !== 'undefined') SideQuestion.closeQuick();

    overlayEl = createOverlay();
    document.getElementById('overlay-root').appendChild(overlayEl);
    setTimeout(function () { if (searchInput) searchInput.focus(); }, 50);

    // Escape closes
    docEscapeBound = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    document.addEventListener('keydown', docEscapeBound);
  }

  function close() {
    if (docEscapeBound) { document.removeEventListener('keydown', docEscapeBound); docEscapeBound = null; }
    if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
    searchInput = null;
    resultEl = null;
    resultsWrapper = null;
    _currentQuery = '';
    _matchCount = 0;
    _currentMatchIdx = -1;
  }

  function createOverlay() {
    var backdrop = DOM.createElement('div', {
      className: 'modal-overlay',
      style: {
        position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
        background: 'rgba(0,0,0,0.5)', zIndex: '200',
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }
    });

    var modal = DOM.createElement('div', {
      className: 'modal',
      style: {
        maxWidth: '600px', width: '100%', maxHeight: '80vh',
        display: 'flex', flexDirection: 'column'
      }
    });

    // ── Header ──
    var header = DOM.createElement('div', { className: 'modal-header' });
    header.innerHTML = '<span>' + (__t('history.title') || 'Conversation History') + '</span>';
    var closeBtn = DOM.createElement('span', { className: 'close' }, '\u00D7');
    closeBtn.addEventListener('click', close);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // ── Search bar (input + nav) ──
    var searchWrap = DOM.createElement('div', {
      style: { padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'flex', gap: '6px', alignItems: 'center' }
    });
    searchInput = DOM.createElement('input', {
      placeholder: __t('history.search_placeholder') || 'Search messages...',
      style: {
        flex: '1', padding: '6px 10px',
        background: 'var(--surface-3)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)', color: 'var(--fg)',
        fontSize: '12px', fontFamily: 'var(--font-sans)', outline: 'none'
      }
    });
    searchInput.addEventListener('input', function () {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(doSearch, 150);
    });
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) navigateResult(-1);
        else navigateResult(1);
      }
    });
    searchWrap.appendChild(searchInput);

    // Match counter
    var countLabel = DOM.createElement('span', {
      id: 'hb-count',
      style: { fontSize: '10px', color: 'var(--fg-3)', minWidth: '60px', textAlign: 'center' }
    }, '');
    searchWrap.appendChild(countLabel);

    // Nav buttons
    var prevBtn = DOM.createElement('button', {
      className: 'modal-btn',
      style: { fontSize: '10px', padding: '2px 8px' }
    }, '\u25B2');
    prevBtn.title = 'Previous match (Shift+Enter)';
    prevBtn.addEventListener('click', function () { navigateResult(-1); });
    searchWrap.appendChild(prevBtn);

    var nextBtn = DOM.createElement('button', {
      className: 'modal-btn',
      style: { fontSize: '10px', padding: '2px 8px' }
    }, '\u25BC');
    nextBtn.title = 'Next match (Enter)';
    nextBtn.addEventListener('click', function () { navigateResult(1); });
    searchWrap.appendChild(nextBtn);

    modal.appendChild(searchWrap);

    // ── Results area ──
    resultsWrapper = DOM.createElement('div', {
      style: { flex: '1', overflowY: 'auto', padding: '0' }
    });
    resultEl = DOM.createElement('div', {
      className: 'messages',
      style: { minHeight: '100px' }
    });

    var emptyHint = DOM.createElement('div', {
      style: {
        textAlign: 'center', padding: '40px 20px', fontSize: '12px',
        color: 'var(--fg-3)', fontStyle: 'italic'
      }
    }, __t('history.type_to_search') || 'Type to search through conversation history');
    resultEl.appendChild(emptyHint);
    resultsWrapper.appendChild(resultEl);
    modal.appendChild(resultsWrapper);

    // ── Footer ──
    var footer = DOM.createElement('div', { className: 'modal-footer' });
    var hint = DOM.createElement('span', {
      style: { fontSize: '10px', color: 'var(--fg-3)' }
    }, '\u2191\u2193 scroll  \u00B7 Enter next  \u00B7 Shift+Enter prev  \u00B7 Esc close');
    footer.appendChild(hint);
    footer.appendChild(DOM.createElement('span', { style: { flex: '1' } }));
    var closeBtn2 = DOM.createElement('button', { className: 'modal-btn' }, __t('quickcmd.close') || 'Close');
    closeBtn2.addEventListener('click', close);
    footer.appendChild(closeBtn2);
    modal.appendChild(footer);

    backdrop.appendChild(modal);

    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) close();
    });

    return backdrop;
  }

  function doSearch() {
    if (!searchInput || !resultEl) return;
    var query = searchInput.value.trim().toLowerCase();
    _currentQuery = query;
    _matchCount = 0;
    _currentMatchIdx = -1;
    DOM.empty(resultEl);

    var allMsgs = AppState.messages || [];
    var countLabel = document.getElementById('hb-count');
    var matchNodes = [];

    if (!query) {
      // No query: show recent messages without highlights
      var recent = allMsgs.slice(-30);
      for (var i = 0; i < recent.length; i++) {
        var rendered = renderMessageSafe(recent[i]);
        if (rendered) appendResult(rendered);
      }
      if (recent.length === 0) showEmpty('No messages yet');
      if (countLabel) countLabel.textContent = '';
      return;
    }

    // Search and collect matched result elements
    var MAX_RESULTS = 100;
    for (var i = allMsgs.length - 1; i >= 0 && matchNodes.length < MAX_RESULTS; i--) {
      var msg = allMsgs[i];
      var role = msg.role || msg.type || '';
      if (role === 'system') continue;
      var content = extractSearchText(msg);
      if (content.indexOf(query) >= 0) {
        var rendered = renderMessageSafe(msg);
        if (rendered) {
          var wrapper = wrapResult(rendered);
          _matchCount++;
          wrapper.dataset.hbMatchIdx = String(_matchCount - 1);
          // Highlight matching text
          var textEls = wrapper.querySelectorAll('.msg-text, .thinking-content, .tool-body');
          for (var j = 0; j < textEls.length; j++) {
            highlightText(textEls[j], query);
          }
          resultEl.appendChild(wrapper);
          matchNodes.push(wrapper);
        }
      }
    }

    if (_matchCount === 0) {
      showEmpty(__t('history.no_results') || 'No matching messages found');
      if (countLabel) countLabel.textContent = '0 matches';
    } else {
      _currentMatchIdx = 0;
      updateCountLabel(countLabel);
      if (matchNodes.length > 0) {
        scrollToMatch(matchNodes[0]);
      }
    }
  }

  function appendResult(rendered) {
    if (!resultEl) return;
    var wrapper = wrapResult(rendered);
    resultEl.appendChild(wrapper);
  }

  function wrapResult(rendered) {
    var wrapper = DOM.createElement('div');
    if (rendered.nodeType === 11) {
      var children = Array.prototype.slice.call(rendered.childNodes);
      for (var i = 0; i < children.length; i++) {
        wrapper.appendChild(children[i]);
      }
    } else {
      wrapper.appendChild(rendered);
    }
    return wrapper;
  }

  function showEmpty(text) {
    if (!resultEl) return;
    var el = DOM.createElement('div', {
      style: {
        textAlign: 'center', padding: '40px 20px', fontSize: '12px',
        color: 'var(--fg-3)', fontStyle: 'italic'
      }
    }, text);
    resultEl.appendChild(el);
  }

  function renderMessageSafe(msg) {
    try {
      if (typeof MessageStream !== 'undefined' && MessageStream.renderMessage) {
        return MessageStream.renderMessage(msg);
      }
    } catch (e) {
      console.error('[HistoryBrowser] render error', e);
    }
    return null;
  }

  /** Navigate to the next/previous matched result */
  function navigateResult(delta) {
    if (_matchCount === 0 || _currentMatchIdx < 0) return;
    var nextIdx = _currentMatchIdx + delta;
    if (nextIdx < 0) nextIdx = _matchCount - 1;
    if (nextIdx >= _matchCount) nextIdx = 0;

    var target = resultEl.querySelector('[data-hb-match-idx="' + nextIdx + '"]');
    if (target) {
      _currentMatchIdx = nextIdx;
      var countLabel = document.getElementById('hb-count');
      updateCountLabel(countLabel);
      scrollToMatch(target);
    }
  }

  function scrollToMatch(el) {
    if (!resultsWrapper || !el) return;
    // Remove previous highlight class
    var prev = resultsWrapper.querySelector('.hb-match-active');
    if (prev) prev.classList.remove('hb-match-active');
    el.classList.add('hb-match-active');
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function updateCountLabel(el) {
    if (!el) return;
    el.textContent = (_currentMatchIdx + 1) + ' / ' + _matchCount;
  }

  /** Highlight search terms in a DOM element's text nodes */
  function highlightText(el, query) {
    if (!el || !query) return;
    // Only walk direct text-node children to avoid breaking nested markup
    var childNodes = Array.prototype.slice.call(el.childNodes);
    for (var i = 0; i < childNodes.length; i++) {
      var node = childNodes[i];
      if (node.nodeType === 3) { // Text node
        var text = node.textContent || '';
        var lower = text.toLowerCase();
        var idx = lower.indexOf(query);
        if (idx >= 0) {
          var fragment = document.createDocumentFragment();
          var lastEnd = 0;
          while (idx >= 0) {
            // Text before match
            if (idx > lastEnd) {
              fragment.appendChild(document.createTextNode(text.slice(lastEnd, idx)));
            }
            // Highlighted match
            var mark = document.createElement('mark');
            mark.style.cssText = 'background:var(--accent);color:var(--bg);border-radius:2px;padding:0 1px;';
            mark.textContent = text.slice(idx, idx + query.length);
            fragment.appendChild(mark);
            lastEnd = idx + query.length;
            idx = lower.indexOf(query, lastEnd);
          }
          // Remaining text after last match
          if (lastEnd < text.length) {
            fragment.appendChild(document.createTextNode(text.slice(lastEnd)));
          }
          node.parentNode.replaceChild(fragment, node);
        }
      } else if (node.nodeType === 1 && node.tagName !== 'SCRIPT' && node.tagName !== 'STYLE') {
        // Recursively highlight child elements (but not script/style)
        highlightText(node, query);
      }
    }
  }

  /** Extract all searchable text from a message */
  function extractSearchText(msg) {
    var texts = [];
    if (typeof msg.content === 'string') {
      texts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (var i = 0; i < msg.content.length; i++) {
        var c = msg.content[i];
        if (c.text) texts.push(c.text);
        if (c.thinking) texts.push(c.thinking);
        if (c.name) texts.push(c.name);
        if (c.input && typeof c.input === 'object') {
          try { texts.push(JSON.stringify(c.input)); } catch (e) { }
        }
      }
    }
    if (msg.message && msg.message.content) {
      texts.push(extractSearchText(msg.message));
    }
    if (msg.text) texts.push(msg.text);
    return texts.join(' ').toLowerCase();
  }

  return { open: open, close: close };
})();
