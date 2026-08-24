/* ═══════════════════════════════════════════════════
   API — WebView ↔ Extension Host message layer
   Protocol matches existing ideMode.ts ↔ provider.ts
   ═══════════════════════════════════════════════════ */

var API = (function () {
  var vscode = acquireVsCodeApi();
  var handlers = {};

  /** Register a handler for incoming message types */
  function on(type, handler) {
    if (!handlers[type]) handlers[type] = [];
    handlers[type].push(handler);
  }

  /** Send a message to the extension host / backend */
  function send(type, payload) {
    var msg = payload || {};
    msg.type = type;
    vscode.postMessage(msg);
  }

  /** Handle incoming messages from window.addEventListener */
  function handleMessage(event) {
    var msg = event.data;
    if (!msg || !msg.type) return;
    var typeHandlers = handlers[msg.type];
    if (typeHandlers) {
      for (var i = 0; i < typeHandlers.length; i++) {
        try {
          typeHandlers[i](msg);
        } catch (e) {
          console.error('[API] handler error for', msg.type, e);
        }
      }
    }
  }

  // Listen for messages from extension host
  window.addEventListener('message', handleMessage);

  return {
    on: on,
    send: send,
    /** Remove all handlers (for cleanup) */
    clearHandlers: function () { handlers = {}; }
  };
})();
