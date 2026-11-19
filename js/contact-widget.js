(function () {
  if (document.getElementById('contact-form') || document.getElementById('cw-root')) return;

  var css = document.createElement('style');
  css.textContent =
    '#cw-root{position:fixed;z-index:90;right:calc(16px + env(safe-area-inset-right,0px));bottom:calc(16px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;font-family:inherit}' +
    '#cw-btn,#cw-panel{pointer-events:auto}' +
    '#cw-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:48px;min-height:48px;padding:0 16px;border:0;border-radius:999px;background:#0EA57A;color:#080C12;font:inherit;font-weight:700;font-size:14px;cursor:pointer}' +
    '#cw-btn:focus-visible{outline:2px solid #F0F2F5}' +
    '#cw-panel{width:340px;max-height:min(70vh,560px);overflow:auto;background:#111827;color:#E2E8F0;border:1px solid #2D3748;border-radius:16px;padding:16px}' +
    '#cw-panel[hidden]{display:none}#cw-panel *{box-sizing:border-box}' +
    '.cw-head{display:flex;align-items:center;justify-content:space-between;gap:8px}' +
    '#cw-title{margin:0;font-size:16px;font-weight:700}' +
    '.cw-x{background:transparent;color:#9BA4B0;border:0;cursor:pointer;font:inherit;font-weight:600;min-width:48px;min-height:44px}' +
    '.cw-intro,.cw-note,#cw-status{font-size:13px;line-height:1.45;color:#9BA4B0}' +
    '.cw-intro{margin:0}.cw-note{margin:10px 0 0;font-size:12px}#cw-status{margin:8px 0 0;color:#E8B86D}' +
    '#cw-panel label{display:block;margin:10px 0 4px;font-size:13px;font-weight:600;color:#C8D0DB}' +
    '#cw-panel input,#cw-panel textarea{width:100%;background:#080C12;color:#E2E8F0;border:1px solid #2D3748;border-radius:10px;padding:10px 12px;font:inherit;font-size:14px}' +
    '#cw-panel textarea{min-height:96px;resize:vertical}' +
    '#cw-panel input:focus,#cw-panel textarea:focus{outline:2px solid #0EA57A}' +
    '.cw-hp{position:fixed;left:-9999px;top:0;width:1px;height:1px;border:0}' +
    '#cw-send,#cw-done .cw-x{display:block;margin-top:12px;min-height:44px;border:0;border-radius:10px;background:#0EA57A;color:#080C12;font:inherit;font-weight:700;cursor:pointer}' +
    '#cw-send{width:100%}#cw-send:disabled{opacity:.65}' +
    '.cw-note a,#cw-status a{color:#0EA57A}#cw-done p{margin:0;font-size:14px;line-height:1.5}' +
    'body{padding-bottom:calc(72px + env(safe-area-inset-bottom,0px))}' +
    '@media (max-width:599px){.cw-label{display:none}#cw-btn{width:48px;height:48px;padding:0}' +
    '#cw-root{left:calc(100vw - 60px - env(safe-area-inset-right,0px));top:calc(100vh - 60px - env(safe-area-inset-bottom,0px));right:auto;bottom:auto}' +
    '#cw-panel{position:fixed;left:0;width:100vw;max-width:100vw;max-height:70vh;top:calc(100vh - 72px - env(safe-area-inset-bottom,0px));transform:translateY(-100%);border-radius:16px 16px 0 0;border-width:1px 0 0}}' +
    '@media (prefers-reduced-motion:reduce){#cw-root{animation:none;transition:none}}';
  document.head.appendChild(css);

  var root = document.createElement('div');
  root.id = 'cw-root';
  root.innerHTML =
    '<div id="cw-panel" role="dialog" aria-labelledby="cw-title" hidden>' +
    '<div id="cw-form-wrap"><div class="cw-head"><h2 id="cw-title">Contact us</h2>' +
    '<button type="button" class="cw-x" id="cw-close">Close</button></div>' +
    '<p class="cw-intro">Send us a message and we will reply by email.</p>' +
    '<form id="cw-form" novalidate><label for="cw-email">Your email</label>' +
    '<input id="cw-email" name="email" type="email" autocomplete="email" required maxlength="254">' +
    '<label for="cw-message">Message</label>' +
    '<textarea id="cw-message" name="message" required maxlength="2000" placeholder="How can we help?"></textarea>' +
    '<label for="cw-name">Your name (optional)</label>' +
    '<input id="cw-name" name="name" type="text" autocomplete="name" maxlength="200">' +
    '<input class="cw-hp" type="text" name="website" tabindex="-1" aria-hidden="true" autocomplete="off">' +
    '<button type="submit" id="cw-send">Send</button><p id="cw-status" aria-live="polite"></p>' +
    '<p class="cw-note">We use your email only to reply. See our <a href="privacy-policy.html">privacy policy</a>.</p>' +
    '</form></div><div id="cw-done" hidden><p>Thank you. We have your message and will reply by email.</p>' +
    '<button type="button" class="cw-x" id="cw-done-close">Close</button></div></div>' +
    '<button type="button" id="cw-btn" aria-label="Contact us" aria-expanded="false" aria-controls="cw-panel">' +
    '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="currentColor" d="M4 4h16v11H8l-4 4z"/></svg>' +
    '<span class="cw-label">Contact us</span></button>';
  document.body.appendChild(root);

  var btn = document.getElementById('cw-btn');
  var panel = document.getElementById('cw-panel');
  var form = document.getElementById('cw-form');
  var formWrap = document.getElementById('cw-form-wrap');
  var done = document.getElementById('cw-done');
  var emailInput = document.getElementById('cw-email');
  var messageInput = document.getElementById('cw-message');
  var nameInput = document.getElementById('cw-name');
  var honeypot = form.querySelector('[name="website"]');
  var sendBtn = document.getElementById('cw-send');
  var status = document.getElementById('cw-status');
  var doneClose = document.getElementById('cw-done-close');

  function focusEl(el) {
    var x = window.scrollX, y = window.scrollY;
    if (el && el.focus) el.focus({ preventScroll: true });
    window.scrollTo(x, y);
  }
  function showFailure() {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    status.innerHTML = 'Could not send your message. Please email <a href="mailto:support@fleetmagnify.com">support@fleetmagnify.com</a>.';
  }
  function openPanel() {
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    focusEl(done.hidden ? emailInput : doneClose);
  }
  function closePanel() {
    var wasDone = !done.hidden;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (wasDone) {
      form.reset();
      status.textContent = '';
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
      formWrap.hidden = false;
      done.hidden = true;
    }
    focusEl(btn);
  }

  btn.addEventListener('click', function () { if (panel.hidden) openPanel(); else closePanel(); });
  document.getElementById('cw-close').addEventListener('click', closePanel);
  doneClose.addEventListener('click', closePanel);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); closePanel(); }
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (sendBtn.disabled) return;
    var email = emailInput.value.trim();
    var message = messageInput.value.trim();
    status.textContent = '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      status.textContent = 'Enter a valid email address.';
      focusEl(emailInput);
      return;
    }
    if (!message) {
      status.textContent = 'Enter a message.';
      focusEl(messageInput);
      return;
    }
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    var elapsed = (typeof performance !== 'undefined' && performance.now) ? Math.round(performance.now()) : 0;
    fetch('/api/contact-form', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'widget',
        email: email,
        message: message,
        name: nameInput.value.trim(),
        page: location.pathname,
        elapsed: elapsed,
        website: honeypot.value
      })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || !data || !data.ok) { showFailure(); return; }
        formWrap.hidden = true;
        done.hidden = false;
        status.textContent = '';
        if (!panel.hidden) focusEl(doneClose);
      });
    }).catch(showFailure);
  });
})();
