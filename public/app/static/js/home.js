/* home.js: "My splits" list, Add Bill (a trip's opens here, in bill.js; a
 * one-off goes straight into its bill), New Trip, email verification. */
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
        '<td class="num">' + (g.my_share == null ? '-' : moneyHtml(g.my_share, g.currency, g.dp)) + '</td>' +
        '<td class="num">' + netTxt + '</td></tr>';
    }).join('');
  }

  /* Add Bill straight into the newest open trips, above Split One Bill. */
  var TRIP_MAX = 3;
  function renderTripBills(all) {
    var box = document.getElementById('trip-bills');
    if (OFFLINE) { box.innerHTML = ''; return; }
    var trips = all.filter(function (g) {
      return g.kind === 'travel' && g.status === 'open' && g.active !== false;
    }).sort(function (a, b) {
      return (Date.parse(b.last_at || b.created_at) || 0) - (Date.parse(a.last_at || a.created_at) || 0);
    }).slice(0, TRIP_MAX);
    box.innerHTML = trips.map(function (g) {
      return '<button type="button" class="btn btn-primary btn-full page-action" data-id="' + esc(g.group_id) + '">' +
        icon('plus') + ' <span>' + esc(t('bill.add_for', g.name)) + '</span></button>';
    }).join('');
  }
  /* The bill editor opens right here, on the trip's view: no page load and,
     with the view kept from before (or warmed below), no wait either. The
     live view follows and redraws the open editor. */
  var S = window.SB;
  document.getElementById('trip-bills').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-id]');
    if (!b) return;
    var gid = b.getAttribute('data-id');
    var shown = false;
    var live = S.open(gid);
    if (S.view && S.gid === gid && S.stale && S.canAddBill()) { window.openBill(null); shown = true; }
    else setBusy(b, true);
    live.then(function (r) {
      setBusy(b, false);
      if (S.gid !== gid) return;
      if (!r.ok) {
        if (shown) closeModal('modal-bill');
        return showToast(errMsg(r.code, r.params), 'error');
      }
      // Nothing to add here (closed, or no longer a member): the trip page says why.
      if (!S.canAddBill()) {
        if (shown) closeModal('modal-bill');
        location.href = '/app/g/' + gid;
        return;
      }
      if (!shown) window.openBill(null);
    });
  });

  /* Warm what a tap is likely to open: the trips on the buttons above, once
     the list is drawn, and any split a pointer or focus lands on. Each view
     is kept (boot.js), so its page or its bill editor draws at once. */
  var warmed = {};
  function warm(gid) {
    if (OFFLINE || !gid || warmed[gid]) return;
    warmed[gid] = true;
    S.prefetch(gid);
  }
  function warmTrips() {
    var later = window.requestIdleCallback || function (fn) { return setTimeout(fn, 200); };
    later(function () {
      var bs = document.querySelectorAll('#trip-bills button[data-id]');
      for (var i = 0; i < bs.length; i++) warm(bs[i].getAttribute('data-id'));
    });
  }
  ['pointerover', 'touchstart', 'focusin'].forEach(function (type) {
    document.getElementById('splits-body').addEventListener(type, function (ev) {
      var tr = ev.target.closest && ev.target.closest('tr[data-id]');
      if (tr) warm(tr.getAttribute('data-id'));
    }, { passive: true });
  });

  // A saved bill changes the list's figures; a person added mid-bill needs the view.
  S.afterWrite = function (path, fresh, r) {
    if (path !== 'bill/save') return fresh ? Promise.resolve() : S.reload();
    // The answer carries this split's new row: patch it in, no list reload.
    if (r && r.row) {
      GROUPS = GROUPS.filter(function (g) { return g.group_id !== r.row.group_id; }).concat([r.row]);
      renderList(GROUPS);
      renderTripBills(GROUPS);
    } else refreshList();
    return Promise.resolve();
  };
  function refreshList() {
    api('groups').then(function (r) {
      if (!r.ok) return;
      GROUPS = r.data || [];
      renderList(GROUPS);
      renderTripBills(GROUPS);
    });
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
    // No email provider set up yet: no code can arrive, so nothing to ask.
    if (!me.email || me.email_verified || !me.email_sending) { card.hidden = true; return; }
    // Folded unless the viewer opened it before.
    try { card.open = localStorage.getItem('sb_verify_folded') === '0'; } catch (e) { /* storage off */ }
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
  function pushPerson(inp, entry) {
    var key = (entry.username || entry.name).toLowerCase();
    if (!people.some(function (p) { return (p.username || p.name).toLowerCase() === key; })) people.push(entry);
    inp.value = '';
    renderPeople();
    inp.focus();
  }
  /* "@" is only ever a username: it is looked up first, and one that does
     not exist stays in the box with a toast, never becoming a plain name. */
  function addPerson() {
    var inp = document.getElementById('new-person');
    var btn = document.getElementById('new-person-add');
    var v = inp.value.trim();
    if (!v) return;
    if (v.charAt(0) !== '@') return pushPerson(inp, { name: v });
    if (btn.disabled) return;
    setBusy(btn, true);
    api('user/check?u=' + encodeURIComponent(v.slice(1))).then(function (r) {
      setBusy(btn, false);
      if (!r.ok) { showToast(errMsg(r.code, r.params), 'error'); inp.focus(); return; }
      if (r.data.me) { inp.value = ''; inp.focus(); return; }
      pushPerson(inp, { username: r.data.username });
    });
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
  document.getElementById('new-bill').addEventListener('click', function () {
    if (OFFLINE) return showToast(errMsg('offline'), 'error');
    if (!ME) return;
    // Opens at once on a draft; the split is created meanwhile (sb.js).
    S.startOneOff(ME, t('home.new_bill_name'), ME.default_currency || 'IDR').then(function (r) {
      if (r.ok || r.gone) return;
      closeModal('modal-bill');
      showToast(errMsg(r.code, r.params), 'error');
    });
    window.openBill(null);
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
        view: true,
      },
    }).then(function (r) {
      setBusy(btn, false);
      if (!r.ok) return showToast(errMsg(r.code, r.params), 'error');
      // The trip's page draws this view at once instead of asking again.
      if (r.view && window.sbCachePut) window.sbCachePut('group&id=' + r.data.group_id, { me: ME, group: r.view, ai: S.ai });
      location.href = '/app/g/' + r.data.group_id;
    });
  });

  /* Draw at once from the list this browser kept, then again live. */
  function show(r) {
    ME = r.data.me;
    OFFLINE = !!r.offline;
    S.me = ME;
    S.ai = r.data.ai !== false;
    topbarSetUser(ME);
    var b = document.getElementById('offline-banner');
    if (OFFLINE) {
      b.textContent = t('offline.banner', fmtDate(new Date(r.at).toISOString()));
      b.hidden = false;
    } else b.hidden = true;
    showVerify(ME);
    GROUPS = r.data.groups || [];
    renderList(GROUPS);
    renderTripBills(GROUPS);
  }
  var kept = window.sbBootCached && window.sbBootCached();
  if (kept && kept.data && kept.data.me) show(kept);

  sbBoot().then(function (r) {
    if (!r.ok) return showToast(errMsg(r.code, r.params), 'error');
    show(r);
    if (!OFFLINE) warmTrips();
  });
}());
