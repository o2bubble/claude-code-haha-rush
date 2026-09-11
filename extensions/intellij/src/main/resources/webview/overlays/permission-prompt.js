/* ═══════════════════════════════════════════════════
   PERMISSION PROMPT — Tool permission inline card
   Design: vs-code-agent-dark.html — .permit-card
   Spec: design-spec.html §3.6, §4.2 #14
   Variants: terminal (destructive), edit (with diff), read (non-destructive)
   ═══════════════════════════════════════════════════ */

var PermissionPrompt = (function () {

  /** Render a permission prompt card.
   *  data: {
   *    variant: 'terminal' | 'edit' | 'read',
   *    toolName: string,
   *    description: string,
   *    filePath: string,
   *    input: object (optional, tool input params),
   *    onResponse: function(action)
   *  }
   */
  function render(data) {
    var variant = data.variant || 'read';
    var toolName = data.toolName || 'Execute Command';
    var description = data.description || '';
    var filePath = data.filePath || '';
    var input = data.input || {};

    var card = DOM.createElement('div', { className: 'permit-card' });

    // Title bar
    var title = DOM.createElement('div', { className: 'permit-title' });
    var iconColor = variant === 'terminal' ? 'var(--yellow)' : variant === 'edit' ? 'var(--accent)' : 'var(--accent)';
    var titleText = variant === 'terminal'
      ? (__t && __t('permission.pending') || 'Execute Command')
      : variant === 'edit'
        ? (__t && __t('permission.edit') || 'Edit') + (filePath ? ' \u2014 ' + escapeHtml(filePath) : '')
        : (__t && __t('permission.read') || 'Read') + (filePath ? ' \u2014 ' + escapeHtml(filePath) : '');
    title.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="color:' + iconColor + ';">' +
        '<path d="M8 1.5l6 3.5v5.5l-6 3.5-6-3.5V5L8 1.5z"/>' +
      '</svg> ' + escapeHtml(titleText);
    card.appendChild(title);

    // Body — show diff for Edit, command for terminal, path for read
    var body = DOM.createElement('div', { className: 'permit-body' });
    if (variant === 'terminal') {
      var cmd = input.command || input.cmd || '';
      if (cmd) {
        body.innerHTML = '<pre style="margin:0;font-size:11px;white-space:pre-wrap;word-break:break-all;">' + escapeHtml(cmd) + '</pre>';
      } else if (description) {
        body.textContent = description;
      }
    } else if (variant === 'edit') {
      var hasDiff = (input.old_string || input.new_string) || (input.content && input.content.length > 20);
      if (hasDiff) {
        // Build inline diff preview (simplified)
        var oldStr = input.old_string || '';
        var newStr = input.new_string || input.content || '';
        if (oldStr && newStr) {
          var oldLines = oldStr.split('\n');
          var newLines = newStr.split('\n');
          var diffHtml = '';
          var maxLen = Math.max(oldLines.length, newLines.length);
          for (var di = 0; di < maxLen; di++) {
            var ol = di < oldLines.length ? oldLines[di] : null;
            var nl = di < newLines.length ? newLines[di] : null;
            if (ol === nl) {
              diffHtml += '<div class="diff-line ctx"><span class="code" style="font-size:10px;"> ' + escapeHtml(ol) + '</span></div>';
            } else {
              if (ol) diffHtml += '<div class="diff-line del"><span class="code" style="font-size:10px;">- ' + escapeHtml(ol) + '</span></div>';
              if (nl) diffHtml += '<div class="diff-line add"><span class="code" style="font-size:10px;">+ ' + escapeHtml(nl) + '</span></div>';
            }
          }
          body.innerHTML = '<div class="diff-view" style="max-height:240px;overflow-y:auto;margin:0;">' + diffHtml + '</div>';
        } else if (newStr) {
          var addLines = newStr.split('\n');
          var addHtml = '';
          for (var ai = 0; ai < addLines.length; ai++) {
            addHtml += '<div class="diff-line add"><span class="code" style="font-size:10px;">+ ' + escapeHtml(addLines[ai]) + '</span></div>';
          }
          body.innerHTML = '<div class="diff-view" style="max-height:240px;overflow-y:auto;margin:0;">' + addHtml + '</div>';
        }
      } else {
        body.innerHTML = '<span style="font-size:11px;">' + escapeHtml(description || (__t && __t('permission.modify_file') || 'Modify file')) + '</span>';
      }
    } else {
      // Read variant
      body.innerHTML = '<span style="font-size:11px;">Path: ' + escapeHtml(filePath) + '</span>' +
        (description ? '<br><span style="font-size:10px;color:var(--fg-3);">' + escapeHtml(description) + '</span>' : '');
    }
    card.appendChild(body);

    // Actions
    var actions = DOM.createElement('div', { className: 'permit-actions' });

    var _locale = typeof __localeData !== 'undefined' ? __localeData : {};
    var btnData = [
      { label: _locale['permission.allow'] || 'Allow', className: 'allow', action: 'allow' },
      { label: _locale['permission.session_allow'] || 'Session', className: '', action: 'session' },
      { label: _locale['permission.always_allow'] || 'Always', className: '', action: 'always' },
      { label: _locale['permission.deny'] || 'Deny', className: 'deny', action: 'deny' }
    ];

    for (var i = 0; i < btnData.length; i++) {
      var b = btnData[i];
      var btn = DOM.createElement('button', {
        className: 'permit-btn' + (b.className ? ' ' + b.className : '')
      }, b.label);
      btn.addEventListener('click', (function (action) {
        return function () {
          if (data.onResponse) data.onResponse(action);
        };
      })(b.action));
      actions.appendChild(btn);
    }

    card.appendChild(actions);
    return card;
  }

  function escapeHtml(text) {
    if (!text) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }

  return { render: render };
})();
