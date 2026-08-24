/* ═══════════════════════════════════════════════════════════════
   APP-NEW — VS Code Agent Extension UI (Redesign)
   Entry point: builds layout, wires API handlers, manages rendering.
   ═══════════════════════════════════════════════════════════════ */

// Shared across modules: thinking translation contexts (matches old app.js pendingTranslations)
var _pendingTranslations = {};
// Pending session ID for auto-resume after model/profile switch (matches old app.js)
var _pendingSessionId = null;
var _queueProcessing = false;
var _profileSwitchTime = 0;

(function () {
  'use strict';

  /* ─── Layout builder ─── */

  function buildLayout() {
    var app = document.getElementById('app');
    if (!app) return;

    // App shell — full height flex column
    var shell = DOM.createElement('div', { className: 'app-shell' });

    // Session panel — fixed at top, does not scroll
    var sessionContainer = DOM.createElement('div', { style: { flexShrink: '0' } });
    shell.appendChild(sessionContainer);

    // Message filter — fixed below session panel, does not scroll
    var filterContainer = DOM.createElement('div', { style: { flexShrink: '0' } });
    shell.appendChild(filterContainer);

    // Scroll wrapper (relative container for scroll area + bottom button)
    var scrollWrapper = DOM.createElement('div', { style: { flex: '1', position: 'relative', overflow: 'hidden' } });

    // Scroll area (fills remaining space, scrolls message content)
    var scrollArea = DOM.createElement('div', {
      className: 'scroll-area',
      id: 'scroll-area',
      style: { position: 'absolute', top: '0', left: '0', right: '0', bottom: '0', overflowY: 'auto' }
    });
    scrollWrapper.appendChild(scrollArea);

    // Scroll-to-bottom button (appears when user scrolls up)
    var scrollToBottomBtn = DOM.createElement('button', {
      id: 'scroll-to-bottom-btn',
      style: { display: 'none', position: 'absolute', bottom: '8px', right: '12px',
               background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '50%',
               width: '32px', height: '32px', cursor: 'pointer', color: 'var(--fg-2)', fontSize: '14px',
               boxShadow: '0 2px 8px rgba(0,0,0,0.3)', zIndex: 10, lineHeight: '30px', textAlign: 'center', padding: '0' }
    });
    scrollToBottomBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:middle;"><path d="M8 11.5l-5-5 1.5-1.5L8 8.5l3.5-3.5 1.5 1.5z"/></svg>';
    scrollToBottomBtn.addEventListener('click', function () {
      scrollArea.scrollTo({ top: scrollArea.scrollHeight, behavior: 'smooth' });
      scrollToBottomBtn.style.display = 'none';
    });
    scrollWrapper.appendChild(scrollToBottomBtn);
    shell.appendChild(scrollWrapper);

    // Plan panel container — fixed between scroll area and input area (does NOT scroll)
    var planPanelContainer = DOM.createElement('div', { id: 'plan-panel-container' });
    shell.appendChild(planPanelContainer);

    // Auto-scroll detection: show button when scrolled up > 100px
    // Pause auto-scroll when user scrolls up, resume when they return to bottom
    var AUTO_SCROLL_THRESHOLD = 100;
    scrollArea.addEventListener('scroll', function () {
      var dist = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight;
      scrollToBottomBtn.style.display = dist > AUTO_SCROLL_THRESHOLD ? '' : 'none';
      AppState.autoScroll = dist <= 10;
    });

    // Input area container
    var inputAreaContainer = DOM.createElement('div', { className: 'input-area', id: 'input-area' });
    shell.appendChild(inputAreaContainer);

    // Overlay root: move into shell so dropdowns appear above input, not below status bar
    var overlayRoot = document.getElementById('overlay-root');
    if (overlayRoot && overlayRoot.parentNode) {
      shell.insertBefore(overlayRoot, inputAreaContainer);
    }

    app.appendChild(shell);

    // Render session panel above scroll area
    SessionPanel.render(sessionContainer);
    // Render message filter below session panel (fixed, no scroll)
    MessageStream.render(scrollArea, filterContainer);
    TasksPanel.render(planPanelContainer);
    PlanPanel.render(planPanelContainer);
    QueuePanel.render(planPanelContainer);
    SelectionPreview.render(shell, scrollArea);

    // Render status bar and input area
    StatusBarComponent.render(shell);
    renderInputArea();

    return { shell: shell, scrollArea: scrollArea };
  }

  /* ─── Input area ─── */

  function renderInputArea() {
    var area = document.getElementById('input-area');
    if (!area) return;
    InputArea.render(area);
  }

  /* ─── API message handlers ─── */
  /* All message types verified against app.js (old). Do NOT guess types. */

  function setupAPIHandlers() {
    // Status: connection, model, context percentage
    // Backend sends { type: 'status', status: 'connected' } on WebSocket open
    // Also sends status updates for thinking, ready, disconnected, etc.
    API.on('status', function (msg) {
      if (msg.status === 'connected') {
        AppState.setMany({
          connection: 'connected',
          statusText: __t('status.ready') || 'Ready'
        });
      } else if (msg.status === 'disconnected' || msg.status === 'exited') {
        AppState.setMany({
          connection: 'disconnected',
          streaming: false,
          statusText: __t('status.disconnected') || 'Disconnected'
        });
      } else if (msg.status === 'ready') {
        AppState.setMany({
          connection: 'connected',
          statusText: __t('status.ready') || 'Ready'
        });
        // Auto-resume pending session after model/profile switch restart
        if (_pendingSessionId) {
          API.send('resume_session', { session_id: _pendingSessionId });
        }
      } else if (msg.status === 'thinking') {
        AppState.set('statusText', __t('status.thinking') || 'Thinking...');
      } else if (msg.status === 'interrupting') {
        AppState.set('statusText', __t('status.interrupting') || 'Interrupting...');
      } else if (msg.status === 'compacting') {
        AppState.set('statusText', __t('status.compacting') || 'Compacting...');
      } else if (msg.status === 'starting' || msg.status === 'restarting') {
        AppState.set('connection', 'disconnected');
        AppState.set('statusText', msg.status === 'restarting'
          ? (__t('status.switching_model') || 'Switching model...')
          : (__t('status.starting') || 'Starting...'));
      }
      if (msg.model && (!_profileSwitchTime || Date.now() - _profileSwitchTime > 3000)) AppState.set('modelName', msg.model);
      if (msg.context_percent !== undefined) AppState.set('contextPercent', msg.context_percent);
    });

    // System events
    // (matches old app.js case "system")
    API.on('system', function (msg) {
      if (msg.subtype === 'compact_boundary') {
        AppState.set('statusText', __t('status.compacting') || 'Compacting...');
      } else if (msg.subtype === 'slash_commands' && msg.commands) {
        // Merge dynamic commands into existing list (matches old app.js line 3191-3205)
        var existing = AppState.slashCommands || [];
        var seen = {};
        for (var si = 0; si < existing.length; si++) seen[existing[si].cmd] = true;
        for (var mi = 0; mi < msg.commands.length; mi++) {
          if (!seen[msg.commands[mi].cmd]) {
            existing.push(msg.commands[mi]);
            seen[msg.commands[mi].cmd] = true;
          }
        }
        AppState.set('slashCommands', existing);
      }
    });

    // Context window usage
    // Backend sends { type: 'context_window', used_percentage, used_tokens, context_window_size }
    API.on('context_window', function (msg) {
      if (msg.used_percentage !== undefined) {
        AppState.set('contextPercent', msg.used_percentage);
      }
      if (msg.used_tokens !== undefined) {
        AppState.set('contextTokens', msg.used_tokens);
      }
      if (msg.context_window_size !== undefined) {
        AppState.set('contextMaxTokens', msg.context_window_size);
      }
    });

    // Session created: new empty session
    API.on('session_created', function (msg) {
      _pendingSessionId = null;
      AppState.set('currentSessionId', msg.session_id);
      AppState.reset();
      MessageStream.renderMessages();
      API.send('list_sessions');
    });

    // Session deleted
    API.on('session_deleted', function (msg) {
      if (msg.was_current && msg.resume_id) {
        AppState.set('currentSessionId', msg.resume_id);
      }
    });

    // Current session: backend sets the active session ID
    API.on('current_session', function (msg) {
      // Skip if waiting for a pending session to resume after model/profile switch
      if (_pendingSessionId) return;
      if (msg.session_id) {
        AppState.set('currentSessionId', msg.session_id);
      }
    });

    // Session loaded: full history batch
    // Backend sends { type: 'session_loaded', session_id, messages }
    API.on('session_loaded', function (msg) {
      _pendingSessionId = null;
      AppState.set('currentSessionId', msg.session_id);
      AppState.set('sessionsExpanded', false); // auto-collapse session list
      if (msg.messages) {
        AppState.set('messages', msg.messages);
      }
    });

    // Stream events — incrementally update messages
    API.on('stream_event', function (msg) {
      handleStreamEvent(msg);
    });

    // Session list
    // Backend sends { type: 'session_list', sessions: [...] }
    API.on('session_list', function (msg) {
      if (msg.sessions) AppState.set('sessions', msg.sessions);
    });

    // Slash commands — dynamic list from backend (also handled in system subtype)
    API.on('slash_commands', function (msg) {
      if (!msg.commands) return;
      var existing = AppState.slashCommands || [];
      var seen = {};
      for (var si = 0; si < existing.length; si++) seen[existing[si].cmd] = true;
      for (var mi = 0; mi < msg.commands.length; mi++) {
        if (!seen[msg.commands[mi].cmd]) {
          existing.push(msg.commands[mi]);
          seen[msg.commands[mi].cmd] = true;
        }
      }
      AppState.set('slashCommands', existing);
    });

    // Quick commands data
    // Backend sends { type: 'quick_cmds_data', commands: [...] }
    API.on('quick_cmds_data', function (msg) {
      if (msg.commands) AppState.set('quickCommands', msg.commands);
    });

    // Task events (backend sends individual events, not batched)
    API.on('task_started', function (msg) {
      var tasks = Object.assign({}, AppState.tasks);
      tasks[msg.task_id] = { id: msg.task_id, name: msg.description, description: msg.description, status: 'running', tool_calls: 0, tokens: 0, agent_type: msg.agent_type || '' };
      AppState.set('tasks', tasks);
    });
    API.on('task_progress', function (msg) {
      var tasks = Object.assign({}, AppState.tasks);
      if (tasks[msg.task_id]) {
        tasks[msg.task_id].progress = msg.progress_percent || 0;
        tasks[msg.task_id].tool_calls = msg.tool_uses || 0;
        tasks[msg.task_id].tokens = msg.total_tokens || 0;
      }
      AppState.set('tasks', tasks);
    });
    API.on('task_completed', function (msg) {
      var tasks = Object.assign({}, AppState.tasks);
      if (tasks[msg.task_id]) {
        tasks[msg.task_id].status = msg.status || 'completed';
        // Preserve the tool_calls/tokens from last progress update for display
      }
      AppState.set('tasks', tasks);
    });
    API.on('task_list', function (msg) {
      var tasks = {};
      if (msg.tasks) {
        for (var ti = 0; ti < msg.tasks.length; ti++) {
          var t = msg.tasks[ti];
          tasks[t.task_id] = { id: t.task_id, name: t.description, status: t.status || 'running' };
        }
      }
      AppState.set('tasks', tasks);
    });

    // Plan tasks
    API.on('plan_tasks', function (msg) {
      if (msg.tasks) AppState.set('planTasks', msg.tasks);
    });

    // Workspace files (for @mention file picker)
    API.on('workspace_files', function (msg) {
      if (msg.tree) FilePicker.setTree(msg.tree);
    });

    // Permission / control request (tool execution needs user approval)
    // Backend sends { type: 'control_request', request_id, request: { tool_name, tool_use_id, input, action_description } }
    API.on('control_request', function (msg) {
      var req = msg.request || {};
      var toolName = req.tool_name || '';
      var input = req.input || {};
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch (e) { input = {}; } }

      // AskUserQuestion: show multi-choice overlay instead of generic permit card
      if (toolName === 'AskUserQuestion') {
        var questions = input.questions || [];
        AskQuestion.open(questions, function (result) {
          if (result) {
            API.send('control_response', {
              request_id: msg.request_id,
              allowed: true,
              updatedInput: {
                questions: questions,
                answers: result.answers,
                annotations: result.annotations,
              },
            });
          } else {
            API.send('control_response', {
              request_id: msg.request_id,
              allowed: false,
            });
          }
        });
        return;
      }

      var filePath = input.file_path || input.path || '';
      var isTerminal = toolName === 'Bash' || toolName === 'PowerShell' || toolName === 'Shell';
      var isEdit = /edit|write|create|replace/i.test(toolName);
      var desc = req.action_description || '';

      console.log('[app-new] control_request', toolName, filePath);

      // Local escape helper
      function esc(s) {
        if (!s) return '';
        var d = document.createElement('div');
        d.appendChild(document.createTextNode(String(s)));
        return d.innerHTML;
      }

      // Build permission card directly (no external dependency)
      var card = DOM.createElement('div', { className: 'permit-card' });

      // Title
      var title = DOM.createElement('div', { className: 'permit-title' });
      var iconColor = isTerminal ? 'var(--yellow)' : 'var(--accent)';
      var titleText = isTerminal ? (__t('permission.pending') || 'Execute Command') :
        isEdit ? ((__t('permission.edit') || 'Edit') + (filePath ? ' — ' + filePath : '')) :
        ((__t('permission.read') || 'Read') + (filePath ? ' — ' + filePath : ''));
      title.innerHTML =
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="color:' + iconColor + ';margin-right:6px;">' +
          '<path d="M8 1.5l6 3.5v5.5l-6 3.5-6-3.5V5L8 1.5z"/>' +
        '</svg> ' + titleText;
      card.appendChild(title);

      // Body
      var body = DOM.createElement('div', { className: 'permit-body' });
      if (isTerminal) {
        var cmd = input.command || input.cmd || '';
        body.innerHTML = cmd ? '<pre style="margin:0;font-size:11px;white-space:pre-wrap;word-break:break-all;">' + (cmd.length > 300 ? cmd.slice(0, 300) + '...' : cmd) + '</pre>' : '';
      } else if (isEdit) {
        var oldStr = input.old_string || '';
        var newStr = input.new_string || input.content || '';
        if (oldStr && newStr) {
          var oldLines = oldStr.split('\n');
          var newLines = newStr.split('\n');
          var diffHtml = '';
          var maxShow = Math.min(Math.max(oldLines.length, newLines.length), 8);
          for (var di = 0; di < maxShow; di++) {
            var ol = di < oldLines.length ? oldLines[di] : null;
            var nl = di < newLines.length ? newLines[di] : null;
            if (ol === nl) {
              diffHtml += '<div style="font-size:10px;color:var(--fg-3);"> ' + esc(ol) + '</div>';
            } else {
              if (ol) diffHtml += '<div style="font-size:10px;color:var(--red);">- ' + esc(ol) + '</div>';
              if (nl) diffHtml += '<div style="font-size:10px;color:var(--green);">+ ' + esc(nl) + '</div>';
            }
          }
          var totalLines = Math.max(oldLines.length, newLines.length);
          if (totalLines > maxShow) diffHtml += '<div style="font-size:10px;color:var(--fg-3);">... ' + totalLines + ' lines</div>';
          body.innerHTML = diffHtml || (__t('permission.modify_file') || 'Modify file');
        } else {
          body.innerHTML = (__t('permission.modify_file') || 'Modify file') + (filePath ? ': ' + filePath : '');
        }
      } else {
        body.innerHTML = (__t('permission.read') || 'Read') + ': ' + (filePath || 'unknown');
      }
      card.appendChild(body);

      // Actions
      var actions = DOM.createElement('div', { className: 'permit-actions' });
      var respond = function (action) {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        // Must use TOP-LEVEL fields (matches old app.js respondToPermission)
        API.send('control_response', {
          request_id: msg.request_id,
          allowed: action === 'allow' || action === 'session' || action === 'always',
          session: action === 'session',
          always: action === 'always',
          reason: ''
        });
      };
      var btnSpecs = [
        { label: __t('permission.allow') || 'Allow', cls: 'permit-btn allow', action: 'allow' },
        { label: __t('permission.session_allow') || 'Session', cls: 'permit-btn', action: 'session' },
        { label: __t('permission.always_allow') || 'Always', cls: 'permit-btn', action: 'always' },
        { label: __t('permission.deny') || 'Deny', cls: 'permit-btn deny', action: 'deny' }
      ];
      for (var bi = 0; bi < btnSpecs.length; bi++) {
        var bs = btnSpecs[bi];
        var btn = DOM.createElement('button', { className: bs.cls }, bs.label);
        btn.addEventListener('click', (function (a) { return function () { respond(a); }; })(bs.action));
        actions.appendChild(btn);
      }
      card.appendChild(actions);

      // Append to overlay-root or fallback to messages area
      var overlayRoot = document.getElementById('overlay-root');
      var overlay = DOM.createElement('div', { className: 'permit-overlay' });
      overlay.appendChild(card);
      if (overlayRoot) {
        // Remove any existing permission prompt
        var existing = overlayRoot.querySelector('.permit-overlay');
        if (existing) existing.remove();
        overlayRoot.appendChild(overlay);
      } else {
        // Fallback: append to messages area
        var messagesEl = document.getElementById('messages');
        if (messagesEl) {
          var existing2 = messagesEl.querySelector('.permit-overlay');
          if (existing2) existing2.remove();
          messagesEl.appendChild(overlay);
        }
      }
    });

    // Interrupt acknowledged — clear permission overlay and stop thinking timer
    API.on('interrupt', function () {
      var overlayRoot = document.getElementById('overlay-root');
      if (overlayRoot) {
        var existing = overlayRoot.querySelector('.permit-overlay');
        if (existing) existing.remove();
      }
      if (typeof MessageStream !== 'undefined' && MessageStream.finalizeThinkTimers) {
        MessageStream.finalizeThinkTimers();
      }
    });

    // Permission mode changed by backend
    // Backend sends { type: 'permission_mode_changed', mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk' }
    API.on('permission_mode_changed', function (msg) {
      if (msg.mode) {
        AppState.set('permissionMode', msg.mode);
      }
    });

    // Backend sends { type: 'thinking_mode_changed', enabled: true/false }
    API.on('thinking_mode_changed', function (msg) {
      if (msg.enabled !== undefined) {
        AppState.set('thinkingEnabled', msg.enabled);
      }
    });

    // Model profiles list from backend
    API.on('model_profiles', function (msg) {
      if (msg.profiles) AppState.set('modelProfiles', msg.profiles);
      if (msg.active) AppState.set('activeProfile', msg.active);
    });

    // Side question from backend (user clarification)
    API.on('side_question', function (msg) {
      if (msg.question && msg.context_id) {
        SideQuestion.open(msg.question, function (answer) {
          API.send('side_question', {
            question: msg.question,
            answer: answer,
            context_id: msg.context_id
          });
        });
      }
    });

    // Side question result — matches pending translation contexts
    API.on('side_question_result', function (msg) {
      var ctx = _pendingTranslations[msg.context_id];
      if (ctx) {
        delete _pendingTranslations[msg.context_id];
        if (ctx.btn) {
          ctx.btn.textContent = '\uD83C\uDF10 ' + (__t('thinking.translate') || 'Translate');
          ctx.btn.disabled = false;
        }
        // DOM-based thinking block: directly append translation result
        if (ctx.block && ctx.block.querySelector) {
          var existing = ctx.block.querySelector('.thinking-translation');
          if (existing) existing.remove();
          if (msg.response) {
            var td = document.createElement('div');
            td.className = 'thinking-translation';
            td.textContent = msg.response;
            ctx.block.appendChild(td);
          }
        } else if (ctx.block) {
          // API thinking block: set on block object, trigger re-render
          ctx.block._translating = false;
          ctx.block._translateCtx = null;
          if (msg.response) {
            ctx.block._translation = msg.response;
          }
          AppState.set('messages', AppState.messages.slice());
        }
        return;
      }
      // Quick ask (SideQuestion overlay) — no context_id match expected
      if (typeof SideQuestion !== 'undefined' && SideQuestion.showResult) {
        SideQuestion.showResult(msg.response || msg.error || 'No response');
      }
    });

    // Log
    API.on('log', function (msg) {
      if (msg.message) console.log('[backend]', msg.message);
    });

    // Assistant message: backend sends full assistant turn.
    // For streamed responses this finalises; for slash-commands this is the ONLY response.
    // (matches old app.js case "assistant": renderAssistantMessage(msg))
    API.on('assistant', function (msg) {
      var message = msg.message;
      if (!message) return;
      var content = message.content;
      if (!Array.isArray(content)) content = [{ type: 'text', text: String(content || '') }];

      var msgs = AppState.messages.slice();
      var lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      // If last message is assistant, it was already built by handleStreamEvent
      // (including thinking blocks). Don't replace — just stamp the uuid.
      if (lastMsg && lastMsg.role === 'assistant') {
        // Streamed response — content already built by handleStreamEvent.
        // Just stamp uuid, don't replace (preserves thinking blocks).
        lastMsg.uuid = msg.uuid;
        if (!lastMsg.tokens && message.usage) lastMsg.tokens = message.usage;
        // Don't re-render messages — content is identical to message_stop render
      } else {
        // Slash command / non-streamed: this is the only response
        msgs.push({ role: 'assistant', content: content, uuid: msg.uuid });
        AppState.set('messages', msgs);
      }
      // Don't touch streaming/statusText — 'result' handles final state
    });

    // Tool result: backend sends tool execution output
    // (matches old app.js case "user": renderToolResult(msg))
    API.on('user', function (msg) {
      // Tool result: backend sends { type:'user', message:{ role:'user', content:[{type:'tool_result',...}] } }
      var message = msg.message;
      if (!message || !message.content) return;
      var contentArr = message.content;
      if (!Array.isArray(contentArr) || contentArr.length === 0) return;
      // Extract tool_use_id and result text from tool_result blocks
      var toolUseId = msg.parent_tool_use_id;
      var resultText = '';
      for (var ri = 0; ri < contentArr.length; ri++) {
        var item = contentArr[ri];
        if (!item) continue;
        if (item.tool_use_id && !toolUseId) toolUseId = item.tool_use_id;
        if (item.type === 'tool_result') {
          var inner = item.content;
          if (typeof inner === 'string') resultText += inner;
          else if (inner && typeof inner === 'object') resultText += JSON.stringify(inner, null, 2);
        }
      }

      var msgs = AppState.messages.slice();
      // Find the matching tool_use block by tool_use_id (preferred) or last one
      for (var mi = msgs.length - 1; mi >= 0; mi--) {
        if (msgs[mi].role === 'assistant' && Array.isArray(msgs[mi].content)) {
          for (var ui = msgs[mi].content.length - 1; ui >= 0; ui--) {
            var block = msgs[mi].content[ui];
            if (block.type === 'tool_use' && (!toolUseId || block.id === toolUseId)) {
              if (!block.output) block.output = resultText;
              if (!block.duration && msg.duration_ms) {
                block.duration = (msg.duration_ms / 1000).toFixed(1) + 's';
              }
              AppState.set('messages', msgs);
              return;
            }
          }
        }
      }
    });

    // Tool progress: real-time streaming output for bash tools
    // (matches old app.js case "tool_progress")
    API.on('tool_progress', function (msg) {
      if (!msg.data || msg.data.type !== 'bash_progress') return;
      var toolUseId = msg.parent_tool_use_id;
      var output = msg.data.fullOutput || msg.data.output || '';
      var msgs = AppState.messages.slice();
      for (var mi = msgs.length - 1; mi >= 0; mi--) {
        if (msgs[mi].role === 'assistant' && Array.isArray(msgs[mi].content)) {
          for (var ui = msgs[mi].content.length - 1; ui >= 0; ui--) {
            if (msgs[mi].content[ui].type === 'tool_use' && msgs[mi].content[ui].id === toolUseId) {
              msgs[mi].content[ui].output = output;
              if (msg.data.elapsedTimeSeconds) {
                msgs[mi].content[ui].duration = msg.data.elapsedTimeSeconds.toFixed(1) + 's';
              }
              AppState.set('messages', msgs);
              return;
            }
          }
        }
      }
    });

    // Result: backend signals end of a turn (success or error)
    API.on('result', function (msg) {
      // Finalize in-progress thinking blocks so re-render shows final times
      var resultMsgs = AppState.messages.slice();
      for (var rmi = resultMsgs.length - 1; rmi >= 0; rmi--) {
        if (resultMsgs[rmi].role === 'assistant' && Array.isArray(resultMsgs[rmi].content)) {
          for (var rci = 0; rci < resultMsgs[rmi].content.length; rci++) {
            var rblock = resultMsgs[rmi].content[rci];
            if ((rblock.type === 'thinking' || rblock.type === 'redacted_thinking') && rblock._startTime && !rblock._duration_ms) {
              rblock._duration_ms = Date.now() - rblock._startTime;
            }
          }
        }
      }
      AppState.set('statusText', msg.subtype === 'success'
        ? (__t('status.done') || 'Done')
        : (__t('status.error') || 'Error'));
      // Trigger re-render to collapse completed tool outputs
      AppState.set('messages', resultMsgs);
      // Stop any lingering thinking timers
      if (typeof MessageStream !== 'undefined' && MessageStream.finalizeThinkTimers) {
        MessageStream.finalizeThinkTimers();
      }
      // Auto-send next queued prompt. Use a processing lock so only one
      // setTimeout is active at a time — prevents the "second timeout finds
      // empty queue → sets streaming=false → user messages bypass queue" race.
      var _queueLen = (AppState.pendingQueue || []).length;
      if (_queueLen > 0 && !_queueProcessing) {
        _queueProcessing = true;
        setTimeout(function () {
          _queueProcessing = false;
          var q = AppState.pendingQueue || [];
          if (q.length === 0) return;
          var next = q[0];
          AppState.set('pendingQueue', q.slice(1));
          var userMsg = { role: 'user', type: 'user', content: next.text, attachments: next.attachments };
          var msgs = AppState.messages.concat([userMsg]);
          AppState.set('messages', msgs);
          AppState.set('streaming', true);
          API.send('user_message', { content: next.text, attachments: next.attachments });
        }, 300);
      } else if (_queueLen === 0) {
        AppState.set('streaming', false);
      }
      // Refresh session list after each turn so new sessions appear immediately
      API.send('list_sessions');
    });

    // Error
    API.on('error', function (msg) {
      _pendingSessionId = null;
      if (msg.message) {
        var errMsg = {
          role: 'assistant',
          type: 'error',
          content: '\u26A0\uFE0F ' + (__t('status.error') || 'Error') + ': ' + msg.message
        };
        var msgs = AppState.messages.concat([errMsg]);
        AppState.set('messages', msgs);
      }
    });

    // Partial assistant: non-streaming partial response
    // (matches old app.js case "partial_assistant": handlePartialAssistant(msg))
    // CRITICAL: Do NOT replace lastMsg.content entirely — partial_assistant is a
    // periodic snapshot that may lack tool_use blocks already streamed via
    // stream_event. Only upsert text/thinking blocks to avoid losing tool_use.
    API.on('partial_assistant', function (msg) {
      var message = msg.message;
      if (!message) return;
      var content = message.content;
      if (!Array.isArray(content)) content = [{ type: 'text', text: String(content || '') }];
      var msgs = AppState.messages.slice();
      var lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      if (!lastMsg || lastMsg.role !== 'assistant') {
        msgs.push({ role: 'assistant', content: content });
        AppState.set('messages', msgs);
        return;
      }
      // Partial snapshot arrived after streaming started — merge instead of replace.
      // For each block type that partial has but streamed message doesn't, add it.
      // Skip tool_use blocks (already created by stream_event content_block_start).
      // Only merge text and thinking blocks that haven't appeared via stream events.
      if (!Array.isArray(lastMsg.content)) {
        lastMsg.content = typeof lastMsg.content === 'string'
          ? [{ type: 'text', text: lastMsg.content }]
          : [];
      }
      var existingTypes = {};
      for (var pi = 0; pi < lastMsg.content.length; pi++) {
        var eb = lastMsg.content[pi];
        if (eb.type === 'text' || eb.type === 'thinking' || eb.type === 'redacted_thinking') {
          existingTypes[eb.type + '_' + eb._index] = true;
        }
      }
      for (var pj = 0; pj < content.length; pj++) {
        var pb = content[pj];
        if (!pb || !pb.type) continue;
        // Skip tool_use blocks — already created by stream_event
        if (pb.type === 'tool_use') continue;
        // Only add if not already present (by type+index)
        var key = pb.type + '_' + (pb._index !== undefined ? pb._index : pj);
        if (existingTypes[key]) continue;
        lastMsg.content.push(pb);
      }
      AppState.set('messages', msgs);
    });

    // Fill input: backend injects text into input
    // (matches old app.js case "fill_input")
    // Fill input: backend injects text/selection chip into input
    // (matches old app.js case "fill_input")
    API.on('fill_input', function (msg) {
      if (msg.selection) {
        InputArea.insertSelectionChip(
          msg.selection.filePath || msg.selection.path || '',
          msg.selection.startLine || 0,
          msg.selection.endLine || 0
        );
      } else {
        var inputEl = document.getElementById('input');
        if (inputEl && msg.text) {
          inputEl.textContent = msg.text;
          InputArea.updateEmptyState && InputArea.updateEmptyState();
          InputArea.updateSendButton && InputArea.updateSendButton();
        }
      }
    });

    // IDE context: protocol sends { files:[{path,content,language}], selection:{path,startLine,endLine,text}, diagnostics:[...] }
    API.on('ide_context', function (msg) {
      if (msg.files && msg.files.length > 0) {
        AppState.set('contextFiles', msg.files.map(function (f) {
          var p = typeof f === 'string' ? f : f.path;
          return { path: p, name: p.replace(/^.*[\\/]/, '') };
        }));
      }
      if (msg.selection && msg.selection.text) {
        var sel = msg.selection;
        var start = (sel.startLine != null ? sel.startLine : sel.start_line) || 0;
        var end = (sel.endLine != null ? sel.endLine : sel.end_line) || 0;
        AppState.set('contextSelection', {
          file: sel.path || '',
          code: sel.text,
          startLine: start + 1,
          endLine: end + 1
        });
      } else {
        // No selection in this update — clear preview (user deselected or switched file)
        AppState.set('contextSelection', null);
      }
      if (msg.diagnostics) {
        AppState.set('contextDiagnostics', msg.diagnostics);
      }
    });

    // TUI-only notice: command requires terminal mode
    // (matches old app.js case "tui_only_notice")
    API.on('tui_only_notice', function (msg) {
      var noticeMsg = {
        role: 'assistant',
        content: [{ type: 'text', text: __t('tui_only.message', { cmd: msg.command }) || ('`' + msg.command + '` ' + (__t('tui_only.terminal') || 'requires terminal mode')) }]
      };
      var msgs = AppState.messages.concat([noticeMsg]);
      AppState.set('messages', msgs);
    });

    // Clipboard: write text to system clipboard
    // (matches old app.js case "clipboard")
    API.on('clipboard', function (msg) {
      if (msg.text && navigator.clipboard) {
        navigator.clipboard.writeText(msg.text).catch(function (err) {
          console.warn('[app-new] clipboard write failed:', err);
        });
      }
    });

    // File picked: backend returns file content/dir listing for @mention chips
    // (matches old app.js case "file_picked")
    API.on('file_picked', function (msg) {
      if (msg.files) {
        for (var fi = 0; fi < msg.files.length; fi++) {
          var f = msg.files[fi];
          InputArea.insertFileChip(f.path, f.path.replace(/^.*[\\/]/, ''));
        }
      }
    });

    // Model profile changed: backend confirms profile switch.
    // Clear the prompt queue — queued messages were written for the old model
    // and the backend restart will orphan them anyway.
    API.on('model_profile_changed', function (msg) {
      _profileSwitchTime = Date.now();
      if ((AppState.pendingQueue || []).length > 0) {
        AppState.set('pendingQueue', []);
        AppState.set('streaming', false);
      }
      if (msg.profile) {
        AppState.set('activeProfile', msg.profile);
        var profiles = AppState.modelProfiles || [];
        var matched = null;
        for (var i = 0; i < profiles.length; i++) {
          if (profiles[i].id === msg.profile) { matched = profiles[i]; break; }
        }
        AppState.set('modelName', msg.model || (matched && matched.model) || msg.profile);
      }
      _pendingSessionId = AppState.currentSessionId;
    });

    // Session renamed
    // (matches old app.js case "session_renamed")
    API.on('session_renamed', function (msg) {
      var sessions = AppState.sessions.slice();
      for (var si = 0; si < sessions.length; si++) {
        if (sessions[si].id === msg.session_id) {
          sessions[si].title = msg.title;
          break;
        }
      }
      AppState.set('sessions', sessions);
    });

    // Rewind points
    // (matches old app.js case "rewind_points")
    API.on('rewind_points', function (msg) {
      if (msg.points) AppState.set('rewindPoints', msg.points);
    });

    // Rewind completed
    // (matches old app.js case "rewind_completed")
    API.on('rewind_completed', function () {
      AppState.set('statusText', __t('status.ready') || 'Ready');
    });
  }

  /* ─── Stream event handling ─── */
  /* CRITICAL: Must NOT call AppState.set('messages', ...) on every event.
     Old app.js directly appends to DOM — full re-render on each event
     kills performance for long conversations (2761+ msgs × 1000s of events). */

  // Streaming state (matches old app.js global state pattern)
  var contentBlockIndexToId = {};  // event.index → tool_use block id
  var toolInputJson = {};          // tool_use block id → accumulated partial JSON string
  var streamingContentText = '';   // accumulate text for copy
  var _textRenderTimer = null;    // throttle text_delta re-renders (40ms)
  var _renderedThinkKeys = {};    // "msgCount:index" → bool — tracks which thinking blocks have DOM

  function handleStreamEvent(msg) {
    var messages = AppState.messages.slice();
    var event = msg.event || msg;
    if (!event) return;

    // Find or create the current assistant message
    var lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    if (!lastMsg || (lastMsg.role || lastMsg.type || '') !== 'assistant') {
      lastMsg = { role: 'assistant', content: [] };
      messages.push(lastMsg);
      // Reset streaming state for new message
      contentBlockIndexToId = {};
      toolInputJson = {};
      streamingContentText = '';
    }

    // Ensure content is an array
    if (!Array.isArray(lastMsg.content)) {
      lastMsg.content = typeof lastMsg.content === 'string'
        ? [{ type: 'text', text: lastMsg.content }]
        : [];
    }

    // ====================================================================
    // Handle event types — matches old app.js handleStreamEvent case-by-case
    // ====================================================================

    if (event.type === 'content_block_start') {
      var cb = event.content_block;
      if (!cb) return;

      if (cb.type === 'tool_use') {
        // Register index→id mapping (matches old app.js pattern)
        if (cb.id) {
          contentBlockIndexToId[event.index] = cb.id;
          toolInputJson[cb.id] = '';
        }
        var toolBlock = {
          type: 'tool_use',
          name: cb.name || '',
          id: cb.id || '',
          input: cb.input || {},
          _index: event.index
        };
        lastMsg.content.push(toolBlock);

      } else if (cb.type === 'thinking' || cb.type === 'redacted_thinking') {
        var thinkBlock = { type: cb.type };
        if (cb.thinking !== undefined) thinkBlock.thinking = cb.thinking;
        thinkBlock._index = event.index;
        thinkBlock._startTime = Date.now();
        lastMsg.content.push(thinkBlock);

      } else if (cb.type === 'text') {
        var textBlock = { type: 'text', text: cb.text || '' };
        textBlock._index = event.index;
        lastMsg.content.push(textBlock);

      } else {
        // Generic fallback for unknown block types
        var genericBlock = { type: cb.type };
        if (cb.text !== undefined) genericBlock.text = cb.text;
        if (cb.thinking !== undefined) genericBlock.thinking = cb.thinking;
        if (cb.name) genericBlock.name = cb.name;
        if (cb.id) genericBlock.id = cb.id;
        if (cb.input) genericBlock.input = cb.input;
        genericBlock._index = event.index;
        lastMsg.content.push(genericBlock);
      }

    } else if (event.type === 'content_block_delta') {
      var delta = event.delta;
      if (!delta) return;

      if (delta.type === 'text_delta') {
        // Accumulate text on the text block (find by index)
        for (var di = 0; di < lastMsg.content.length; di++) {
          if (lastMsg.content[di]._index == event.index && lastMsg.content[di].type === 'text') {
            lastMsg.content[di].text = (lastMsg.content[di].text || '') + (delta.text || '');
            streamingContentText += delta.text || '';
            break;
          }
        }
        // Throttled re-render for text streaming (perf: avoid re-render on every char).
        // Use AppState.messages (latest data) instead of closure var to avoid
        // losing deltas that arrived faster than 40ms.
        if (!_textRenderTimer) {
          _textRenderTimer = setTimeout(function () {
            _textRenderTimer = null;
            AppState.set('messages', AppState.messages.slice());
            if (AppState.autoScroll) {
              var sa = document.getElementById('scroll-area');
              if (sa) sa.scrollTop = sa.scrollHeight;
            }
          }, 40);
        }
      } else if (delta.type === 'thinking_delta') {
        for (var ti = 0; ti < lastMsg.content.length; ti++) {
          if (lastMsg.content[ti]._index == event.index && (lastMsg.content[ti].type === 'thinking' || lastMsg.content[ti].type === 'redacted_thinking')) {
            lastMsg.content[ti].thinking = (lastMsg.content[ti].thinking || '') + (delta.thinking || '');
            break;
          }
        }
        // Direct DOM update instead of full re-render — rapid thinking deltas
        // can block the UI thread if every event rebuilds all messages.
        if (delta.thinking) {
          var msgLen = AppState.messages.length;
          var thinkKey = msgLen + ':' + event.index;
          var isNewBlock = !_renderedThinkKeys[thinkKey];

          if (isNewBlock) {
            // First delta for this thinking block — DOM doesn't have the
            // element yet. Do a full render to create it, then subsequent
            // deltas can do direct DOM updates.
            _renderedThinkKeys[thinkKey] = true;
            AppState.set('messages', messages);
          } else {
            // Subsequent deltas — find existing .thinking-content and append
            var allThink = document.querySelectorAll('.thinking-block');
            var lastThink = allThink[allThink.length - 1];
            var tc = lastThink ? lastThink.querySelector('.thinking-content') : null;
            if (tc) {
              tc.textContent += delta.thinking;
              // Update live token estimate in header
              var tokenSpan = lastThink.querySelector('.thinking-tokens');
              if (tokenSpan) {
                var newTokens = Math.round(tc.textContent.length / 3.5);
                tokenSpan.textContent = '(~' + newTokens + ' tokens)';
              }
              if (AppState.autoScroll) {
                var sa = document.getElementById('scroll-area');
                if (sa) sa.scrollTop = sa.scrollHeight;
              }
            } else {
              // DOM gone missing — fall back to full render
              AppState.set('messages', messages);
            }
          }
        }
      } else if (delta.type === 'input_json_delta') {
        // Match old app.js: use contentBlockIndexToId to find the right block
        var toolId = contentBlockIndexToId[event.index];
        if (toolId && toolInputJson[toolId] !== undefined) {
          toolInputJson[toolId] += delta.partial_json || '';
          // Try to parse the accumulated JSON
          try {
            var parsed = JSON.parse(toolInputJson[toolId]);
            // Update the tool_use block's input
            for (var uj = 0; uj < lastMsg.content.length; uj++) {
              if (lastMsg.content[uj].id === toolId && lastMsg.content[uj].type === 'tool_use') {
                lastMsg.content[uj].input = parsed;
                break;
              }
            }
            delete toolInputJson[toolId];
          } catch (e) {
            // Keep accumulating
          }
        }
      }

    } else if (event.type === 'content_block_stop') {
      // Finalize thinking block duration
      var thinkIdx = -1;
      for (var tz = lastMsg.content.length - 1; tz >= 0; tz--) {
        if (lastMsg.content[tz]._index == event.index && (lastMsg.content[tz].type === 'thinking' || lastMsg.content[tz].type === 'redacted_thinking')) {
          thinkIdx = tz;
          break;
        }
      }
      if (thinkIdx >= 0 && lastMsg.content[thinkIdx]._startTime) {
        lastMsg.content[thinkIdx]._duration_ms = Date.now() - lastMsg.content[thinkIdx]._startTime;
      }

      // Finalize any remaining unparsed tool input (backup parse)
      for (var toolIdKey in toolInputJson) {
        if (toolInputJson[toolIdKey]) {
          try {
            var parsedLate = JSON.parse(toolInputJson[toolIdKey]);
            for (var k = 0; k < lastMsg.content.length; k++) {
              if (lastMsg.content[k].id === toolIdKey && lastMsg.content[k].type === 'tool_use') {
                lastMsg.content[k].input = parsedLate;
                break;
              }
            }
            delete toolInputJson[toolIdKey];
          } catch (e) { /* keep */ }
        }
      }

    } else if (event.type === 'message_start') {
      // Force new assistant message: the previous assistant may have had
      // tool_use output silently attached by the 'user' handler, so its
      // content array is no longer empty. Without this, new content blocks
      // would be appended to the wrong message (merging two turns).
      lastMsg = { role: 'assistant', content: [] };
      messages.push(lastMsg);
      contentBlockIndexToId = {};
      toolInputJson = {};
      streamingContentText = '';
      _renderedThinkKeys = {};

    } else if (event.type === 'message_delta') {
      if (event.usage) {
        lastMsg.tokens = event.usage;
        // Accumulate session tokens (matches old app.js line 829-830)
        var sessTok = AppState.sessionTokens || { input: 0, output: 0 };
        if (event.usage.input_tokens) sessTok.input += event.usage.input_tokens;
        if (event.usage.output_tokens) sessTok.output += event.usage.output_tokens;
        AppState.set('sessionTokens', sessTok);
      }

    } else if (event.type === 'message_stop') {
      // Final sweep: parse any remaining tool input
      for (var tId in toolInputJson) {
        if (toolInputJson[tId]) {
          try {
            var finalParsed = JSON.parse(toolInputJson[tId]);
            for (var f = 0; f < lastMsg.content.length; f++) {
              if (lastMsg.content[f].id === tId && lastMsg.content[f].type === 'tool_use') {
                lastMsg.content[f].input = finalParsed;
                break;
              }
            }
          } catch (e) { /* keep */ }
        }
      }

      // One assistant message done — render it. Do NOT set status=Ready here:
      // multiple assistant messages (tool-call loop) may follow. Only 'result' does.
      AppState.set('messages', messages);
      return;

    } else if (event.type === 'tool_use') {
      lastMsg.content.push({
        type: 'tool_use',
        name: event.name,
        input: event.input,
        id: event.id
      });
    }

    // Silent update — no full re-render during streaming
    AppState.messages = messages;
  }

  /* ─── Init ─── */

  function init() {
    console.log('[app-new] UI initialising — v2 redesign');

    // Build the layout
    buildLayout();

    // Setup API handlers
    setupAPIHandlers();

    // Signal ready to extension host
    API.send('ready');

    // Request initial data (matching old app.js init sequence)
    setTimeout(function () {
      API.send('list_sessions');
      API.send('get_quick_cmds');
      API.send('list_tasks');
      API.send('request_model_profiles');
    }, 500);

    console.log('[app-new] UI ready');
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
