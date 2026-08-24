/* ═══════════════════════════════════════════════════
   TASKS PANEL — Background task tracking
   Design: vs-code-agent-dark.html — .task-item section
   Reference: app.js — renderTaskPanel, task events
   ═══════════════════════════════════════════════════ */

var TasksPanel = (function () {

  var panelEl = null;
  var listEl = null;
  var countEl = null;

  function render(container) {
    var panel = DOM.createElement('div', { className: 'panel', id: 'panel-tasks', style: { display: 'none' } });

    // Header
    var header = DOM.createElement('div', { className: 'panel-header' });
    var label = DOM.createElement('span', { className: 'label' });
    label.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l5 2.5V6c0 3.3-2 6.3-5 7-3-1.7-5-4.7-5-7V3.5L8 1z"/></svg> ' +
      (__t('task.panel_header') || 'Tasks');
    countEl = DOM.createElement('span', { className: 'badge' }, '0');
    label.appendChild(countEl);
    header.appendChild(label);

    var clearBtn = DOM.createElement('span', { className: 'action-btn' }, __t('task.clear_completed') || 'Clear done');
    clearBtn.addEventListener('click', function () {
      var tasks = AppState.tasks || {};
      var updated = {};
      for (var id in tasks) {
        if (tasks[id].status !== 'completed' && tasks[id].status !== 'failed' && tasks[id].status !== 'killed') {
          updated[id] = tasks[id];
        }
      }
      AppState.set('tasks', updated);
    });
    header.appendChild(clearBtn);
    panel.appendChild(header);

    // Task list
    listEl = DOM.createElement('div', { id: 'task-panel-list' });
    panel.appendChild(listEl);

    container.appendChild(panel);
    panelEl = panel;

    AppState.subscribe('tasks', function () {
      renderTasks();
      panel.style.display = hasTasks() ? '' : 'none';
    });

    return panel;
  }

  function hasTasks() {
    var tasks = AppState.tasks || {};
    for (var k in tasks) return true;
    return false;
  }

  function renderTasks() {
    if (!listEl) return;
    DOM.empty(listEl);
    var tasks = AppState.tasks || {};
    var ids = Object.keys(tasks);
    var runningCount = 0;
    for (var i = 0; i < ids.length; i++) {
      if (tasks[ids[i]].status === 'running') runningCount++;
    }
    if (countEl) countEl.textContent = runningCount + '/' + ids.length;

    for (var i = 0; i < ids.length; i++) {
      listEl.appendChild(renderTaskItem(tasks[ids[i]], ids[i]));
    }
  }

  function renderTaskItem(task, taskId) {
    var status = task.status || 'running';
    var item = DOM.createElement('div', { className: 'task-item' });

    // Status icon
    var iconEl = DOM.createElement('span', { style: { flexShrink: '0', color: getStatusColor(status) } });
    if (status === 'running') {
      iconEl.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4v4l3 2"/></svg>';
    } else if (status === 'completed') {
      iconEl.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.8 4.2l-7.3 7.3-4.3-4.3 1.4-1.4 2.9 2.9 5.9-5.9 1.4 1.4z"/></svg>';
    } else {
      iconEl.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2l6 6-6 6-6-6 6-6z"/></svg>';
    }
    item.appendChild(iconEl);

    // Info: name + subtext
    var info = DOM.createElement('div', { className: 'task-info' });
    var name = DOM.createElement('div', { className: 'task-name' }, task.name || task.description || task.label || 'Task');
    name.title = task.description || task.name || '';
    info.appendChild(name);

    // Only show subtext if there's useful data
    if (status === 'running' && (task.tool_calls > 0 || task.tokens > 0)) {
      var sub = DOM.createElement('div', { className: 'task-sub' });
      var toolsStr = task.tool_calls > 0 ? task.tool_calls + ' tools' : '';
      var tokStr = task.tokens > 0 ? (task.tokens / 1000).toFixed(1) + 'k tok' : '';
      sub.textContent = [toolsStr, tokStr].filter(Boolean).join(', ');
      info.appendChild(sub);
    }
    item.appendChild(info);

    // Kill button (only for running tasks)
    if (status === 'running') {
      var killBtn = DOM.createElement('button', {
        className: 'task-kill-btn',
        'data-task-id': taskId,
        title: __t('task.stop_agent') || 'Stop agent',
        style: { background: 'none', border: 'none', color: 'var(--fg-3)', cursor: 'pointer', fontSize: '14px', padding: '0 4px' }
      }, '\u25A0');
      killBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        API.send('kill_task', { task_id: taskId });
        task.status = 'killed';
        AppState.set('tasks', AppState.tasks);
      });
      item.appendChild(killBtn);
    }

    return item;
  }

  function getStatusColor(status) {
    if (status === 'running') return 'var(--accent)';
    if (status === 'completed') return 'var(--green)';
    return 'var(--red)';
  }

  return { render: render };
})();
