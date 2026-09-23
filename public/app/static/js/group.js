/* group.js: one split's page. Everything shown comes from the server's
 * computed view (the engine), except the live preview inside the bill editor
 * (bill.js), which runs the same engine in the browser. */
(function () {
  var S = { view: null, me: null, offline: false };
  window.SB = S;

  var $ = function (id) { return document.getElementById(id); };
  var GID = (location.pathname.match(/^\/app\/g\/([A-Za-z0-9]+)/) || [])[1] || '';

  // ── lookups ──
  function member(id) {
    var ms = S.view.members;
    for (var i = 0; i < ms.length; i++) if (ms[i].id === id) return ms[i];
    return null;
  }
  function nameOf(id) {
    var m = member(id);
    if (!m) return '?';
    return m.id === S.view.me ? m.name + ' (' + t('mem.you') + ')' : m.name;
  }
  function G() { return S.view.group; }
  function isOpen() { return G().status === 'open'; }
  function isTravel() { return G().kind === 'travel'; }
  function myMember() { return S.view.me ? member(S.view.me) : null; }
  function gmoney(minor) { return money(minor, G().currency, G().dp); }

  S.member = member;
  S.nameOf = nameOf;
  S.isTravel = isTravel;

  S.canAddBill = function () {
    var me = myMember();
    if (S.offline || !isOpen() || !me || !me.active) return false;
    return isTravel() || (S.view.is_owner && !S.view.bills.length);
  };
  S.canEditBill = function (b) {
    if (S.offline || !isOpen()) return false;
    if (S.view.is_owner) return true;
    return isTravel() && b.created_by === S.me.user_id;
  };
  S.canRecord = function (fromId, toId) {
    if (S.offline) return false;
    if (S.view.is_owner) return true;
    var from = member(fromId), to = member(toId);
    if (!from || !to) return false;
    if (to.user_id === S.me.user_id) return true;
    return to.user_id === null && from.user_id === S.me.user_id;
  };

  // ── render ──
  function render() {
    var g = G();
    document.title = g.name + ' · Split Bill';
    $('g-name').textContent = g.name;
    $('g-chips').innerHTML =
      '<span class="chip">' + esc(t(g.kind === 'travel' ? 'kind.travel' : 'kind.one_off')) + '</span> ' +
      (g.status === 'settled'
        ? '<span class="chip chip-settled">' + esc(t('status.settled')) + '</span>'
        : '<span class="chip chip-open">' + esc(t('status.not_settled')) + '</span>');

    var miss = $('missing-banner');
    if (!S.view.complete && S.view.missing.length) {
      var m0 = S.view.missing[0];
      miss.textContent = t('rate.missing_banner', m0.currency, fmtDate(m0.date));
      miss.hidden = false;
    } else miss.hidden = true;

    renderBalances();
    renderBills();
    renderPayments();
    renderMembers();
    renderRates();
    $('card-danger').hidden = !S.view.is_owner || S.offline;
    $('btn-currency').hidden = !(S.view.is_owner && isTravel() && isOpen() && !S.offline);
    $('btn-add-bill').hidden = !S.canAddBill();
    $('btn-add-payment').hidden = S.offline || !isOpen();
    $('btn-add-member').hidden = S.offline || !S.view.is_owner || !isOpen();
  }

  function renderBalances() {
    var v = S.view;
    var mine = null;
    for (var i = 0; i < v.balances.length; i++) if (v.balances[i].id === v.me) mine = v.balances[i];
    var tiles = '<div class="tool-tile"><div class="lbl">' + esc(t('bal.spent')) + '</div><div class="val">' + esc(gmoney(v.spent)) + '</div></div>';
    if (mine) {
      var n = BigInt(mine.net);
      tiles += '<div class="tool-tile"><div class="lbl">' + esc(t(n > 0n ? 'bal.you_get' : n < 0n ? 'bal.you_owe' : 'bal.mine')) + '</div>' +
        '<div class="val ' + (n > 0n ? 'pos' : n < 0n ? 'neg' : '') + '">' + esc(gmoney((n < 0n ? -n : n).toString())) + '</div></div>';
    }
    $('bal-tiles').innerHTML = tiles;

    var rows = v.balances.filter(function (b) {
      var m = member(b.id);
      return m && (m.active || BigInt(b.net) !== 0n || BigInt(b.paid) !== 0n || BigInt(b.share) !== 0n);
    });
    $('bal-body').innerHTML = rows.map(function (b) {
      var n = BigInt(b.net);
      return '<tr><td>' + esc(nameOf(b.id)) + '</td>' +
        '<td class="num">' + esc(money(b.paid, G().currency, G().dp, { plain: true })) + '</td>' +
        '<td class="num">' + esc(money(b.share, G().currency, G().dp, { plain: true })) + '</td>' +
        '<td class="num ' + (n > 0n ? 'pos' : n < 0n ? 'neg' : '') + '">' + esc(signedMoney(b.net, G().currency, G().dp)) + '</td></tr>';
    }).join('');

    var tr = v.transfers;
    var html;
    if (!tr.length) {
      html = '<div class="tool-empty">' + esc(t(v.bills.length ? 'bal.all_even' : 'bal.no_bills')) + '</div>';
    } else {
      html = tr.map(function (x) {
        var paid = x.status === 'paid';
        var btn = '';
        if (G().status === 'settled' && x.id && S.canRecord(x.from, x.to)) {
          btn = paid
            ? '<button type="button" class="btn btn-ghost btn-compact" data-unpaid="' + esc(x.id) + '">' + icon('undo') + ' ' + esc(t('xfer.undo')) + '</button>'
            : '<button type="button" class="btn btn-secondary btn-compact" data-paid="' + esc(x.id) + '">' + icon('check') + ' ' + esc(t('xfer.mark_paid')) + '</button>';
        }
        var tag = paid ? '<span class="chip chip-settled">' + esc(t('xfer.paid')) + '</span>' : '';
        return '<div class="transfer' + (paid ? ' paid' : '') + '"><span class="who">' + esc(nameOf(x.from)) + ' ' + icon('arrow-right') + ' ' + esc(nameOf(x.to)) + ' ' + tag + '</span>' +
          '<span class="amt">' + esc(gmoney(x.amount)) + '</span>' + btn + '</div>';
      }).join('');
    }
    $('transfers').innerHTML = html;

    var acts = '';
    if (v.is_owner && !S.offline) {
      if (G().status === 'open') {
        acts = '<button type="button" class="btn btn-primary" id="btn-settle"' + (v.complete ? '' : ' disabled') + '>' + icon('lock') + ' ' + esc(t('grp.settle')) + '</button>';
      } else {
        acts = '<button type="button" class="btn btn-ghost" id="btn-reopen">' + icon('unlock') + ' ' + esc(t('grp.reopen')) + '</button>';
      }
    }
    $('owner-actions').innerHTML = acts;
    $('owner-actions').hidden = !acts;
  }

  function renderBills() {
    var v = S.view;
    var wrap = $('bills-wrap');
    if (!v.bills.length) { setTableEmpty(wrap, t('bill.empty')); return; }
    setTableEmpty(wrap, '');
    var list = v.bills.slice().sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : Number(b.id) - Number(a.id); });
    $('bills-body').innerHTML = list.map(function (b) {
      var mine = v.me && b.shares[v.me] ? b.shares[v.me][0] : null;
      var total = money(b.total, b.currency, b.dp);
      var conv = b.currency !== G().currency && b.converted != null ? '<div class="tool-sub">' + esc(gmoney(b.converted)) + '</div>' : '';
      var err = b.error ? '<div class="tool-sub neg">' + esc(errMsg(b.error.code, b.error.params)) + '</div>' : '';
      var acts = S.canEditBill(b)
        ? '<div class="tool-row-actions">' +
            '<button type="button" class="btn btn-ghost btn-compact btn-icon" data-edit="' + esc(b.id) + '" aria-label="' + esc(t('common.edit')) + '">' + icon('pencil') + '</button>' +
            '<button type="button" class="btn btn-danger btn-compact btn-icon" data-del="' + esc(b.id) + '" aria-label="' + esc(t('common.delete')) + '">' + icon('trash') + '</button></div>'
        : '<div class="tool-row-actions"><button type="button" class="btn btn-ghost btn-compact btn-icon" data-view="' + esc(b.id) + '" aria-label="' + esc(t('bill.view')) + '">' + icon('eye') + '</button></div>';
      return '<tr><td>' + esc(b.description) +
        '<div class="tool-sub">' + esc(fmtDate(b.date)) + ' · ' + esc(t('bill.paid_by_x', nameOf(b.payer))) + ' · ' + esc(t('mode.' + b.mode)) + '</div>' + err + '</td>' +
        '<td class="num">' + esc(total) + conv + '</td>' +
        '<td class="num">' + (mine == null ? '<span class="muted">-</span>' : esc(money(mine, b.currency, b.dp, { plain: true }))) + '</td>' +
        '<td class="act">' + acts + '</td></tr>';
    }).join('');
  }

  function renderPayments() {
    var v = S.view;
    var wrap = $('pay-wrap');
    if (!v.payments.length) { setTableEmpty(wrap, t('pay.empty')); return; }
    setTableEmpty(wrap, '');
    $('pay-body').innerHTML = v.payments.slice().reverse().map(function (p) {
      var canDel = !S.offline && isOpen() && !p.transfer_id && (S.canRecord(p.from, p.to) || p.created_by === S.me.user_id);
      var conv = p.currency !== G().currency && p.converted != null ? '<div class="tool-sub">' + esc(gmoney(p.converted)) + '</div>' : '';
      var tag = p.transfer_id ? ' · ' + esc(t('pay.from_settle')) : '';
      return '<tr><td>' + esc(nameOf(p.from)) + ' ' + icon('arrow-right') + ' ' + esc(nameOf(p.to)) +
        '<div class="tool-sub">' + esc(fmtDate(p.date)) + tag + (p.note ? ' · ' + esc(p.note) : '') + '</div></td>' +
        '<td class="num">' + esc(money(p.amount, p.currency, p.dp)) + conv + '</td>' +
        '<td class="act">' + (canDel ? '<div class="tool-row-actions"><button type="button" class="btn btn-danger btn-compact btn-icon" data-delpay="' + esc(p.id) + '" aria-label="' + esc(t('common.delete')) + '">' + icon('trash') + '</button></div>' : '') + '</td></tr>';
    }).join('');
  }

  function renderMembers() {
    var v = S.view;
    var owner = v.is_owner && !S.offline;
    $('mem-body').innerHTML = v.members.map(function (m) {
      var chips = [];
      if (m.user_id === G().owner) chips.push('<span class="chip">' + esc(t('mem.owner')) + '</span>');
      if (!m.user_id) chips.push('<span class="chip chip-muted">' + esc(t('mem.no_app')) + '</span>');
      if (!m.active) chips.push('<span class="chip chip-muted">' + esc(t('mem.inactive')) + '</span>');
      var acts = [];
      if (owner || m.id === v.me) acts.push('<button type="button" class="btn btn-ghost btn-compact btn-icon" data-mren="' + esc(m.id) + '" aria-label="' + esc(t('mem.rename')) + '">' + icon('pencil') + '</button>');
      if (owner && !m.user_id) acts.push('<button type="button" class="btn btn-ghost btn-compact btn-icon" data-mlink="' + esc(m.id) + '" aria-label="' + esc(t('mem.link')) + '" title="' + esc(t('mem.link')) + '">' + icon('link') + '</button>');
      if (owner && !m.active) acts.push('<button type="button" class="btn btn-ghost btn-compact btn-icon" data-mact="' + esc(m.id) + '" aria-label="' + esc(t('mem.reactivate')) + '">' + icon('undo') + '</button>');
      if (owner && m.active && m.user_id !== G().owner) acts.push('<button type="button" class="btn btn-danger btn-compact btn-icon" data-mdel="' + esc(m.id) + '" aria-label="' + esc(t('mem.remove')) + '">' + icon('trash') + '</button>');
      return '<tr><td>' + esc(nameOf(m.id)) + (m.username ? '<div class="tool-sub">@' + esc(m.username) + '</div>' : '') + '</td>' +
        '<td>' + chips.join(' ') + '</td>' +
        '<td class="act"><div class="tool-row-actions">' + acts.join('') + '</div></td></tr>';
    }).join('');

    var box = $('invite-box');
    if (isTravel() && G().invite_code && !S.offline) {
      box.hidden = false;
      $('invite-link').value = location.origin + '/app/join/' + G().invite_code;
      $('invite-reset').hidden = !v.is_owner;
    } else box.hidden = true;
  }

  /* "16250.5" -> "16,250.5" / "16.250,5". */
  function fmtRate(text) {
    var parts = String(text).split('.');
    var id = window.__LANG__ === 'id';
    return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, id ? '.' : ',') + (parts[1] ? (id ? ',' : '.') + parts[1] : '');
  }

  function rateText(r) {
    // Stored big side first: inverted means 1 settlement unit = rate foreign.
    return r.inverted
      ? '1 ' + G().currency + ' = ' + fmtRate(r.rate) + ' ' + r.currency
      : '1 ' + r.currency + ' = ' + fmtRate(r.rate) + ' ' + G().currency;
  }
  S.rateText = rateText;

  function renderRates() {
    var card = $('card-rates');
    card.hidden = !isTravel();
    if (!isTravel()) return;
    var v = S.view;
    $('btn-add-rate').hidden = S.offline || !v.is_owner || !isOpen();
    var wrap = $('rates-wrap');
    if (!v.rates.length) { setTableEmpty(wrap, t('rate.empty')); return; }
    setTableEmpty(wrap, '');
    var edit = v.is_owner && !S.offline && isOpen();
    $('rates-body').innerHTML = v.rates.map(function (r) {
      return '<tr><td>' + esc(fmtDate(r.effective)) + '</td>' +
        '<td class="mono">' + esc(rateText(r)) + (r.source === 'auto' ? ' <span class="chip chip-muted">' + esc(t('rate.auto')) + '</span>' : '') + '</td>' +
        '<td class="act">' + (edit ? '<div class="tool-row-actions">' +
          '<button type="button" class="btn btn-ghost btn-compact btn-icon" data-redit="' + esc(r.currency + '|' + r.effective) + '" aria-label="' + esc(t('common.edit')) + '">' + icon('pencil') + '</button>' +
          '<button type="button" class="btn btn-danger btn-compact btn-icon" data-rdel="' + esc(r.currency + '|' + r.effective) + '" aria-label="' + esc(t('common.delete')) + '">' + icon('trash') + '</button></div>' : '') + '</td></tr>';
    }).join('');
  }

  // ── data ──
  function setView(data, offline, at) {
    S.view = data.group;
    S.me = data.me;
    S.offline = !!offline;
    topbarSetUser(S.me);
    var b = $('offline-banner');
    if (S.offline) {
      b.textContent = t('offline.banner', fmtDate(new Date(at || Date.now()).toISOString()));
      b.hidden = false;
    } else b.hidden = true;
    render();
  }

  S.reload = function () {
    return api('group?id=' + encodeURIComponent(GID)).then(function (r) {
      if (!r.ok) { showToast(errMsg(r.code, r.params), 'error'); return; }
      setView({ group: r.data, me: S.me }, false);
    });
  };

  /* Run a write, toast its error, reload on success. */
  S.act = function (path, body, okMsg, btn) {
    if (btn) setBusy(btn, true);
    return api(path, { body: Object.assign({ group_id: GID }, body) }).then(function (r) {
      if (btn) setBusy(btn, false);
      if (!r.ok) {
        showToast(errMsg(r.code, r.params), 'error');
        if (r.status === 409) S.reload();
        return r;
      }
      if (okMsg) showToast(okMsg);
      return S.reload().then(function () { return r; });
    });
  };
  S.gid = GID;

  // ── events ──
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('button');
    if (!el || !S.view) return;
    var d = el.dataset;
    if (el.id === 'btn-settle') {
      confirmDialog(t('grp.settle_confirm'), { title: t('grp.settle'), okLabel: t('grp.settle'), danger: false }).then(function (yes) {
        if (yes) S.act('settle', { expected_revision: G().revision }, t('grp.settled_toast'), el);
      });
    } else if (el.id === 'btn-reopen') {
      confirmDialog(t('grp.reopen_confirm'), { title: t('grp.reopen'), okLabel: t('grp.reopen'), danger: false }).then(function (yes) {
        if (yes) S.act('reopen', {}, t('grp.reopened_toast'), el);
      });
    } else if (d.paid) {
      S.act('transfer/paid', { transfer_id: d.paid }, t('xfer.paid_toast'), el);
    } else if (d.unpaid) {
      S.act('transfer/unpaid', { transfer_id: d.unpaid }, null, el);
    } else if (d.del) {
      confirmDialog(t('bill.delete_confirm'), { okLabel: t('common.delete') }).then(function (yes) {
        if (yes) S.act('bill/delete', { bill_id: d.del }, t('bill.deleted'));
      });
    } else if (d.delpay) {
      confirmDialog(t('pay.delete_confirm'), { okLabel: t('common.delete') }).then(function (yes) {
        if (yes) S.act('payment/delete', { payment_id: d.delpay }, t('pay.deleted'));
      });
    } else if (d.mdel) {
      confirmDialog(t('mem.remove_confirm', member(d.mdel).name), { okLabel: t('mem.remove') }).then(function (yes) {
        if (yes) S.act('member/remove', { member_id: d.mdel }).then(function (r) {
          if (r.ok) showToast(t(r.data.removed ? 'mem.removed' : 'mem.deactivated'));
        });
      });
    } else if (d.mact) {
      S.act('member/reactivate', { member_id: d.mact });
    } else if (d.mren) {
      openMember('rename', member(d.mren));
    } else if (d.mlink) {
      openMember('link', member(d.mlink));
    } else if (d.rdel) {
      var parts = d.rdel.split('|');
      confirmDialog(t('rate.delete_confirm'), { okLabel: t('common.delete') }).then(function (yes) {
        if (yes) S.act('rate/delete', { currency: parts[0], effective: parts[1] }, t('rate.deleted'));
      });
    } else if (d.redit) {
      var p2 = d.redit.split('|');
      if (window.openRate) window.openRate(p2[0], p2[1]);
    }
  });

  $('btn-add-member').addEventListener('click', function () { openMember('add', null); });
  $('btn-add-payment').addEventListener('click', function () { openPayment(); });
  $('btn-add-rate').addEventListener('click', function () { if (window.openRate) window.openRate(); });
  $('invite-copy').addEventListener('click', function () {
    copyText($('invite-link').value);
  });
  $('invite-reset').addEventListener('click', function (ev) {
    confirmDialog(t('mem.invite_reset_confirm'), { okLabel: t('mem.invite_reset'), danger: false }).then(function (yes) {
      if (yes) S.act('group/invite-reset', {}, null, ev.target.closest('button'));
    });
  });
  $('btn-rename').addEventListener('click', function () { openMember('group', null); });
  $('btn-delete-group').addEventListener('click', function () {
    confirmDialog(t('grp.delete_confirm', G().name), { okLabel: t('grp.delete') }).then(function (yes) {
      if (!yes) return;
      api('group/delete', { body: { group_id: GID } }).then(function (r) {
        if (!r.ok) return showToast(errMsg(r.code, r.params), 'error');
        location.href = '/app';
      });
    });
  });

  function copyText(txt) {
    var done = function () { showToast(t('common.copied')); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, function () { fallback(); });
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      document.body.removeChild(ta);
    }
  }
  S.copyText = copyText;

  // ── member modal (add / rename / link / group rename) ──
  var memMode = 'add', memTarget = null;
  function openMember(mode, m) {
    memMode = mode; memTarget = m;
    var nameF = $('mem-name-field'), linkF = $('mem-link-field');
    nameF.hidden = mode === 'link';
    linkF.hidden = mode !== 'link';
    $('mem-name').value = mode === 'rename' ? m.name : mode === 'group' ? G().name : '';
    $('mem-name').placeholder = mode === 'add' ? t('new.person_ph') : '';
    var tip = nameF.querySelector('.tooltip-icon');
    if (tip) tip.hidden = mode !== 'add';
    $('mem-title').textContent = t(mode === 'add' ? 'mem.add' : mode === 'rename' ? 'mem.rename' : mode === 'link' ? 'mem.link' : 'grp.rename');
    if (mode === 'link') {
      var opts = S.view.members.filter(function (x) { return x.user_id && x.user_id !== G().owner && x.id !== m.id; });
      $('mem-link').innerHTML = opts.length
        ? opts.map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.name) + (x.username ? ' (@' + esc(x.username) + ')' : '') + '</option>'; }).join('')
        : '<option value="">' + esc(t('mem.link_none')) + '</option>';
    }
    openModal('modal-mem', { initialFocus: mode === 'link' ? '#mem-link' : '#mem-name' });
  }
  $('mem-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var btn = $('mem-save');
    var v = $('mem-name').value.trim();
    var p;
    if (memMode === 'add') p = S.act('member/add', v.charAt(0) === '@' ? { username: v.slice(1) } : { name: v }, null, btn);
    else if (memMode === 'rename') p = S.act('member/rename', { member_id: memTarget.id, name: v }, null, btn);
    else if (memMode === 'group') p = S.act('group/rename', { name: v }, null, btn);
    else p = S.act('member/link', { member_id: memTarget.id, target_member_id: $('mem-link').value }, t('mem.linked'), btn);
    p.then(function (r) { if (r.ok) closeModal('modal-mem'); });
  });

  // ── payment modal ──
  function memberOptions(sel, pick) {
    sel.innerHTML = S.view.members.filter(function (m) { return m.active; }).map(function (m) {
      return '<option value="' + esc(m.id) + '">' + esc(nameOf(m.id)) + '</option>';
    }).join('');
    if (pick) sel.value = pick;
  }
  S.memberOptions = memberOptions;

  function openPayment() {
    memberOptions($('pay-from'), S.view.me);
    var other = S.view.members.filter(function (m) { return m.active && m.id !== S.view.me; })[0];
    memberOptions($('pay-to'), other ? other.id : null);
    fillCurrencySelect($('pay-currency'), G().currency);
    $('pay-currency').disabled = !isTravel();
    $('pay-amount').value = '';
    $('pay-note').value = '';
    $('pay-date').value = todayIn(G().timezone);
    openModal('modal-pay', { initialFocus: '#pay-amount' });
  }
  $('pay-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var ccy = $('pay-currency').value;
    var amount;
    try { amount = parseMoney($('pay-amount').value, SBEngine.minorUnits(ccy)); }
    catch (e) { return showToast(errMsg(e.code || 'amount_invalid', e.params), 'error'); }
    S.act('payment/record', {
      from: $('pay-from').value, to: $('pay-to').value, currency: ccy, amount: amount,
      date: $('pay-date').value, note: $('pay-note').value,
    }, t('pay.saved'), $('pay-save')).then(function (r) { if (r.ok) closeModal('modal-pay'); });
  });

  // ── boot ──
  sbBoot().then(function (r) {
    if (!r.ok) {
      showToast(errMsg(r.code, r.params), 'error');
      if (r.status === 404) setTimeout(function () { location.href = '/app'; }, 1200);
      return;
    }
    setView(r.data, r.offline, r.at);
    if (location.hash === '#add-bill' && S.canAddBill()) {
      history.replaceState(null, '', location.pathname);
      if (window.openBill) window.openBill(null);
    }
  });
}());

