/* bill.js: the bill editor. Form, chat and photo all fill the same form;
 * the preview runs the SAME engine the server uses (window.SBEngine), so what
 * you see is what saves. The server recomputes everything on save anyway. */
(function () {
  var E = window.SBEngine;
  var S = window.SB;
  var $ = function (id) { return document.getElementById(id); };

  var B = null;         // the bill being edited
  var ok = false;       // does the current form save?
  var timer = null;

  function G() { return S.view.group; }
  function ccy() { return $('bill-currency').value || G().currency; }
  function dp() { return E.minorUnits(ccy()); }

  /* Members the editor may offer: active ones, plus inactive ones this bill
     already uses (they stay as they were; they cannot be newly added). */
  function pickable() {
    var used = {};
    if (B && B.orig) {
      used[B.orig.payer] = 1;
      B.orig.items.forEach(function (i) { i.members.forEach(function (m) { used[m] = 1; }); });
      B.orig.participants.forEach(function (p) { used[p.member] = 1; });
    }
    return S.view.members.filter(function (m) { return m.active || used[m.id]; });
  }

  function chipsHtml(selected, cls) {
    var list = pickable();
    var all = list.length && list.every(function (m) { return selected.indexOf(m.id) >= 0; });
    return '<button type="button" class="mchip ' + cls + '" data-all="1" aria-pressed="' + all + '">' + esc(t('common.all')) + '</button>' +
      list.map(function (m) {
        return '<button type="button" class="mchip ' + cls + '" data-m="' + esc(m.id) + '" aria-pressed="' + (selected.indexOf(m.id) >= 0) + '">' + esc(m.name) + '</button>';
      }).join('');
  }

  // ── render the editable parts ──
  function renderItems() {
    $('items').innerHTML = B.items.map(function (it, i) {
      return '<div class="line" data-i="' + i + '">' +
        '<div class="line-row">' +
          '<input type="text" class="it-name" maxlength="120" value="' + esc(it.name) + '" placeholder="' + esc(t('bill.item_ph')) + '" aria-label="' + esc(t('bill.item')) + '">' +
          '<input type="text" class="amt it-amt" inputmode="decimal" value="' + esc(it.amount) + '" placeholder="0" aria-label="' + esc(t('bill.amount')) + '">' +
          '<button type="button" class="btn btn-ghost btn-compact btn-icon it-del" aria-label="' + esc(t('common.remove')) + '">' + icon('x') + '</button>' +
        '</div>' +
        '<div class="chips">' + chipsHtml(it.members, 'it-chip') + '</div>' +
      '</div>';
    }).join('');
  }

  function renderAdjs() {
    var kinds = ['tax', 'service', 'tip', 'discount', 'other'];
    $('adjs').innerHTML = B.adjs.map(function (a, i) {
      return '<div class="line" data-a="' + i + '"><div class="line-row">' +
        '<select class="adj-kind" aria-label="' + esc(t('adj.kind')) + '">' + kinds.map(function (k) {
          return '<option value="' + k + '"' + (k === a.kind ? ' selected' : '') + '>' + esc(t('adj.' + k)) + '</option>';
        }).join('') + '</select>' +
        '<input type="text" class="amt adj-amt" inputmode="decimal" value="' + esc(a.amount) + '" placeholder="' + esc(a.kind === 'tax' || a.kind === 'service' ? '10%' : '0') + '" aria-label="' + esc(t('bill.amount')) + '">' +
        '<button type="button" class="btn btn-ghost btn-compact btn-icon adj-del" aria-label="' + esc(t('common.remove')) + '">' + icon('x') + '</button>' +
      '</div></div>';
    }).join('');
  }

  function renderSimple() {
    $('even-chips').innerHTML = chipsHtml(B.even, 'ev-chip');
    $('even-who').hidden = B.mode !== 'even';
    $('pcts').hidden = B.mode !== 'percent';
    if (B.mode === 'percent') {
      $('pcts').innerHTML = pickable().map(function (m) {
        return '<div class="pct-row"><span class="who">' + esc(m.name) + '</span>' +
          '<input type="text" class="pct" inputmode="decimal" data-m="' + esc(m.id) + '" value="' + esc(B.pcts[m.id] || '') + '" placeholder="0" aria-label="%">' +
          '<span class="muted">%</span></div>';
      }).join('') +
      '<button type="button" class="btn btn-ghost btn-compact" id="pct-fill">' + esc(t('bill.fill_rest')) + '</button>';
    }
  }

  function renderMode() {
    var tabs = $('mode-tabs').querySelectorAll('[data-mode]');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-mode') === B.mode);
    $('panel-items').hidden = B.mode !== 'items';
    $('panel-simple').hidden = B.mode === 'items';
    if (B.mode === 'items') { renderItems(); renderAdjs(); } else renderSimple();
    schedule();
  }

  function renderPayer() {
    var sel = $('bill-payer');
    sel.innerHTML = pickable().map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(S.nameOf(m.id)) + '</option>'; }).join('');
    sel.value = B.payer;
  }

  // ── build the engine input from the form ──
  function parseOrThrow(text, opts) {
    return E.parseAmount(text, dp(), opts || {});
  }

  function build() {
    var bill = { payer: $('bill-payer').value, mode: B.mode };
    var payload = { mode: B.mode, payer: bill.payer };
    if (B.mode === 'items') {
      bill.items = []; payload.items = [];
      B.items.forEach(function (it, i) {
        if (!it.name.trim() && !it.amount.trim()) return;
        var amt;
        try { amt = it.amount.trim() ? parseOrThrow(it.amount, { allowZero: true }) : 0n; }
        catch (e) { e.params = Object.assign({ index: i + 1 }, e.params); throw e; }
        bill.items.push({ name: it.name, amount: amt, members: it.members.slice() });
        payload.items.push({ name: it.name.trim() || ('#' + (i + 1)), qty: it.qty || '1', amount: amt.toString(), members: it.members.slice() });
      });
      bill.adjustments = []; payload.adjustments = [];
      B.adjs.forEach(function (a) {
        if (!a.amount.trim()) return;
        var v = parseOrThrow(a.amount, { allowNegative: a.kind === 'other' });
        if (a.kind === 'discount') v = -v;
        bill.adjustments.push({ kind: a.kind, amount: v });
        payload.adjustments.push({ kind: a.kind, amount: v.toString() });
      });
      var stated = $('bill-stated').value.trim();
      payload.stated_total = stated ? parseOrThrow(stated).toString() : null;
    } else {
      var total = parseOrThrow($('bill-total').value);
      bill.total = total;
      payload.total = total.toString();
      if (B.mode === 'even') {
        bill.participants = B.even.map(function (m) { return { member: m }; });
      } else {
        bill.participants = [];
        Object.keys(B.pcts).forEach(function (m) {
          var s = (B.pcts[m] || '').trim();
          if (!s) return;
          var bp = E.parsePercent(s);
          if (bp > 0) bill.participants.push({ member: m, bp: bp });
        });
      }
      payload.participants = bill.participants.slice();
    }
    return { bill: bill, payload: payload };
  }

  function order() {
    var m = new Map();
    S.view.members.forEach(function (x) { m.set(x.id, x.position); });
    return m;
  }

  // ── preview ──
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(preview, 60);
  }

  function preview() {
    var rec = $('reconcile'), pv = $('preview');
    var d = dp(), c = ccy();
    ok = false;
    var built, alloc;
    try {
      built = build();
    } catch (e) {
      rec.className = 'reconcile bad';
      rec.textContent = errMsg(e.code || 'amount_invalid', e.params);
      pv.innerHTML = '';
      $('bill-save').disabled = true;
      return;
    }

    // What adds up, before who pays what.
    if (B.mode === 'items') {
      var sum = E.itemsTotal(built.bill.items, built.bill.adjustments);
      var stated = built.payload.stated_total;
      if (stated != null) {
        var diff = BigInt(stated) - sum;
        rec.className = 'reconcile ' + (diff === 0n ? 'good' : 'bad');
        rec.innerHTML = '<span>' + esc(t('bill.lines_total')) + ' ' + esc(money(sum.toString(), c, d)) + '</span>' +
          '<span>' + (diff === 0n ? esc(t('bill.matches')) : esc(t('bill.diff')) + ' ' + esc(signedMoney(diff.toString(), c, d)) +
            ' <button type="button" class="btn btn-ghost btn-compact" id="add-diff">' + esc(t('bill.add_diff')) + '</button>') + '</span>';
      } else {
        rec.className = 'reconcile';
        rec.innerHTML = '<span>' + esc(t('bill.total')) + '</span><span>' + esc(money(sum.toString(), c, d)) + '</span>';
      }
    } else if (B.mode === 'percent') {
      var bp = 0;
      built.bill.participants.forEach(function (p) { bp += p.bp; });
      rec.className = 'reconcile ' + (bp === 10000 ? 'good' : 'bad');
      rec.innerHTML = '<span>' + esc(t('bill.pct_total')) + '</span><span>' + esc(E.formatPercent(bp, window.__LANG__)) + '% / 100%</span>';
    } else {
      rec.className = 'reconcile';
      rec.innerHTML = '<span>' + esc(t('bill.total')) + '</span><span>' + esc(money(built.bill.total.toString(), c, d)) + '</span>';
    }

    try {
      alloc = E.allocate(built.bill, order());
      if (B.mode === 'items' && built.payload.stated_total != null && BigInt(built.payload.stated_total) !== alloc.total) {
        throw new E.EngineError('stated_total_mismatch', { diff: '' });
      }
    } catch (e) {
      if (e.code !== 'stated_total_mismatch') {
        rec.className = 'reconcile bad';
        rec.textContent = errMsg(e.code || 'generic', friendly(e.params));
      }
      pv.innerHTML = '';
      $('bill-save').disabled = true;
      return;
    }

    // Converted view when the bill is foreign.
    var conv = null, note = '';
    if (c !== G().currency) {
      var date = $('bill-date').value;
      var r = E.findRate(S.view.rates, c, date);
      if (!r) {
        note = t('rate.missing_for', c, fmtDate(date));
      } else {
        try {
          var C = E.convertTotal(alloc.total, d, G().dp, E.factorFromRate(E.parseRate(r.rate).value, r.inverted));
          conv = E.convertShares(alloc, C, built.bill.payer, order());
          note = t('bill.converted', money(C.toString(), G().currency, G().dp), S.rateText(r));
        } catch (e) { note = errMsg(e.code, e.params); }
      }
    }

    var rows = [];
    alloc.shares.forEach(function (x, m) { rows.push([m, x]); });
    rows.sort(function (a, b) { return S.member(a[0]).position - S.member(b[0]).position; });
    pv.innerHTML = '<div class="report-sub">' + esc(t('bill.shares')) + '</div>' + rows.map(function (r) {
      var cm = conv ? conv.get(r[0]) : null;
      return '<div class="preview-row"><span>' + esc(S.nameOf(r[0])) + (r[0] === built.bill.payer ? ' <span class="chip">' + esc(t('bill.paid_chip')) + '</span>' : '') + '</span>' +
        '<span class="mono">' + esc(money(r[1].toString(), c, d)) + (cm != null ? ' · ' + esc(money(cm.toString(), G().currency, G().dp)) : '') + '</span></div>';
    }).join('') + (note ? '<div class="preview-note">' + esc(note) + '</div>' : '');

    ok = !!$('bill-desc').value.trim() && !!$('bill-date').value && (c === G().currency || conv !== null);
    $('bill-save').disabled = !ok;
  }

  /* Member ids in engine params become names. */
  function friendly(params) {
    var p = Object.assign({}, params || {});
    if (p.member && S.member(p.member)) p.member = S.member(p.member).name;
    return p;
  }

  // ── open ──
  function blank() {
    var active = S.view.members.filter(function (m) { return m.active; }).map(function (m) { return m.id; });
    return {
      id: null, version: null, orig: null, clientKey: randomKey(), draftId: null, source: 'form',
      mode: 'items', payer: S.view.me || active[0],
      items: [{ name: '', amount: '', members: active.slice(), qty: '1' }],
      adjs: [], even: active.slice(), pcts: {},
    };
  }

  function fromBill(b) {
    var d = b.dp;
    var st = blank();
    st.id = b.id; st.version = b.version; st.orig = b; st.mode = b.mode; st.payer = b.payer; st.source = b.source;
    if (b.mode === 'items') {
      st.items = b.items.map(function (i) { return { name: i.name, amount: plainMoney(i.amount, d), members: i.members.slice(), qty: i.qty }; });
      st.adjs = b.adjustments.map(function (a) {
        var v = BigInt(a.amount);
        return { kind: a.kind, amount: plainMoney((a.kind === 'discount' ? -v : v).toString(), d) };
      });
    } else {
      st.even = b.participants.map(function (p) { return p.member; });
      st.pcts = {};
      b.participants.forEach(function (p) { if (p.bp != null) st.pcts[p.member] = E.formatPercent(p.bp, 'en'); });
    }
    return st;
  }

  function setInputTab(which) {
    var tabs = $('input-tabs').querySelectorAll('[data-input]');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-input') === which);
    $('ai-chat').hidden = which !== 'chat';
    $('ai-photo').hidden = which !== 'photo';
    $('ai-status').hidden = true;
  }

  window.openBill = function (billId, readOnly) {
    var b = billId ? S.view.bills.filter(function (x) { return x.id === billId; })[0] : null;
    B = b ? fromBill(b) : blank();
    B.readOnly = !!readOnly;
    $('bill-title').textContent = t(readOnly ? 'bill.view' : b ? 'bill.edit' : 'bill.add');
    $('input-tabs').hidden = !!b;
    setInputTab('form');
    $('bill-desc').value = b ? b.description : (G().kind === 'one_off' && !S.view.bills.length ? G().name : '');
    $('bill-date').value = b ? b.date : todayIn(G().timezone);
    fillCurrencySelect($('bill-currency'), b ? b.currency : G().currency);
    $('bill-total').value = b && b.mode !== 'items' ? plainMoney(b.total, b.dp) : '';
    $('bill-stated').value = b && b.stated ? plainMoney(b.stated, b.dp) : '';
    renderPayer();
    renderMode();
    var form = $('bill-form');
    var fields = form.querySelectorAll('input, select, textarea, .modal-body button');
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].classList.contains('modal-close')) continue;
      fields[i].disabled = !!readOnly;
    }
    $('bill-save').hidden = !!readOnly;
    openModal('modal-bill', { initialFocus: b ? '#bill-desc' : '#bill-desc' });
    preview();
  };

  window.fillBillFromDraft = function (d) {
    B.draftId = d.draft_id || null;
    B.source = d.source || 'chat';
    if (d.description) $('bill-desc').value = d.description;
    if (d.date) $('bill-date').value = d.date;
    if (d.currency) $('bill-currency').value = d.currency;
    if (d.payer) B.payer = d.payer;
    B.mode = d.mode || 'items';
    var dd = E.minorUnits(d.currency || ccy());
    if (B.mode === 'items') {
      B.items = (d.items || []).map(function (i) { return { name: i.name || '', amount: i.amount != null ? plainMoney(i.amount, dd) : '', members: (i.members || []).slice(), qty: i.qty || '1' }; });
      if (!B.items.length) B.items = [{ name: '', amount: '', members: [], qty: '1' }];
      B.adjs = (d.adjustments || []).map(function (a) {
        var v = BigInt(a.amount);
        return { kind: a.kind, amount: plainMoney((a.kind === 'discount' ? -v : v).toString(), dd) };
      });
      $('bill-stated').value = d.stated_total ? plainMoney(d.stated_total, dd) : '';
    } else {
      $('bill-total').value = d.total ? plainMoney(d.total, dd) : '';
      B.even = (d.participants || []).map(function (p) { return p.member; });
      B.pcts = {};
      (d.participants || []).forEach(function (p) { if (p.bp) B.pcts[p.member] = E.formatPercent(p.bp, 'en'); });
    }
    renderPayer();
    renderMode();
    setInputTab('form');
  };

  // ── events ──
  $('btn-add-bill').addEventListener('click', function () { window.openBill(null); });
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.edit) window.openBill(b.dataset.edit);
    else if (b.dataset.view) window.openBill(b.dataset.view, true);
  });

  $('mode-tabs').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-mode]');
    if (!b || B.readOnly) return;
    B.mode = b.getAttribute('data-mode');
    renderMode();
  });
  $('input-tabs').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-input]');
    if (b) setInputTab(b.getAttribute('data-input'));
  });

  $('add-item').addEventListener('click', function () {
    var active = S.view.members.filter(function (m) { return m.active; }).map(function (m) { return m.id; });
    var last = B.items[B.items.length - 1];
    B.items.push({ name: '', amount: '', members: last ? last.members.slice() : active, qty: '1' });
    renderItems();
    var names = $('items').querySelectorAll('.it-name');
    if (names.length) names[names.length - 1].focus();
    schedule();
  });
  $('panel-items').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.adj) {
      B.adjs.push({ kind: b.dataset.adj, amount: '' });
      renderAdjs();
      var a = $('adjs').querySelectorAll('.adj-amt');
      if (a.length) a[a.length - 1].focus();
      return schedule();
    }
    var line = b.closest('.line');
    if (!line) return;
    if (b.classList.contains('it-del')) {
      B.items.splice(Number(line.dataset.i), 1);
      if (!B.items.length) B.items.push({ name: '', amount: '', members: [], qty: '1' });
      renderItems();
    } else if (b.classList.contains('adj-del')) {
      B.adjs.splice(Number(line.dataset.a), 1);
      renderAdjs();
    } else if (b.classList.contains('it-chip')) {
      var it = B.items[Number(line.dataset.i)];
      toggle(it.members, b);
      line.querySelector('.chips').innerHTML = chipsHtml(it.members, 'it-chip');
    }
    schedule();
  });
  $('panel-items').addEventListener('input', function (ev) {
    var el = ev.target;
    var line = el.closest('.line');
    if (!line) return schedule();
    if (el.classList.contains('it-name')) B.items[Number(line.dataset.i)].name = el.value;
    if (el.classList.contains('it-amt')) B.items[Number(line.dataset.i)].amount = el.value;
    if (el.classList.contains('adj-amt')) B.adjs[Number(line.dataset.a)].amount = el.value;
    if (el.classList.contains('adj-kind')) B.adjs[Number(line.dataset.a)].kind = el.value;
    schedule();
  });
  $('panel-items').addEventListener('change', function (ev) {
    var el = ev.target;
    var line = el.closest('.line');
    if (el.classList.contains('adj-kind')) { B.adjs[Number(line.dataset.a)].kind = el.value; schedule(); }
  });
  // "11%" in a tax / service line becomes an amount, once, from the items.
  $('panel-items').addEventListener('focusout', function (ev) {
    var el = ev.target;
    if (!el.classList.contains('adj-amt') || !/%\s*$/.test(el.value)) return;
    try {
      var bp = E.parsePercent(el.value);
      var sub = 0n;
      B.items.forEach(function (it) { if (it.amount.trim()) sub += E.parseAmount(it.amount, dp(), { allowZero: true }); });
      var v = E.roundHalfEven(sub * BigInt(bp), 10000n);
      el.value = E.toPlain(v, dp());
      B.adjs[Number(el.closest('.line').dataset.a)].amount = el.value;
      schedule();
    } catch (e) { showToast(errMsg(e.code || 'percent_invalid'), 'error'); }
  });

  function toggle(list, btn) {
    if (btn.dataset.all) {
      var ids = pickable().filter(function (m) { return m.active; }).map(function (m) { return m.id; });
      var allOn = ids.every(function (id) { return list.indexOf(id) >= 0; });
      list.length = 0;
      if (!allOn) ids.forEach(function (id) { list.push(id); });
      return;
    }
    var id = btn.dataset.m;
    var i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1); else list.push(id);
  }

  $('panel-simple').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    if (b.classList.contains('ev-chip')) {
      toggle(B.even, b);
      $('even-chips').innerHTML = chipsHtml(B.even, 'ev-chip');
    } else if (b.id === 'pct-fill') {
      var used = 0, empty = null;
      pickable().forEach(function (m) {
        var s = (B.pcts[m.id] || '').trim();
        if (!s) { if (!empty) empty = m.id; return; }
        try { used += E.parsePercent(s); } catch (e) {}
      });
      if (empty && used < 10000) B.pcts[empty] = E.formatPercent(10000 - used, 'en');
      renderSimple();
    }
    schedule();
  });
  $('panel-simple').addEventListener('input', function (ev) {
    var el = ev.target;
    if (el.classList.contains('pct')) B.pcts[el.dataset.m] = el.value;
    schedule();
  });

  ['bill-desc', 'bill-date', 'bill-currency', 'bill-payer', 'bill-stated', 'bill-total'].forEach(function (id) {
    $(id).addEventListener('input', schedule);
    $(id).addEventListener('change', schedule);
  });
  $('bill-payer').addEventListener('change', function () { B.payer = $('bill-payer').value; });

  // Receipt total disagrees: one tap adds the gap as an "Other" line.
  $('reconcile').addEventListener('click', function (ev) {
    if (!ev.target.closest('#add-diff')) return;
    try {
      var built = build();
      var diff = BigInt(built.payload.stated_total) - E.itemsTotal(built.bill.items, built.bill.adjustments);
      B.adjs.push({ kind: 'other', amount: E.toPlain(diff, dp()) });
      renderAdjs();
      schedule();
    } catch (e) {}
  });

  $('bill-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (B.readOnly) return;
    preview();
    if (!ok) return;
    var built;
    try { built = build(); } catch (e) { return showToast(errMsg(e.code || 'generic', e.params), 'error'); }
    var body = Object.assign(built.payload, {
      bill_id: B.id, version: B.version, client_key: B.id ? null : B.clientKey,
      description: $('bill-desc').value, date: $('bill-date').value, currency: ccy(),
      source: B.source, draft_id: B.draftId,
    });
    S.act('bill/save', body, t('bill.saved'), $('bill-save')).then(function (r) {
      if (r.ok) closeModal('modal-bill');
    });
  });
}());

