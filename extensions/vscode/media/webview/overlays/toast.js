/* ═══════════════════════════════════════════════════
   TOAST — Fixed-position notification
   Design: vs-code-agent-dark.html — .toast section
   Spec: design-spec.html §4.2 #18
   ═══════════════════════════════════════════════════ */

var Toast = (function () {
  var container = null;

  /** Ensure toast container exists */
  function ensureContainer() {
    if (!container || !container.parentNode) {
      container = DOM.createElement('div', {
        className: 'toast-wrap',
        id: 'toast-wrap'
      });
      document.body.appendChild(container);
    }
    return container;
  }

  /** Show a toast notification */
  function show(type, message, duration) {
    duration = duration || 3000;
    var c = ensureContainer();

    var toast = DOM.createElement('div', { className: 'toast ' + type });

    // Icon
    var iconSvg = '';
    if (type === 'success') {
      iconSvg = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.8 4.2l-7.3 7.3-4.3-4.3 1.4-1.4 2.9 2.9 5.9-5.9 1.4 1.4z"/></svg>';
    } else if (type === 'error') {
      iconSvg = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4.34 2.63l9.03 9.03-1.71 1.71-9.03-9.03 1.71-1.71z"/><path d="M11.66 2.63l1.71 1.71-9.03 9.03-1.71-1.71 9.03-9.03z"/></svg>';
    } else {
      iconSvg = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="6"/></svg>';
    }

    toast.innerHTML = iconSvg + ' <span>' + escapeHtml(message) + '</span> <span class="toast-close">&times;</span>';

    // Close button
    var closeBtn = toast.querySelector('.toast-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () { dismiss(toast); });
    }

    c.appendChild(toast);

    // Auto-dismiss
    if (duration > 0) {
      setTimeout(function () { dismiss(toast); }, duration);
    }

    return toast;
  }

  function dismiss(toast) {
    if (!toast || !toast.parentNode) return;
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }

  function escapeHtml(text) {
    if (!text) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }

  return { show: show };
})();
