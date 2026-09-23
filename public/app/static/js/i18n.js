/* i18n.js: tiny client-side translator. Adapted from finance-tracker.
 *
 * Ships no strings. boot.js picks the active language out of
 * window.__I18N_ALL__ (i18n-all.js, generated from src/i18n.ts) into
 * window.__I18N__ before first paint. This file:
 *   - window.t(key, ...subs)  translate a key, {0}/{1} positional substitution
 *   - window.applyI18n(root)  swap text/attrs on [data-i18n*] elements
 * It runs applyI18n() immediately (it is loaded at the end of <body>), so the
 * static shell is translated before the browser paints it.
 */
(function () {
  var I18N = window.__I18N__ || {};

  function t(key) {
    var s = I18N[key];
    if (s === undefined || s === null) return key;
    for (var i = 1; i < arguments.length; i++) {
      s = s.split('{' + (i - 1) + '}').join(String(arguments[i]));
    }
    return s;
  }
  window.t = t;

  function _each(root, sel, fn) {
    var nodes = root.querySelectorAll(sel);
    for (var i = 0; i < nodes.length; i++) fn(nodes[i]);
  }

  function applyI18n(root) {
    root = root || document;
    _each(root, '[data-i18n]', function (el) {
      var v = I18N[el.getAttribute('data-i18n')];
      if (v !== undefined) el.textContent = v;
    });
    _each(root, '[data-i18n-ph]', function (el) {
      var v = I18N[el.getAttribute('data-i18n-ph')];
      if (v !== undefined) el.setAttribute('placeholder', v);
    });
    _each(root, '[data-i18n-title]', function (el) {
      var v = I18N[el.getAttribute('data-i18n-title')];
      if (v !== undefined) el.setAttribute('title', v);
    });
    _each(root, '[data-i18n-tip]', function (el) {
      var v = I18N[el.getAttribute('data-i18n-tip')];
      if (v !== undefined) el.setAttribute('data-tip', v);
    });
    _each(root, '[data-i18n-aria]', function (el) {
      var v = I18N[el.getAttribute('data-i18n-aria')];
      if (v !== undefined) el.setAttribute('aria-label', v);
    });
  }
  window.applyI18n = applyI18n;
  applyI18n();
  document.documentElement.classList.remove('i18n-wait');
}());
