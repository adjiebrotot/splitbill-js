/* bill.js: the bill editor. Photo, chat and form all fill the same form;
 * the preview runs the SAME engine the server uses (window.SBEngine), so what
 * you see is what saves. The server recomputes everything on save anyway.
 *
 * A new bill starts at its input: photo first, then chat, then the bare form.
 * Once the AI has read something, the input gives way to the form and a Reset.
 * People are added right where they are needed: the "+" at the end of every
 * chip row, or one tap on a name the AI read but could not match. */
(function () {
  var E = window.SBEngine;
  var S = window.SB;
  var $ = function (id) { return document.getElementById(id); };

  var B = null;         // the bill being edited
  var ok = false;       // does the current form save?
  var timer = null;
  var photo = null;     // the shrunk receipt being read

  function G() { return S.view.group; }
  function ccy() { return $('bill-currency').value || G().currency; }
  function dp() { return E.minorUnits(ccy()); }
  function same(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }

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
  function activeIds() {
    return pickable().filter(function (m) { return m.active; }).map(function (m) { return m.id; });
  }
  /* A line that has everybody keeps everybody: a person added later joins it. */
  function coversAll(list) {
    var ids = activeIds();
    return ids.length > 0 && ids.every(function (id) { return list.indexOf(id) >= 0; });
  }
  function dis() { return B.readOnly ? ' disabled' : ''; }

  function plusChip(where) {
    if (B.readOnly || !S.canAddMember()) return '';
    return '<button type="button" class="mchip mchip-add" data-plus="' + esc(where) + '" aria-label="' + esc(t('mem.add_person')) + '" title="' + esc(t('mem.add_person')) + '">+</button>';
  }

  function chipsHtml(selected, cls, where) {
    var list = pickable();
    var all = list.length && list.every(function (m) { return selected.indexOf(m.id) >= 0; });
    return '<button type="button" class="mchip ' + cls + '" data-all="1" aria-pressed="' + all + '"' + dis() + '>' + esc(t('common.all')) + '</button>' +
      list.map(function (m) {
        return '<button type="button" class="mchip ' + cls + '" data-m="' + esc(m.id) + '" aria-pressed="' + (selected.indexOf(m.id) >= 0) + '"' + dis() + '>' + esc(m.name) + '</button>';
      }).join('') + plusChip(where);
  }

  /* A money box carries the bill's currency code in front of the figure. */
  function amountBox(input) {
    return '<div class="amount-wrap has-prefix"><span class="amount-affix is-prefix" aria-hidden="true">' + esc(ccy()) + '</span>' + input + '</div>';
  }

  // ── render the editable parts ──
  function renderPayer() {
    $('payer-chips').innerHTML = pickable().map(function (m) {
      var on = m.id === B.payer;
      return '<button type="button" class="mchip pay-chip" role="radio" aria-checked="' + on + '" aria-pressed="' + on + '" data-m="' + esc(m.id) + '"' + dis() + '>' + esc(S.nameOf(m.id)) + '</button>';
    }).join('') + plusChip('payer');
  }

  function renderItems() {
    $('items').innerHTML = B.items.map(function (it, i) {
      return '<div class="line" data-i="' + i + '">' +
        '<div class="line-row">' +
          '<input type="text" class="it-name" maxlength="120" value="' + esc(it.name) + '" placeholder="' + esc(t('bill.item_ph')) + '" aria-label="' + esc(t('bill.item')) + '"' + dis() + '>' +
          amountBox('<input type="text" class="amt it-amt" inputmode="decimal" value="' + esc(it.amount) + '" placeholder="0" aria-label="' + esc(t('bill.amount')) + '"' + dis() + '>') +
          '<button type="button" class="btn btn-ghost btn-compact btn-icon it-del" aria-label="' + esc(t('common.remove')) + '"' + dis() + '>' + icon('x') + '</button>' +
        '</div>' +
        '<div class="chips">' + chipsHtml(it.members, 'it-chip', 'it:' + i) + '</div>' +
      '</div>';
    }).join('');
  }

  function renderAdjs() {
    var kinds = ['tax', 'service', 'tip', 'discount', 'other'];
    $('adjs').innerHTML = B.adjs.map(function (a, i) {
      return '<div class="line" data-a="' + i + '"><div class="line-row">' +
        '<select class="adj-kind" aria-label="' + esc(t('adj.kind')) + '"' + dis() + '>' + kinds.map(function (k) {
          return '<option value="' + k + '"' + (k === a.kind ? ' selected' : '') + '>' + esc(t('adj.' + k)) + '</option>';
        }).join('') + '</select>' +
        amountBox('<input type="text" class="amt adj-amt" inputmode="decimal" value="' + esc(a.amount) + '" placeholder="' + esc(a.kind === 'tax' || a.kind === 'service' ? '10%' : '0') + '" aria-label="' + esc(t('bill.amount')) + '"' + dis() + '>') +
        '<button type="button" class="btn btn-ghost btn-compact btn-icon adj-del" aria-label="' + esc(t('common.remove')) + '"' + dis() + '>' + icon('x') + '</button>' +
      '</div></div>';
    }).join('');
  }

  function renderSimple() {
    $('even-chips').innerHTML = chipsHtml(B.even, 'ev-chip', 'even');
    $('even-who').hidden = B.mode !== 'even';
    $('pcts').hidden = B.mode !== 'percent';
    if (B.mode === 'percent') {
      $('pcts').innerHTML = pickable().map(function (m) {
        return '<div class="pct-row"><span class="who">' + esc(m.name) + '</span>' +
          '<input type="text" class="pct" inputmode="decimal" data-m="' + esc(m.id) + '" value="' + esc(B.pcts[m.id] || '') + '" placeholder="0" aria-label="%"' + dis() + '>' +
          '<span class="muted">%</span></div>';
      }).join('') +
      '<div class="chips"><button type="button" class="btn btn-ghost btn-compact" id="pct-fill"' + dis() + '>' + esc(t('bill.fill_rest')) + '</button>' + plusChip('pct') + '</div>';
    }
  }

  function renderMode() {
    var tabs = $('mode-tabs').querySelectorAll('[data-mode]');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-mode') === B.mode);
    $('panel-items').hidden = B.mode !== 'items';
    $('panel-simple').hidden = B.mode === 'items';
    $('stated-field').hidden = B.mode !== 'items';
    if (B.mode === 'items') { renderItems(); renderAdjs(); } else renderSimple();
    schedule();
  }

  /* Names the AI read that match nobody: one tap adds that person and puts
     them where the message or note put them. */
  function renderUnknown() {
    var box = $('ai-unknown');
    var names = B.readOnly ? [] : B.unknown;
    box.hidden = !names.length;
    if (!names.length) { box.innerHTML = ''; return; }
    if (!S.canAddMember()) {
      box.innerHTML = '<span class="chips-lbl">' + esc(t('input.unknown', names.join(', '))) + '</span>';
      return;
    }
    box.innerHTML = '<span class="chips-lbl">' + esc(t('input.unknown_add')) + '</span>' + names.map(function (n) {
      return '<button type="button" class="mchip mchip-new" data-unknown="' + esc(n) + '">+ ' + esc(n) + '</button>';
    }).join('') + (names.length > 1 ? '<button type="button" class="mchip mchip-new" data-unknown-all="1">+ ' + esc(t('common.all')) + '</button>' : '');
  }

  /* Which part of the editor shows: the input (photo, chat) or the form. */
  function renderStage() {
    var isNew = !B.id;
    var input = isNew && !B.read && !B.readOnly;
    var tabs = $('input-tabs').querySelectorAll('[data-input]');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-input') === B.tab);
    $('input-tabs').hidden = !input || !S.ai;
    $('ai-photo').hidden = !input || B.tab !== 'photo';
    $('ai-chat').hidden = !input || B.tab !== 'chat';
    $('ai-reset').hidden = !(isNew && B.read);
    var fields = !isNew || B.read || B.tab === 'form';
    $('bill-fields').hidden = !fields;
    $('bill-actions').hidden = !fields || B.readOnly;
    renderUnknown();
  }

  function renderAll() {
    renderPayer();
    renderMode();
    renderStage();
  }

  // ── build the engine input from the form ──
  function parseOrThrow(text, opts) {
    return E.parseAmount(text, dp(), opts || {});
  }

  function build() {
    var bill = { payer: B.payer, mode: B.mode };
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
    setAmountAffix($('bill-fields'), c);
    $('bill-more-sum').textContent = fmtDate($('bill-date').value) + ' · ' + c;
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
        rec.innerHTML = '<span>' + esc(t('bill.lines_total')) + ' ' + moneyHtml(sum.toString(), c, d) + '</span>' +
          '<span>' + (diff === 0n ? esc(t('bill.matches')) : esc(t('bill.diff')) + ' ' + signedMoneyHtml(diff.toString(), c, d) +
            ' <button type="button" class="btn btn-ghost btn-compact" id="add-diff">' + esc(t('bill.add_diff')) + '</button>') + '</span>';
      } else {
        rec.className = 'reconcile';
        rec.innerHTML = '<span>' + esc(t('bill.total')) + '</span><span>' + moneyHtml(sum.toString(), c, d) + '</span>';
      }
    } else if (B.mode === 'percent') {
      var bp = 0;
      built.bill.participants.forEach(function (p) { bp += p.bp; });
      rec.className = 'reconcile ' + (bp === 10000 ? 'good' : 'bad');
      rec.innerHTML = '<span>' + esc(t('bill.pct_total')) + '</span><span>' + esc(E.formatPercent(bp, window.__LANG__)) + '% / 100%</span>';
    } else {
      rec.className = 'reconcile';
      rec.innerHTML = '<span>' + esc(t('bill.total')) + '</span><span>' + moneyHtml(built.bill.total.toString(), c, d) + '</span>';
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
        // Nothing to ask: the server adds the market rate when this saves.
        note = t('rate.auto_on_save', c);
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
        '<span class="mono">' + moneyHtml(r[1].toString(), c, d) + (cm != null ? ' · ' + moneyHtml(cm.toString(), G().currency, G().dp) : '') + '</span></div>';
    }).join('') + (note ? '<div class="preview-note">' + esc(note) + '</div>' : '');

    ok = !!$('bill-desc').value.trim() && !!$('bill-date').value && !!B.payer;
    $('bill-save').disabled = !ok;
  }

  /* Member ids in engine params become names. */
  function friendly(params) {
    var p = Object.assign({}, params || {});
    if (p.member && S.member(p.member)) p.member = S.member(p.member).name;
    return p;
  }

  // ── state ──
  /* A new bill starts evenly among everyone; everyone stays everyone as
     people are added. */
  function blank() {
    var active = S.view.members.filter(function (m) { return m.active; }).map(function (m) { return m.id; });
    return {
      id: null, version: null, orig: null, clientKey: randomKey(), draftId: null, source: 'form',
      mode: 'even', payer: S.view.me || active[0],
      items: [{ name: '', amount: '', members: active.slice(), qty: '1', unknown: [], auto: true }],
      adjs: [], even: active.slice(), evenAuto: true, pcts: {},
      unknown: [], payerUnknown: null, evenUnknown: [], pctUnknown: [],
      tab: S.ai ? 'photo' : 'form', read: false, readOnly: false,
    };
  }

  function fromBill(b) {
    var d = b.dp;
    var st = blank();
    st.id = b.id; st.version = b.version; st.orig = b; st.mode = b.mode; st.payer = b.payer; st.source = b.source;
    st.tab = 'form';
    st.evenAuto = false;
    if (b.mode === 'items') {
      st.items = b.items.map(function (i) { return { name: i.name, amount: plainMoney(i.amount, d), members: i.members.slice(), qty: i.qty, unknown: [], auto: false }; });
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

  function fillFields(b) {
    $('bill-desc').value = b ? b.description : '';
    $('bill-date').value = b ? b.date : todayIn(G().timezone);
    fillCurrencySelect($('bill-currency'), b ? b.currency : G().currency);
    $('bill-total').value = b && b.mode !== 'items' ? plainMoney(b.total, b.dp) : '';
    $('bill-stated').value = b && b.stated ? plainMoney(b.stated, b.dp) : '';
    $('bill-more').open = false;
  }

  function resetInput() {
    photo = null;
    $('ai-file').value = '';
    $('ai-thumb').hidden = true;
    $('ai-thumb').removeAttribute('src');
    $('ai-pick').classList.remove('busy');
    $('ai-text').value = '';
    $('ai-caption').value = '';
    status('');
  }

  window.openBill = function (billId, readOnly) {
    var b = billId ? S.view.bills.filter(function (x) { return x.id === billId; })[0] : null;
    B = b ? fromBill(b) : blank();
    B.readOnly = !!readOnly;
    $('bill-title').textContent = t(readOnly ? 'bill.view' : b ? 'bill.edit' : 'bill.add');
    var del = $('bill-delete');
    del.hidden = !b || !!readOnly;
    del.dataset.del = b && !readOnly ? b.id : '';
    fillFields(b);
    resetInput();
    renderAll();
    var fields = $('bill-fields').querySelectorAll('input, select, textarea, button');
    for (var i = 0; i < fields.length; i++) fields[i].disabled = !!readOnly;
    openModal('modal-bill', {
      initialFocus: B.tab === 'form' ? '#bill-desc' : null,
      onClose: function () { if (S.discardEmpty) S.discardEmpty(); },
    });
    preview();
  };

  window.fillBillFromDraft = function (d) {
    B.draftId = d.draft_id || null;
    B.source = d.source || 'chat';
    if (d.description) $('bill-desc').value = d.description;
    if (d.date) $('bill-date').value = d.date;
    if (d.currency) $('bill-currency').value = d.currency;
    if (d.payer) B.payer = d.payer;
    B.payerUnknown = d.payer_unknown || null;
    B.unknown = (d.unknown || []).slice();
    B.mode = d.mode || 'items';
    var dd = E.minorUnits(d.currency || ccy());
    if (B.mode === 'items') {
      B.items = (d.items || []).map(function (i) {
        return {
          name: i.name || '', amount: i.amount != null ? plainMoney(i.amount, dd) : '', members: (i.members || []).slice(), qty: i.qty || '1',
          unknown: (i.unknown || []).slice(), auto: !!i.everyone,
        };
      });
      if (!B.items.length) B.items = [{ name: '', amount: '', members: [], qty: '1', unknown: [], auto: false }];
      B.adjs = (d.adjustments || []).map(function (a) {
        var v = BigInt(a.amount);
        return { kind: a.kind, amount: plainMoney((a.kind === 'discount' ? -v : v).toString(), dd) };
      });
      $('bill-stated').value = d.stated_total ? plainMoney(d.stated_total, dd) : '';
    } else {
      $('bill-total').value = d.total ? plainMoney(d.total, dd) : '';
      B.even = (d.participants || []).map(function (p) { return p.member; });
      B.evenAuto = !!d.participants_everyone;
      B.pcts = {};
      (d.participants || []).forEach(function (p) { if (p.bp) B.pcts[p.member] = E.formatPercent(p.bp, 'en'); });
      var missing = d.participants_unknown || [];
      B.evenUnknown = B.mode === 'even' ? missing.map(function (x) { return x.name; }) : [];
      B.pctUnknown = B.mode === 'percent' ? missing.filter(function (x) { return x.bp; }) : [];
    }
    B.read = true;
    status('');
    renderAll();
  };

  // ── people, added where they are needed ──
  function takeName(list, name) {
    for (var i = 0; i < list.length; i++) if (same(list[i], name)) { list.splice(i, 1); return true; }
    return false;
  }
  function addTo(list, id) { if (list.indexOf(id) < 0) list.push(id); }

  /* Put a (new) member where they belong: the row whose "+" was tapped, every
     line that is everyone's, and wherever the AI had read their name. */
  function place(id, where, name) {
    B.items.forEach(function (it, i) {
      if (it.auto || where === 'it:' + i) addTo(it.members, id);
      if (name && takeName(it.unknown, name)) addTo(it.members, id);
    });
    if (B.evenAuto || where === 'even') addTo(B.even, id);
    if (name && takeName(B.evenUnknown, name)) addTo(B.even, id);
    if (name) {
      B.pctUnknown = B.pctUnknown.filter(function (p) {
        if (!same(p.name, name)) return true;
        B.pcts[id] = E.formatPercent(p.bp, 'en');
        return false;
      });
    }
    if (where === 'payer' || (name && B.payerUnknown && same(B.payerUnknown, name))) {
      B.payer = id;
      B.payerUnknown = null;
    }
    if (name) takeName(B.unknown, name);
  }

  /* "Ali" or "@ali". Someone already here is picked, never added twice. */
  function addPerson(raw, where, name) {
    var v = String(raw || '').trim();
    if (!v) { renderAll(); return Promise.resolve(null); }
    var user = v.charAt(0) === '@';
    var key = (user ? v.slice(1) : v).toLowerCase();
    var hit = S.view.members.filter(function (m) {
      return m.active && (m.name.toLowerCase() === key || (m.username || '').toLowerCase() === key);
    })[0];
    if (hit) { place(hit.id, where, name); renderAll(); return Promise.resolve(hit.id); }
    return S.act('member/add', user ? { username: v.slice(1) } : { name: v }).then(function (r) {
      if (r.ok) place(r.data.member_id, where, name);
      renderAll();
      return r.ok ? r.data.member_id : null;
    });
  }

  /* The "+" chip becomes a name box in place. Enter or leaving it adds. */
  function openPlus(btn) {
    var where = btn.dataset.plus;
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'mchip-input';
    inp.maxLength = 40;
    inp.placeholder = t('new.person_ph');
    inp.setAttribute('aria-label', t('mem.add_person'));
    btn.replaceWith(inp);
    inp.focus();
    var done = false;
    function finish(keep) {
      if (done) return;
      done = true;
      if (keep && inp.value.trim()) {
        inp.disabled = true;
        return addPerson(inp.value, where, null);
      }
      // Put the "+" back in place: a full re-render here would swallow the
      // click on whatever chip took the focus away.
      var tmp = document.createElement('div');
      tmp.innerHTML = plusChip(where);
      if (tmp.firstChild) inp.replaceWith(tmp.firstChild); else inp.remove();
    }
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    });
    inp.addEventListener('blur', function () { finish(true); });
    inp._cancel = function () { finish(false); };
  }
  // Esc in the name box drops the box, not the whole bill (window capture runs before the modal's).
  window.addEventListener('keydown', function (ev) {
    var el = document.activeElement;
    if (ev.key === 'Escape' && el && el.classList && el.classList.contains('mchip-input') && el._cancel) {
      ev.stopPropagation();
      ev.preventDefault();
      el._cancel();
    }
  }, true);

  // ── events ──
  function toggle(list, btn) {
    if (btn.dataset.all) {
      var ids = activeIds();
      var allOn = ids.every(function (id) { return list.indexOf(id) >= 0; });
      list.length = 0;
      if (!allOn) ids.forEach(function (id) { list.push(id); });
      return;
    }
    var id = btn.dataset.m;
    var i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1); else list.push(id);
  }

  $('bill-fields').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b || B.readOnly) return;
    if (b.dataset.plus) { ev.preventDefault(); openPlus(b); return; }
    if (b.classList.contains('pay-chip')) {
      B.payer = b.dataset.m;
      B.payerUnknown = null;
      renderPayer();
      schedule();
    }
  });

  $('ai-unknown').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.unknownAll) {
      setBusy(b, true);
      B.unknown.slice().reduce(function (p, n) {
        return p.then(function () { return addPerson(n, null, n); });
      }, Promise.resolve());
    } else if (b.dataset.unknown) {
      setBusy(b, true);
      addPerson(b.dataset.unknown, null, b.dataset.unknown);
    }
  });

  $('mode-tabs').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-mode]');
    if (!b || B.readOnly) return;
    B.mode = b.getAttribute('data-mode');
    renderMode();
  });
  $('input-tabs').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-input]');
    if (!b) return;
    B.tab = b.getAttribute('data-input');
    status('');
    renderStage();
    if (B.tab === 'chat') $('ai-text').focus();
    else if (B.tab === 'form') $('bill-desc').focus();
  });
  $('ai-reset').addEventListener('click', function () {
    var tab = B.tab;
    B = blank();
    B.tab = tab;
    fillFields(null);
    resetInput();
    renderAll();
    preview();
  });

  $('add-item').addEventListener('click', function () {
    var last = B.items[B.items.length - 1];
    B.items.push({ name: '', amount: '', members: last ? last.members.slice() : activeIds(), qty: '1', unknown: [], auto: last ? last.auto : true });
    renderItems();
    var names = $('items').querySelectorAll('.it-name');
    if (names.length) names[names.length - 1].focus();
    schedule();
  });
  $('panel-items').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b || B.readOnly || b.dataset.plus) return;
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
      if (!B.items.length) B.items.push({ name: '', amount: '', members: [], qty: '1', unknown: [], auto: false });
      renderItems();
    } else if (b.classList.contains('adj-del')) {
      B.adjs.splice(Number(line.dataset.a), 1);
      renderAdjs();
    } else if (b.classList.contains('it-chip')) {
      var i = Number(line.dataset.i);
      var it = B.items[i];
      toggle(it.members, b);
      it.auto = coversAll(it.members);
      line.querySelector('.chips').innerHTML = chipsHtml(it.members, 'it-chip', 'it:' + i);
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

  $('panel-simple').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b || B.readOnly || b.dataset.plus) return;
    if (b.classList.contains('ev-chip')) {
      toggle(B.even, b);
      B.evenAuto = coversAll(B.even);
      $('even-chips').innerHTML = chipsHtml(B.even, 'ev-chip', 'even');
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

  ['bill-desc', 'bill-date', 'bill-currency', 'bill-stated', 'bill-total'].forEach(function (id) {
    $(id).addEventListener('input', schedule);
    $(id).addEventListener('change', schedule);
  });

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
    if (B.readOnly || $('bill-fields').hidden) return;
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

  // ── Photo and chat: the AI reads, the form stays the only thing that saves. ──
  function status(msg, isErr) {
    var el = $('ai-status');
    el.textContent = msg;
    el.className = 'assist-status' + (isErr ? ' error' : '');
    el.hidden = !msg;
  }

  function done(r, bill) {
    $('ai-pick').classList.remove('busy');
    if (bill !== B) return; // closed or reset while reading
    // No AI on this server: say nothing, just hand over the form.
    if (!r.ok && r.code === 'ai_unavailable') {
      S.ai = false;
      B.tab = 'form';
      status('');
      renderStage();
      return;
    }
    if (!r.ok) return status(errMsg(r.code, r.params), true);
    window.fillBillFromDraft(r.data);
  }

  $('ai-chat-go').addEventListener('click', function (ev) {
    var btn = ev.currentTarget;
    var text = $('ai-text').value.trim();
    if (!text) return $('ai-text').focus();
    var bill = B;
    setBusy(btn, true);
    status(t('input.reading'));
    api('ai/chat', { body: { group_id: S.gid, text: text } }).then(function (r) { setBusy(btn, false); done(r, bill); });
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

  /* Picking the photo is the whole action: it is read at once. */
  $('ai-file').addEventListener('change', function () {
    var f = $('ai-file').files[0];
    if (!f) return;
    var bill = B;
    $('ai-pick').classList.add('busy');
    status(t('input.reading'));
    shrink(f).then(function (b) {
      photo = b;
      var th = $('ai-thumb');
      th.src = URL.createObjectURL(b);
      th.hidden = false;
      var fd = new FormData();
      fd.append('group_id', S.gid);
      fd.append('caption', $('ai-caption').value);
      fd.append('file', photo, 'receipt.jpg');
      // The same photo picked again after an error must fire "change" again.
      $('ai-file').value = '';
      return api('ai/photo', { body: fd });
    }).then(function (r) { done(r, bill); });
  });
}());
