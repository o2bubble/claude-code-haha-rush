/* ═══════════════════════════════════════════════════
   PLAN PANEL — Task plan with progress tracking
   Design: vs-code-agent-dark.html — .plan-item section
   Spec: design-spec.html §3.8 Plan Item, §4.1 #04
   ═══════════════════════════════════════════════════ */

var PlanPanel = (function () {

  var panelEl = null;
  var listEl = null;

  function render(container) {
    var panel = DOM.createElement('div', { className: 'panel', id: 'panel-plan', style: { display: 'none' } });

    // Header
    var header = DOM.createElement('div', { className: 'panel-header' });
    var label = DOM.createElement('span', { className: 'label' });
    label.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3l7-2 7 2v10l-7 2-7-2V3z"/><path d="M8 3v10M1 5l7 2M15 5l-7 2"/></svg> ' +
      (__t('plan.panel_header') || 'Plan') +
      ' <span class="badge" id="plan-count">0/0</span>';
    header.appendChild(label);
    panel.appendChild(header);

    // Plan list
    listEl = DOM.createElement('div', { id: 'plan-panel-list' });
    panel.appendChild(listEl);

    container.appendChild(panel);
    panelEl = panel;

    // Subscribe to plan changes
    AppState.subscribe('planTasks', function () {
      renderPlan();
      panel.style.display = (AppState.planTasks || []).length > 0 ? '' : 'none';
    });

    return panel;
  }

  function renderPlan() {
    if (!listEl) return;
    DOM.empty(listEl);
    var tasks = AppState.planTasks || [];
    var done = 0;
    var total = tasks.length;

    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (t.status === 'completed') done++;
      var item = renderPlanItem(t);
      listEl.appendChild(item);
    }

    var count = document.getElementById('plan-count');
    if (count) count.textContent = done + '/' + total;
  }

  function renderPlanItem(task) {
    var status = task.status || 'pending';
    var item = DOM.createElement('div', { className: 'plan-item' });

    // Status icon
    var icon = DOM.createElement('span', { className: 'status-icon ' + status });
    if (status === 'completed') {
      icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.8 4.2l-7.3 7.3-4.3-4.3 1.4-1.4 2.9 2.9 5.9-5.9 1.4 1.4z"/></svg>';
    } else if (status === 'active' || status === 'in_progress') {
      icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="3"/></svg>';
    } else {
      icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    }
    item.appendChild(icon);

    // Text
    var text = DOM.createElement('span', { className: 'plan-text ' + status });
    text.textContent = task.name || task.label || task.description || 'Task';
    item.appendChild(text);

    // Blocked-by warning — only for pending/active tasks with actual blockers
    var blocker = task.blocked_by || task.blockedBy || '';
    if (blocker && status !== 'completed') {
      var blocked = DOM.createElement('span', { className: 'blocked-by' });
      blocked.textContent = 'blocked: ' + blocker;
      item.appendChild(blocked);
    }

    return item;
  }

  return { render: render };
})();