/* ── Rates and settlement currency (trip groups) ──────────────────────────
   Rates are stored "big side first": 1 USD = 16,000 IDR, never 0.0000625.
   `inverted` means 1 settlement unit = rate foreign units. */
(function () {
  var S = window.SB, E = window.SBEngine;
  var $ = function (id) { return document.getElementById(id); };
  var R = { inverted: false, source: 'manual', replace: null };
  function G() { return S.view.group; }
  function lang() { return window.__LANG__ || 'en'; }
  function localRate(text) { return lang() === 'id' ? String(text).replace('.', ',') : String(text); }

  function label() {
    var c = $('rate-currency').value;
    $('rate-label').textContent = R.inverted ? '1 ' + G().currency + ' = ? ' + c : '1 ' + c + ' = ? ' + G().currency;
  }

  window.openRate = function (currency, effective) {
    var row = currency ? S.view.rates.filter(function (r) { return r.currency === currency && r.effective === effective; })[0] : null;
    R = { inverted: row ? row.inverted : false, source: row ? row.source : 'manual', replace: row ? { currency: row.currency, effective: row.effective } : null };
    var sel = $('rate-currency');
    fillCurrencySelect(sel, currency || (S.view.missing[0] && S.view.missing[0].currency) || 'USD');
    var own = sel.querySelector('option[value="' + G().currency + '"]');
    if (own) own.remove();
    var start = !row ? !S.view.rates.some(function (r) { return r.currency === sel.value; }) : row.effective === '-infinity';
    $('rate-start').checked = start;
    $('rate-date').value = row && row.effective !== '-infinity' ? row.effective : todayIn(G().timezone);
    $('rate-date').disabled = start;
    $('rate-value').value = row ? localRate(row.rate) : '';
    $('rate-title').textContent = t(row ? 'rate.edit' : 'rate.add');
    label();
    openModal('modal-rate', { initialFocus: '#rate-value' });
  };

  $('rate-currency').addEventListener('change', label);
  $('rate-start').addEventListener('change', function () { $('rate-date').disabled = $('rate-start').checked; });
  $('rate-value').addEventListener('input', function () { R.source = 'manual'; });
  $('rate-flip').addEventListener('click', function () {
    R.inverted = !R.inverted;
    // Keep the same meaning: flip the number too when one is there.
    try {
      var r = E.parseLocaleRate($('rate-value').value, lang()).value;
      var inv = E.frac(r.den, r.num);
      var n = Number(inv.num) / Number(inv.den);
      $('rate-value').value = localRate(Number(n.toPrecision(10)).toString());
    } catch (e) {}
    label();
  });
  $('rate-auto').addEventListener('click', function (ev) {
    var btn = ev.currentTarget;
    setBusy(btn, true);
    api('rate/auto', { body: { group_id: S.gid, currency: $('rate-currency').value, effective: $('rate-start').checked ? '-infinity' : $('rate-date').value } })
      .then(function (r) {
        setBusy(btn, false);
        if (!r.ok) return showToast(errMsg(r.code, r.params), 'error');
        R.inverted = r.data.inverted;
        R.source = 'auto';
        $('rate-value').value = localRate(r.data.rate);
        label();
        showToast(t('rate.auto_done'));
      });
  });
  $('rate-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var rate;
    try { rate = E.parseLocaleRate($('rate-value').value, lang()).text; }
    catch (e) { return showToast(errMsg(e.code || 'rate_invalid'), 'error'); }
    S.act('rate/set', {
      currency: $('rate-currency').value,
      effective: $('rate-start').checked ? '-infinity' : $('rate-date').value,
      rate: rate, inverted: R.inverted, source: R.source, replace: R.replace,
    }, t('rate.saved'), $('rate-save')).then(function (r) { if (r.ok) closeModal('modal-rate'); });
  });
}());

