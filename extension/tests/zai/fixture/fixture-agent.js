/**
 * WORK-029: Z.ai fixture agent — deterministic stand-in for the real Z.ai
 * chat behavior on the OBSERVED DOM contract (see index.html).
 *
 * Real-submit only: the send button enables via the input event (React-like),
 * and a submit ONLY counts when the form submit fires with a non-empty
 * composer (window.__zaiFixture.submits counts REAL submits — the E2E
 * asserts it equals 1 to prove exactly-once injection).
 *
 * After a submit the fixture "creates a conversation" (/chat/<uuid> via
 * history.pushState) and streams a deterministic agent lifecycle:
 *   thinking → progress (branch/commit/PR/tests) → done.
 * Variants (query params): wall=login · fail=1 · confirm=1 · xss=1.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var counter = { submits: 0, submittedTexts: [] };

  function expose() {
    window.__zaiFixture = {
      submits: counter.submits,
      submittedTexts: counter.submittedTexts.slice(),
      conversationPath: window.location.pathname,
    };
  }
  expose();

  var input = document.getElementById('chat-input');
  var sendBtn = document.getElementById('send-btn');
  var form = document.getElementById('composer-form');
  var transcript = document.getElementById('transcript');
  var signin = document.getElementById('signin-btn');

  // Login-wall variant: no composer, Sign in visible (observed contract).
  if (params.get('wall') === 'login') {
    input.hidden = true;
    form.hidden = true;
    signin.hidden = false;
    return;
  }

  // React-like enable-on-input (the runtime uses the native setter + event).
  input.addEventListener('input', function () {
    sendBtn.disabled = input.value.trim().length === 0;
  });

  function appendMessage(text, cls, state) {
    var div = document.createElement('div');
    div.className = 'msg ' + (cls || '');
    if (state) div.setAttribute('data-state', state);
    // textContent ONLY — fixture content (incl. the XSS probe payload) is
    // never parsed as HTML.
    div.textContent = text;
    transcript.appendChild(div);
    return div;
  }

  function showError(text) {
    var slot = document.getElementById('error-slot');
    var div = document.createElement('div');
    div.setAttribute('role', 'alert');
    div.textContent = text;
    slot.appendChild(div);
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (sendBtn.disabled || !input.value.trim()) return;
    var prompt = input.value;
    counter.submits += 1;
    counter.submittedTexts.push(prompt);
    expose();
    input.value = '';
    sendBtn.disabled = true;
    appendMessage(prompt, 'user');

    // Conversation creation (observed product behavior: /chat/<id>).
    if (!/^\/chat\//.test(window.location.pathname)) {
      var id =
        'conv-' +
        Math.random().toString(16).slice(2, 8) + Math.random().toString(16).slice(2, 8);
      window.history.pushState({}, '', '/chat/' + id);
      expose();
    }

    if (params.get('confirm') === '1') {
      var dlg = document.createElement('div');
      dlg.setAttribute('role', 'alertdialog');
      var inner = document.createElement('div');
      var label = document.createElement('p');
      label.textContent = 'Confirm: apply these repository changes?';
      var ok = document.createElement('button');
      ok.textContent = 'Confirm';
      ok.addEventListener('click', function () {
        dlg.remove();
        runAgent();
      });
      inner.append(label, ok);
      dlg.appendChild(inner);
      document.body.appendChild(dlg);
      return; // blocked until the user confirms (§24)
    }

    runAgent();
  });

  function runAgent() {
    if (params.get('fail') === '1') {
      setTimeout(function () {
        appendMessage('Working on it…', 'assistant', 'streaming');
        setTimeout(function () {
          showError('Generation failed: model unavailable. Please try again.');
        }, 300);
      }, 200);
      return;
    }

    setTimeout(function () {
      appendMessage('Thinking…', 'assistant', 'streaming');
      setTimeout(function () {
        appendMessage(
          'Implementing on branch: `feat/work-fixture-001`',
          'assistant',
          'streaming'
        );
        setTimeout(function () {
          var finalText =
            'Task complete.\n' +
            'branch: feat/work-fixture-001\n' +
            'commit: 1a2b3c4d5e6f\n' +
            'pull request: #9\n' +
            '12 tests passed' +
            (params.get('xss') === '1'
              ? '\n<img src=x onerror="window.__pwned=1"><script>window.__pwned2=1<' + '/script>'
              : '');
          appendMessage(finalText, 'assistant', 'done');
          // All streaming markers are gone now (every intermediate message).
          var streamingAll = transcript.querySelectorAll('[data-state="streaming"]');
          streamingAll.forEach(function (el) {
            el.removeAttribute('data-state');
          });
        }, 400);
      }, 350);
    }, 200);
  }
})();
