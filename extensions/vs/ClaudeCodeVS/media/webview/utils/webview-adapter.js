/* ═══════════════════════════════════════════════════
   WebView2 Adapter — WebView2 message bridge

   Replaces api.js for Visual Studio WebView2 environment.
   Implements the same { on, send, clearHandlers } API
   so all existing component code works without changes.

   VS Code: acquireVsCodeApi().postMessage(msg)
            window.addEventListener('message', fn)

   WebView2 (VS2026): AddHostObjectToScript native bridge
   WebView2 (VS2022): window.chrome.webview.postMessage(msg)
   ═══════════════════════════════════════════════════ */

var API = (function () {
  var handlers = {};
  var isWebView2 = typeof window.chrome !== 'undefined'
    && window.chrome.webview !== undefined;

  // Console the adapter version so we know which code is loaded
  console.log('[webview-adapter] v2 — native bridge + postMessage fallback');

  /** Register a handler for incoming message types */
  function on(type, handler) {
    if (!handlers[type]) handlers[type] = [];
    handlers[type].push(handler);
  }

  /** Send a message to the C# host with multi-fallback for SDK compatibility */
  function send(type, payload) {
    var msg = payload || {};
    msg.type = type;
    var json = JSON.stringify(msg);

    if (isWebView2) {
      // Method 1: Native bridge via AddHostObjectToScript (VS2026 SDK).
      // chrome.webview.postMessage does NOT trigger C# WebMessageReceived
      // in VS2026, regardless of origin — so we call the COM bridge directly.
      try {
        var bridge = window.chrome.webview.hostObjects.sync.hostBridge;
        if (bridge) {
          bridge.PostMessage(json);
          return;
        }
      } catch (e1) {
        console.warn('[WebView2] native bridge failed, trying postMessage');
      }

      // Method 2: postMessage JSON string (VS2022 SDK)
      try {
        window.chrome.webview.postMessage(json);
        return;
      } catch (e2) {
        console.warn('[WebView2] postMessage(string) failed, trying object');
      }

      // Method 3: postMessage object (older SDKs)
      try {
        window.chrome.webview.postMessage(msg);
        return;
      } catch (e3) {
        console.warn('[WebView2] postMessage(object) failed');
      }
    } else {
      // Fallback: VS Code message event (for development/testing)
      console.log('[WebView2] postMessage fallback:', type, msg);
      window.postMessage(msg, '*');
    }
  }

  /** Handle incoming messages */
  function handleMessage(msg) {
    // Normalize: WebView2 may deliver raw JSON string (VS2026) or parsed object (VS2022)
    if (typeof msg === 'string') {
      try {
        msg = JSON.parse(msg);
      } catch (e) {
        console.error('[API] Failed to parse incoming message:', e);
        return;
      }
    }
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

  // Listen for messages from C# host
  if (isWebView2) {
    // WebView2: messages may arrive as parsed objects (VS2022) or raw JSON strings (VS2026)
    window.chrome.webview.addEventListener('message', function (e) {
      // e.data may be a JS object (VS2022) or a JSON string (VS2026)
      handleMessage(e.data);
    });
  } else {
    // Fallback: VS Code message event (dev/testing)
    window.addEventListener('message', function (e) {
      handleMessage(e.data);
    });
  }

  return {
    on: on,
    send: send,
    clearHandlers: function () { handlers = {}; }
  };
})();