/* ── Change a trip's settlement currency: one request with every rate. ── */
(function () {
  var S = window.SB, E = window.SBEngine;
  var $ = function (id) { return document.getElementById(id); };
  function G() { return S.view.group; }

  function used() {
    var set = {};
    S.view.bills.forEach(function (b) { set[b.currency] = 1; });
    S.view.payments.forEach(function (p) { set[p.currency] = 1; });
    return Object.keys(set).sort();
  }

  function renderRates() {
    var to = $('ccy-new').value;
    var need = used().filter(function (c) { return c !== to; });
    $('ccy-rates').innerHTML = need.map(function (c) {
      return '<div class="pct-row"><span class="who">1 ' + esc(c) + ' =</span>' +
        '<input type="text" class="ccy-rate" data-c="' + esc(c) + '" inputmode="decimal" aria-label="' + esc(c) + '">' +
        '<span class="muted">' + esc(to) + '</span></div>';
    }).join('');
  }

  $('btn-currency').addEventListener('click', function () {
    fillCurrencySelect($('ccy-new'), G().currency);
    renderRates();
    openModal('modal-ccy', { initialFocus: '#ccy-new' });
  });
  $('ccy-new').addEventListener('change', renderRates);
  $('ccy-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var rates = [];
    var inputs = $('ccy-rates').querySelectorAll('.ccy-rate');
    for (var i = 0; i < inputs.length; i++) {
      try { rates.push({ currency: inputs[i].dataset.c, effective: '-infinity', rate: E.parseLocaleRate(inputs[i].value, window.__LANG__).text, inverted: false }); }
      catch (e) { return showToast(errMsg(e.code || 'rate_invalid'), 'error'); }
    }
    S.act('group/currency', { currency: $('ccy-new').value, rates: rates }, t('common.saved'), $('ccy-save'))
      .then(function (r) { if (r.ok) closeModal('modal-ccy'); });
  });
}());

