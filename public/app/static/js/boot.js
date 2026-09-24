/* boot.js: the first script on every page, loaded blocking in <head>.
 *
 * Pages are static HTML on the CDN (no function renders them), so this file
 * does what a server render used to, before first paint:
 *
 *   1. Signed-out on a signed-in page (no `sb_auth` hint cookie): go to login.
 *   2. Pick the language (`sb_lang` cookie, else the browser) and select that
 *      half of window.__I18N_ALL__ (i18n-all.js, loaded just before).
 *   3. Start the page's ONE data request (/app/api/boot) in parallel with the
 *      rest of the page's JS. window.sbBoot() resolves it.
 *   4. Offline: fall back to the last boot payload this browser saw for the
 *      same page, flagged `offline` so the page disables every write.
 *
 * The hint cookies grant nothing; the API checks the signed session on every
 * call and answers 401, which also lands on login.
 */
(function () {
  var script = document.currentScript;
  var PAGE = (script && script.getAttribute('data-page')) || '';
  var AUTH = script && script.getAttribute('data-auth') === '1';

  function cookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  var signedIn = cookie('sb_auth') === '1';
  if (AUTH && !signedIn) {
    location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash));
    return;
  }
  // The landing and sign-in pages send a signed-in visitor straight to the app.
  if ((PAGE === 'landing' || PAGE === 'login') && signedIn) {
    var next = new URLSearchParams(location.search).get('next') || '/app';
    location.replace(/^\/(?!\/|\\)/.test(next) ? next : '/app');
    return;
  }

  var lang = cookie('sb_lang');
  // The admin console is English only (its labels are not i18n keys).
  if (PAGE === 'admin') lang = 'en';
  if (lang !== 'en' && lang !== 'id') {
    lang = /^id\b/i.test(navigator.language || '') ? 'id' : 'en';
  }
  var all = window.__I18N_ALL__ || {};
  window.__LANG__ = lang;
  window.__I18N__ = all[lang] || all.en || {};
  document.documentElement.setAttribute('lang', lang);

  /* The boot request for this page. */
  var qs = '';
  var m;
  if (PAGE === 'group' && (m = location.pathname.match(/^\/app\/g\/([A-Za-z0-9]{4,16})/))) qs = '&id=' + m[1];
  if (PAGE === 'join' && (m = location.pathname.match(/^\/app\/join\/([A-Za-z0-9]{4,32})/))) qs = '&code=' + m[1];
  var KEY = 'sb_boot:' + PAGE + qs;

  window.sbBoot = function () { return _boot; };
  var _boot = !AUTH ? Promise.resolve({ ok: true, data: null }) :
    fetch('/app/api/boot?page=' + PAGE + qs, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401) {
          location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
          return new Promise(function () {});
        }
        return r.json().then(function (j) {
          if (j && j.ok) {
            try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), data: j.data })); } catch (e) {}
          }
          j.status = r.status;
          return j;
        });
      })
      .catch(function () {
        try {
          var c = JSON.parse(localStorage.getItem(KEY) || 'null');
          if (c) return { ok: true, data: c.data, offline: true, at: c.at };
        } catch (e) {}
        return { ok: false, code: 'offline', params: {}, offline: true };
      });

  /* Offline cache belongs to the account that wrote it. */
  window.sbClearCache = function () {
    try {
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (k && k.indexOf('sb_boot:') === 0) localStorage.removeItem(k);
      }
    } catch (e) {}
    try { if (window.caches) caches.keys().then(function (ks) { ks.forEach(function (k) { caches.delete(k); }); }); } catch (e) {}
  };

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
    });
  }
}());
