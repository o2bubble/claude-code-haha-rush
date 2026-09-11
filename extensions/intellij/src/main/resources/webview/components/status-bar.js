/* ═══════════════════════════════════════════════════
   STATUS BAR — Connection, mode, model, context, status
   Design: vs-code-agent-dark.html — .status-bar
   Spec: design-spec.html §3.11, §4.1 #07
   ═══════════════════════════════════════════════════ */

var StatusBarComponent = (function () {

  var barEl = null;

  function render(container) {
    barEl = DOM.createElement('div', { className: 'status-bar', id: 'status-bar-new' });

    // ── Connection indicator ──
    var connItem = DOM.createElement('span', { className: 'status-item', id: 'status-connection' });
    connItem.innerHTML =
      '<span class="dot-indicator ' + getConnectionColor(AppState.connection) + '"></span> ' +
      (AppState.connection === 'connected' ? (__t('status.connected') || 'connected') : AppState.connection);
    barEl.appendChild(connItem);

    // ── Permission mode pill with dropdown (design: "Permission Mode Selector") ──
    // Values MUST match backend ideMode.ts:2359 validModes
    var permModes = [
      { value: 'default',            label: __t('permission.mode_default') || 'Default',            desc: __t('permission.mode_default_desc') || 'Ask on risky actions' },
      { value: 'acceptEdits',        label: __t('permission.mode_accept_edits') || 'Accept Edits',   desc: __t('permission.mode_accept_edits_desc') || 'Auto-approve file edits' },
      { value: 'plan',               label: __t('permission.mode_plan') || 'Plan Mode',              desc: __t('permission.mode_plan_desc') || 'Plan first, then execute' },
      { value: 'bypassPermissions',  label: __t('permission.mode_bypass') || 'Bypass',              desc: __t('permission.mode_bypass_desc') || 'Auto-approve all actions' },
      { value: 'dontAsk',            label: __t('permission.mode_dont_ask') || "Don't Ask",         desc: __t('permission.mode_dont_ask_desc') || 'Remember last choice' }
    ];
    var currentPermMode = AppState.permissionMode || 'default';

    function findPermMode(val) {
      for (var p = 0; p < permModes.length; p++) {
        if (permModes[p].value === val) return permModes[p];
      }
      return permModes[0];
    }

    var curPerm = findPermMode(currentPermMode);

    var permWrap = DOM.createElement('span', {
      className: 'status-pill perm-mode-pill',
      style: { position: 'relative', cursor: 'pointer' },
      title: __t('permission.mode_tooltip') || 'Permission mode'
    });
    permWrap.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style="margin-right:2px;"><path d="M8 1l5 2.5V6c0 3.3-2 6.3-5 7-3-1.7-5-4.7-5-7V3.5L8 1z"/></svg> ' +
      '<span class="perm-mode-label">' + curPerm.label + '</span>' +
      '<svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor" style="margin-left:2px;opacity:0.5;"><path d="M4 6l4 4 4-4"/></svg>';
    barEl.appendChild(permWrap);

    var permDropdown = DOM.createElement('div', {
      className: 'perm-dropdown dropdown',
      style: { display: 'none', position: 'absolute', bottom: '100%', left: 0, marginBottom: '4px',
               background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
               minWidth: '240px', maxWidth: '280px', zIndex: 60, padding: '2px 0', fontSize: '12px' }
    });
    for (var pj = 0; pj < permModes.length; pj++) {
      var pm = permModes[pj];
      var isActive = pm.value === currentPermMode;
      var opt = DOM.createElement('div', {
        className: 'dd-item' + (isActive ? ' active' : ''),
        style: { cursor: 'pointer', justifyContent: 'space-between' },
        'data-value': pm.value
      });
      opt.innerHTML =
        '<span><strong>' + pm.label + '</strong>' +
        '<span style="color:var(--fg-3);margin-left:6px;font-size:10px;">\u2014 ' + pm.desc + '</span></span>';
      if (isActive) {
        opt.innerHTML +=
          '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M4 6l4 4 4-4"/></svg>';
      }
      opt.addEventListener('click', (function (val) {
        return function (e) {
          e.stopPropagation();
          AppState.set('permissionMode', val);
          API.send('set_permission_mode', { mode: val });
          permDropdown.style.display = 'none';
          updatePermLabel(val);
        };
      })(pm.value));
      permDropdown.appendChild(opt);
    }
    // Hint
    var permHint = DOM.createElement('div', {
      className: 'dd-hint'
    }, __t('permission.saved_hint') || 'Saved to ~/.claude/settings.json');
    permDropdown.appendChild(permHint);
    permWrap.appendChild(permDropdown);

    function updatePermLabel(val) {
      var m = findPermMode(val);
      var lbl = permWrap.querySelector('.perm-mode-label');
      if (lbl) lbl.textContent = m.label;
    }

    permWrap.addEventListener('click', function (e) {
      e.stopPropagation();
      // Update active state before showing
      var curVal = AppState.permissionMode || 'default';
      var opts = permDropdown.querySelectorAll('.dd-item');
      for (var o = 0; o < opts.length; o++) {
        opts[o].classList.toggle('active', opts[o].getAttribute('data-value') === curVal);
      }
      permDropdown.style.display = permDropdown.style.display === 'none' ? '' : 'none';
    });
    document.addEventListener('click', function () {
      permDropdown.style.display = 'none';
    });

    // ── Thinking mode toggle (on/off) ──
    var thinkPill = DOM.createElement('span', {
      className: 'status-pill',
      style: { position: 'relative', cursor: 'pointer' },
      title: (AppState.thinkingEnabled ? (__t('thinking.disable') || 'Disable thinking') : (__t('thinking.enable') || 'Enable thinking'))
    });
    thinkPill.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style="margin-right:2px;"><path d="M8 1C4.1 1 1 4.1 1 8s3.1 7 7 7 7-3.1 7-7-3.1-7-7-7zm0 12c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm1-7.5v5L6 8l3-2.5z"/></svg> ' +
      '<span class="think-label">' + (AppState.thinkingEnabled ? (__t('thinking.on') || 'Thinking') : (__t('thinking.off') || 'Fast')) + '</span>';
    thinkPill.addEventListener('click', function (e) {
      e.stopPropagation();
      var newVal = !AppState.thinkingEnabled;
      AppState.set('thinkingEnabled', newVal);
      API.send('set_thinking_mode', { enabled: newVal });
    });
    barEl.appendChild(thinkPill);

    // ── Thinking block visibility toggle (eye icon) ──
    var eyePill = DOM.createElement('span', {
      className: 'status-pill',
      style: { position: 'relative', cursor: 'pointer' },
      title: AppState.showThinkingBlocks ? (__t('thinking.hide_blocks') || 'Hide thinking blocks') : (__t('thinking.show_blocks') || 'Show thinking blocks')
    });
    eyePill.innerHTML =
      '<span class="eye-label">' + (AppState.showThinkingBlocks ? '\u{1F441}' : '\u{1F441}\u200D\u{1F5E8}') + '</span>';
    eyePill.addEventListener('click', function (e) {
      e.stopPropagation();
      var newVal = !AppState.showThinkingBlocks;
      AppState.set('showThinkingBlocks', newVal);
    });
    barEl.appendChild(eyePill);

    // ── Model pill with dropdown ──
    var modelPill = DOM.createElement('span', {
      className: 'status-pill',
      style: { position: 'relative', cursor: 'pointer' },
      title: __t('profile.tooltip') || 'Switch model profile'
    });
    modelPill.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style="margin-right:2px;"><path d="M8 0C3.6 0 0 3.6 0 8s3.6 8 8 8 8-3.6 8-8-3.6-8-8-8z"/></svg> ' +
      '<span class="model-label">' + (AppState.modelName || AppState.activeProfile || __t('profile.default') || 'Model') + '</span>';
    barEl.appendChild(modelPill);

    var modelDropdown = DOM.createElement('div', {
      className: 'model-dropdown',
      style: { display: 'none', position: 'absolute', bottom: '100%', left: 0, marginBottom: '4px',
               background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
               minWidth: '160px', maxWidth: '240px', zIndex: 60, padding: '2px 0' }
    });
    renderModelDropdown(modelDropdown, modelPill);
    modelPill.appendChild(modelDropdown);

    modelPill.addEventListener('click', function (e) {
      e.stopPropagation();
      renderModelDropdown(modelDropdown, modelPill);
      modelDropdown.style.display = modelDropdown.style.display === 'none' ? '' : 'none';
    });
    document.addEventListener('click', function () {
      modelDropdown.style.display = 'none';
    });

    // ── Context window bar ──
    var ctxWrap = DOM.createElement('div', {
      className: 'context-bar-wrap',
      title: (__t('status.context_window') || 'Context window') + ': ' + (AppState.contextPercent || 0) + '%'
    });
    var ctxPct = AppState.contextPercent || 0;
    ctxWrap.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h12v1H2V3zm0 3h12v1H2V6zm0 3h12v1H2V9zm0 3h10v1H2v-1z"/></svg>' +
      '<span style="font-size:10px;color:var(--fg-3);">' + ctxPct + '%</span>' +
      '<div class="context-bar-fill"><div class="fill ' + getContextColor(ctxPct) + '" style="width:' + ctxPct + '%;"></div></div>';
    ctxWrap.addEventListener('click', function (e) {
      e.stopPropagation();
      ContextDetail.open();
    });
    barEl.appendChild(ctxWrap);

    // ── Status text (right-aligned) ──
    var statusItem = DOM.createElement('span', { className: 'status-item', style: { marginLeft: 'auto' } });
    statusItem.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3l5 4H3l5-4zM8 13l-5-4h10l-5 4z"/></svg> ' +
      (AppState.statusText || (__t('status.ready') || 'Ready'));
    barEl.appendChild(statusItem);

    container.appendChild(barEl);

    // ── Subscribers ──

    AppState.subscribe('connection', function (val) {
      var dot = barEl.querySelector('.dot-indicator');
      if (dot) dot.className = 'dot-indicator ' + getConnectionColor(val);
      var connSpan = document.getElementById('status-connection');
      if (connSpan && connSpan.childNodes[1]) {
        connSpan.childNodes[1].textContent = val === 'connected'
          ? (__t('status.connected') || 'connected') : val;
      }
    });

    AppState.subscribe('statusText', function (val) {
      var st = barEl.querySelector('.status-item:last-child');
      if (st && st.childNodes[1]) st.childNodes[1].textContent = val;
    });

    AppState.subscribe('modelName', function (val) {
      updateModelLabel(val || AppState.activeProfile);
    });

    AppState.subscribe('activeProfile', function (val) {
      updateModelLabel(AppState.modelName || val);
    });

    AppState.subscribe('modelProfiles', function () {
      if (modelDropdown.style.display !== 'none') {
        renderModelDropdown(modelDropdown, modelPill);
      }
    });

    AppState.subscribe('permissionMode', function (val) {
      updatePermLabel(val);
      var opts = barEl.querySelectorAll('.perm-dropdown .dd-item');
      for (var o = 0; o < opts.length; o++) {
        opts[o].classList.toggle('active', opts[o].getAttribute('data-value') === val);
      }
    });

    AppState.subscribe('thinkingEnabled', function (val) {
      var label = barEl.querySelector('.think-label');
      if (label) label.textContent = val ? (__t('thinking.on') || 'Thinking') : (__t('thinking.off') || 'Fast');
      var pill = barEl.querySelector('.status-pill .think-label');
      if (pill) pill.parentNode.title = val ? (__t('thinking.disable') || 'Disable thinking') : (__t('thinking.enable') || 'Enable thinking');
    });

    AppState.subscribe('showThinkingBlocks', function (val) {
      var label = barEl.querySelector('.eye-label');
      if (label) label.textContent = val ? '\u{1F441}' : '\u{1F441}\u200D\u{1F5E8}';
      var pill = barEl.querySelector('.eye-label');
      if (pill) pill.parentNode.title = val ? (__t('thinking.hide_blocks') || 'Hide thinking blocks') : (__t('thinking.show_blocks') || 'Show thinking blocks');
      // Trigger re-render to show/hide thinking blocks
      AppState.set('messages', AppState.messages.slice());
    });

    AppState.subscribe('contextPercent', function (val) {
      var pct = val || 0;
      var span = barEl.querySelector('.context-bar-wrap span');
      if (span) span.textContent = pct + '%';
      var fill = barEl.querySelector('.context-bar-fill .fill');
      if (fill) {
        fill.style.width = pct + '%';
        fill.className = 'fill ' + getContextColor(pct);
      }
      ctxWrap.title = (__t('status.context_window') || 'Context window') + ': ' + pct + '%';
    });

    return barEl;
  }

  /** Render model profile dropdown options */
  function renderModelDropdown(dropdown, pill) {
    DOM.empty(dropdown);
    var profiles = AppState.modelProfiles || [];
    var active = AppState.activeProfile || '';

    if (profiles.length === 0) {
      var empty = DOM.createElement('div', {
        style: { padding: '4px 10px', fontSize: '11px', color: 'var(--fg-3)', fontStyle: 'italic' }
      }, 'No profiles configured');
      dropdown.appendChild(empty);
      return;
    }

    for (var i = 0; i < profiles.length; i++) {
      var p = profiles[i];
      var opt = DOM.createElement('div', {
        className: 'model-option',
        style: { padding: '4px 10px', fontSize: '11px', cursor: 'pointer', color: 'var(--fg-2)',
                 overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        'data-id': p.id
      }, p.label || p.id);
      if (p.id === active) opt.style.background = 'var(--border)';
      opt.addEventListener('click', (function (profileId) {
        return function (e) {
          e.stopPropagation();
          API.send('set_model_profile', { profile: profileId });
          dropdown.style.display = 'none';
        };
      })(p.id));
      dropdown.appendChild(opt);
    }
  }

  /** Update model pill label text */
  function updateModelLabel(name) {
    var label = barEl.querySelector('.model-label');
    if (label) {
      label.textContent = name || (__t('profile.default') || 'Model');
    }
  }

  function escapeHtml(text) {
    if (!text) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }

  function getConnectionColor(state) {
    if (state === 'connected') return 'green';
    if (state === 'connecting' || state === 'restarting' || state === 'starting') return 'yellow';
    return 'red';
  }

  function getContextColor(pct) {
    if (pct >= 90) return 'danger';
    if (pct >= 70) return 'warn';
    if (pct >= 50) return '';
    return 'safe';
  }

  return { render: render };
})();
