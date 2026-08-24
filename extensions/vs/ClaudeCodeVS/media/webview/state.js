/* ═══════════════════════════════════════════════════
   STATE — Single source of truth for all UI state
   ═══════════════════════════════════════════════════ */

var AppState = {
  // Connection
  connection: 'disconnected', // 'connecting' | 'connected' | 'disconnected'

  // Session
  currentSessionId: null,
  sessions: [],
  sessionsExpanded: true,

  // Messages
  messages: [],
  messageFilter: 'all', // 'all' | 'user' | 'assistant'
  autoScroll: true,

  // Streaming
  streaming: false,
  thinking: { active: false, text: '' },

  // Queued prompts (frontend-managed, auto-sent when current turn finishes)
  pendingQueue: [],

  // Tasks
  tasks: {},
  tasksExpanded: true,

  // Plan
  planTasks: [],
  planExpanded: true,

  // Context
  contextFiles: [],
  contextSelection: null,
  contextDiagnostics: {},

  // Input
  inputText: '',

  // Permission
  pendingPermission: false,
  permissionMode: 'default',
  thinkingEnabled: false,
  showThinkingBlocks: true,  // UI toggle to hide thinking block rendering

  // Status
  statusText: 'Disconnected',
  contextPercent: 0,
  contextTokens: 0,
  contextMaxTokens: 0,
  modelName: '',
  sessionTokens: { input: 0, output: 0 },

  // Slash commands (loaded from backend)
  slashCommands: [],

  // Quick commands (loaded from backend)
  quickCommands: [],

  // Queued prompts (before the current turn finishes)
  promptQueue: [],

  // Subscribers (state change callbacks)
  _listeners: {},

  /** Subscribe to state changes. Returns unsubscribe fn. */
  subscribe: function (key, fn) {
    if (!this._listeners[key]) this._listeners[key] = [];
    this._listeners[key].push(fn);
    var self = this;
    return function () {
      self._listeners[key] = self._listeners[key].filter(function (f) { return f !== fn; });
    };
  },

  /** Update a state key and notify subscribers */
  set: function (key, value) {
    if (this[key] === value) return;
    this[key] = value;
    var listeners = this._listeners[key];
    if (listeners) {
      for (var i = 0; i < listeners.length; i++) {
        listeners[i](value);
      }
    }
    // Also notify '*' listeners (catch-all)
    var allListeners = this._listeners['*'];
    if (allListeners) {
      for (var j = 0; j < allListeners.length; j++) {
        allListeners[j](key, value);
      }
    }
  },

  /** Batch update multiple keys */
  setMany: function (updates) {
    for (var key in updates) {
      if (updates.hasOwnProperty(key)) {
        this.set(key, updates[key]);
      }
    }
  },

  /** Reset state for a new session */
  reset: function () {
    this.messages = [];
    this.thinking = { active: false, text: '' };
    this.streaming = false;
    this.tasks = {};
    this.planTasks = [];
    this.contextFiles = [];
    this.contextSelection = null;
    this.contextDiagnostics = {};
    this.inputText = '';
    this.pendingPermission = false;
    this.autoScroll = true;
    this.sessionTokens = { input: 0, output: 0 };
  }
};
