/* ═══════════════════════════════════════════════════
   SESSION PANEL — Session history list
   Design: vs-code-agent-dark.html — Sessions panel
   Spec: design-spec.html §3.1 Panel Header, §4.1 #01
   ═══════════════════════════════════════════════════ */

var SessionPanel = (function () {

  /** Render the session panel into a container element */
  function render(container) {
    var panel = DOM.div('panel');
    var header = buildHeader();
    var body = DOM.div('', buildBody());

    panel.appendChild(header);
    panel.appendChild(body);
    container.appendChild(panel);

    // Collapse/expand
    header.addEventListener('click', function (e) {
      if (e.target.closest('.action-btn')) return;
      AppState.set('sessionsExpanded', !AppState.sessionsExpanded);
      body.style.display = AppState.sessionsExpanded ? '' : 'none';
      var chevron = header.querySelector('.chevron-icon');
      if (chevron) chevron.style.transform = AppState.sessionsExpanded ? 'rotate(0deg)' : 'rotate(-90deg)';
    });

    // + New button
    var newBtn = header.querySelector('.action-btn');
    if (newBtn) {
      newBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        API.send('new_session');
      });
    }

    // Subscribe to session list changes
    AppState.subscribe('sessions', function () {
      var listEl = panel.querySelector('.session-list');
      if (listEl) {
        DOM.empty(listEl);
        renderSessionList(listEl);
      }
      var badge = header.querySelector('.badge');
      if (badge) badge.textContent = AppState.sessions.length;
    });

    // Subscribe to session list show/hide
    AppState.subscribe('sessionsExpanded', function () {
      body.style.display = AppState.sessionsExpanded ? '' : 'none';
      var chevron = header.querySelector('.chevron-icon');
      if (chevron) chevron.style.transform = AppState.sessionsExpanded ? 'rotate(0deg)' : 'rotate(-90deg)';
    });

    // Subscribe to current session changes — re-render to update active highlight
    AppState.subscribe('currentSessionId', function () {
      var listEl = panel.querySelector('.session-list');
      if (listEl) {
        DOM.empty(listEl);
        renderSessionList(listEl);
      }
    });

    return panel;
  }

  function buildHeader() {
    var header = DOM.createElement('div', { className: 'panel-header' });
    var sessionLabel = __t('session.sessions_title') || 'Sessions';
    header.innerHTML =
      '<span class="label">' +
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 2h11l.5.5v11l-.5.5h-11l-.5-.5v-11l.5-.5zM3 3v10h10V3H3zm2 2h6v1H5V5zm0 2h6v1H5V7zm0 2h4v1H5V9z"/></svg>' +
        sessionLabel +
        ' <span class="badge">' + AppState.sessions.length + '</span>' +
      '</span>' +
      '<div style="display:flex;gap:2px;align-items:center;">' +
        '<span class="action-btn">+ ' + (__t('session.new') || 'New') + '</span>' +
        '<span class="chevron-icon" style="color:var(--fg-3);display:flex;transition:transform 0.15s;">' +
          '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l4 4-4 4"/></svg>' +
        '</span>' +
      '</div>';
    return header;
  }

  function buildBody() {
    var wrapper = DOM.createElement('div', {
      style: { padding: '4px 8px 8px' }
    });
    var list = DOM.createElement('div', { className: 'session-list' });
    wrapper.appendChild(list);
    renderSessionList(list);
    return wrapper;
  }

  function renderSessionList(listEl) {
    var sessions = AppState.sessions;
    if (!sessions || sessions.length === 0) {
      listEl.innerHTML = '<div style="padding:8px 6px;font-size:11px;color:var(--fg-3);">' +
        (__t('app.no_past_sessions') || 'No past sessions') + '</div>';
      return;
    }
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var item = createSessionItem(s, i);
      listEl.appendChild(item);
    }
  }

  function formatSessionTime(ts) {
    if (!ts) return '';
    var now = Date.now();
    var then = new Date(ts).getTime();
    var diff = Math.floor((now - then) / 1000);
    if (diff < 60) return __t('time.just_now');
    if (diff < 3600) return __t('time.minutes_ago', {n: Math.floor(diff / 60)});
    if (diff < 86400) return __t('time.hours_ago', {n: Math.floor(diff / 3600)});
    if (diff < 2592000) return __t('time.days_ago', {n: Math.floor(diff / 86400)});
    return new Date(ts).toLocaleDateString();
  }

  function createSessionItem(session, idx) {
    var sid = session.sessionId;
    var isActive = sid === AppState.currentSessionId;
    var item = DOM.createElement('div', {
      className: 'session-item' + (isActive ? ' active' : ''),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '5px 6px',
        borderRadius: 'var(--radius-sm)',
        background: isActive ? 'var(--accent-bg)' : 'transparent',
        border: isActive ? '1px solid rgba(88,166,255,0.2)' : 'none',
        cursor: 'pointer',
        marginTop: idx > 0 ? '2px' : '0'
      }
    });

    var iconColor = isActive ? 'var(--accent)' : 'var(--fg-3)';
    var icon = DOM.createElement('span', { style: { flexShrink: '0', color: iconColor } });
    icon.innerHTML = '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="3"/></svg>';
    item.appendChild(icon);

    // Info area
    var info = DOM.createElement('div', { style: { flex: '1', minWidth: '0' } });
    var titleEl = DOM.createElement('div', {
      className: 'session-title',
      style: { fontSize: '11px', color: isActive ? 'var(--fg)' : 'var(--fg-2)', fontWeight: isActive ? '500' : '400', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
    });
    titleEl.textContent = session.title || sid || 'Session';
    info.appendChild(titleEl);
    info.appendChild(DOM.createElement('div', {
      style: { fontSize: '9px', color: 'var(--fg-3)' }
    }, (session.gitBranch || '') + (session.gitBranch ? ' \u00B7 ' : '') + formatSessionTime(session.timestamp)));
    item.appendChild(info);

    // Rename button (pen icon)
    var renameBtn = DOM.createElement('span', {
      className: 'session-rename-btn',
      style: { fontSize: '10px', color: 'var(--fg-3)', cursor: 'pointer', padding: '1px 3px', opacity: '0', transition: 'opacity 0.15s' },
      title: __t('session.rename_btn') || 'Rename session'
    });
    renameBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M12.5 1.5l2 2L5 13l-3 1 1-3 9.5-9.5z"/></svg>';
    renameBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var input = document.createElement('input');
      input.style.cssText = 'font-size:11px;color:var(--fg);background:var(--surface-3);border:1px solid var(--border);border-radius:2px;padding:1px 4px;width:100%;outline:none;font-family:var(--font-sans);';
      input.value = titleEl.textContent;
      input.addEventListener('click', function (ev) { ev.stopPropagation(); });
      input.addEventListener('blur', function () { finishRename(sid, input, titleEl); });
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); finishRename(sid, input, titleEl); }
        if (ev.key === 'Escape') { input.value = titleEl.textContent; input.blur(); }
      });
      titleEl.replaceWith(input);
      input.focus();
      input.select();
    });
    item.appendChild(renameBtn);

    // Delete button
    var delBtn = DOM.createElement('span', {
      className: 'session-del-btn',
      style: { fontSize: '11px', color: 'var(--fg-3)', cursor: 'pointer', padding: '1px 4px', opacity: '0', transition: 'opacity 0.15s' },
      title: __t('session.delete_btn') || 'Delete session'
    }, '\u00D7');
    item.appendChild(delBtn);

    // Click to load session (rename/delete buttons stopPropagation so only item clicks reach here)
    item.addEventListener('click', function () {
      if (sid !== AppState.currentSessionId) {
        API.send('resume_session', { session_id: sid });
      }
    });

    // Delete button handler
    delBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (delBtn.dataset.confirming === 'true') {
        API.send('delete_session', { session_id: sid });
      } else {
        delBtn.dataset.confirming = 'true';
        delBtn.textContent = '\u2713?';
        delBtn.style.color = 'var(--red)';
        setTimeout(function () {
          delete delBtn.dataset.confirming;
          delBtn.textContent = '\u00D7';
          delBtn.style.color = '';
        }, 2000);
      }
    });

    // Show rename + delete on hover
    item.addEventListener('mouseenter', function () {
      delBtn.style.opacity = '1';
      renameBtn.style.opacity = '1';
    });
    item.addEventListener('mouseleave', function () {
      delBtn.style.opacity = '0';
      renameBtn.style.opacity = '0';
    });

    return item;
  }

  function finishRename(sessionId, input, titleEl) {
    // Guard: blur + Enter both fire finishRename — only run once
    if (!input.parentNode || input._renamed) return;
    input._renamed = true;
    var title = input.value.trim();
    if (title) {
      API.send('rename_session', { session_id: sessionId, title: title });
    }
    var newTitle = document.createElement('div');
    newTitle.className = 'session-title';
    newTitle.style.cssText = titleEl.style.cssText || 'font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    newTitle.textContent = title || titleEl.textContent;
    input.replaceWith(newTitle);
  }

  return { render: render };
})();
