/* sw.js: Split Bill service worker (scope "/"). ONE copy, served from
 * public/ with Cache-Control: no-cache (next.config.mjs). The ?v= values and
 * CACHE name are written by scripts/stamp_assets.ts; never edit them by hand.
 *
 *   /app/api/*      never cached: money data is always live.
 *   /app/static/*   cache first (versioned, immutable).
 *   page loads      network first; offline, the page's cached shell, which
 *                   then renders its last boot payload from localStorage.
 */
const CACHE = 'sb-603477d6';
const STATIC = [
  '/app/static/css/shared.css?v=8463989a',
  '/app/static/assets/icons.svg?v=17f4531f',
  '/app/static/js/i18n-all.js?v=619d0a8c',
  '/app/static/js/boot.js?v=4f3053eb',
  '/app/static/js/engine.js?v=f52c3ca1',
  '/app/static/js/ui.js?v=b30fcd5a',
  '/app/static/js/i18n.js?v=3c7c0ae8',
  '/app/static/js/topbar.js?v=87d85aba',
  '/app/static/js/currency.js?v=7e4d6b4b',
  '/app/static/js/home.js?v=f1448825',
  '/app/static/js/group.js?v=bddb48f7',
  '/app/static/js/bill.js?v=7cf7d1ab',
  '/app/static/js/settings.js?v=96386946',
  '/app/static/js/join.js?v=20af1930',
  '/app/static/js/auth.js?v=21ffab8d',
  '/app/static/icons/icon-192.png?v=b9439c9e',
  '/app/static/pages/landing.html?v=9ca2d718',
  '/app/static/pages/login.html?v=35347828',
  '/app/static/pages/register.html?v=953914ee',
  '/app/static/pages/home.html?v=a93323a6',
  '/app/static/pages/group.html?v=c6c0bf30',
  '/app/static/pages/join.html?v=4b2356b5',
  '/app/static/pages/settings.html?v=4ddfb204',
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
