/* ═══════════════════════════════════════════════════
   INPUT AREA — Compose area with chip + toolbar
   Design: vs-code-agent-dark.html — .input-area
   Spec: design-spec.html §3.10 Input Area, §4.1 #08
   Reference: app.js — sendMessage(), contenteditable handling
   ═══════════════════════════════════════════════════ */

var InputArea = (function () {

  var inputEl = null;
  var sendBtn = null;
  var stopBtn = null;
  var filePickerOverlay = null;
  var pastedContents = [];
  var nextPasteId = 0;
  var PASTE_THRESHOLD = 500;

  function render(container) {
    DOM.empty(container);

    // Input box (contenteditable — always true; disable via CSS class)
    var inputBox = DOM.createElement('div', { className: 'input-box' });
    inputEl = DOM.createElement('div', {
      id: 'input',
      contentEditable: true,
      'data-placeholder': __t('input.placeholder_connected')
    });
    if (AppState.connection !== 'connected') {
      inputBox.classList.add('input-disconnected');
    }

    inputBox.appendChild(inputEl);
    container.appendChild(inputBox);

    // Toolbar
    var toolbar = DOM.createElement('div', { className: 'input-toolbar' });

    // @ mention button
    var atBtn = createToolButton('@', __t('input.attach_files') || __t('toolbar.at_mention') || '@mention file', function () {
      if (typeof SlashAutocomplete !== 'undefined') SlashAutocomplete.close();
      if (typeof EmojiPicker !== 'undefined') EmojiPicker.close();
      FilePicker.open(function (path, name) {
        InputArea.insertFileChip(path, name);
      });
    });
    toolbar.appendChild(atBtn);

    // / slash command button (toggle: opens with filter focused, closes if already open)
    var slashBtn = createToolButton('/', __t('toolbar.slash_cmd') || 'Slash commands', function () {
      if (typeof FilePicker !== 'undefined') FilePicker.close();
      if (typeof EmojiPicker !== 'undefined') EmojiPicker.close();
      if (SlashAutocomplete.isOpen && SlashAutocomplete.isOpen()) {
        SlashAutocomplete.close();
        return;
      }
      SlashAutocomplete.open(slashBtn, selectSlashCommand, '', false);
    });
    toolbar.appendChild(slashBtn);

    // Side question (BTW) button
    var btwBtn = createToolButton(
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zm0 2.5c-.7 0-1.2.5-1.2 1.2 0 .6.5 1.2 1.2 1.2.6 0 1.2-.5 1.2-1.2 0-.7-.5-1.2-1.2-1.2zm0 4c-.4 0-.8.3-.8.8v2.5c0 .4.3.8.8.8s.8-.3.8-.8V8.3c0-.5-.3-.8-.8-.8z"/></svg>',
      __t('toolbar.side_question') || 'Side question',
      function () {
        if (typeof FilePicker !== 'undefined') FilePicker.close();
        if (typeof SlashAutocomplete !== 'undefined') SlashAutocomplete.close();
        if (typeof EmojiPicker !== 'undefined') EmojiPicker.close();
        if (typeof SideQuestion !== 'undefined' && SideQuestion.openQuickAsk) {
          SideQuestion.openQuickAsk();
        }
      }
    );
    toolbar.appendChild(btwBtn);

    // Structure mode button
    var structBtn = createToolButton(
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.5v11l.5.5h5l.5-.5v-11l-.5-.5h-5l-.5.5zM3 4h1v1H3V4zm8-1.5l-.5.5h-5l-.5.5v1l.5.5h5l.5-.5V3l-.5-.5z"/></svg>',
      __t('toolbar.structure_editor') || 'Structure editor',
      function () {
        if (typeof FilePicker !== 'undefined') FilePicker.close();
        if (typeof SlashAutocomplete !== 'undefined') SlashAutocomplete.close();
        if (typeof EmojiPicker !== 'undefined') EmojiPicker.close();
        MarkdownEditor.open();
      }
    );
    toolbar.appendChild(structBtn);

    // Emoji button
    var emojiBtn = createToolButton(
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="6.5"/><circle cx="5.5" cy="7" r="1"/><circle cx="10.5" cy="7" r="1"/><path d="M5 10.5c1 1.5 5 1.5 6 0"/></svg>',
      __t('toolbar.emoji_picker') || 'Emoji',
      function () {
        if (typeof FilePicker !== 'undefined') FilePicker.close();
        if (typeof SlashAutocomplete !== 'undefined') SlashAutocomplete.close();

        // Save cursor position BEFORE opening picker — clicking the emoji
        // toolbar button steals focus, so we must snapshot the selection now.
        // Store as a Range clone that survives DOM changes.
        var sel = window.getSelection();
        var savedRange = null;
        if (sel.rangeCount > 0) {
          var r = sel.getRangeAt(0);
          if (inputEl.contains(r.commonAncestorContainer)) {
            savedRange = r.cloneRange();
          }
        }

        EmojiPicker.open(function (emoji) {
          if (inputEl) {
            // Clean up stray <br> tags that browsers insert in empty
            // contenteditable divs — prevents emoji landing on a new line
            var brs = inputEl.querySelectorAll('br');
            for (var bi = 0; bi < brs.length; bi++) brs[bi].remove();

            // Restore saved selection, or place cursor at end of input
            var sel = window.getSelection();
            if (savedRange) {
              sel.removeAllRanges();
              sel.addRange(savedRange);
            } else {
              // No saved position — put cursor at end of input
              var lastChild = inputEl.lastChild;
              while (lastChild && lastChild.nodeType === 1 && lastChild.tagName !== 'BR') {
                lastChild = lastChild.lastChild || lastChild.previousSibling;
              }
              inputEl.focus();
              var range = document.createRange();
              if (inputEl.lastChild) {
                range.setStartAfter(inputEl.lastChild);
              } else {
                range.setStart(inputEl, 0);
              }
              range.collapse(true);
              sel.removeAllRanges();
              sel.addRange(range);
            }

            // Insert emoji at cursor position
            var range = sel.getRangeAt(0);
            if (inputEl.contains(range.commonAncestorContainer)) {
              range.deleteContents();
              var textNode = document.createTextNode(emoji);
              range.insertNode(textNode);
              // Move cursor past the inserted emoji
              range.setStartAfter(textNode);
              range.collapse(true);
              sel.removeAllRanges();
              sel.addRange(range);
            }

            updateEmptyState();
            updateSendButton();
          }
        });
      }
    );
    toolbar.appendChild(emojiBtn);

    // Quick commands dropdown (self-contained, not a separate overlay)
    var qcDropdownEl = null;
    var qcBtn = createToolButton(
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3l5 4H3l5-4zM8 13l-5-4h10l-5 4z"/></svg> ' + (__t('quickcmd.label') || 'Quick'),
      __t('quickcmd.label') || 'Quick commands',
      function () {
        if (qcDropdownEl && qcDropdownEl.style.display !== 'none') {
          qcDropdownEl.style.display = 'none';
          return;
        }
        if (!qcDropdownEl) {
          qcDropdownEl = DOM.createElement('div', {
            style: {
              position: 'fixed', bottom: '52px', left: '50%', transform: 'translateX(-50%)',
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', minWidth: '220px', maxWidth: '300px',
              zIndex: 9999, padding: '4px 0', fontSize: '12px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
            }
          });
          document.body.appendChild(qcDropdownEl);
        }
        // Render items
        DOM.empty(qcDropdownEl);
        var cmds = AppState.quickCommands || [];
        if (cmds.length === 0) {
          qcDropdownEl.appendChild(DOM.createElement('div', {
            style: { padding: '8px 12px', color: 'var(--fg-3)', fontStyle: 'italic', textAlign: 'center' }
          }, (__t('quickcmd.empty') || 'No custom commands yet.')));
        } else {
          for (var qi = 0; qi < cmds.length; qi++) {
            (function (text) {
              var name = cmds[qi].name || cmds[qi].cmd || '';
              var cmd = cmds[qi].command || cmds[qi].cmd || '';
              var item = DOM.createElement('div', {
                className: 'dd-item',
                style: { cursor: 'pointer', padding: '6px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
              });
              item.innerHTML =
                '<span><strong>' + (name ? escapeHtml(name) : '') + '</strong></span>' +
                '<span style="color:var(--fg-3);font-size:10px;margin-left:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px;">' + escapeHtml(cmd.substring(0, 40)) + '</span>';
              item.addEventListener('click', function () {
                qcDropdownEl.style.display = 'none';
                var ie = document.getElementById('input');
                if (ie && text) {
                  ie.textContent = text;
                  updateSendButton && updateSendButton();
                  sendMessage && sendMessage();
                }
              });
              qcDropdownEl.appendChild(item);
            })(cmds[qi].command || cmds[qi].cmd || '');
          }
        }
        // Manage button
        var mgmt = DOM.createElement('div', {
          style: { cursor: 'pointer', color: 'var(--accent)', padding: '6px 12px', borderTop: '1px solid var(--border)' }
        }, (__t('quickcmd.manage') || 'Manage commands...'));
        mgmt.addEventListener('click', function () {
          qcDropdownEl.style.display = 'none';
          QuickCommandManager.open();
        });
        qcDropdownEl.appendChild(mgmt);
        qcDropdownEl.style.display = '';
        // Close on click outside (delayed to avoid immediate close from current click)
        setTimeout(function () {
          document.addEventListener('click', function _closeQc(e) {
            if (qcDropdownEl && !qcDropdownEl.contains(e.target)) {
              qcDropdownEl.style.display = 'none';
              document.removeEventListener('click', _closeQc);
            }
          });
        }, 0);
      }
    );
    toolbar.appendChild(qcBtn);

    // Send button
    sendBtn = DOM.createElement('span', {
      className: 'tool send',
      title: __t('send.btn') || 'Send',
      style: { marginLeft: 'auto' }
    });
    sendBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1 1l14 7L1 15V9l10-2L1 5V1z"/></svg>';
    sendBtn.addEventListener('click', sendMessage);
    toolbar.appendChild(sendBtn);

    // Stop/interrupt button (hidden by default)
    stopBtn = DOM.createElement('span', {
      className: 'tool stop',
      title: __t('toolbar.stop') || __t('interrupt.btn') || 'Stop',
      style: { marginLeft: 'auto', display: 'none' }
    });
    stopBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>';
    stopBtn.addEventListener('click', function () { API.send('interrupt'); });
    toolbar.appendChild(stopBtn);

    container.appendChild(toolbar);

    // Subscribe to connection state — toggle visual disable, not contentEditable
    AppState.subscribe('connection', function (val) {
      var connected = val === 'connected';
      inputBox.classList.toggle('input-disconnected', !connected);
      inputEl.dataset.placeholder = connected
        ? __t('input.placeholder_connected')
        : __t('input.placeholder_disconnected');
    });

    // Subscribe to streaming state (toggle send/stop)
    AppState.subscribe('streaming', function (val) {
      if (sendBtn) sendBtn.style.display = val ? 'none' : '';
      if (stopBtn) stopBtn.style.display = val ? '' : 'none';
    });

    // Prevent editing inside chips — contentEditable=false is not fully enforced
    // by Chromium WebView: cursor can land inside and typing can mutate chip text
    inputEl.addEventListener('beforeinput', function (e) {
      var sel = getSelection();
      if (sel && sel.anchorNode) {
        var node = sel.anchorNode;
        while (node && node !== inputEl) {
          if (node.nodeType === 1 && node.classList && node.classList.contains('chip-inline')) {
            e.preventDefault();
            return;
          }
          node = node.parentNode;
        }
      }
    });

    // Input event handlers
    inputEl.addEventListener('input', function () {
      updateEmptyState();
      updateSendButton();
      // If SlashAutocomplete is open, sync filter from input text
      if (typeof SlashAutocomplete !== 'undefined' && SlashAutocomplete.isOpen && SlashAutocomplete.isOpen()) {
        var text = getInputText();
        if (text.indexOf('/') === 0) {
          SlashAutocomplete.updateFilter(text.slice(1).toLowerCase());
        } else {
          SlashAutocomplete.close();
        }
      }
    });

    /** Shared callback for slash command selection — clears input, inserts /cmd, focuses */
    function selectSlashCommand(cmd) {
      if (inputEl) {
        // Clear input first (old code uses textContent = — replaces partial "/ski" with "/skills ")
        inputEl.innerHTML = '';
        var textNode = document.createTextNode('/' + cmd + ' ');
        inputEl.appendChild(textNode);
        updateEmptyState();
        updateSendButton();
        // Focus input so user can press Enter to send (matches old confirmSlashSelection)
        inputEl.focus();
        // Place cursor at end of text
        var range = document.createRange();
        range.selectNodeContents(inputEl);
        range.collapse(false);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }

    // Paste handler — strip rich formatting, only plain text (matches old app.js)
    inputEl.addEventListener('paste', function (e) {
      e.preventDefault();
      var clipboardData = e.clipboardData || window.clipboardData;
      if (!clipboardData) return;
      // Handle image files via clipboard
      var files = clipboardData.files;
      if (files && files.length > 0) {
        for (var fi = 0; fi < files.length; fi++) {
          if (files[fi].type.indexOf('image/') === 0) {
            insertImagePaste(files[fi]);
            return;
          }
        }
      }
      var text = clipboardData.getData('text/plain');
      if (!text) return;
      if (text.length > PASTE_THRESHOLD) {
        insertPasteChip(text);
        return;
      }
      // Insert as plain text node to avoid rich formatting
      var sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && inputEl.contains(sel.anchorNode)) {
        var range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        // fallback when cursor outside input — avoid inserting after trailing <br>
        var trailingBr = inputEl.lastChild && inputEl.lastChild.nodeName === 'BR' ? inputEl.lastChild : null;
        if (trailingBr) {
          inputEl.insertBefore(document.createTextNode(text), trailingBr);
        } else {
          inputEl.appendChild(document.createTextNode(text));
        }
      }
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    });

    inputEl.addEventListener('keydown', function (e) {
      // In Markdown editor mode, let Enter create newlines (don't send)
      if (inputEl.parentNode && inputEl.parentNode.classList && inputEl.parentNode.classList.contains('sd-body-input')) {
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
          // Let browser handle Enter=newline; Tab still selects slash commands
        }
        return;
      }
      // When SlashAutocomplete is open, Arrow keys navigate the dropdown list
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
          typeof SlashAutocomplete !== 'undefined' && SlashAutocomplete.isOpen && SlashAutocomplete.isOpen()) {
        e.preventDefault();
        if (e.key === 'ArrowUp') SlashAutocomplete.moveUp();
        else SlashAutocomplete.moveDown();
        return;
      }
      // When SlashAutocomplete is open, Enter / Tab selects the active command (not send)
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        if (typeof SlashAutocomplete !== 'undefined' && SlashAutocomplete.isOpen && SlashAutocomplete.isOpen()) {
          e.preventDefault();
          SlashAutocomplete.selectActive();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          sendMessage();
        }
        return;
      }
      // @-mention trigger — only at start or after whitespace
      if (e.key === '@') {
        var text = getInputText();
        if (text === '' || /[\s\n]$/.test(text)) {
          e.preventDefault();
          if (typeof SlashAutocomplete !== 'undefined') SlashAutocomplete.close();
          if (typeof EmojiPicker !== 'undefined') EmojiPicker.close();
          FilePicker.open(function (path, name) {
            InputArea.insertFileChip(path, name);
          });
          return;
        }
      }
      // / slash command trigger — only when input is empty
      if (e.key === '/') {
        var slashText = getInputText();
        if (slashText === '') {
          // Let / be inserted, then open dropdown (no auto-focus filter: user types in main input)
          setTimeout(function () {
            if (typeof FilePicker !== 'undefined') FilePicker.close();
            if (typeof EmojiPicker !== 'undefined') EmojiPicker.close();
            SlashAutocomplete.open(slashBtn, selectSlashCommand, '', true);
          }, 5);
          return;
        }
      }
    });

    // Initial state
    updateEmptyState();
    updateSendButton();

    return container;
  }

  function createToolButton(innerHTML, title, onClick) {
    var btn = DOM.createElement('span', { className: 'tool', title: title });
    btn.innerHTML = innerHTML;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function updateEmptyState() {
    if (!inputEl) return;
    var text = inputEl.textContent || '';
    inputEl.classList.toggle('is-empty', !text.trim());
    // Ensure a <br> is present so Chromium can place the cursor
    if (!text.trim() && !inputEl.querySelector('br')) {
      inputEl.appendChild(document.createElement('br'));
    }
  }

  function updateSendButton() {
    if (!sendBtn) return;
    var text = getInputText();
    sendBtn.disabled = !text.trim();
    if (sendBtn.disabled) {
      sendBtn.style.opacity = '0.4';
      sendBtn.style.cursor = 'default';
    } else {
      sendBtn.style.opacity = '';
      sendBtn.style.cursor = '';
    }
  }

  function getInputText() {
    if (!inputEl) return '';
    var text = '';
    for (var i = 0; i < inputEl.childNodes.length; i++) {
      var node = inputEl.childNodes[i];
      if (node.nodeType === 3) {
        text += node.textContent;
      } else if (node.nodeType === 1 && node.classList.contains('paste-chip')) {
        var pid = parseInt(node.dataset.pasteId);
        var paste = pastedContents[pid];
        if (paste) {
          text += '[Pasted text #' + (pid + 1) + ' +' + paste.lines + ' lines]';
        }
      } else if (node.nodeType === 1 && node.classList.contains('chip-inline') && node.classList.contains('image-chip')) {
        text += '[Image: ' + (node.dataset.path || 'pasted-image') + ']';
      } else if (node.nodeType === 1 && node.classList.contains('selection-chip')) {
        var sf = node.dataset.filePath;
        var sl = parseInt(node.dataset.startLine);
        var el = parseInt(node.dataset.endLine);
        text += '[' + sf + ':' + (sl === el ? sl : sl + '-' + el) + ']';
      } else if (node.nodeType === 1 && !node.classList.contains('placeholder')) {
        text += node.textContent || '';
      }
    }
    return text.trim();
  }

  function sendMessage() {
    if (sendBtn && sendBtn.disabled) return;
    var text = getInputText();
    if (!text.trim()) return;

    // Collect file attachments from chips
    var attachments = [];
    var chips = inputEl.querySelectorAll('.chip-inline');
    for (var i = 0; i < chips.length; i++) {
      if (chips[i].dataset.path) {
        var att = { path: chips[i].dataset.path };
        if (chips[i].dataset.mediaType) att.mediaType = chips[i].dataset.mediaType;
        attachments.push(att);
      }
    }
    // Collect paste chips as attachments with full content
    var pasteChips = inputEl.querySelectorAll('.paste-chip');
    for (var pci = 0; pci < pasteChips.length; pci++) {
      var pid = parseInt(pasteChips[pci].dataset.pasteId);
      var paste = pastedContents[pid];
      if (paste) {
        attachments.push({
          path: '[Pasted #' + (pid + 1) + ' +' + paste.lines + ' lines]',
          content: paste.content,
          language: '',
          kind: 'paste'
        });
      }
    }
    // Collect selection chips as attachments
    var selectionChips = inputEl.querySelectorAll('.selection-chip');
    for (var sci = 0; sci < selectionChips.length; sci++) {
      var sc = selectionChips[sci];
      attachments.push({
        kind: 'selection',
        filePath: sc.dataset.filePath,
        startLine: parseInt(sc.dataset.startLine),
        endLine: parseInt(sc.dataset.endLine)
      });
    }

    // 1. Send to backend FIRST (must not be blocked by render errors)
    API.send('user_message', { content: text, attachments: attachments });

    // 2. Clear input immediately (matches old app.js order)
    inputEl.innerHTML = '';
    updateEmptyState();
    updateSendButton();

    // 3. Optimistic render: add user message to list (non-blocking for send)
    try {
      var userMsg = {
        role: 'user',
        type: 'user',
        content: text,
        attachments: attachments
      };
      var msgs = AppState.messages.concat([userMsg]);
      AppState.set('messages', msgs);
    } catch (e) {
      console.error('[InputArea] optimistic render failed', e);
    }

    // 4. Signal thinking state locally + enable stop button
    AppState.setMany({
      statusText: __t('status.thinking') || 'Thinking...',
      streaming: true
    });
  }

  /** Insert a file chip at cursor position */
  function insertFileChip(path, name) {
    if (!inputEl) return;
    var chip = DOM.createElement('span', {
      className: 'chip-inline',
      contentEditable: false,
      'data-path': path
    });
    chip.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1.5v13l1 .5h8l1-.5V4.5L9.5 1H3l-1 .5z"/></svg> ' +
      escapeHtml(name || path) +
      ' <span class="x">&times;</span>';

    // Close button removes chip
    chip.querySelector('.x').addEventListener('click', function () {
      chip.parentNode.removeChild(chip);
      inputEl.focus();
      updateSendButton();
    });

    // Always append chip at end of input to avoid nesting inside existing chips.
    // Then add a trailing space and place cursor there so typing stays outside the chip.
    // Insert before any trailing <br> (from updateEmptyState) to avoid extra blank line.
    var trailingBr = inputEl.lastChild && inputEl.lastChild.nodeName === 'BR' ? inputEl.lastChild : null;
    if (trailingBr) {
      inputEl.insertBefore(chip, trailingBr);
      inputEl.insertBefore(document.createTextNode(' '), trailingBr);
    } else {
      inputEl.appendChild(chip);
      var space = document.createTextNode(' ');
      inputEl.appendChild(space);
    }

    inputEl.focus();
    var r = document.createRange();
    r.setStartAfter(space);
    r.collapse(true);
    var s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);

    updateEmptyState();
    updateSendButton();
  }

  /** Ensure every chip has text node padding on both sides so cursor can move freely */
  function normalizeChipBoundaries() {
    if (!inputEl) return;
    var chips = inputEl.querySelectorAll('.chip-inline, .paste-chip, .selection-chip');
    // Process in reverse to avoid index issues
    for (var i = chips.length - 1; i >= 0; i--) {
      var chip = chips[i];
      // Ensure a text node exists AFTER the chip
      if (!chip.nextSibling || chip.nextSibling.nodeType !== 3) {
        chip.parentNode.insertBefore(document.createTextNode(' '), chip.nextSibling);
      }
      // Ensure a text node exists BEFORE the chip
      if (!chip.previousSibling || chip.previousSibling.nodeType !== 3) {
        chip.parentNode.insertBefore(document.createTextNode(' '), chip);
      }
    }
  }

  function escapeHtml(text) {
    if (!text) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }

  /** Insert a paste chip for large pasted text (matches old app.js insertPasteChip) */
  function insertPasteChip(text) {
    if (!inputEl) return;
    var id = nextPasteId++;
    var lines = text.split('\n').length;
    pastedContents[id] = { content: text, lines: lines };
    var chip = DOM.createElement('span', { className: 'paste-chip', contentEditable: false });
    chip.dataset.pasteId = String(id);
    var label = (__t('chip.pasted_prefix') || 'Pasted') + ' #' + (id + 1);
    if (lines > 1) label += ' +' + lines + ' ' + (__t('chip.pasted_lines', { n: lines }) || 'lines');
    chip.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M4 3v10l1 1h8l1-1V4.5l-.5-.5h-4l-1-1H5l-1 1z"/></svg> ' +
      escapeHtml(label) +
      ' <span class="x">&times;</span>';
    chip.querySelector('.x').addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      delete pastedContents[parseInt(chip.dataset.pasteId)];
      chip.remove();
      updateSendButton();
    });
    // Insert before trailing <br> to avoid extra blank line (matches insertFileChip)
    var trailingBr = inputEl.lastChild && inputEl.lastChild.nodeName === 'BR' ? inputEl.lastChild : null;
    var space = document.createTextNode(' ');
    if (trailingBr) {
      inputEl.insertBefore(chip, trailingBr);
      inputEl.insertBefore(space, trailingBr);
    } else {
      inputEl.appendChild(chip);
      inputEl.appendChild(space);
    }
    inputEl.focus();
    var r = document.createRange();
    r.setStartAfter(space);
    r.collapse(true);
    var s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    updateEmptyState();
    updateSendButton();
  }

  /** Handle image paste from clipboard (matches old app.js paste handler) */
  function insertImagePaste(file) {
    var reader = new FileReader();
    reader.onload = function (event) {
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        var pngDataUrl = canvas.toDataURL('image/png');
        var filename = 'pasted-image-' + Date.now() + '.png';
        insertImageChip(filename, pngDataUrl);
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  }

  /** Insert an image chip (matches old app.js insertImageChip) */
  function insertImageChip(filename, dataUrl) {
    if (!inputEl) return;
    var chip = DOM.createElement('span', { className: 'chip-inline image-chip', contentEditable: false });
    chip.dataset.path = filename;
    chip.dataset.mediaType = 'image/png';
    chip.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h12v12H2V2zm1 1v10h10V5.5L10 3H3z"/></svg> ' +
      escapeHtml(filename) +
      ' <span class="x">&times;</span>';
    chip.querySelector('.x').addEventListener('click', function () {
      chip.remove();
      updateSendButton();
    });
    inputEl.appendChild(chip);
    updateEmptyState();
    updateSendButton();
  }

  /** Insert a selection chip (matches old app.js insertSelectionChip) */
  function insertSelectionChip(filePath, startLine, endLine) {
    if (!inputEl) return;
    var chip = DOM.createElement('span', { className: 'selection-chip', contentEditable: false });
    chip.dataset.filePath = filePath;
    chip.dataset.startLine = String(startLine);
    chip.dataset.endLine = String(endLine);
    var lineLabel = startLine === endLine ? String(startLine) : startLine + '-' + endLine;
    chip.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h12v12H2V2zm1 1v10h10V5.5L10 3H3z"/></svg> ' +
      escapeHtml(filePath) + ' (' + lineLabel + ')' +
      ' <span class="x">&times;</span>';
    chip.querySelector('.x').addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      chip.remove();
      inputEl.focus();
      updateSendButton();
    });
    // Insert before trailing <br> to avoid extra blank line (matches insertFileChip)
    var trailingBr = inputEl.lastChild && inputEl.lastChild.nodeName === 'BR' ? inputEl.lastChild : null;
    var space = document.createTextNode(' ');
    if (trailingBr) {
      inputEl.insertBefore(chip, trailingBr);
      inputEl.insertBefore(space, trailingBr);
    } else {
      inputEl.appendChild(chip);
      inputEl.appendChild(space);
    }
    inputEl.focus();
    var r = document.createRange();
    r.setStartAfter(space);
    r.collapse(true);
    var s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    updateEmptyState();
    updateSendButton();
  }

  return { render: render, insertFileChip: insertFileChip, updateSendButton: updateSendButton, sendMessage: sendMessage, insertSelectionChip: insertSelectionChip };
})();