/* ── Chat and photo: the AI reads, the form stays the only thing that saves. ── */
(function () {
  var S = window.SB;
  var $ = function (id) { return document.getElementById(id); };
  var photo = null;

  function status(msg, isErr) {
    var el = $('ai-status');
    el.textContent = msg;
    el.className = 'assist-status' + (isErr ? ' error' : '');
    el.hidden = !msg;
  }

  function done(r, btn) {
    setBusy(btn, false);
    if (!r.ok) return status(errMsg(r.code, r.params), true);
    window.fillBillFromDraft(r.data);
    var msg = t('input.read_done');
    if (r.data.unknown && r.data.unknown.length) msg += ' ' + t('input.unknown', r.data.unknown.join(', '));
    status(msg, false);
  }

  $('ai-chat-go').addEventListener('click', function (ev) {
    var btn = ev.currentTarget;
    var text = $('ai-text').value.trim();
    if (!text) return $('ai-text').focus();
    setBusy(btn, true);
    status(t('input.reading'));
    api('ai/chat', { body: { group_id: S.gid, text: text } }).then(function (r) { done(r, btn); });
  });

  /* Shrink before upload: 1600px long side, JPEG 0.85. Receipts stay
     readable and a 5 MB phone photo becomes a few hundred KB. */
  function shrink(file) {
    return new Promise(function (resolve) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { resolve(b || file); }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  $('ai-file').addEventListener('change', function () {
    var f = $('ai-file').files[0];
    if (!f) return;
    shrink(f).then(function (b) {
      photo = b;
      var th = $('ai-thumb');
      th.src = URL.createObjectURL(b);
      th.hidden = false;
      $('ai-photo-go').disabled = false;
      status('');
    });
  });

  $('ai-photo-go').addEventListener('click', function (ev) {
    if (!photo) return;
    var btn = ev.currentTarget;
    var fd = new FormData();
    fd.append('group_id', S.gid);
    fd.append('caption', $('ai-caption').value);
    fd.append('file', photo, 'receipt.jpg');
    setBusy(btn, true);
    status(t('input.reading'));
    api('ai/photo', { body: fd }).then(function (r) { done(r, btn); });
  });
}());
