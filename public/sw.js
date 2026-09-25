/* sw.js: Split Bill service worker (scope "/"). ONE copy, served from
 * public/ with Cache-Control: no-cache (next.config.mjs). The ?v= values and
 * CACHE name are written by scripts/stamp_assets.ts; never edit them by hand.
 *
 *   /app/api/*      never cached: money data is always live.
 *   /app/static/*   cache first (versioned, immutable).
 *   page loads      network first; offline, the page's cached shell, which
 *                   then renders its last boot payload from localStorage.
 */
const CACHE = 'sb-87e4683f';
const STATIC = [
  '/app/static/css/shared.css?v=b8cf820d',
  '/app/static/assets/icons.svg?v=17f4531f',
  '/app/static/js/i18n-all.js?v=7d28b53c',
  '/app/static/js/boot.js?v=466484cf',
  '/app/static/js/engine.js?v=f52c3ca1',
  '/app/static/js/ui.js?v=d5b36f67',
  '/app/static/js/i18n.js?v=3c7c0ae8',
  '/app/static/js/topbar.js?v=208398f2',
  '/app/static/js/currency.js?v=7e4d6b4b',
  '/app/static/js/home.js?v=ff31c4cb',
  '/app/static/js/group.js?v=f8f721f7',
  '/app/static/js/bill.js?v=f276cb09',
  '/app/static/js/settings.js?v=445072ee',
  '/app/static/js/join.js?v=20af1930',
  '/app/static/js/auth.js?v=2cde165a',
  '/app/static/js/admin.js?v=30172910',
  '/app/static/icons/icon-192.png?v=34543553',
  '/app/static/pages/landing.html?v=11ed8ad5',
  '/app/static/pages/login.html?v=44c1548b',
  '/app/static/pages/register.html?v=2ed6f101',
  '/app/static/pages/home.html?v=be00e629',
  '/app/static/pages/group.html?v=5321f1f5',
  '/app/static/pages/join.html?v=8d9bbb1a',
  '/app/static/pages/settings.html?v=715a163f',
  '/app/static/pages/admin.html?v=467ea649',
];

/* Which shell a pretty URL is served from (mirrors next.config.mjs rewrites). */
function shellFor(pathname) {
  var p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/') return '/app/static/pages/landing.html';
  if (p === '/login') return '/app/static/pages/login.html';
  if (p === '/register') return '/app/static/pages/register.html';
  if (p === '/app') return '/app/static/pages/home.html';
  if (p === '/app/settings') return '/app/static/pages/settings.html';
  if (p.indexOf('/app/g/') === 0) return '/app/static/pages/group.html';
  if (p.indexOf('/app/join/') === 0) return '/app/static/pages/join.html';
  if (p === '/admin') return '/app/static/pages/admin.html';
  return null;
}

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(STATIC); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.indexOf('/app/api/') === 0) return;

  if (url.pathname.indexOf('/app/static/') === 0) {
    e.respondWith(caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        if (res.ok && url.search) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    }));
    return;
  }

  if (req.mode === 'navigate') {
    var shell = shellFor(url.pathname);
    if (!shell) return;
    e.respondWith(fetch(req).catch(function () {
      return caches.match(shell, { ignoreSearch: true }).then(function (hit) {
        return hit || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
      });
    }));
  }
});
