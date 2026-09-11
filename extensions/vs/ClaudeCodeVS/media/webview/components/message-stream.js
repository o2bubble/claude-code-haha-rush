/* ═══════════════════════════════════════════════════
   MESSAGE STREAM — Message rendering + filter
   Design: vs-code-agent-dark.html — Messages section
   Spec: design-spec.html §3.2 Messages, §4.1 #02
   Reference: app.js — formatContent(), handleStreamEvent()
   ═══════════════════════════════════════════════════ */

var MessageStream = (function () {

  var filterEl = null;
  var streamEl = null;
  var scrollEl = null;
  var isLoadingHistory = false;
  var historyRenderStart = 0;
  var HISTORY_INITIAL = 25;
  var HISTORY_MORE = 20;
  var _thinkTimer = null;

  function startThinkTimer() {
    if (_thinkTimer) return;
    _thinkTimer = setInterval(function () {
      var timers = document.querySelectorAll('.thinking-timer');
      if (timers.length === 0) {
        clearInterval(_thinkTimer);
        _thinkTimer = null;
        return;
      }
      for (var ti = 0; ti < timers.length; ti++) {
        var start = parseInt(timers[ti].dataset.start, 10);
        if (start) {
          var elapsed = Math.round((Date.now() - start) / 1000);
          timers[ti].textContent = '(' + elapsed + 's)';
        }
      }
    }, 1000);
  }

  function finalizeThinkTimers() {
    if (_thinkTimer) {
      clearInterval(_thinkTimer);
      _thinkTimer = null;
    }
    var timers = document.querySelectorAll('.thinking-timer');
    for (var ti = 0; ti < timers.length; ti++) {
      var start = parseInt(timers[ti].dataset.start, 10);
      if (start) {
        var elapsed = Math.round((Date.now() - start) / 1000);
        timers[ti].textContent = '(' + elapsed + 's)';
        delete timers[ti].dataset.start;
      }
    }
  }

  function render(container, filterContainer) {
    var wrapper = DOM.createElement('div', {
      style: { borderBottom: '1px solid var(--border)' }
    });

    // Filter bar
    filterEl = DOM.createElement('div', { className: 'msg-filter' });
    renderFilter();
    if (filterContainer) {
      filterContainer.appendChild(filterEl);
    }

    // Stream area
    streamEl = DOM.createElement('div', {
      className: 'messages',
      id: 'messages'
    });
    renderEmptyState();

    // Delegated click: copy code buttons + open file paths
    streamEl.addEventListener('click', function (e) {
      // Copy code block button
      var copyBtn = e.target.closest('[data-action="copy-code"]');
      if (copyBtn) {
        e.preventDefault();
        e.stopPropagation();
        var preEl = copyBtn.parentNode.querySelector('pre');
        var codeText = preEl ? preEl.textContent : '';
        if (codeText && navigator.clipboard) {
          navigator.clipboard.writeText(codeText).then(function () {
            copyBtn.textContent = 'Copied!';
            setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500);
          });
        }
        return;
      }
      // File path code spans
      var codeEl = e.target.closest('code');
      if (!codeEl) return;
      var text = (codeEl.textContent || '').trim();
      if (!text) return;
      var isPath = /[\\/]/.test(text) || /\.[a-z]{2,6}$/i.test(text);
      var isUrl = /^https?:\/\//i.test(text) || /^[a-z]+:\//i.test(text);
      if (isPath && !isUrl) {
        e.preventDefault();
        e.stopPropagation();
        API.send('open_file', { path: text });
      }
    });

    if (!filterContainer) wrapper.appendChild(filterEl);
    wrapper.appendChild(streamEl);

    // Scroll-to-bottom FAB
    var fab = DOM.createElement('div', {
      style: { textAlign: 'center', padding: '4px 8px', display: 'none' },
      id: 'scroll-fab'
    });
    fab.innerHTML =
      '<span style="font-size:10px;color:var(--fg-3);background:var(--surface-3);padding:3px 14px;border-radius:12px;border:1px solid var(--border);cursor:pointer;display:inline-flex;align-items:center;gap:4px;">' +
        '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3v10M3 8l5 5 5-5"/></svg> ' +
        'Scroll to latest <span id="fab-count" style="font-weight:600;"></span>' +
      '</span>';
    fab.addEventListener('click', function () { scrollToBottom(true); });
    wrapper.appendChild(fab);

    container.appendChild(wrapper);

    // Subscribe to messages changes
    AppState.subscribe('messages', onMessagesChange);
    AppState.subscribe('messageFilter', onFilterChange);
    // Reset lazy load position on session change
    AppState.subscribe('currentSessionId', function () {
      historyRenderStart = 0;
    });

    // Scroll detection for FAB visibility + lazy history
    var scrollArea = document.getElementById('scroll-area');
    if (scrollArea) {
      scrollArea.addEventListener('scroll', function () {
        var dist = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight;
        var fabEl = document.getElementById('scroll-fab');
        if (fabEl) {
          fabEl.style.display = dist > 100 ? '' : 'none';
        }
        // Lazy history: scroll near top → load more
        if (scrollArea.scrollTop < 200 && !isLoadingHistory) {
          loadMoreHistory();
        }
      });
    }

    return wrapper;
  }

  /* ─── Filter ─── */

  function renderFilter() {
    DOM.empty(filterEl);
    var filters = [
      { key: 'all', label: __t('filter.all') || 'All' },
      { key: 'user', label: __t('filter.user') || 'You' },
      { key: 'assistant', label: __t('filter.assistant') || 'Agent' }
    ];
    for (var i = 0; i < filters.length; i++) {
      var f = filters[i];
      var pill = DOM.createElement('span', {
        className: 'filter-pill' + (AppState.messageFilter === f.key ? ' active' : ''),
        'data-filter': f.key
      }, f.label);
      pill.addEventListener('click', function (key) {
        return function () { AppState.set('messageFilter', key); };
      }(f.key));
      filterEl.appendChild(pill);
    }

    // Message count
    var countSpan = DOM.createElement('span', {
      id: 'msg-count',
      style: { marginLeft: 'auto', fontSize: '10px', color: 'var(--fg-3)', padding: '2px 4px' }
    }, '\u2193 ' + AppState.messages.length);
    filterEl.appendChild(countSpan);
  }

  function onFilterChange() {
    renderFilter();
    historyRenderStart = 0;
    renderMessages();
  }

  function onMessagesChange() {
    renderMessages();
    var count = document.getElementById('msg-count');
    if (count) count.textContent = '\u2193 ' + AppState.messages.length;
    var fabCount = document.getElementById('fab-count');
    if (fabCount) fabCount.textContent = AppState.messages.length;
  }

  /* ─── Message rendering ─── */

  function renderMessages() {
    // Save scroll position before DOM rebuild so the browser doesn't
    // clamp scrollTop to 0 when streamEl is emptied (see loadMoreHistory
    // for the same pattern). Restore after rebuild unless auto-scroll
    // is active (streaming), in which case go to bottom.
    var area = document.getElementById('scroll-area');
    var oldScrollTop = area ? area.scrollTop : 0;
    var oldScrollHeight = area ? area.scrollHeight : 0;

    DOM.empty(streamEl);
    var allMsgs = getFilteredMessages();
    if (!allMsgs || allMsgs.length === 0) {
      historyRenderStart = 0;
      renderEmptyState();
      return;
    }
    var total = allMsgs.length;
    // After compaction/reload, historyRenderStart may exceed the new total,
    // causing everything to be invisible. Clamp to a valid range.
    if (historyRenderStart !== 0 && historyRenderStart >= total) {
      historyRenderStart = total > HISTORY_INITIAL ? total - HISTORY_INITIAL : 0;
    }
    // Initialize lazy render start: only show last HISTORY_INITIAL messages
    if (historyRenderStart === 0 && total > HISTORY_INITIAL) {
      historyRenderStart = total - HISTORY_INITIAL;
    }
    var start = historyRenderStart;
    for (var i = start; i < total; i++) {
      try {
        appendRendered(streamEl, renderMessage(allMsgs[i]));
      } catch (e) {
        console.error('[MessageStream] render error for msg', i, e);
        // Render a placeholder so broken messages don't block the list
        var placeholder = DOM.createElement('div', {
          className: 'msg assistant',
          style: { padding: '8px 14px', opacity: '0.4', fontSize: '11px', color: 'var(--fg-3)' }
        }, __t('app.render_error') || 'Message failed to render');
        streamEl.appendChild(placeholder);
      }
    }
    // Show load indicator if there are older messages
    if (start > 0) {
      var indicator = DOM.createElement('div', {
        className: 'history-load-indicator',
        style: { textAlign: 'center', padding: '6px 8px', fontSize: '10px', color: 'var(--fg-3)', cursor: 'pointer' }
      }, __t('history.load_more', { shown: total - start, total: total }));
      indicator.addEventListener('click', loadMoreHistory);
      streamEl.insertBefore(indicator, streamEl.firstChild);
    }
    // Restore or update scroll position after DOM rebuild
    if (area) {
      if (AppState.autoScroll) {
        area.scrollTop = area.scrollHeight;
      } else {
        area.scrollTop = oldScrollTop + (area.scrollHeight - oldScrollHeight);
      }
    }
  }

  /** Append an element or fragment children to target */
  function appendRendered(target, rendered) {
    if (!rendered) return;
    if (rendered.nodeType === 11) {
      // DocumentFragment — move each child
      var children = Array.prototype.slice.call(rendered.childNodes);
      for (var i = 0; i < children.length; i++) {
        target.appendChild(children[i]);
      }
    } else {
      target.appendChild(rendered);
    }
  }

  function getFilteredMessages() {
    var all = AppState.messages || [];
    var filter = AppState.messageFilter;
    if (filter === 'all') return all;
    return all.filter(function (m) {
      return m.role === filter || m.type === filter;
    });
  }

  function renderMessage(msg) {
    if (!msg) return null;
    // History messages use { type }, streaming uses { role }
    var role = msg.role || msg.type || 'assistant';
    // Skip system messages (matches old app.js renderMessageBatch behavior)
    if (role === 'system') return null;
    // Extract content directly for history format
    if (msg.message && !msg.content) {
      msg = msg.message;
    }
    role = msg.role || msg.type || role;
    if (role === 'user') {
      // Check if this is actually a tool result (matches old app.js renderMessageBatch)
      if (Array.isArray(msg.content) && msg.content.length > 0 && msg.content[0].type === 'tool_result') {
        return null; // tool_result handled by tool card output toggle
      }
      return renderUserMessage(msg);
    }
    return renderAssistantMessage(msg);
  }

  /* ─── User message ─── */

  function renderUserMessage(msg) {
    var div = DOM.createElement('div', { className: 'msg user' });
    var content = getMessageContent(msg);
    var attachments = content.attachments || [];

    // Avatar
    var avatar = DOM.createElement('div', { className: 'avatar' });
    avatar.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1c-1.5 0-2.8.6-3.7 1.5C3.3 3.2 3 4.5 3 6v1H2v2h1v1c0 1.5.3 2.8 1.3 3.5C5.2 14.4 6.5 15 8 15s2.8-.6 3.7-1.5c1-.7 1.3-2 1.3-3.5V9h1V7h-1V6c0-1.5-.3-2.8-1.3-3.5C10.8 1.6 9.5 1 8 1zM5.5 6.5a1 1 0 110 2 1 1 0 010-2zm5 0a1 1 0 110 2 1 1 0 010-2zM6 10c.5.8 1.2 1 2 1s1.5-.2 2-1H6z"/></svg>';
    div.appendChild(avatar);

    // Body — text content
    var body = DOM.createElement('div', { className: 'body' });
    if (content.text) {
      body.innerHTML += formatContent(content.text);
    }

    // Separate attachments by kind (matches old app.js renderUserMessage)
    var pasteAtts = [];
    var selectionAtts = [];
    var fileAtts = [];
    for (var ai = 0; ai < attachments.length; ai++) {
      if (attachments[ai].kind === 'paste') {
        pasteAtts.push(attachments[ai]);
      } else if (attachments[ai].kind === 'selection') {
        selectionAtts.push(attachments[ai]);
      } else if (attachments[ai].type !== 'image') {
        fileAtts.push(attachments[ai]);
      }
    }

    // File chips
    for (var fi = 0; fi < fileAtts.length; fi++) {
      var fatt = fileAtts[fi];
      var chip = DOM.createElement('span', { className: 'file-chip' });
      chip.innerHTML =
        '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1.5v13l1 .5h8l1-.5V4.5L9.5 1H3l-1 .5z"/></svg> ' +
        escapeHtml(fatt.path || fatt.name || 'file');
      body.appendChild(chip);
    }

    // Selection chips (matches old app.js selection-chip-msg)
    for (var si = 0; si < selectionAtts.length; si++) {
      var satt = selectionAtts[si];
      var sChip = DOM.createElement('span', { className: 'selection-chip-msg' });
      var sl2 = satt.startLine, el2 = satt.endLine;
      var sr2 = sl2 === el2 ? String(sl2) : sl2 + '-' + el2;
      sChip.innerHTML =
        '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h12v12H2V2zm1 1v10h10V5.5L10 3H3z"/></svg> ' +
        escapeHtml(satt.filePath || '') + ':' + sr2;
      body.appendChild(sChip);
    }

    // Paste chips — expandable (matches old app.js paste-chip-msg)
    for (var pi = 0; pi < pasteAtts.length; pi++) {
      var patt = pasteAtts[pi];
      var pChip = DOM.createElement('div', { className: 'paste-chip-msg' });
      pChip.innerHTML =
        '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M4 3v10l1 1h8l1-1V4.5l-.5-.5h-4l-1-1H5l-1 1z"/></svg> ' +
        '<span class="paste-label">' + escapeHtml(patt.path || ('Pasted text')) + '</span>';
      pChip.title = 'Click to expand/collapse pasted content';
      pChip.dataset.content = patt.content || '';
      pChip.addEventListener('click', function () {
        var existing = this.querySelector('.paste-content');
        if (existing) {
          existing.remove();
        } else {
          var codeBlock = document.createElement('pre');
          codeBlock.className = 'paste-content';
          codeBlock.style.cssText = 'max-height:200px;overflow:auto;margin-top:4px;padding:6px;background:var(--code-bg);border-radius:4px;font-size:11px;white-space:pre-wrap;word-break:break-all;color:var(--fg-2);';
          codeBlock.textContent = this.dataset.content;
          this.appendChild(codeBlock);
        }
      });
      body.appendChild(pChip);
    }

    div.appendChild(body);
    return div;
  }

  /* ─── Assistant message ─── */

  function renderAssistantMessage(msg) {
    var content = getMessageContent(msg);
    var fragment = document.createDocumentFragment();

    // Build the .msg.assistant element (avatar + text body + meta + tool_use blocks)
    var hasText = false;
    var hasTools = false;
    var body = DOM.createElement('div', { className: 'body' });
    var copyText = ''; // raw text for copy button

    // Process content blocks — route by type.
    // Text goes into body, thinking goes before msgDiv, tool_use goes after body (inside msgDiv).
    if (content.blocks && content.blocks.length > 0) {
      var thinkSeq = 0;
      for (var i = 0; i < content.blocks.length; i++) {
        var block = content.blocks[i];
        if (!block || !block.type) continue;

        switch (block.type) {
          case 'text':
            if (block.text && block.text.trim()) {
              var textWrap = DOM.createElement('div', { className: 'msg-text' });
              textWrap.innerHTML = formatContent(block.text);
              body.appendChild(textWrap);
              copyText += block.text + '\n';
              hasText = true;
            }
            break;
          case 'thinking':
          case 'redacted_thinking':
            // Thinking blocks sit outside the assistant message wrapper
            // Skip rendering if user has hidden thinking blocks
            if (!AppState.showThinkingBlocks) break;
            thinkSeq++;
            var tb = renderThinkingBlock(block, thinkSeq);
            if (tb) fragment.appendChild(tb);
            break;
          case 'tool_use':
            // Tool blocks go inside the assistant message, after the text body.
            // Defer append so they render after body but inside msgDiv.
            hasTools = true;
            break;
          // tool_result handled inline in tool card
        }
      }
    } else if (content.text) {
      var textWrap = DOM.createElement('div', { className: 'msg-text' });
      textWrap.innerHTML = formatContent(content.text);
      body.appendChild(textWrap);
      hasText = true;
    }

    // Add translate buttons to manually rendered thinking blocks (e.g. from text content)
    if (!AppState.streaming) {
      var thinkingBlocks = body.querySelectorAll('details.thinking-block:not(.has-translate)');
      for (var tbIdx = 0; tbIdx < thinkingBlocks.length; tbIdx++) {
        var tbEl = thinkingBlocks[tbIdx];
        tbEl.classList.add('has-translate');
        var tbContent = tbEl.querySelector('.thinking-content');
        var tbText = tbContent ? tbContent.textContent || '' : '';
        if (!tbText.trim()) continue;
        var tBtn = DOM.createElement('button', { className: 'translate-btn' },
          '\uD83C\uDF10 ' + (__t('thinking.translate') || 'Translate'));
        tBtn.addEventListener('click', (function (text, btn) {
          return function () {
            if (btn.disabled) return;
            btn.disabled = true;
            btn.textContent = '\u7FFB\u8BD1\u4E2D...';
            var ctxId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
            _pendingTranslations[ctxId] = { block: tbEl, btn: btn };
            API.send('side_question', {
              question: '\u8BF7\u5C06\u4EE5\u4E0B\u82F1\u6587\u7FFB\u8BD1\u4E3A\u4E2D\u6587\uFF0C\u76F4\u63A5\u8F93\u51FA\u7FFB\u8BD1\u7ED3\u679C\u4E0D\u8981\u89E3\u91CA\uFF1A\n\n' + text,
              context_id: ctxId
            });
          };
        })(tbText, tBtn));
        tbEl.appendChild(tBtn);
      }
    }

    // Meta: tokens + timing + copy (only for messages with text)
    if (hasText) {
      var meta = DOM.createElement('div', { className: 'meta' });
      if (msg.tokens) {
        var inp = msg.tokens.input_tokens;
        var out = msg.tokens.output_tokens;
        var fmt = function (n) {
          if (n == null) return '0';
          if (n >= 1000) { var k = n / 1000; return (k >= 100 ? Math.round(k) : parseFloat(k.toFixed(1))) + 'K'; }
          return String(n);
        };
        meta.innerHTML += '<span>\u2191 ' + fmt(inp) + ' \u00B7 \u2193 ' + fmt(out) + '</span>';
      }
      if (msg.duration) {
        meta.innerHTML += '<span>' + msg.duration + '</span>';
      }
      // Copy button — click copies assistant text to clipboard
      var copySpan = DOM.createElement('span', {
        style: 'cursor:pointer;color:var(--accent);'
      }, __t('permission.copy') || 'Copy');
      copySpan.addEventListener('click', function () {
        var fullText = copyText || body.textContent || '';
        var ta = document.createElement('textarea');
        ta.value = fullText;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        ta.style.top = '0';
        ta.style.left = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try {
          document.execCommand('copy');
        } catch (e) {
          // ignore
        }
        document.body.removeChild(ta);
        // Visual feedback
        copySpan.textContent = (__t('permission.copied') || 'Copied!');
        var savedSpan = copySpan;
        setTimeout(function () {
          if (savedSpan.parentNode) savedSpan.textContent = (__t('permission.copy') || 'Copy');
        }, 2000);
      });
      meta.appendChild(copySpan);
      body.appendChild(meta);
    }

    // Create msg.assistant wrapper for avatar + text body (flex row)
    // Tool cards go outside msgDiv in the fragment so they stack vertically
    if (hasText || hasTools || body.children.length > 0) {
      var msgDiv = DOM.createElement('div', { className: 'msg assistant' });
      var avatar = DOM.createElement('div', { className: 'avatar' });
      avatar.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="6" width="18" height="14" rx="3"/><circle cx="9" cy="13" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="13" r="1.5" fill="currentColor" stroke="none"/><path d="M9 18h6" stroke-linecap="round"/><path d="M7 3h10M8 6V3M16 6V3" stroke-linecap="round"/></svg>';
      msgDiv.appendChild(avatar);
      msgDiv.appendChild(body);
      fragment.appendChild(msgDiv);

      // Append tool_use blocks in fragment after msgDiv (outside flex container)
      if (content.blocks && content.blocks.length > 0) {
        for (var j = 0; j < content.blocks.length; j++) {
          var toolBlock = content.blocks[j];
          if (!toolBlock || toolBlock.type !== 'tool_use') continue;
          if (isEditTool(toolBlock.name)) {
            var dv = renderDiffViewer(toolBlock);
            if (dv) fragment.appendChild(dv);
          } else {
            var tc = renderToolCard(toolBlock);
            if (tc) fragment.appendChild(tc);
          }
        }
      }
    }

    return fragment;
  }

  /* ─── Thinking block ─── */

  function renderThinkingBlock(block, seqNum) {
    var text = block.thinking || block.text || '';
    if (!text.trim()) return null;
    var estTokens = Math.round(text.length / 3.5);
    var duration = block._duration_ms ? (block._duration_ms / 1000).toFixed(1) + 's' : null;

    var container = DOM.createElement('details', {
      className: 'thinking-block',
      open: false
    });

    var summary = DOM.createElement('summary', { className: 'thinking-header' });
    var label = 'Thinking';
    if (seqNum && seqNum > 1) label += ' #' + seqNum;
    // Live timer during streaming, final duration when done
    if (duration) {
      summary.innerHTML = label + ' (' + duration + (estTokens ? ', <span class="thinking-tokens">~' + estTokens + ' tokens</span>' : '') + ')';
    } else if (block._startTime) {
      var elapsed = Math.round((Date.now() - block._startTime) / 1000);
      summary.innerHTML =
        '<div class="thinking-dots"><span></span><span></span><span></span></div> ' +
        label + ' <span class="thinking-timer" data-start="' + block._startTime + '">(' + elapsed + 's)</span>' +
        (estTokens ? ' <span class="thinking-tokens">(~' + estTokens + ' tokens)</span>' : '');
      startThinkTimer();
    } else {
      summary.innerHTML =
        '<div class="thinking-dots"><span></span><span></span><span></span></div> ' +
        label + (estTokens ? ' <span class="thinking-tokens">(~' + estTokens + ' tokens)</span>' : '');
    }
    container.appendChild(summary);

    var content = DOM.createElement('div', {
      className: 'thinking-content',
      style: { maxHeight: '400px', overflowY: 'auto' }
    });
    content.textContent = text;
    container.appendChild(content);

    // Translate button (when done — has duration, or viewing history where no streaming is happening)
    if (text.trim() && !AppState.streaming) {
      var btn = DOM.createElement('button', {
        className: 'translate-btn'
      }, '\uD83C\uDF10 ' + (__t('thinking.translate') || 'Translate'));
      btn.addEventListener('click', function () {
        if (block._translating) return;
        block._translating = true;
        btn.textContent = '\u7FFB\u8BD1\u4E2D...';
        btn.disabled = true;
        var contextId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        _pendingTranslations[contextId] = { block: block, btn: btn };
        API.send('side_question', {
          question: '\u8BF7\u5C06\u4EE5\u4E0B\u82F1\u6587\u7FFB\u8BD1\u4E3A\u4E2D\u6587\uFF0C\u76F4\u63A5\u8F93\u51FA\u7FFB\u8BD1\u7ED3\u679C\u4E0D\u8981\u89E3\u91CA\uFF1A\n\n' + text,
          context_id: contextId
        });
      });
      container.appendChild(btn);
    }

    // Translation result
    if (block._translation) {
      var transDiv = DOM.createElement('div', { className: 'thinking-translation' });
      transDiv.textContent = block._translation;
      container.appendChild(transDiv);
    }

    return container;
  }

  /* ─── Tool card ─── */

  function renderToolCard(block) {
    var name = block.name || '';
    var input = block.input || {};
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch (e) { input = {}; }
    }
    var id = block.id || '';

    // Check if this is an edit tool — render diff viewer instead
    if (isEditTool(name)) {
      return renderDiffViewer(block);
    }

    var card = DOM.createElement('div', { className: 'tool-card' });

    // Header
    var header = DOM.createElement('div', { className: 'tool-header' });
    var iconType = getToolIconType(name);
    var filePath = (input.file_path || input.path || '');
    header.innerHTML =
      '<span class="tool-icon ' + iconType + '">' + getToolIcon(iconType) + '</span>' +
      formatToolName(name) +
      (filePath ? ' <span class="tool-file-path">' + escapeHtml(filePath.replace(/^.*[\\/]/, '')) + '</span>' : '') +
      '<span class="tool-time">' + (block.duration || '') + '</span>';
    if (filePath) {
      var openBtn = DOM.createElement('button', {
        className: 'tool-open-btn',
        'data-path': filePath,
        title: __t('tool.open_in_editor') || 'Open in editor',
        style: { background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '11px', marginLeft: 'auto', padding: '0 4px' }
      });
      openBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M12 2h2v2l-1-1-3 3-1-1 3-3-1-1h1zM2 3v11h11V8h-1v5H3V4h5V3H2z"/></svg>';
      openBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        API.send('open_file', { path: this.getAttribute('data-path') });
      });
      header.appendChild(openBtn);
    }
    card.appendChild(header);

    // Body (command preview)
    var cmdText = getToolCommand(name, input);
    if (cmdText) {
      var body = DOM.createElement('div', { className: 'tool-body' });
      body.innerHTML = cmdText;
      card.appendChild(body);
    }

    // Output toggle — auto-expanded during streaming, collapsed when done
    var resultText = getToolResult(block);
    var isStreaming = AppState.streaming;
    if (resultText) {
      var outputToggle = DOM.createElement('div', { className: 'tool-output' });
      var outputLines = resultText.split('\n').filter(function (l) { return l.length > 0; }).length || 1;
      var expanded = isStreaming; // auto-expand during streaming

      outputToggle.innerHTML =
        '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" class="chevron" style="transition:transform 0.15s;' + (expanded ? 'transform:rotate(90deg);' : '') + '"><path d="M4.5 2l6 6-6 6"/></svg> ' +
        'Output (' + outputLines + ' lines)';
      card.appendChild(outputToggle);

      // Output content div — use innerHTML with <br> for newlines
      var outputContent = DOM.createElement('div', {
        className: 'tool-body',
        style: { borderTop: '1px solid var(--border)', margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--fg-2)', maxHeight: '300px', overflowY: 'auto' }
      });
      // Convert newlines to <br> but keep as text via pre-wrap
      outputContent.textContent = resultText;
      if (!expanded) outputContent.style.display = 'none';
      card.appendChild(outputContent);

      outputToggle.addEventListener('click', function () {
        expanded = !expanded;
        outputContent.style.display = expanded ? '' : 'none';
        outputToggle.querySelector('.chevron').style.transform = expanded ? 'rotate(90deg)' : '';
      });
    }

    return card;
  }

  function isEditTool(name) {
    if (!name) return false;
    var n = name.toLowerCase();
    return n.indexOf('edit') !== -1 || n.indexOf('write') !== -1 || n.indexOf('create') !== -1 || n.indexOf('replace') !== -1;
  }

  function getToolIconType(name) {
    if (!name) return 'text';
    var n = name.toLowerCase();
    if (n === 'bash' || n === 'powershell' || n === 'shell' || n === 'terminal' || n.indexOf('command') !== -1) return 'bash';
    if (n.indexOf('edit') !== -1 || n.indexOf('write') !== -1 || n.indexOf('create') !== -1 || n.indexOf('replace') !== -1) return 'edit';
    if (n.indexOf('read') !== -1 || n.indexOf('grep') !== -1 || n.indexOf('search') !== -1 || n.indexOf('glob') !== -1 || n.indexOf('list') !== -1) return 'file';
    if (n.indexOf('web') !== -1 || n.indexOf('fetch') !== -1 || n.indexOf('curl') !== -1) return 'web';
    if (n === 'agent' || n.indexOf('agent') !== -1) return 'agent';
    if (n.indexOf('mcp') !== -1 || n.indexOf('server') !== -1) return 'mcp';
    return 'text';
  }

  function getToolIcon(type) {
    var icons = {
      bash: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2l6 6-6 6-1.5-1.5L7 8 2.5 3.5 4 2z"/></svg>',
      edit: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M12.5 1.5l2 2L5 13l-3 1 1-3 9.5-9.5z"/></svg>',
      file: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h8l3 3v9H2V2zm1 1v10h10V6H9V3H3z"/></svg>',
      web: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zm0 1.5c-1.1 0-2.3.7-3.2 2h6.4c-.9-1.3-2.1-2-3.2-2zm-4 4.5c0 .5.1 1.1.3 1.5h7.4c.2-.4.3-1 .3-1.5s-.1-1.1-.3-1.5H4.3c-.2.4-.3 1-.3 1.5zm.3 3c.9 1.3 2.1 2 3.2 2s2.3-.7 3.2-2H4.3zm9.2-1.5H14A5.5 5.5 0 018 14v-.5c.7 0 1.5-.4 2.2-1.1.7-.7 1.1-1.6 1.3-2.9zm-.9-3h.9A5.5 5.5 0 008 2v.5c.7 0 1.5.4 2.2 1.1.7.7 1.1 1.6 1.3 2.9z"/></svg>',
      agent: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l2 4 4 .5-3 3 1 4.5-4-2.5-4 2.5 1-4.5-3-3L6 5l2-4z"/></svg>',
      mcp: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="4" r="2.5"/><circle cx="4" cy="12" r="2.5"/><circle cx="12" cy="12" r="2.5"/><path d="M8 6.5L4 12m4-5.5l4 5.5" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
      text: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h12v1H2V3zm0 4h12v1H2V7zm0 4h8v1H2v-1z"/></svg>'
    };
    return icons[type] || icons.text;
  }

  function formatToolName(name) {
    if (!name) return 'Tool';
    // Convert camelCase/PascalCase to Title Case with spaces
    var formatted = name.replace(/([a-z])([A-Z])/g, '$1 $2');
    // Capitalize first letter
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
  }

  function getToolCommand(name, input) {
    if (!input) return '';
    var isBash = name && /bash|powershell|shell|terminal|command/i.test(name);
    var cmd = input.command || input.cmd || '';
    if (cmd) {
      var prompt = isBash ? '<span class="cmd-prompt" style="color:var(--accent);margin-right:6px;">$</span>' : '';
      var highlighted;
      try {
        if (isBash && typeof hljs !== 'undefined') {
          highlighted = hljs.highlight(cmd, { language: 'bash' }).value;
        } else {
          highlighted = escapeHtml(cmd);
        }
      } catch (e) {
        highlighted = escapeHtml(cmd);
      }
      return '<pre style="margin:0;white-space:pre-wrap;word-break:break-all;font-size:11px;color:var(--fg-2);">' + prompt + '<span class="cmd-text">' + highlighted + '</span></pre>';
    }
    if (input.file_path) return '<span style="font-size:11px;color:var(--fg-3);">' + escapeHtml(input.file_path) + '</span>';
    if (input.path) return '<span style="font-size:11px;color:var(--fg-3);">' + escapeHtml(input.path) + '</span>';
    if (input.pattern) return '<span style="font-size:11px;color:var(--fg-3);">' + escapeHtml(input.pattern) + '</span>';
    if (input.url) return '<span style="font-size:11px;color:var(--fg-3);">' + escapeHtml(input.url) + '</span>';
    if (input.query) return '<span style="font-size:11px;color:var(--fg-3);">' + escapeHtml(input.query) + '</span>';
    if (input.content) return '<pre style="margin:0;white-space:pre-wrap;word-break:break-all;font-size:11px;color:var(--fg-2);">' + escapeHtml(input.content.slice(0, 500)) + '</pre>';
    if (input.text) return '<span style="font-size:11px;color:var(--fg-3);">' + escapeHtml(input.text.slice(0, 500)) + '</span>';
    return '';
  }

  function getToolResult(block) {
    if (block.result) return block.result;
    if (block.output) return block.output;
    if (block.content) {
      if (typeof block.content === 'string') return block.content;
      if (Array.isArray(block.content)) {
        return block.content.map(function (c) {
          if (typeof c === 'string') return c;
          if (c.text) return c.text;
          return '';
        }).join('\n');
      }
    }
    return '';
  }

  /* ─── Diff viewer (matches old app.js formatEditDiff + extractKeyDetail) ─── */

  function renderDiffViewer(block) {
    var input = block.input || {};
    // input may arrive as a JSON string from some code paths
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch (e) { input = {}; }
    }
    // Try all possible file path fields
    var filePath = input.file_path || input.path || input.filepath || '';
    var oldStr = input.old_string || '';
    var newStr2 = input.new_string || '';
    var newContent = input.content || input.file_content || '';

    var wrap = DOM.createElement('div', { className: 'diff-wrap' });

    // Header
    var header = DOM.createElement('div', { className: 'diff-header' });
    header.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2l1.5 3.5H13l-2.5 2.5.5 3.5L8 9.5 5 11.5l.5-3.5L3 5.5h3.5L8 2z"/></svg> ' +
      'Edit' + (filePath ? ' \u2014 ' + escapeHtml(filePath) : '');
    if (filePath) {
      var openBtn = DOM.createElement('button', {
        className: 'tool-open-btn',
        'data-path': filePath,
        title: __t('tool.open_in_editor') || 'Open in editor',
        style: { background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '11px', marginLeft: 'auto', padding: '0 4px' }
      });
      openBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M12 2h2v2l-1-1-3 3-1-1 3-3-1-1h1zM2 3v11h11V8h-1v5H3V4h5V3H2z"/></svg>';
      openBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        API.send('open_file', { path: this.getAttribute('data-path') });
      });
      header.appendChild(openBtn);
    }
    wrap.appendChild(header);

    // Diff body
    var body = DOM.createElement('div', { className: 'diff-body' });

    if (oldStr && (newStr2 || newContent)) {
      // Inline diff with old_string + new_string
      var oldLines = oldStr.split('\n');
      var newLines = (newStr2 || newContent).split('\n');
      var lineNum = input.line_number || 1;
      renderInlineDiff(body, oldLines, newLines, lineNum);
    } else if (newContent) {
      // Just show new content (e.g. file creation)
      var lines = newContent.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var addLine = DOM.createElement('div', { className: 'diff-line add' });
        addLine.innerHTML = '<span class="ln">' + (i + 1) + '</span><span class="code">' + escapeHtml(lines[i]) + '</span>';
        body.appendChild(addLine);
      }
    } else {
      // Fallback: show whatever input fields exist (matches old app.js extractKeyDetail)
      var detail = extractEditDetail(input);
      if (detail) {
        var pre = DOM.createElement('div', {
          className: 'tool-body',
          style: { borderTop: 'none' }
        });
        pre.textContent = detail;
        body.appendChild(pre);
      } else {
        // Last resort: show full input as JSON
        var jsonStr = JSON.stringify(input, null, 2);
        if (jsonStr !== '{}') {
          var pre2 = DOM.createElement('div', {
            className: 'tool-body',
            style: { borderTop: 'none', fontSize: '10px' }
          });
          pre2.textContent = jsonStr.slice(0, 500);
          body.appendChild(pre2);
        }
      }
    }

    if (body.children.length > 0) {
      wrap.appendChild(body);
    }
    return wrap;
  }

  /** Extract meaningful detail from tool input (matches old app.js extractKeyDetail) */
  function extractEditDetail(input) {
    if (!input || typeof input !== 'object') return null;
    if (input.command) return input.command;
    if (input.cmd) return input.cmd;
    if (input.file_path) return 'File: ' + input.file_path;
    if (input.path) return 'Path: ' + input.path;
    if (input.pattern) return 'Pattern: ' + input.pattern + (input.path ? ' in ' + input.path : '');
    if (input.url) return 'URL: ' + input.url;
    if (input.query) return 'Query: ' + input.query;
    if (input.text) return input.text.slice(0, 500);
    return null;
  }

  function renderInlineDiff(body, oldLines, newLines, startLine) {
    var maxLen = Math.max(oldLines.length, newLines.length);
    var oi = 0, ni = 0;

    while (oi < oldLines.length || ni < newLines.length) {
      if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
        // Context line
        var ctxLine = DOM.createElement('div', { className: 'diff-line ctx' });
        ctxLine.innerHTML = '<span class="ln">' + (startLine + oi) + '</span><span class="code">' + escapeHtml(oldLines[oi]) + '</span>';
        body.appendChild(ctxLine);
        oi++; ni++;
      } else {
        // Deletion
        if (oi < oldLines.length) {
          var delLine = DOM.createElement('div', { className: 'diff-line del' });
          delLine.innerHTML = '<span class="ln">' + (startLine + oi) + '</span><span class="code">' + escapeHtml(oldLines[oi]) + '</span>';
          body.appendChild(delLine);
          oi++;
        }
        // Addition
        if (ni < newLines.length) {
          var addLine = DOM.createElement('div', { className: 'diff-line add' });
          addLine.innerHTML = '<span class="ln">' + (startLine + ni) + '</span><span class="code">' + escapeHtml(newLines[ni]) + '</span>';
          body.appendChild(addLine);
          ni++;
        }
      }
    }
  }

  /* ─── Empty state ─── */

  function renderEmptyState() {
    streamEl.innerHTML =
      '<div class="empty-state">' +
        '<p>' + (__t('app.title') || 'Claude Code Chat') + '</p>' +
        '<p style="font-size:12px;margin-top:8px;">' + (__t('app.empty_hint') || 'Ask a question or send code to get started') + '</p>' +
      '</div>';
  }

  /* ─── Content extraction ─── */

  function getMessageContent(msg) {
    if (!msg) return { text: '', blocks: [] };
    var text = '';
    var blocks = [];
    var attachments = msg.attachments || [];

    // Handle string content
    if (typeof msg.content === 'string') {
      text = msg.content;
      // If content is empty string but msg.message has content, use that instead
      if (!text && msg.message) {
        return getMessageContent(msg.message);
      }
    }
    // Handle array content (modern format)
    else if (Array.isArray(msg.content)) {
      for (var i = 0; i < msg.content.length; i++) {
        var c = msg.content[i];
        if (typeof c === 'string') {
          text += c;
        } else if (c && c.type) {
          blocks.push(c);
          if (c.type === 'text' && c.text) text += c.text;
        }
      }
    }
    // Handle message.message format (history)
    else if (msg.message) {
      return getMessageContent(msg.message);
    }

    // Handle top-level text
    if (msg.text) text += msg.text;

    return { text: text, blocks: blocks, attachments: attachments };
  }

  /* ─── Lazy history loading ─── */

  function loadMoreHistory() {
    if (isLoadingHistory || historyRenderStart <= 0) return;
    var allMsgs = getFilteredMessages();
    if (!allMsgs || allMsgs.length === 0) return;
    isLoadingHistory = true;

    var prevStart = historyRenderStart;
    var loadCount = Math.min(HISTORY_MORE, prevStart);
    var newStart = prevStart - loadCount;

    // Save scroll position before prepending
    var area = document.getElementById('scroll-area');
    var oldScrollHeight = area ? area.scrollHeight : 0;

    // Remove old load-more indicator (first child)
    var indicator = streamEl.querySelector('.history-load-indicator');
    if (indicator) indicator.remove();

    // Render and prepend new batch (skip broken messages)
    var tempFrag = document.createDocumentFragment();
    for (var i = newStart; i < prevStart; i++) {
      try {
        appendRendered(tempFrag, renderMessage(allMsgs[i]));
      } catch (e) {
        console.error('[MessageStream] render error in loadMoreHistory', i, e);
      }
    }
    streamEl.insertBefore(tempFrag, streamEl.firstChild);

    // Add new load-more indicator if still more
    if (newStart > 0) {
      var newIndicator = DOM.createElement('div', {
        className: 'history-load-indicator',
        style: { textAlign: 'center', padding: '6px 8px', fontSize: '10px', color: 'var(--fg-3)', cursor: 'pointer' }
      }, __t('history.load_more', { shown: allMsgs.length - newStart, total: allMsgs.length }));
      newIndicator.addEventListener('click', loadMoreHistory);
      streamEl.insertBefore(newIndicator, streamEl.firstChild);
    }

    // Preserve scroll position after prepend
    if (area) {
      area.scrollTop = area.scrollTop + (area.scrollHeight - oldScrollHeight);
    }

    historyRenderStart = newStart;
    isLoadingHistory = false;
  }

  /* ─── Scroll management ─── */

  function scrollToBottom(force) {
    if (!force && !AppState.autoScroll) return;
    var area = document.getElementById('scroll-area');
    if (area) {
      area.scrollTop = area.scrollHeight;
    }
    // Also scroll open thinking content divs to bottom so latest text is visible
    var openThinking = document.querySelectorAll('.thinking-block[open] .thinking-content');
    for (var si = 0; si < openThinking.length; si++) {
      openThinking[si].scrollTop = openThinking[si].scrollHeight;
    }
    // Also scroll open tool output containers so streaming output follows the tail
    var toolOutputs = document.querySelectorAll('.tool-body');
    for (var ti = 0; ti < toolOutputs.length; ti++) {
      toolOutputs[ti].scrollTop = toolOutputs[ti].scrollHeight;
    }
  }

  /* ─── Content formatting (reuses marked + hljs) ─── */

  function formatContent(text) {
    if (!text) return '';
    // Use marked if available (handles HTML escaping internally)
    var html;
    if (typeof marked !== 'undefined') {
      try {
        html = marked.parse(text);
      } catch (e) {
        return escapeHtml(text);
      }
    } else {
      html = escapeHtml(text);
    }
    // Inject copy buttons into code blocks
    return injectCopyButtons(html);
  }

  function injectCopyButtons(html) {
    // Inject copy buttons into code blocks.  Btn visibility via CSS
    // (.pre-wrapper:hover .copy-code-btn) and click via event delegation
    // on #messages — direct listeners are lost across innerHTML round-trip.
    var div = document.createElement('div');
    div.innerHTML = html;
    var pres = div.querySelectorAll('pre');
    for (var pi = 0; pi < pres.length; pi++) {
      var pre = pres[pi];
      if (pre.querySelector('.copy-code-btn')) continue;
      // Wrap pre in a relative container so the button anchors safely
      var wrapper = document.createElement('div');
      wrapper.className = 'pre-wrapper';
      wrapper.style.position = 'relative';
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);
      var btn = document.createElement('button');
      btn.className = 'copy-code-btn';
      btn.setAttribute('title', (typeof __t === 'function' ? __t('tool.copy') : null) || 'Copy');
      btn.setAttribute('data-action', 'copy-code');
      btn.textContent = 'Copy';
      wrapper.appendChild(btn);
    }
    return div.innerHTML;
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }

  return { render: render, renderMessages: renderMessages, finalizeThinkTimers: finalizeThinkTimers };
})();
