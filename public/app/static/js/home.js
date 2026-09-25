/* home.js: "My splits" list, Add Bill (a one-off, straight into its bill),
 * New Trip, email verification. */
(function () {
  var ME = null;
  var OFFLINE = false;
  var people = [];

  /* Open splits first, always. Within each half: newest activity on top,
     or A-Z when the viewer picks it (remembered on this device). */
  var PAGE = 1, SIZE = 10;
  var SORT = 'new';
  try { if (localStorage.getItem('sb_splits_sort') === 'az') SORT = 'az'; } catch (e) { /* storage off */ }

  function isSettled(g) { return g.stage === 'settled'; }
  function sorted(list) {
    return list.slice().sort(function (a, b) {
      var sa = isSettled(a) ? 1 : 0, sb = isSettled(b) ? 1 : 0;
      if (sa !== sb) return sa - sb;
      if (SORT === 'az') {
        var c = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        if (c) return c;
      }
      var ta = Date.parse(a.last_at || a.created_at) || 0, tb = Date.parse(b.last_at || b.created_at) || 0;
      return tb - ta;
    });
  }
  function renderSort() {
    var b = document.getElementById('splits-sort');
    b.textContent = t(SORT === 'az' ? 'home.sort_az' : 'home.sort_new');
    b.hidden = GROUPS.length < 2;
  }
  document.getElementById('splits-sort').addEventListener('click', function () {
    SORT = SORT === 'az' ? 'new' : 'az';
    try { localStorage.setItem('sb_splits_sort', SORT); } catch (e) { /* storage off */ }
    PAGE = 1;
    renderList(GROUPS);
  });

  function renderList(all) {
    var body = document.getElementById('splits-body');
    var wrap = document.getElementById('splits-wrap');
    var pager = document.getElementById('splits-pager');
    renderSort();
    if (!all.length) { setTableEmpty(wrap, t('home.empty')); pager.hidden = true; return; }
    setTableEmpty(wrap, '');
    var list = sorted(all);
    PAGE = renderPager(pager, PAGE, list.length, SIZE, function (p) { PAGE = p; renderList(GROUPS); });
    list = list.slice((PAGE - 1) * SIZE, PAGE * SIZE);
    body.innerHTML = list.map(function (g) {
      var kind = g.kind === 'travel' ? t('kind.travel') : t('kind.one_off');
      var status = stageChip(g.stage);
      var net = BigInt(g.my_net);
      var netTxt = net === 0n ? '<span class="muted">' + esc(t('bal.even')) + '</span>'
        : '<span class="' + (net > 0n ? 'pos' : 'neg') + '">' + signedMoneyHtml(g.my_net, g.currency, g.dp) + '</span>';
      return '<tr class="row-link" data-id="' + esc(g.group_id) + '" tabindex="0">' +
        '<td>' + esc(g.name) + '<div class="tool-sub">' + esc(kind) + ' · ' + status + '</div></td>' +
        '<td class="num">' + moneyHtml(g.spent, g.currency, g.dp) + '</td>' +
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
    try { card.open = localStorage.getItem('sb_verify_folded') !== '1'; } catch (e) { /* storage off */ }
    card.hidden = false;
    document.getElementById('verify-desc').textContent = t('verify.desc', me.email);
  }
  document.getElementById('verify-card').addEventListener('toggle', function (ev) {
    try { localStorage.setItem('sb_verify_folded', ev.currentTarget.open ? '0' : '1'); } catch (e) { /* storage off */ }
  });
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

  /* Recommended in the currency picker: the user's default, then the
     currencies their splits already use. */
  var GROUPS = [];
  setCurrencyHints(function () {
    return [ME && ME.default_currency].concat(GROUPS.map(function (g) { return g.currency; }));
  });

  function openTrip() {
    if (OFFLINE) return showToast(errMsg('offline'), 'error');
    people = [];
    renderPeople();
    document.getElementById('new-name').value = '';
    fillCurrencySelect(document.getElementById('new-currency'), (ME && ME.default_currency) || 'IDR');
    openModal('modal-new', { initialFocus: '#new-name' });
  }
  document.getElementById('new-trip').addEventListener('click', openTrip);

  /* A one-off needs nothing up front: it is named after its bill, people are
     added in the bill, and leaving before saving leaves nothing behind. */
  document.getElementById('new-bill').addEventListener('click', function (ev) {
    if (OFFLINE) return showToast(errMsg('offline'), 'error');
    var btn = ev.currentTarget;
    setBusy(btn, true);
    api('groups', {
      body: { kind: 'one_off', name: t('home.new_bill_name'), currency: (ME && ME.default_currency) || 'IDR', members: [] },
    }).then(function (r) {
      if (!r.ok) { setBusy(btn, false); return showToast(errMsg(r.code, r.params), 'error'); }
      location.href = '/app/g/' + r.data.group_id + '#add-bill';
    });
  });

  document.getElementById('new-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    addPerson();
    var btn = document.getElementById('new-save');
    setBusy(btn, true);
    api('groups', {
      body: {
        kind: 'travel',
        name: document.getElementById('new-name').value,
        currency: document.getElementById('new-currency').value,
        members: people,
      },
    }).then(function (r) {
      setBusy(btn, false);
      if (!r.ok) return showToast(errMsg(r.code, r.params), 'error');
      location.href = '/app/g/' + r.data.group_id;
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
    GROUPS = r.data.groups || [];
    renderList(GROUPS);
  });
}());
