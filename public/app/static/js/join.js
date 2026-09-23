/* join.js: accept a trip invite link. */
(function () {
  var code = (location.pathname.match(/^\/app\/join\/([A-Za-z0-9]+)/) || [])[1] || '';
  var btn = document.getElementById('join-btn');
  var errBox = document.getElementById('login-error');
  sbBoot().then(function (r) {
    if (!r.ok) {
      errBox.textContent = errMsg(r.code, r.params);
      errBox.classList.add('show');
      return;
    }
    var inv = r.data.invite;
    document.getElementById('join-name').textContent = inv.name;
    if (inv.already) { location.replace('/app/g/' + inv.group_id); return; }
    btn.disabled = false;
    btn.addEventListener('click', function () {
      setBusy(btn, true);
      api('invite/join', { body: { code: code } }).then(function (j) {
        if (!j.ok) {
          setBusy(btn, false);
          errBox.textContent = errMsg(j.code, j.params);
          errBox.classList.add('show');
          return;
        }
        location.href = '/app/g/' + j.data.group_id;
      });
    });
  });
}());
