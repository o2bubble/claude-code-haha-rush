/* ═══════════════════════════════════════════════════
   DOM — Lightweight DOM helpers
   ═══════════════════════════════════════════════════ */

var DOM = {
  /** querySelector shortcut */
  $: function (selector, parent) {
    return (parent || document).querySelector(selector);
  },

  /** querySelectorAll shortcut */
  $$: function (selector, parent) {
    return Array.from((parent || document).querySelectorAll(selector));
  },

  /** Create an element with attributes and children */
  createElement: function (tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var key in attrs) {
        if (attrs.hasOwnProperty(key)) {
          if (key === 'className') {
            el.className = attrs[key];
          } else if (key === 'style' && typeof attrs[key] === 'object') {
            for (var s in attrs[key]) {
              if (attrs[key].hasOwnProperty(s)) {
                el.style[s] = attrs[key][s];
              }
            }
          } else if (key === 'dataset' && typeof attrs[key] === 'object') {
            for (var d in attrs[key]) {
              if (attrs[key].hasOwnProperty(d)) {
                el.dataset[d] = attrs[key][d];
              }
            }
          } else if (key === 'contentEditable') {
            el.contentEditable = attrs[key];
          } else if (key.indexOf('on') === 0) {
            el.addEventListener(key.slice(2).toLowerCase(), attrs[key]);
          } else {
            el.setAttribute(key, attrs[key]);
          }
        }
      }
    }
    if (children) {
      if (typeof children === 'string') {
        el.innerHTML = children;
      } else if (Array.isArray(children)) {
        for (var i = 0; i < children.length; i++) {
          if (children[i]) el.appendChild(children[i]);
        }
      } else if (children instanceof Node) {
        el.appendChild(children);
      }
    }
    return el;
  },

  /** Shorthand for div */
  div: function (className, children) {
    return DOM.createElement('div', className ? { className: className } : null, children);
  },

  /** Shorthand for span */
  span: function (className, text) {
    return DOM.createElement('span', className ? { className: className } : null, text);
  },

  /** Create SVG icon from path */
  svg: function (viewBox, paths, attrs) {
    var merged = Object.assign({ xmlns: 'http://www.w3.org/2000/svg', viewBox: viewBox || '0 0 16 16' }, attrs);
    var el = DOM.createElement('svg', merged);
    if (typeof paths === 'string') {
      el.innerHTML = paths;
    }
    return el;
  },

  /** Empty an element's children */
  empty: function (el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  },

  /** Set innerHTML with script-safe flag */
  setHTML: function (el, html) {
    el.innerHTML = html;
  },

  /** Toggle a class */
  toggleClass: function (el, className, force) {
    if (force !== undefined) {
      el.classList.toggle(className, force);
    } else {
      el.classList.toggle(className);
    }
  }
};
