/* home.js: "My splits" list, new one-off / trip, email verification. */
(function () {
  var ME = null;
  var OFFLINE = false;
  var newKind = 'one_off';
  var people = [];

  function renderList(list) {
    var body = document.getElementById('splits-body');
    var wrap = document.getElementById('splits-wrap');
    if (!list.length) { setTableEmpty(wrap, t('home.empty')); return; }
    setTableEmpty(wrap, '');
    body.innerHTML = list.map(function (g) {
      var kind = g.kind === 'travel' ? t('kind.travel') : t('kind.one_off');
      var status = g.status === 'settled'
        ? '<span class="chip chip-settled">' + esc(t('status.settled')) + '</span>'
        : '<span class="chip chip-open">' + esc(t('status.open')) + '</span>';
      var net = BigInt(g.my_net);
      var netTxt = net === 0n ? '<span class="muted">' + esc(t('bal.even')) + '</span>'
        : '<span class="' + (net > 0n ? 'pos' : 'neg') + '">' + esc(signedMoney(g.my_net, g.currency, g.dp)) + '</span>';
      return '<tr class="row-link" data-id="' + esc(g.group_id) + '" tabindex="0">' +
        '<td>' + esc(g.name) + '<div class="tool-sub">' + esc(kind) + ' · ' + status + '</div></td>' +
        '<td class="num">' + esc(money(g.spent, g.currency, g.dp)) + '</td>' +
        '<td class="num">' + netTxt + '</td></tr>';
    }).join('');
  }

  function open(ev) {
    var tr = ev.target.closest('tr[data-id]');
    if (tr) location.href = '/app/g/' + tr.getAttribute('data-id');
  }
  document.getElementById('splits-body').addEventListener('click', open);
  document.getElementById('splits-body').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') open(ev); });

  // ── verify email ──
  function showVerify(me) {
    var card = document.getElementById('verify-card');
    if (!me.email || me.email_verified) { card.hidden = true; return; }
    card.hidden = false;
    document.getElementById('verify-desc').textContent = t('verify.desc', me.email);
  }
  document.getElementById('verify-btn').addEventListener('click', function (ev) {
    var btn = ev.currentTarget;
    setBusy(btn, true);
    api('auth/verify', { body: { code: document.getElementById('verify-code').value } }).then(function (r) {
      setBusy(btn, false);
      if (!r.ok) return showToast(errMsg(r.code, r.params), 'error');
      document.getElementById('verify-card').hidden = true;
      showToast(t('verify.done'));
    });
  });
  document.getElementById('verify-resend').addEventListener('click', function (ev) {
    var btn = ev.currentTarget;
    setBusy(btn, true);
    api('auth/resend', { body: {} }).then(function (r) {
      setBusy(btn, false);
      showToast(r.ok ? t('verify.sent') : errMsg(r.code, r.params), r.ok ? '' : 'error');
    });
  });

  // ── new split ──
  function renderPeople() {
    document.getElementById('new-people').innerHTML = people.map(function (p, i) {
      return '<button type="button" class="mchip" aria-pressed="true" data-i="' + i + '" title="' + esc(t('common.remove')) + '">' +
        esc(p.username ? '@' + p.username : p.name) + ' ×</button>';
    }).join('');
  }
  function addPerson() {
    var inp = document.getElementById('new-person');
    var v = inp.value.trim();
    if (!v) return;
    var entry = v.charAt(0) === '@' ? { username: v.slice(1) } : { name: v };
    var key = (entry.username || entry.name).toLowerCase();
    if (!people.some(function (p) { return (p.username || p.name).toLowerCase() === key; })) people.push(entry);
    inp.value = '';
    renderPeople();
    inp.focus();
  }
  document.getElementById('new-person-add').addEventListener('click', addPerson);
  document.getElementById('new-person').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); addPerson(); }
  });
  document.getElementById('new-people').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-i]');
    if (!b) return;
    people.splice(Number(b.getAttribute('data-i')), 1);
    renderPeople();
  });

  function openNew(kind) {
    if (OFFLINE) return showToast(errMsg('offline'), 'error');
    newKind = kind;
    people = [];
    renderPeople();
    document.getElementById('new-title').textContent = kind === 'travel' ? t('home.new_trip') : t('home.new_oneoff');
    document.getElementById('new-name').value = '';
    document.getElementById('new-ccy-label').textContent = kind === 'travel' ? t('new.settle_currency') : t('new.currency');
    fillCurrencySelect(document.getElementById('new-currency'), (ME && ME.default_currency) || 'IDR');
    openModal('modal-new', { initialFocus: '#new-name' });
  }
  document.getElementById('new-oneoff').addEventListener('click', function () { openNew('one_off'); });
  document.getElementById('new-trip').addEventListener('click', function () { openNew('travel'); });

  document.getElementById('new-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    addPerson();
    var btn = document.getElementById('new-save');
    setBusy(btn, true);
    api('groups', {
      body: {
        kind: newKind,
        name: document.getElementById('new-name').value,
        currency: document.getElementById('new-currency').value,
        members: people,
      },
    }).then(function (r) {
      setBusy(btn, false);
      if (!r.ok) return showToast(errMsg(r.code, r.params), 'error');
      location.href = '/app/g/' + r.data.group_id + (newKind === 'one_off' ? '#add-bill' : '');
    });
  });

  sbBoot().then(function (r) {
    if (!r.ok) return showToast(errMsg(r.code, r.params), 'error');
    ME = r.data.me;
    OFFLINE = !!r.offline;
    topbarSetUser(ME);
    if (OFFLINE) {
      var b = document.getElementById('offline-banner');
      b.textContent = t('offline.banner', fmtDate(new Date(r.at).toISOString()));
      b.hidden = false;
    }
    showVerify(ME);
    renderList(r.data.groups || []);
  });
}());
