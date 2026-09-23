/* auth.js: landing, sign-in and create-account pages. */
(function () {
  var errBox = document.getElementById('login-error');

  function showErr(code, params) {
    if (!errBox) return;
    errBox.textContent = errMsg(code, params);
    errBox.classList.add('show');
  }
  function clearErr() { if (errBox) errBox.classList.remove('show'); }

  function next() {
    var n = new URLSearchParams(location.search).get('next') || '/app';
    return /^\/(?!\/|\\)/.test(n) ? n : '/app';
  }

  // Keep ?next= across Sign In <-> Create Account, so an invite link still
  // lands on the invite after a new person registers.
  var nextParam = new URLSearchParams(location.search).get('next');
  if (nextParam && /^\/(?!\/|\\)/.test(nextParam)) {
    var links = document.querySelectorAll('a[href="/register"], a[href="/login"]');
    for (var j = 0; j < links.length; j++) {
      links[j].setAttribute('href', links[j].getAttribute('href') + '?next=' + encodeURIComponent(nextParam));
    }
  }

  // Language flags: remember the choice and re-render in it.
  var flags = document.querySelectorAll('.lang-flag-btn');
  for (var i = 0; i < flags.length; i++) {
    var b = flags[i];
    b.classList.toggle('active', b.getAttribute('data-lang') === window.__LANG__);
    b.addEventListener('click', function (ev) {
      var l = ev.currentTarget.getAttribute('data-lang');
      document.cookie = 'sb_lang=' + l + '; Path=/; Max-Age=31536000; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
      location.reload();
    });
  }

  var google = document.getElementById('google-btn');
  if (google) {
    api('auth/providers', { allow401: true }).then(function (r) {
      if (r.ok && r.data && r.data.google) {
        google.href = '/app/api/auth/google/start?next=' + encodeURIComponent(next());
        google.hidden = false;
      }
    });
    var gerr = new URLSearchParams(location.search).get('error');
    if (gerr) showErr(gerr);
  }

  var login = document.getElementById('login-form');
  if (login) {
    login.addEventListener('submit', function (ev) {
      ev.preventDefault();
      clearErr();
      var btn = document.getElementById('signin-btn');
      setBusy(btn, true);
      api('auth/login', {
        allow401: true,
        body: {
          identifier: document.getElementById('login-identifier').value,
          password: document.getElementById('login-password').value,
          remember: document.getElementById('remember-me').checked,
        },
      }).then(function (r) {
        if (r.ok) { location.href = next(); return; }
        setBusy(btn, false);
        showErr(r.code, r.params);
      });
    });
  }

  var reg = document.getElementById('register-form');
  if (reg) {
    reg.addEventListener('submit', function (ev) {
      ev.preventDefault();
      clearErr();
      var btn = document.getElementById('register-btn');
      setBusy(btn, true);
      var tz = '';
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
      api('auth/register', {
        allow401: true,
        body: {
          display_name: document.getElementById('reg-name').value,
          username: document.getElementById('reg-username').value,
          email: document.getElementById('reg-email').value,
          password: document.getElementById('reg-password').value,
          language: window.__LANG__,
          timezone: tz,
        },
      }).then(function (r) {
        if (r.ok) { location.href = next(); return; }
        setBusy(btn, false);
        showErr(r.code, r.params);
      });
    });
  }
}());
