/* sw.js: Split Bill service worker (scope "/"). ONE copy, served from
 * public/ with Cache-Control: no-cache (next.config.mjs). The ?v= values and
 * CACHE name are written by scripts/stamp_assets.ts; never edit them by hand.
 *
 *   /app/api/*      never cached: money data is always live.
 *   /app/static/*   cache first (versioned, immutable).
 *   page loads      network first; offline, the page's cached shell, which
 *                   then renders its last boot payload from localStorage.
 */
const CACHE = 'sb-871c41c1';
const STATIC = [
  '/app/static/css/shared.css?v=6142e9d3',
  '/app/static/assets/icons.svg?v=17f4531f',
  '/app/static/js/i18n-all.js?v=8cccab74',
  '/app/static/js/boot.js?v=466484cf',
  '/app/static/js/engine.js?v=7c879c47',
  '/app/static/js/ui.js?v=e64d328d',
  '/app/static/js/i18n.js?v=3c7c0ae8',
  '/app/static/js/topbar.js?v=208398f2',
  '/app/static/js/currency.js?v=06eddacb',
  '/app/static/js/home.js?v=7c85f23e',
  '/app/static/js/group.js?v=a5cc4251',
  '/app/static/js/bill.js?v=bfacd312',
  '/app/static/js/settings.js?v=df8606be',
  '/app/static/js/join.js?v=20af1930',
  '/app/static/js/auth.js?v=2cde165a',
  '/app/static/js/admin.js?v=cee8cd9e',
  '/app/static/icons/icon-192.png?v=34543553',
  '/app/static/pages/landing.html?v=4d21bd44',
  '/app/static/pages/login.html?v=1bb26978',
  '/app/static/pages/register.html?v=165547bb',
  '/app/static/pages/home.html?v=1bb93015',
  '/app/static/pages/group.html?v=6d8f57d2',
  '/app/static/pages/join.html?v=22841dac',
  '/app/static/pages/settings.html?v=90fb95f3',
  '/app/static/pages/admin.html?v=d0f1765f',
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
