/* ═══════════════════════════════════════════════════
   SLASH AUTOCOMPLETE — Command dropdown
   Design: vs-code-agent-dark.html — .dropdown
   Spec: design-spec.html §4.2 #11
   Reference: app.js — SLASH_COMMANDS, showSlashDropdown()
   ═══════════════════════════════════════════════════ */

var SlashAutocomplete = (function () {

  var overlayEl = null;
  var listEl = null;
  var activeIndex = 0;
  var onSelect = null;

  var docClickBound = null;
  var docEscapeBound = null;

  function open(triggerEl, callback, initialFilter, fromKeyboard) {
    close();
    onSelect = callback;
    activeIndex = 0;
    overlayEl = createOverlay(initialFilter || '', fromKeyboard);

    // Close other overlays
    if (typeof FilePicker !== 'undefined') FilePicker.close();
    if (typeof EmojiPicker !== 'undefined') EmojiPicker.close();

    document.getElementById('overlay-root').appendChild(overlayEl);

    // Position above input area (same as file picker)
    positionAboveInput();

    // Clicks inside the overlay must not bubble to document
    overlayEl.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    // Click outside closes
    docClickBound = function () { close(); };
    // Escape closes
    docEscapeBound = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    setTimeout(function () {
      document.addEventListener('click', docClickBound);
      document.addEventListener('keydown', docEscapeBound);
    }, 0);

    // Auto-focus filter only for button trigger; keyboard trigger types in main input
    if (!fromKeyboard) {
      var filterInput = overlayEl.querySelector('.dd-search input');
      if (filterInput) setTimeout(function () { filterInput.focus(); }, 50);
    }
  }

  function positionAboveInput() {
    if (!overlayEl) return;
    var inputArea = document.querySelector('.input-area');
    if (!inputArea) return;
    var ir = inputArea.getBoundingClientRect();
    overlayEl.style.position = 'fixed';
    overlayEl.style.left = ir.left + 'px';
    overlayEl.style.width = (ir.width * 0.55) + 'px';
    overlayEl.style.bottom = (window.innerHeight - ir.top + 6) + 'px';
    overlayEl.style.top = 'auto';
    overlayEl.style.maxHeight = Math.min(300, Math.max(120, ir.top - 12)) + 'px';
    overlayEl.style.zIndex = '100';
  }

  function close() {
    if (docClickBound) { document.removeEventListener('click', docClickBound); docClickBound = null; }
    if (docEscapeBound) { document.removeEventListener('keydown', docEscapeBound); docEscapeBound = null; }
    if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
    listEl = null;
  }

  function updateFilter(filterText) {
    if (listEl) {
      activeIndex = 0;
      renderCommands(listEl, filterText);
    }
  }

  function isOpen() {
    return !!overlayEl;
  }

  /** Navigate up in the dropdown list (for external keyboard control from main input) */
  function moveUp() {
    if (!listEl) return;
    var items = listEl.querySelectorAll('.dd-item');
    if (items.length === 0) return;
    activeIndex = Math.max(activeIndex - 1, 0);
    highlightItem(activeIndex);
  }

  /** Navigate down in the dropdown list (for external keyboard control from main input) */
  function moveDown() {
    if (!listEl) return;
    var items = listEl.querySelectorAll('.dd-item');
    if (items.length === 0) return;
    activeIndex = Math.min(activeIndex + 1, items.length - 1);
    highlightItem(activeIndex);
  }

  /** Select active command (called when Enter pressed in main input) */
  function selectActive() {
    if (!listEl) return;
    var items = listEl.querySelectorAll('.dd-item');
    if (activeIndex >= 0 && activeIndex < items.length) {
      var cmd = items[activeIndex].getAttribute('data-cmd');
      if (cmd && onSelect) onSelect(cmd);
    }
    close();
  }

  function createOverlay(initialFilter, fromKeyboard) {
    var dropdown = DOM.createElement('div', { className: 'dropdown' });

    // Search filter
    var searchWrap = DOM.createElement('div', { className: 'dd-search' });
    searchWrap.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="color:var(--fg-3);"><path d="M11.5 7.5a4 4 0 1 0-8 0 4 4 0 0 0 8 0zm.8 3.7l3.4 3.4-1.4 1.4-3.4-3.4"/></svg>';
    var filterInput = DOM.createElement('input', {
      type: 'text',
      placeholder: 'Filter commands...',
      value: initialFilter
    });
    searchWrap.appendChild(filterInput);
    dropdown.appendChild(searchWrap);

    // Command list
    listEl = DOM.createElement('div', { className: 'dd-list' });
    renderCommands(listEl, initialFilter);
    dropdown.appendChild(listEl);

    // Hint
    var hint = DOM.createElement('div', { className: 'dd-hint' });
    hint.innerHTML = '\u2191\u2193 navigate \u00B7 Enter/Tab select \u00B7 Esc close';
    dropdown.appendChild(hint);

    // Keyboard navigation
    filterInput.addEventListener('keydown', function (e) {
      var items = listEl.querySelectorAll('.dd-item');
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, items.length - 1); highlightItem(activeIndex); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); highlightItem(activeIndex); }
      else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        var active = items[activeIndex];
        if (active && onSelect) { onSelect(active.dataset.cmd); close(); }
      } else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    // Live filter as user types
    filterInput.addEventListener('input', function () {
      activeIndex = 0;
      renderCommands(listEl, filterInput.value.toLowerCase());
    });

    return dropdown;
  }

  function renderCommands(list, filter) {
    DOM.empty(list);
    var commands = getBuiltInCommands();
    var filtered = filter ? commands.filter(function (c) {
      return c && c.cmd && (c.cmd.toLowerCase().indexOf(filter) !== -1 || (c.desc && c.desc.toLowerCase().indexOf(filter) !== -1));
    }) : commands.filter(function (c) { return c && c.cmd; });

    if (filtered.length === 0) {
      list.innerHTML = '<div class="dd-item" style="color:var(--fg-3);cursor:default;">No matching commands</div>';
      return;
    }

    for (var i = 0; i < filtered.length; i++) {
      var cmd = filtered[i];
      var item = DOM.createElement('div', {
        className: 'dd-item' + (i === activeIndex ? ' active' : ''),
        'data-cmd': cmd.cmd
      });
      item.innerHTML =
        '<span style="font-weight:600;color:var(--fg-2);">/' + escapeHtml(cmd.cmd) + '</span>' +
        '<span class="path">' + escapeHtml(cmd.desc || '') + '</span>';
      item.addEventListener('click', function (c) {
        return function () {
          if (onSelect) onSelect(c.cmd);
          close();
        };
      }(cmd));
      item.addEventListener('mouseenter', function (idx) {
        return function () { activeIndex = idx; highlightItem(idx); };
      }(i));
      list.appendChild(item);
    }
  }

  function highlightItem(idx) {
    var items = listEl.querySelectorAll('.dd-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', i === idx);
      if (i === idx) items[i].scrollIntoView({ block: 'nearest' });
    }
  }

  /** Hardcoded fallback (backend doesn't send slash_commands) — mirrors old app.js SLASH_COMMANDS */
  var DEFAULT_COMMANDS = [
    { cmd: 'advisor', desc: 'Configure advisor settings' },
    { cmd: 'compact', desc: 'Compact conversation context' },
    { cmd: 'context', desc: 'Show current context usage' },
    { cmd: 'cost', desc: 'Show session cost and duration' },
    { cmd: 'extra-usage', desc: 'Configure extra usage' },
    { cmd: 'files', desc: 'List files in context' },
    { cmd: 'heapdump', desc: 'Dump JS heap' },
    { cmd: 'release-notes', desc: 'View release notes' },
    { cmd: 'copy', desc: 'Copy last assistant response' },
    { cmd: 'rewind', desc: 'Restore code to a previous point' },
    { cmd: 'checkpoint', desc: 'Restore code to a previous point' },
    { cmd: 'skills', desc: 'List all available commands' },
    { cmd: 'status', desc: 'Show IDE status info' },
    { cmd: 'stats', desc: 'Show usage statistics' },
    { cmd: 'init', desc: 'Initialize CLAUDE.md' },
    { cmd: 'insights', desc: 'Generate session report' },
    { cmd: 'memory', desc: 'Recall saved memories' },
    { cmd: 'pr-comments', desc: 'Get GitHub PR comments' },
    { cmd: 'review', desc: 'Review a pull request' },
    { cmd: 'security-review', desc: 'Security review of changes' },
    { cmd: 'statusline', desc: 'Set up status line UI' },
    { cmd: 'config', desc: 'Open config panel' },
    { cmd: 'effort', desc: 'Set effort level' },
    { cmd: 'help', desc: 'Show help and commands' },
    { cmd: 'mcp', desc: 'Manage MCP servers' },
    { cmd: 'permissions', desc: 'Manage permission rules' },
    { cmd: 'plugin', desc: 'Manage plugins' },
    { cmd: 'rename', desc: 'Rename conversation' },
    { cmd: 'resume', desc: 'Resume a conversation' },
    { cmd: 'theme', desc: 'Change the theme' },
    { cmd: 'update-config', desc: 'Configure settings.json & hooks' },
    { cmd: 'debug', desc: 'Enable debug logging' },
    { cmd: 'simplify', desc: 'Review & simplify changed code' }
  ];

  /** Hardcoded base + dynamic from backend (merged in app-new.js system handler) */
  function getBuiltInCommands() {
    var dynamic = AppState.slashCommands || [];
    if (dynamic.length === 0) return DEFAULT_COMMANDS;
    // Merge: dynamic takes precedence, base commands fill gaps
    var seen = {};
    var merged = [];
    for (var i = 0; i < dynamic.length; i++) {
      merged.push(dynamic[i]);
      seen[dynamic[i].cmd] = true;
    }
    for (var j = 0; j < DEFAULT_COMMANDS.length; j++) {
      if (!seen[DEFAULT_COMMANDS[j].cmd]) {
        merged.push(DEFAULT_COMMANDS[j]);
      }
    }
    return merged;
  }

  function escapeHtml(text) {
    if (!text) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }

  return { open: open, close: close, updateFilter: updateFilter, isOpen: isOpen, selectActive: selectActive, moveUp: moveUp, moveDown: moveDown };
})();
