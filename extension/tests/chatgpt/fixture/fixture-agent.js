/**
 * WORK-030: ChatGPT fixture agent — deterministic stand-in for the real
 * ChatGPT behavior on the OBSERVED DOM contract (see index.html).
 *
 * Real-submit only: the send button enables via the input event, and a
 * submit ONLY counts when the send button is clicked on a non-empty
 * composer (window.__chatgptFixture.submits counts REAL submits — the E2E
 * asserts it equals 1 to prove exactly-once injection).
 *
 * After a submit the fixture "creates a conversation" (/c/<uuid> via
 * history.pushState), shows the stop-button while generating, then streams
 * a deterministic agent lifecycle: thinking → progress (branch/commit/PR/
 * tests) → done (stop-button hidden).
 * Variants: ?wall=login · ?fail=1 · ?confirm=1 · ?xss=1
 */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var counter = { submits: 0, submittedTexts: [] };

  function expose() {
    window.__chatgptFixture = {
      submits: counter.submits,
      submittedTexts: counter.submittedTexts.slice(),
      conversationPath: window.location.pathname,
    };
  }
  expose();

  var composer = document.getElementById('prompt-textarea');
  var sendBtn = document.getElementById('send-btn');
  var stopBtn = document.getElementById('stop-btn');
  var form = document.getElementById('composer-form');
  var transcript = document.getElementById('transcript');
  var loginBtn = document.getElementById('login-btn');

  // Login-wall variant: no composer, Log in visible (observed contract).
  if (params.get('wall') === 'login') {
    composer.hidden = true;
    form.hidden = true;
    loginBtn.hidden = false;
    if (window.location.pathname.indexOf('/auth/login') !== 0) {
      window.history.replaceState({}, '', '/auth/login');
    }
    return;
  }

  function composerText() {
    return (composer.textContent || '').replace(/\u00a0/g, ' ');
  }

  // Product-like enable-on-input (contenteditable + input event).
  composer.addEventListener('input', function () {
    sendBtn.disabled = composerText().trim().length === 0;
  });

  function appendMessage(text, cls, state) {
    var div = document.createElement('div');
    div.className = 'msg ' + (cls || '');
    // Observed product anchor for message authorship.
    div.setAttribute('data-message-author-role', cls === 'assistant' ? 'assistant' : 'user');
    if (state) div.setAttribute('data-state', state);
    // textContent ONLY — fixture content (incl. the XSS probe) is never
    // parsed as HTML.
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

  sendBtn.addEventListener('click', function () {
    if (sendBtn.disabled) return;
    var prompt = composerText();
    if (!prompt.trim()) return;
    counter.submits += 1;
    counter.submittedTexts.push(prompt);
    expose();
    composer.textContent = '';
    sendBtn.disabled = true;
    appendMessage(prompt, 'user');

    // Conversation creation (observed product behavior: /c/<uuid>).
    if (!/^\/c\//.test(window.location.pathname)) {
      var id =
        'c-' +
        Math.random().toString(16).slice(2, 8) + Math.random().toString(16).slice(2, 8);
      window.history.pushState({}, '', '/' + id);
      expose();
    }

    if (params.get('confirm') === '1') {
      var dlg = document.createElement('div');
      dlg.setAttribute('role', 'alertdialog');
      var inner = document.createElement('div');
      var label = document.createElement('p');
      label.textContent = 'Confirm: allow ChatGPT to run this action?';
      var ok = document.createElement('button');
      ok.textContent = 'Confirm';
      ok.addEventListener('click', function () {
        dlg.remove();
        runAgent();
      });
      inner.append(label, ok);
      dlg.appendChild(inner);
      document.body.appendChild(dlg);
      return; // blocked until the user confirms (§16)
    }

    runAgent();
  });

  function runAgent() {
    if (params.get('fail') === '1') {
      stopBtn.hidden = false; // generating marker visible
      setTimeout(function () {
        appendMessage('Working on it…', 'assistant', 'streaming');
        setTimeout(function () {
          stopBtn.hidden = true;
          showError('Generation failed: something went wrong. Please try again.');
        }, 300);
      }, 200);
      return;
    }

    stopBtn.hidden = false; // generating marker visible
    setTimeout(function () {
      appendMessage('Thinking…', 'assistant', 'streaming');
      setTimeout(function () {
        appendMessage('Implementing on branch: `feat/work-fixture-001`', 'assistant', 'streaming');
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
          // Generation finished: the stop control disappears (observed
          // streaming-completion signal).
          stopBtn.hidden = true;
          var streamingAll = transcript.querySelectorAll('[data-state="streaming"]');
          streamingAll.forEach(function (el) {
            el.removeAttribute('data-state');
          });
        }, 400);
      }, 350);
    }, 200);
  }
})();
