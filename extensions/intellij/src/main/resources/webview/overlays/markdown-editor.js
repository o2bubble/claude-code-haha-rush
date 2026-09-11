/* ═══════════════════════════════════════════════════
   MARKDOWN EDITOR — Structure mode split editor
   Design: vs-code-agent-dark.html — .modal section
   Reference: app.js — struct dialog: moves inputEl into dialog
   ═══════════════════════════════════════════════════ */

var MarkdownEditor = (function () {

  var overlayEl = null;
  var previewEl = null;
  var charCountEl = null;
  var previewTimer = null;
  var inputEl = null;
  var inputWrapper = null;
  var docEscapeBound = null;
  var _inputBound = false;

  function _ensureInputListener() {
    if (_inputBound || !inputEl) return;
    inputEl.addEventListener('input', function () {
      updateCharCount();
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(updatePreview, 200);
    });
    _inputBound = true;
  }

  function open() {
    close();

    // Close other overlays
    if (typeof FilePicker !== 'undefined') FilePicker.close();
    if (typeof SlashAutocomplete !== 'undefined') SlashAutocomplete.close();
    if (typeof EmojiPicker !== 'undefined') EmojiPicker.close();
    if (typeof SideQuestion !== 'undefined') SideQuestion.closeQuick();

    inputEl = document.getElementById('input');
    inputWrapper = inputEl ? inputEl.parentNode : null;  // .input-box wrapper, not entire .input-area
    if (!inputEl || !inputWrapper) return;

    overlayEl = createOverlay();
    document.getElementById('overlay-root').appendChild(overlayEl);

    // Move the real inputEl into the dialog body (matches old app.js openStructDialog)
    var bodyInput = overlayEl.querySelector('.sd-body-input');
    bodyInput.appendChild(inputEl);
    if (inputWrapper) inputWrapper.style.display = 'none';

    setTimeout(function () { inputEl.focus(); updatePreview(); }, 50);

    // Escape closes (document-level)
    docEscapeBound = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); doClose(false); }
    };
    document.addEventListener('keydown', docEscapeBound);
  }

  /** Move inputEl back to input wrapper (matches old app.js moveInputBack) */
  function moveInputBack() {
    if (!inputEl || !inputWrapper) return;
    if (inputEl.parentNode !== inputWrapper) {
      inputWrapper.appendChild(inputEl);
    }
    inputWrapper.style.display = '';
    if (typeof InputArea !== 'undefined' && InputArea.updateSendButton) {
      InputArea.updateSendButton();
    }
  }

  function doClose(clearInput) {
    if (docEscapeBound) { document.removeEventListener('keydown', docEscapeBound); docEscapeBound = null; }
    moveInputBack();
    if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
    if (clearInput && inputEl) {
      inputEl.innerHTML = '';
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // Update send button state after returning
    if (typeof InputArea !== 'undefined' && InputArea.updateSendButton) {
      InputArea.updateSendButton();
    }
  }

  function close() {
    doClose(false);
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

    var modal = DOM.createElement('div', { className: 'modal', style: { maxWidth: '480px', width: '100%' } });

    // Header
    var header = DOM.createElement('div', { className: 'modal-header' });
    charCountEl = DOM.createElement('span', { style: { fontSize: '10px', color: 'var(--fg-3)', fontWeight: '400' } }, '0 chars');
    header.innerHTML = '<span>' + (__t('struct.title') || 'Markdown Editor') + '</span>';
    header.appendChild(charCountEl);
    var closeBtn = DOM.createElement('span', { className: 'close' }, '\u00D7');
    closeBtn.addEventListener('click', function () { doClose(false); });
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // Toolbar
    var toolbar = DOM.createElement('div', {
      style: { padding: '6px 12px', borderBottom: '1px solid var(--border)', display: 'flex', gap: '4px', flexWrap: 'wrap' }
    });

    var tools = [
      { label: 'H2', prefix: '## ' },
      { label: '\u2022 List', prefix: '- ' },
      { label: '1. List', prefix: '1. ' },
      { label: '\u2611', prefix: '- [ ] ' },
      { label: '</>', prefix: '```\n', suffix: '\n```' },
      { label: '\u275D', prefix: '> ' },
      { label: '|', prefix: '---\n' }
    ];

    for (var i = 0; i < tools.length; i++) {
      var t = tools[i];
      var btn = DOM.createElement('button', {
        className: 'modal-btn',
        style: { fontSize: '10px', padding: '2px 8px' }
      }, t.label);
      btn.addEventListener('click', (function (tool) {
        return function () { insertToolbar(tool); };
      })(t));
      toolbar.appendChild(btn);
    }
    modal.appendChild(toolbar);

    // Body: editor container + preview
    var body = DOM.createElement('div', {
      className: 'modal-body',
      style: { display: 'flex', flexDirection: 'column', gap: '10px' }
    });

    // Editor container — inputEl will be moved here
    var editorContainer = DOM.createElement('div', {
      className: 'sd-body-input',
      style: {
        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
        padding: '10px', minHeight: '120px',
        fontFamily: 'var(--font-mono)', fontSize: '11px',
        color: 'var(--fg-2)', background: 'var(--code-bg)',
        outline: 'none'
      }
    });
    body.appendChild(editorContainer);

    var previewLabel = DOM.createElement('div', {
      style: { fontSize: '9px', color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }
    }, 'Preview');
    body.appendChild(previewLabel);

    previewEl = DOM.createElement('div', {
      className: 'sd-preview-content',
      style: {
        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
        padding: '10px', minHeight: '50px', maxHeight: '200px', overflowY: 'auto',
        fontSize: '12px'
      }
    });
    previewEl.innerHTML = '<span style="opacity:0.4;font-style:italic;">' + (__t('struct.preview_placeholder') || 'Preview will appear here') + '</span>';
    body.appendChild(previewEl);

    modal.appendChild(body);

    // Footer
    var footer = DOM.createElement('div', { className: 'modal-footer' });
    footer.innerHTML = '<span style="font-size:10px;color:var(--fg-3);">' + (__t('struct.hint') || 'Enter = new line') + '</span><span style="flex:1;"></span>';
    var cancelBtn = DOM.createElement('button', { className: 'modal-btn' }, __t('struct.cancel') || 'Cancel');
    cancelBtn.addEventListener('click', function () { doClose(true); });
    footer.appendChild(cancelBtn);
    var sendBtn = DOM.createElement('button', { className: 'modal-btn primary' }, __t('struct.send') || 'Send');
    sendBtn.addEventListener('click', function () {
      if (!inputEl || !inputEl.textContent.trim()) return;
      moveInputBack();
      if (typeof InputArea !== 'undefined' && InputArea.sendMessage) {
        InputArea.sendMessage();
      }
      // Remove overlay after sending
      if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
      overlayEl = null;
      if (docEscapeBound) { document.removeEventListener('keydown', docEscapeBound); docEscapeBound = null; }
    });
    footer.appendChild(sendBtn);
    modal.appendChild(footer);

    backdrop.appendChild(modal);

    // Click backdrop → close
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) doClose(false);
    });

    // Ensure inputEl has preview listener (only once)
    _ensureInputListener();

    return backdrop;
  }

  function insertToolbar(tool) {
    if (!inputEl) return;
    var prefix = tool.prefix || '';
    var suffix = tool.suffix || '';
    inputEl.focus();
    var sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && inputEl.contains(sel.anchorNode)) {
      var range = sel.getRangeAt(0);
      range.deleteContents();
      var textNode = document.createTextNode(prefix + suffix);
      range.insertNode(textNode);
      // Place cursor between prefix and suffix for paired inserts
      if (suffix) {
        range.setStart(textNode, prefix.length);
        range.setEnd(textNode, prefix.length);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else {
      inputEl.textContent = (inputEl.textContent || '') + prefix + suffix;
    }
    // Normalize merges adjacent text nodes — prevents cursor/selection glitches
    // that occur when multiple toolbar inserts create fragmented text nodes.
    inputEl.normalize();
    updatePreview();
    updateCharCount();
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function updatePreview() {
    if (!inputEl || !previewEl) return;
    var text = inputEl.innerText || inputEl.textContent || '';
    // Preserve scroll position so rebuild doesn't jump to top
    var oldScrollTop = previewEl.scrollTop;
    var oldScrollHeight = previewEl.scrollHeight;
    if (text.trim()) {
      try {
        if (typeof marked !== 'undefined') {
          previewEl.innerHTML = marked.parse(text);
        } else {
          previewEl.textContent = text;
        }
      } catch (e) {
        previewEl.textContent = text;
      }
    } else {
      previewEl.innerHTML = '<span style="opacity:0.4;font-style:italic;">' + (__t('struct.preview_placeholder') || 'Preview will appear here') + '</span>';
    }
    // Restore proportional scroll position after content update
    if (previewEl.scrollHeight > oldScrollHeight && oldScrollTop > 0) {
      previewEl.scrollTop = oldScrollTop + (previewEl.scrollHeight - oldScrollHeight);
    } else if (oldScrollTop <= 0) {
      previewEl.scrollTop = 0;
    }
  }

  function updateCharCount() {
    if (!inputEl || !charCountEl) return;
    charCountEl.textContent = (inputEl.textContent || '').length + ' chars';
  }

  return { open: open, close: close };
})();
