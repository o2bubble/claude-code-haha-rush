/* ═══════════════════════════════════════════════════
   QUICK COMMAND MANAGER — CRUD dialog
   Design: vs-code-agent-dark.html — modal section
   Spec: design-spec.html §4.2 #13
   Reference: app.js — quickCmd, get_quick_cmds, save_quick_cmds
   ═══════════════════════════════════════════════════ */

var QuickCommandManager = (function () {

  var overlayEl = null;
  var listEl = null;
  var nameInput = null;
  var cmdInput = null;

  function open() {
    close();
    overlayEl = createOverlay();
    document.getElementById('overlay-root').appendChild(overlayEl);
    renderList();
  }

  function close() {
    if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
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

    var modal = DOM.createElement('div', { className: 'modal', style: { maxWidth: '420px', width: '100%' } });

    // Header
    var header = DOM.createElement('div', { className: 'modal-header' });
    header.innerHTML = '<span>Quick Commands</span>';
    var closeBtn = DOM.createElement('span', { className: 'close' }, '\u00D7');
    closeBtn.addEventListener('click', close);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // Body
    var body = DOM.createElement('div', { className: 'modal-body' });

    // Command list
    listEl = DOM.createElement('div', { style: { marginBottom: '8px' } });
    body.appendChild(listEl);

    // Add form
    var form = DOM.createElement('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } });
    nameInput = DOM.createElement('input', {
      type: 'text',
      placeholder: 'Name',
      style: {
        flex: '1', padding: '6px 8px', background: 'var(--surface-3)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
        color: 'var(--fg)', fontSize: '12px', fontFamily: 'var(--font-sans)', outline: 'none'
      }
    });
    cmdInput = DOM.createElement('input', {
      type: 'text',
      placeholder: 'Command to send',
      style: {
        flex: '2', padding: '6px 8px', background: 'var(--surface-3)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
        color: 'var(--fg)', fontSize: '12px', fontFamily: 'var(--font-sans)', outline: 'none'
      }
    });
    form.appendChild(nameInput);
    form.appendChild(cmdInput);
    body.appendChild(form);

    modal.appendChild(body);

    // Footer
    var footer = DOM.createElement('div', { className: 'modal-footer' });
    var closeModalBtn = DOM.createElement('button', { className: 'modal-btn' }, 'Close');
    closeModalBtn.addEventListener('click', close);
    footer.appendChild(closeModalBtn);
    var addBtn = DOM.createElement('button', { className: 'modal-btn primary' }, '+ Add');
    addBtn.addEventListener('click', addCommand);
    footer.appendChild(addBtn);
    modal.appendChild(footer);

    backdrop.appendChild(modal);
    return backdrop;
  }

  function renderList() {
    if (!listEl) return;
    DOM.empty(listEl);

    var cmds = AppState.quickCommands || [];
    if (cmds.length === 0) {
      listEl.innerHTML = '<div style="font-size:12px;color:var(--fg-3);padding:8px 0;">No custom commands yet. Add one below.</div>';
      return;
    }

    for (var i = 0; i < cmds.length; i++) {
      var cmd = cmds[i];
      var row = DOM.createElement('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: '12px'
        }
      });
      var cmdName = cmd.name || cmd.cmd || '';
      var cmdText = cmd.cmd || cmd.command || '';
      row.innerHTML =
        '<span style="color:var(--fg-2);">' + escapeHtml(cmdName) + '</span>' +
        '<span style="font-family:var(--font-mono);font-size:10px;color:var(--fg-3);">/' + escapeHtml(cmdText) + '</span>';
      var delBtn = DOM.createElement('span', {
        style: { color: 'var(--red)', cursor: 'pointer', fontSize: '14px', lineHeight: '1' }
      }, '\u00D7');
      delBtn.addEventListener('click', (function (idx) {
        return function () { deleteCommand(idx); };
      })(i));
      row.appendChild(delBtn);
      listEl.appendChild(row);
    }
  }

  function addCommand() {
    var name = (nameInput.value || '').trim();
    var cmd = (cmdInput.value || '').trim();
    if (!name || !cmd) return;

    var cmds = (AppState.quickCommands || []).slice();
    cmds.push({ name: name, cmd: cmd, description: name });
    AppState.set('quickCommands', cmds);
    API.send('save_quick_cmds', { commands: cmds });

    nameInput.value = '';
    cmdInput.value = '';
    renderList();
  }

  function deleteCommand(idx) {
    var cmds = (AppState.quickCommands || []).slice();
    cmds.splice(idx, 1);
    AppState.set('quickCommands', cmds);
    API.send('save_quick_cmds', { commands: cmds });
    renderList();
  }

  function escapeHtml(text) {
    if (!text) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }

  return { open: open, close: close };
})();