/* ── Report modal: text preview, Copy, PNG, PDF ── */
(function () {
  var S = window.SB;
  var $ = function (id) { return document.getElementById(id); };
  var type = 'group';

  function query(format) {
    var q = 'report?group_id=' + encodeURIComponent(S.gid) + '&type=' + type + '&format=' + format + '&lang=' + (window.__LANG__ || 'en');
    if (type === 'member') q += '&member=' + encodeURIComponent($('report-member').value);
    return q;
  }

  function load() {
    $('report-member-field').hidden = type !== 'member';
    $('report-text').value = t('input.reading');
    api(query('text')).then(function (r) {
      $('report-text').value = r.ok ? r.data.text : errMsg(r.code, r.params);
    });
  }

  function setType(tp) {
    type = tp;
    var tabs = $('report-tabs').querySelectorAll('[data-rtype]');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-rtype') === tp);
    load();
  }

  $('btn-report').addEventListener('click', function () {
    if (S.offline) return showToast(errMsg('offline'), 'error');
    S.memberOptions($('report-member'), S.view.me);
    setType('group');
    openModal('modal-report');
  });
  $('report-tabs').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-rtype]');
    if (b) setType(b.getAttribute('data-rtype'));
  });
  $('report-member').addEventListener('change', load);
  $('report-copy').addEventListener('click', function () { S.copyText($('report-text').value); });

  function download(format, btn) {
    setBusy(btn, true);
    fetch('/app/api/' + query(format), { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw j; });
      var name = (r.headers.get('content-disposition') || '').replace(/^.*filename="([^"]+)".*$/, '$1') || ('report.' + format);
      return r.blob().then(function (b) {
        var file = new File([b], name, { type: b.type });
        // Phones: the share sheet sends the file straight into a chat.
        if (navigator.canShare && navigator.canShare({ files: [file] }) && /Mobi|Android/i.test(navigator.userAgent)) {
          return navigator.share({ files: [file], title: name }).catch(function () {});
        }
        var a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      });
    }).catch(function (j) {
      showToast(errMsg((j && j.code) || 'network', j && j.params), 'error');
    }).then(function () { setBusy(btn, false); });
  }
  $('report-png').addEventListener('click', function (ev) { download('png', ev.currentTarget); });
  $('report-pdf').addEventListener('click', function (ev) { download('pdf', ev.currentTarget); });
}());
