/* settings.js: profile, password, Telegram link. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var ME = null;

  function fill(me) {
    ME = me;
    topbarSetUser(me);
    $('set-name').value = me.display_name;
    $('set-lang').value = me.language;
    fillCurrencySelect($('set-currency'), me.default_currency);
    $('set-tz').value = me.timezone;
    $('acct-desc').textContent = '@' + me.username + (me.email ? ' · ' + me.email : '');
    $('tg-status').textContent = t(me.telegram_linked ? 'tg.linked' : 'tg.web_not_linked');
    $('tg-link').textContent = t(me.telegram_linked ? 'tg.relink' : 'tg.link');
    try {
      var zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [];
      $('tz-list').innerHTML = zones.map(function (z) { return '<option value="' + esc(z) + '">'; }).join('');
    } catch (e) {}
  }

  $('profile-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var btn = $('profile-save');
    setBusy(btn, true);
    var lang = $('set-lang').value;
    api('settings', { method: 'PATCH', body: {
      display_name: $('set-name').value, language: lang,
      default_currency: $('set-currency').value, timezone: $('set-tz').value,
    } }).then(function (r) {
      setBusy(btn, false);
      if (!r.ok) return showToast(errMsg(r.code, r.params), 'error');
      if (lang !== window.__LANG__) { location.reload(); return; }
      fill(r.data);
      showToast(t('common.saved'));
    });
  });

  $('pw-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var btn = $('pw-save');
    setBusy(btn, true);
    api('settings/password', { body: { current: $('pw-current').value, next: $('pw-new').value } }).then(function (r) {
      setBusy(btn, false);
      if (!r.ok) return showToast(errMsg(r.code, r.params), 'error');
      $('pw-current').value = $('pw-new').value = '';
      showToast(t('set.pw_changed'));
    });
  });

  $('tg-link').addEventListener('click', function (ev) {
    var btn = ev.currentTarget;
    setBusy(btn, true);
    api('telegram/link-code', { body: {} }).then(function (r) {
      setBusy(btn, false);
      if (!r.ok) return showToast(errMsg(r.code, r.params), 'error');
      window.open(r.data.url, '_blank', 'noopener');
      $('tg-status').textContent = t('tg.open_hint');
    });
  });

  sbBoot().then(function (r) {
    if (!r.ok) return showToast(errMsg(r.code, r.params), 'error');
    fill(r.data.me);
  });
}());
