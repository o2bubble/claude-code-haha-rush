/* ═══════════════════════════════════════════════════
   ASK QUESTION — Multi-choice question overlay for
   the AskUserQuestion tool in IDE mode.

   Pattern: full-screen modal overlay (like side-question.js)
   Spec: AskUserQuestionTool — questions with header, options,
         preview, multiSelect, annotations
   ═══════════════════════════════════════════════════ */

var AskQuestion = (function () {

  // Hardcoded theme tokens (avoid CSS var() not resolving in inline styles)
  var TOKENS = {
    surface1: '#1e1e2e',
    surface2: '#2a2a3c',
    surface3: '#353550',
    surface1Light: '#ffffff',
    surface2Light: '#f5f5f7',
    surface3Light: '#e8e8ed',
    fg1: '#e0e0e0',
    fg2: '#b0b0b0',
    fg3: '#888888',
    fg1Light: '#1e1e1e',
    fg2Light: '#555555',
    fg3Light: '#999999',
    accent: '#7c3aed',
    border: '#404060',
    borderLight: '#d0d0d5',
    radiusSm: '6px',
    radiusLg: '10px',
    fontMono: 'var(--font-mono)',
  };

  var overlayEl = null;
  var questionStates = {};
  var currentQuestions = null;
  var callbackFn = null;
  var isDark = true;  // match app theme

  function t(key, fallback) {
    return (typeof __t === 'function' ? __t(key) : null) || fallback;
  }

  function tk(name) {
    if (isDark) return TOKENS[name];
    // Light theme variants
    var lightMap = {
      surface1: TOKENS.surface1Light,
      surface2: TOKENS.surface2Light,
      surface3: TOKENS.surface3Light,
      fg1: TOKENS.fg1Light,
      fg2: TOKENS.fg2Light,
      fg3: TOKENS.fg3Light,
      border: TOKENS.borderLight,
    };
    return lightMap[name] || TOKENS[name];
  }

  function detectTheme() {
    // Check if --surface-1 resolves to a dark or light value
    var test = document.createElement('div');
    test.style.display = 'none';
    test.style.backgroundColor = 'var(--surface-1)';
    document.body.appendChild(test);
    var bg = getComputedStyle(test).backgroundColor;
    document.body.removeChild(test);
    // rgb(30, 30, 46) or similar dark → isDark = true
    if (bg) {
      var parts = bg.match(/\d+/g);
      if (parts && parts.length >= 3) {
        var avg = (parseInt(parts[0]) + parseInt(parts[1]) + parseInt(parts[2])) / 3;
        isDark = avg < 128;
      }
    }
  }

  function open(questions, callback) {
    if (overlayEl) close();
    if (!questions || questions.length === 0) {
      callback(null);
      return;
    }
    detectTheme();
    currentQuestions = questions;
    callbackFn = callback;
    questionStates = {};
    for (var qi = 0; qi < questions.length; qi++) {
      questionStates[qi] = { selected: [], notes: '' };
      if (!questions[qi].multiSelect && questions[qi].options && questions[qi].options.length > 0) {
        questionStates[qi].selected = [questions[qi].options[0].label];
      }
    }
    overlayEl = createOverlay();
    document.getElementById('overlay-root').appendChild(overlayEl);
    var firstOpt = overlayEl.querySelector('.ask-option');
    if (firstOpt) firstOpt.focus();
  }

  function close() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    currentQuestions = null;
    callbackFn = null;
  }

  function collectAnswers() {
    var answers = {};
    var annotations = {};
    for (var qi = 0; qi < currentQuestions.length; qi++) {
      var q = currentQuestions[qi];
      var st = questionStates[qi];
      var selected = st.selected;
      if (selected.length === 0) continue;
      answers[q.question] = selected.join(', ');
      var ann = {};
      if (st.notes) ann.notes = st.notes;
      for (var oi = 0; oi < (q.options || []).length; oi++) {
        if (q.options[oi].label === selected[0] && q.options[oi].preview) {
          ann.preview = q.options[oi].preview;
          break;
        }
      }
      if (Object.keys(ann).length > 0) annotations[q.question] = ann;
    }
    return { answers: answers, annotations: annotations };
  }

  // BUGFIX: capture callbackFn before close() clears it
  function submit() {
    var result = collectAnswers();
    var cb = callbackFn;
    close();
    if (cb) cb(result);
  }

  function cancel() {
    var cb = callbackFn;
    close();
    if (cb) cb(null);
  }

  function toggleOption(qi, label, multi) {
    var st = questionStates[qi];
    if (multi) {
      var idx = st.selected.indexOf(label);
      if (idx >= 0) st.selected.splice(idx, 1);
      else st.selected.push(label);
    } else {
      st.selected = [label];
    }
    updateUI();
  }

  function updateUI() {
    if (!overlayEl) return;
    var allOpts = overlayEl.querySelectorAll('.ask-option');
    for (var oi = 0; oi < allOpts.length; oi++) {
      var opt = allOpts[oi];
      var qi = parseInt(opt.dataset.qi, 10);
      var label = opt.dataset.label;
      var st = questionStates[qi];
      var isSelected = st.selected.indexOf(label) >= 0;
      opt.classList.toggle('selected', isSelected);
      opt.style.background = isSelected ? tk('surface3') : tk('surface1');
      opt.style.borderColor = isSelected ? tk('accent') : tk('border');
      var radio = opt.querySelector('.ask-option-radio');
      if (radio) {
        radio.textContent = isSelected ? '\u25CF' : '\u25CB';  // ● or ○
      }
      var checkbox = opt.querySelector('.ask-option-checkbox');
      if (checkbox) {
        checkbox.textContent = isSelected ? '\u2611' : '\u2610';  // ☑ or ☐
      }
    }
    updatePreviews();
    var submitBtn = overlayEl.querySelector('.ask-submit');
    if (submitBtn) {
      var hasAnswers = false;
      for (var qi2 = 0; qi2 < currentQuestions.length; qi2++) {
        if (questionStates[qi2].selected.length > 0) { hasAnswers = true; break; }
      }
      submitBtn.disabled = !hasAnswers;
      submitBtn.style.opacity = hasAnswers ? '' : '0.4';
    }
  }

  function updatePreviews() {
    var previews = overlayEl.querySelectorAll('.ask-preview-area');
    for (var pi = 0; pi < previews.length; pi++) {
      var pqi = parseInt(previews[pi].dataset.qi, 10);
      var st = questionStates[pqi];
      var found = false;
      if (st.selected.length > 0) {
        var q = currentQuestions[pqi];
        for (var oi2 = 0; oi2 < (q.options || []).length; oi2++) {
          if (q.options[oi2].label === st.selected[0] && q.options[oi2].preview) {
            previews[pi].textContent = q.options[oi2].preview;
            previews[pi].style.display = '';
            found = true;
            break;
          }
        }
      }
      if (!found) previews[pi].style.display = 'none';
    }
  }

  function createOverlay() {
    var S = tk('surface1'), S2 = tk('surface2'), S3 = tk('surface3');
    var F1 = tk('fg1'), F2 = tk('fg2'), F3 = tk('fg3');
    var B = tk('border'), ACC = tk('accent');
    var RAD = tk('radiusSm'), RAD_LG = tk('radiusLg');

    // Backdrop — solid dark overlay
    var backdrop = DOM.createElement('div', {
      className: 'ask-question-backdrop',
      style: {
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }
    });
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) cancel();
    });

    // Modal — hardcoded background
    var modal = DOM.createElement('div', {
      className: 'ask-question-modal',
      style: {
        backgroundColor: S, borderRadius: RAD_LG,
        width: '500px', maxHeight: '80vh', display: 'flex',
        flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        overflow: 'hidden'
      }
    });

    // Header
    var header = DOM.createElement('div', {
      className: 'ask-question-modal-header',
      style: {
        padding: '14px 18px', borderBottom: '1px solid ' + B,
        fontSize: '13px', fontWeight: '600', color: F1,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0
      }
    }, t('ask_question.title', 'Claude wants your input'));
    modal.appendChild(header);

    // Body (scrollable)
    var body = DOM.createElement('div', {
      className: 'ask-question-modal-body',
      style: {
        flex: '1 1 auto', overflowY: 'auto', padding: '14px 18px',
        minHeight: 0
      }
    });

    for (var qi = 0; qi < currentQuestions.length; qi++) {
      var q = currentQuestions[qi];
      var isMulti = q.multiSelect === true;

      var card = DOM.createElement('div', {
        className: 'ask-question-card',
        style: { marginBottom: qi < currentQuestions.length - 1 ? '20px' : '4px' }
      });

      // Header chip
      if (q.header) {
        var chip = DOM.createElement('span', {
          className: 'ask-question-chip',
          style: {
            display: 'inline-block', padding: '2px 8px', fontSize: '10px',
            fontWeight: '600', textTransform: 'uppercase',
            color: ACC, backgroundColor: S3,
            borderRadius: RAD, marginBottom: '8px'
          }
        }, q.header);
        card.appendChild(chip);
      }

      // Question text
      var qt = DOM.createElement('div', {
        className: 'ask-question-text',
        style: {
          fontSize: '13px', fontWeight: '500', color: F1,
          marginBottom: '12px', lineHeight: '1.5'
        }
      }, q.question);
      card.appendChild(qt);

      // Options
      var opts = q.options || [];
      for (var oi2 = 0; oi2 < opts.length; oi2++) {
        var opt = opts[oi2];
        var isSelected = questionStates[qi].selected.indexOf(opt.label) >= 0;

        var optEl = DOM.createElement('div', {
          className: 'ask-option' + (isSelected ? ' selected' : ''),
          'data-qi': qi,
          'data-label': opt.label,
          tabindex: '0',
          style: {
            display: 'flex', alignItems: 'flex-start', gap: '10px',
            padding: '10px 12px', marginBottom: '6px', cursor: 'pointer',
            borderRadius: RAD,
            border: '1px solid ' + (isSelected ? ACC : B),
            backgroundColor: isSelected ? S3 : S,
            transition: 'background-color 0.15s, border-color 0.15s'
          }
        });

        // Indicator
        var indicator = DOM.createElement('span', {
          className: isMulti ? 'ask-option-checkbox' : 'ask-option-radio',
          style: {
            flexShrink: 0, fontSize: '15px', marginTop: '1px',
            color: ACC, width: '18px', textAlign: 'center'
          }
        }, isMulti ? (isSelected ? '\u2611' : '\u2610') : (isSelected ? '\u25CF' : '\u25CB'));
        optEl.appendChild(indicator);

        // Text
        var textArea = DOM.createElement('div', { style: { flex: '1', minWidth: 0 } });
        var lbl = DOM.createElement('div', {
          className: 'ask-option-label',
          style: { fontSize: '12px', fontWeight: '600', color: F1, lineHeight: '1.4' }
        }, opt.label);
        textArea.appendChild(lbl);
        if (opt.description) {
          var desc = DOM.createElement('div', {
            className: 'ask-option-desc',
            style: { fontSize: '11px', color: F2, marginTop: '3px', lineHeight: '1.4' }
          }, opt.description);
          textArea.appendChild(desc);
        }
        optEl.appendChild(textArea);

        // Click
        optEl.addEventListener('click', function (qIdx, label, multi) {
          return function (e) { e.stopPropagation(); toggleOption(qIdx, label, multi); };
        }(qi, opt.label, isMulti));

        // Keyboard
        optEl.addEventListener('keydown', function (qIdx, label, multi) {
          return function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggleOption(qIdx, label, multi);
            }
          };
        }(qi, opt.label, isMulti));

        // Hover
        optEl.addEventListener('mouseenter', function (el) {
          return function () { if (!el.classList.contains('selected')) el.style.backgroundColor = S2; };
        }(optEl));
        optEl.addEventListener('mouseleave', function (el, origBg) {
          return function () { if (!el.classList.contains('selected')) el.style.backgroundColor = origBg; };
        }(optEl, isSelected ? S3 : S));

        card.appendChild(optEl);
      }

      // Preview area
      if (opts.length > 0) {
        var preview = DOM.createElement('div', {
          className: 'ask-preview-area',
          'data-qi': qi,
          style: {
            display: 'none', marginTop: '8px', padding: '10px',
            backgroundColor: S2, borderRadius: RAD,
            fontSize: '11px', color: F2, whiteSpace: 'pre-wrap',
            maxHeight: '150px', overflowY: 'auto',
            fontFamily: tk('fontMono'),
            border: '1px solid ' + B, lineHeight: '1.5'
          }
        });
        card.appendChild(preview);
      }

      // Notes
      var notesLabel = DOM.createElement('div', {
        style: { fontSize: '11px', color: F3, marginTop: '10px', marginBottom: '4px' }
      }, t('ask_question.notes', 'Notes (optional)'));
      card.appendChild(notesLabel);
      var notesInput = DOM.createElement('textarea', {
        className: 'ask-notes-input',
        placeholder: t('ask_question.notes_placeholder', 'Add your notes here\u2026'),
        style: {
          width: '100%', boxSizing: 'border-box', padding: '8px 10px',
          fontSize: '11px', borderRadius: RAD,
          border: '1px solid ' + B, backgroundColor: S2,
          color: F1, resize: 'vertical', minHeight: '30px',
          fontFamily: 'inherit', lineHeight: '1.4'
        }
      });
      notesInput.value = questionStates[qi].notes;
      notesInput.addEventListener('input', function (qIdx) {
        return function (e) { questionStates[qIdx].notes = e.target.value; };
      }(qi));
      card.appendChild(notesInput);

      body.appendChild(card);
    }

    modal.appendChild(body);

    // Footer
    var footer = DOM.createElement('div', {
      className: 'ask-question-modal-footer',
      style: {
        padding: '12px 18px', borderTop: '1px solid ' + B,
        display: 'flex', justifyContent: 'flex-end', gap: '8px',
        flexShrink: 0
      }
    });

    var cancelBtn = DOM.createElement('button', {
      className: 'ask-cancel',
      style: {
        padding: '7px 16px', fontSize: '12px',
        border: '1px solid ' + B,
        backgroundColor: 'transparent', color: F2,
        borderRadius: RAD, cursor: 'pointer'
      }
    }, t('ask_question.skip', 'Skip'));
    cancelBtn.addEventListener('click', cancel);
    footer.appendChild(cancelBtn);

    var submitBtn = DOM.createElement('button', {
      className: 'ask-submit',
      style: {
        padding: '7px 20px', fontSize: '12px', border: 'none',
        backgroundColor: ACC, color: '#ffffff',
        borderRadius: RAD, cursor: 'pointer', fontWeight: '600'
      }
    }, t('ask_question.submit', 'Submit'));
    submitBtn.addEventListener('click', submit);
    footer.appendChild(submitBtn);
    modal.appendChild(footer);

    // Escape → cancel
    modal.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') cancel();
    });

    backdrop.appendChild(modal);

    // Show initial previews
    setTimeout(function () { updatePreviews(); }, 0);

    return backdrop;
  }

  return { open: open, close: close };
})();
