/* settings.js: profile (with photo), password, Telegram link. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var ME = null;

  function fill(me) {
    ME = me;
    topbarSetUser(me);
    $('set-name').value = me.display_name;
    fillAvatar(me);
    $('set-lang').value = me.language;
    setCurrencyHints(function () { return [ME && ME.default_currency]; });
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

  /* The photo saves on its own, the moment it is picked: it is not part of
     the form's Save. */
  function fillAvatar(me) {
    $('avatar-view').innerHTML = avatarHtml({ name: me.display_name, url: me.avatar, key: 'u' + me.user_id, size: 'lg' });
    $('avatar-btns').hidden = !me.avatar_upload && !me.avatar;
    $('avatar-pick').hidden = !me.avatar_upload;
    $('avatar-pick').textContent = t(me.avatar ? 'set.avatar_change' : 'set.avatar_upload');
    $('avatar-remove').hidden = !me.avatar;
  }

  /* Centre square, 512px JPEG: the server makes the final 256px WebP, this
     only keeps a phone photo small on the way up. */
  function squareJpeg(file) {
    return new Promise(function (resolve) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, side = Math.min(w, h);
        var out = Math.min(512, side);
        var c = document.createElement('canvas');
        c.width = c.height = out;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, out, out);
        ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, out, out);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { resolve(b || file); }, 'image/jpeg', 0.9);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  $('avatar-pick').addEventListener('click', function () { $('avatar-file').click(); });
  $('avatar-file').addEventListener('change', function () {
    var f = $('avatar-file').files[0];
    $('avatar-file').value = '';
    if (!f) return;
    var btn = $('avatar-pick');
    setBusy(btn, true);
    squareJpeg(f).then(function (b) {
      var fd = new FormData();
      fd.append('file', b, 'avatar.jpg');
      return api('settings/avatar', { body: fd });
    }).then(function (r) {
      setBusy(btn, false);
      if (!r.ok) return showToast(errMsg(r.code, r.params), 'error');
      fill(r.data);
      showToast(t('set.avatar_saved'));
    });
  });

  $('avatar-remove').addEventListener('click', function (ev) {
    var btn = ev.currentTarget;
    setBusy(btn, true);
    api('settings/avatar/remove', { body: {} }).then(function (r) {
      setBusy(btn, false);
      if (!r.ok) return showToast(errMsg(r.code, r.params), 'error');
      fill(r.data);
      showToast(t('set.avatar_removed'));
    });
  });

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
