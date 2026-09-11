/* ═══════════════════════════════════════════════════
   FILE PICKER — @Mention hierarchical file tree
   Design: vs-code-agent-dark.html — .dropdown
   Spec: design-spec.html §4.2 #09
   Reference: app.js — @mention, file-picker, getVisibleNodes()
   ═══════════════════════════════════════════════════ */

var FilePicker = (function () {

  var overlayEl = null;
  var filterInput = null;
  var listEl = null;
  var treeData = [];
  var expandedDirs = {};
  var activeIndex = 0;
  var selectCallback = null; // stored callback for use in renderTree

  var docClickBound = null;
  var docEscapeBound = null;

  function open(triggerCallback) {
    close();
    // Close other overlays
    if (typeof SlashAutocomplete !== 'undefined') SlashAutocomplete.close();
    if (typeof EmojiPicker !== 'undefined') EmojiPicker.close();
    overlayEl = createOverlay(triggerCallback);
    document.getElementById('overlay-root').appendChild(overlayEl);
    setTimeout(function () { if (filterInput) filterInput.focus(); }, 50);

    // Clicks inside the overlay must not bubble to document, otherwise
    // renderTree → DOM.empty(listEl) removes the clicked element before
    // the document handler runs, causing contains() to return false → close().
    overlayEl.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    // Click outside closes
    docClickBound = function () { close(); };
    // Escape closes (document-level, works even if filterInput loses focus)
    docEscapeBound = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    setTimeout(function () {
      document.addEventListener('click', docClickBound);
      document.addEventListener('keydown', docEscapeBound);
    }, 0);
  }

  function close() {
    if (docClickBound) { document.removeEventListener('click', docClickBound); docClickBound = null; }
    if (docEscapeBound) { document.removeEventListener('keydown', docEscapeBound); docEscapeBound = null; }
    if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
  }

  function createOverlay(onSelect) {
    selectCallback = onSelect;
    var dropdown = DOM.createElement('div', { className: 'dropdown mention-dropdown' });

    // Search
    var searchWrap = DOM.createElement('div', { className: 'dd-search' });
    searchWrap.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="color:var(--fg-3);"><path d="M11.5 7.5a4 4 0 1 0-8 0 4 4 0 0 0 8 0zm.8 3.7l3.4 3.4-1.4 1.4-3.4-3.4"/></svg>';
    filterInput = DOM.createElement('input', {
      type: 'text',
      placeholder: 'Filter files...'
    });
    searchWrap.appendChild(filterInput);
    dropdown.appendChild(searchWrap);

    // File list
    listEl = DOM.createElement('div', { className: 'mention-dropdown-list' });
    dropdown.appendChild(listEl);

    // Hint
    var hint = DOM.createElement('div', { className: 'dd-hint' });
    hint.innerHTML = '\u2191\u2193 navigate \u00B7 Enter select \u00B7 Esc close';
    dropdown.appendChild(hint);

    // Render initial tree
    renderTree(treeData, '');

    // Search filter
    filterInput.addEventListener('input', function () {
      renderFilteredTree(filterInput.value.toLowerCase());
      activeIndex = 0;
      highlightItem(0);
    });

    // Keyboard navigation
    filterInput.addEventListener('keydown', function (e) {
      var items = listEl.querySelectorAll('.dd-item');
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, items.length - 1); highlightItem(activeIndex); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); highlightItem(activeIndex); }
      else if (e.key === 'ArrowRight') {
        // Expand collapsed directory
        e.preventDefault();
        var activeR = items[activeIndex];
        if (activeR && activeR.dataset.isdir === 'true' && !expandedDirs[activeR.dataset.path]) {
          expandedDirs[activeR.dataset.path] = true;
          renderTree(treeData, filterInput.value.toLowerCase());
          highlightItem(activeIndex);
        }
      }
      else if (e.key === 'ArrowLeft') {
        // Collapse expanded directory
        e.preventDefault();
        var activeL = items[activeIndex];
        if (activeL && activeL.dataset.isdir === 'true' && expandedDirs[activeL.dataset.path]) {
          expandedDirs[activeL.dataset.path] = false;
          renderTree(treeData, filterInput.value.toLowerCase());
          highlightItem(activeIndex);
        }
      }
      else if (e.key === 'Enter') {
        e.preventDefault();
        var active = items[activeIndex];
        if (active) {
          selectFile(active.dataset.path, active.dataset.name, onSelect);
        }
      } else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    // Request file tree from backend
    API.send('request_file_pick');

    return dropdown;
  }

  function setTree(tree) {
    treeData = tree || [];
    if (listEl) renderTree(treeData, filterInput ? filterInput.value.toLowerCase() : '');
  }

  function renderTree(tree, query) {
    if (!listEl) return;
    // The scrollable container is the .dropdown parent, not listEl itself
    var scrollContainer = listEl.closest('.dropdown');
    var prevScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
    DOM.empty(listEl);
    var visible = getFilteredNodes(tree, query);
    if (visible.length === 0) {
      listEl.innerHTML = '<div class="dd-item" style="color:var(--fg-3);cursor:default;">No matching files</div>';
      return;
    }
    for (var i = 0; i < visible.length; i++) {
      var node = visible[i];
      var item = DOM.createElement('div', {
        className: 'dd-item' + (i === activeIndex ? ' active' : ''),
        'data-path': node.path,
        'data-name': node.name,
        'data-isdir': node.isDir ? 'true' : 'false'
      });

      // Build item content as DOM so we can attach separate handlers
      var folderIcon = DOM.createElement('span', { className: 'dd-icon' });
      folderIcon.innerHTML = node.isDir
        ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="color:var(--fg-3);"><path d="M2 5v8l1 1h10l1-1V4.5l-.5-.5h-4l-1-1H3l-1 1z"/></svg>'
        : '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1.5v13l1 .5h8l1-.5V4.5L9.5 1H3l-1 .5z"/></svg>';
      item.appendChild(folderIcon);

      if (!node.isDir) {
        item.style.paddingLeft = (8 + (node._depth || 0) * 16) + 'px';
      }

      var nameSpan = DOM.createElement('span', { className: 'dd-name' });
      nameSpan.textContent = node.name;
      item.appendChild(nameSpan);

      if (node.isDir) {
        var chevron = DOM.createElement('span', {
          className: 'dd-chevron' + (expandedDirs[node.path] ? ' expanded' : '')
        });
        chevron.innerHTML = '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style="transition:transform 0.15s;transform:' + (expandedDirs[node.path] ? 'rotate(0deg)' : 'rotate(-90deg)') + '"><path d="M4 6l4 4 4-4"/></svg>';
        // Chevron click = expand/collapse only (does not select)
        chevron.addEventListener('click', function (dirPath) {
          return function (e) {
            e.stopPropagation();
            expandedDirs[dirPath] = !expandedDirs[dirPath];
            renderTree(treeData, filterInput ? filterInput.value.toLowerCase() : '');
            if (filterInput) filterInput.focus();
          };
        }(node.path));
        item.appendChild(chevron);

        // Click on directory item = select it (like a file)
        item.addEventListener('click', function (n) {
          return function () {
            selectFile(n.path, n.name, selectCallback);
          };
        }(node));
      } else {
        var pathSpan = DOM.createElement('span', { className: 'path' });
        pathSpan.textContent = getParentPath(node.path);
        item.appendChild(pathSpan);

        // Click on file item = select it
        item.addEventListener('click', function (n) {
          return function () {
            selectFile(n.path, n.name, selectCallback);
          };
        }(node));
      }

      listEl.appendChild(item);
    }
    // Restore scroll position after re-render (expanding directories resets it)
    if (scrollContainer) scrollContainer.scrollTop = prevScrollTop;
  }

  function renderFilteredTree(query) {
    renderTree(treeData, query);
  }

  function getFilteredNodes(tree, query) {
    var result = [];
    for (var i = 0; i < tree.length; i++) {
      var node = tree[i];
      node._depth = 0;
      if (query) {
        var nameMatch = node.name.toLowerCase().indexOf(query) !== -1;
        var children = node.children ? filterTreeChildren(node.children, query, 1) : [];
        if (nameMatch || children.length > 0) {
          result.push(node);
          if (node.isDir) result = result.concat(children);
        }
      } else {
        result.push(node);
        if (node.isDir && expandedDirs[node.path] && node.children) {
          addVisibleChildren(node.children, result, 1);
        }
      }
    }
    return result;
  }

  function filterTreeChildren(children, query, depth) {
    var result = [];
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      c._depth = depth;
      var nameMatch = c.name.toLowerCase().indexOf(query) !== -1;
      var grandChildren = c.children ? filterTreeChildren(c.children, query, depth + 1) : [];
      if (nameMatch || grandChildren.length > 0) {
        result.push(c);
        if (c.isDir) result = result.concat(grandChildren);
      }
    }
    return result;
  }

  function addVisibleChildren(children, result, depth) {
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      c._depth = depth;
      result.push(c);
      if (c.isDir && expandedDirs[c.path] && c.children) {
        addVisibleChildren(c.children, result, depth + 1);
      }
    }
  }

  function getParentPath(path) {
    var idx = path.lastIndexOf('/');
    return idx > 0 ? path.slice(0, idx) + '/' : '';
  }

  function selectFile(path, name, callback) {
    if (callback) callback(path, name);
    close();
  }

  function highlightItem(idx) {
    var items = listEl.querySelectorAll('.dd-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', i === idx);
    }
  }

  function escapeHtml(text) {
    if (!text) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }

  return { open: open, close: close, setTree: setTree };
})();
