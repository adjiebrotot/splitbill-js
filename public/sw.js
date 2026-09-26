/* sw.js: Split Bill service worker (scope "/"). ONE copy, served from
 * public/ with Cache-Control: no-cache (next.config.mjs). The ?v= values and
 * CACHE name are written by scripts/stamp_assets.ts; never edit them by hand.
 *
 *   /app/api/*      never cached: money data is always live.
 *   /app/static/*   cache first (versioned, immutable).
 *   page loads      network first; offline, the page's cached shell, which
 *                   then renders its last boot payload from localStorage.
 */
const CACHE = 'sb-70ff7b80';
const STATIC = [
  '/app/static/css/shared.min.css?v=782c1c14',
  '/app/static/assets/fonts/dm-sans-latin-wght-normal.woff2?v=9fea608a',
  '/app/static/assets/fonts/dm-sans-latin-ext-wght-normal.woff2?v=a5d38fe9',
  '/app/static/assets/fonts/dm-mono-latin-400-normal.woff2?v=e1896b13',
  '/app/static/assets/fonts/dm-mono-latin-500-normal.woff2?v=9964608a',
  '/app/static/assets/fonts/dm-mono-latin-ext-400-normal.woff2?v=a52e19eb',
  '/app/static/assets/fonts/dm-mono-latin-ext-500-normal.woff2?v=8711f938',
  '/app/static/assets/icons.svg?v=17f4531f',
  '/app/static/js/i18n-all.js?v=c889fa2d',
  '/app/static/js/boot.min.js?v=54359d3c',
  '/app/static/js/engine.js?v=7c879c47',
  '/app/static/js/ui.min.js?v=57c20b9a',
  '/app/static/js/i18n.min.js?v=23384dda',
  '/app/static/js/topbar.min.js?v=901d34bd',
  '/app/static/js/currency.min.js?v=69826b20',
  '/app/static/js/sb.min.js?v=487a00c9',
  '/app/static/js/home.min.js?v=bbaaa1e5',
  '/app/static/js/group.min.js?v=b3d6e063',
  '/app/static/js/bill.min.js?v=cfff4427',
  '/app/static/js/settings.min.js?v=e966f9f7',
  '/app/static/js/join.min.js?v=0a643cc4',
  '/app/static/js/auth.min.js?v=b8c913fe',
  '/app/static/js/admin.min.js?v=2804245e',
  '/app/static/icons/icon-192.png?v=34543553',
  '/app/static/pages/landing.html?v=021cce83',
  '/app/static/pages/login.html?v=8c548e85',
  '/app/static/pages/register.html?v=3df07415',
  '/app/static/pages/home.html?v=a9b7178d',
  '/app/static/pages/group.html?v=3d18d3b6',
  '/app/static/pages/join.html?v=858e0799',
  '/app/static/pages/settings.html?v=20dd237c',
  '/app/static/pages/admin.html?v=3c813b6c',
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
