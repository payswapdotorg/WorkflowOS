/**
 * WORK-031: Claude Code fixture agent — deterministic stand-in for
 * the Claude Code coding-environment task flow on the fixture DOM (code.html).
 *
 * Real-submit only: the send button enables on input; a submit counts ONLY
 * via a send click on a non-empty composer
 * (window.__claudeCodeFixture.submits — the E2E asserts exactly 1).
 *
 * After a submit the fixture creates a task (/code/t/<id> pushState), shows
 * the stop control while running, then streams: working → repository
 * changes (branch/commit/PR/tests) → done (stop hidden).
 * Variants: ?wall=login · ?fail=1 · ?confirm=1 · ?xss=1
 */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var counter = { submits: 0, submittedTexts: [] };

  function expose() {
    window.__claudeCodeFixture = {
      submits: counter.submits,
      submittedTexts: counter.submittedTexts.slice(),
      taskPath: window.location.pathname,
    };
  }
  expose();

  var composer = document.getElementById('prompt-textarea');
  var sendBtn = document.getElementById('send-btn');
  var stopBtn = document.getElementById('stop-btn');
  var form = document.getElementById('composer-form');
  var taskLog = document.getElementById('task-log');
  var loginBtn = document.getElementById('login-btn');

  if (params.get('wall') === 'login') {
    composer.hidden = true;
    form.hidden = true;
    loginBtn.hidden = false;
    if (window.location.pathname.indexOf('/auth/login') !== 0) {
      window.history.replaceState({}, '', '/code/login');
    }
    return;
  }

  function composerText() {
    return (composer.textContent || '').replace(/\u00a0/g, ' ');
  }

  composer.addEventListener('input', function () {
    sendBtn.disabled = composerText().trim().length === 0;
  });

  function appendTask(text, cls, state) {
    var div = document.createElement('div');
    div.className = 'task ' + (cls || '');
    div.setAttribute('data-message-author-role', cls === 'agent' ? 'assistant' : 'user');
    if (state) div.setAttribute('data-state', state);
    div.textContent = text; // textContent ONLY — XSS probe never parsed.
    taskLog.appendChild(div);
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
    appendTask(prompt, 'user');

    if (!/^\/code\/t\//.test(window.location.pathname)) {
      var id = 't-' + Math.random().toString(16).slice(2, 8) + Math.random().toString(16).slice(2, 8);
      window.history.pushState({}, '', '/code/' + id);
      expose();
    }

    if (params.get('confirm') === '1') {
      var dlg = document.createElement('div');
      dlg.setAttribute('role', 'alertdialog');
      var inner = document.createElement('div');
      var label = document.createElement('p');
      label.textContent = 'Confirm: run this task in the coding environment?';
      var ok = document.createElement('button');
      ok.textContent = 'Confirm';
      ok.addEventListener('click', function () {
        dlg.remove();
        runTask();
      });
      inner.append(label, ok);
      dlg.appendChild(inner);
      document.body.appendChild(dlg);
      return; // blocked until the user confirms (§16)
    }

    runTask();
  });

  function runTask() {
    stopBtn.hidden = false;
    if (params.get('fail') === '1') {
      setTimeout(function () {
        appendTask('Setting up environment…', 'agent', 'streaming');
        setTimeout(function () {
          stopBtn.hidden = true;
          showError('Task failed: environment unavailable. Please try again.');
        }, 300);
      }, 200);
      return;
    }

    setTimeout(function () {
      appendTask('Working: analyzing the repository…', 'agent', 'streaming');
      setTimeout(function () {
        appendTask('Implementing on branch: `feat/work-fixture-001`', 'agent', 'streaming');
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
          appendTask(finalText, 'agent', 'done');
          stopBtn.hidden = true;
          var streamingAll = taskLog.querySelectorAll('[data-state="streaming"]');
          streamingAll.forEach(function (el) {
            el.removeAttribute('data-state');
          });
        }, 400);
      }, 350);
    }, 200);
  }
})();
