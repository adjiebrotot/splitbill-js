/* topbar.js: the one top bar, on every signed-in page. Adapted from
 * finance-tracker topbar.js (same markup classes, built once, mounted first
 * in <body>). Split Bill has one page of its own, so there is no nav: the
 * logo goes home, Settings and Sign out sit in the user menu.
 *
 * Exposes:
 *   window.toggleUserMenu(ev)
 *   window.topbarSetUser(me)   fill in the name from the boot payload
 *   window.signOut()
 */
(function () {
  var PATH = String(location.pathname || '/app').replace(/\/+$/, '') || '/';

  function _build() {
    var bar = document.createElement('div');
    bar.className = 'top-bar';
    var setCur = PATH === '/app/settings' ? ' aria-current="page"' : '';
    bar.innerHTML =
      '<a class="logo" href="/app">' + icon('receipt') + ' <span data-i18n="app.name">Split Bill</span></a>' +
      '<div class="top-bar-right">' +
        '<div class="user-menu-wrap">' +
          '<button class="username-btn" type="button" onclick="toggleUserMenu(event)" aria-haspopup="true">' +
            '<span id="top-username">' + icon('user') + '</span>' +
          '</button>' +
          '<div class="user-dropdown" id="user-dropdown">' +
            '<a href="/app/settings"' + setCur + '>' + icon('gear') + ' <span data-i18n="nav.settings">Settings</span></a>' +
            '<div class="user-dropdown-divider"></div>' +
            '<a href="#" class="user-dropdown-signout" onclick="signOut(event)" data-i18n="nav.signout">Sign out</a>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.insertBefore(bar, document.body.firstChild);
    if (window.applyI18n) window.applyI18n(bar);
    return bar;
  }

  var bar = _build();
  var dd = bar.querySelector('#user-dropdown');

  window.toggleUserMenu = function (ev) {
    if (ev) ev.stopPropagation();
    dd.classList.toggle('open');
  };
  document.addEventListener('click', function () { dd.classList.remove('open'); });

  window.topbarSetUser = function (me) {
    if (!me) return;
    var el = document.getElementById('top-username');
    if (el) el.innerHTML = icon('user') + ' ' + esc(me.display_name || me.username || '');
  };

  window.signOut = function (ev) {
    if (ev) ev.preventDefault();
    if (window.sbClearCache) window.sbClearCache();
    api('auth/logout', { body: {} }).then(function () { location.href = '/login'; });
  };
}());
