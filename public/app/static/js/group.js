/* group.js: one split's page. Everything shown comes from the server's
 * computed view (the engine), except the live preview inside the bill editor
 * (bill.js), which runs the same engine in the browser. */
(function () {
  var S = { view: null, me: null, offline: false };
  // Page per list, and how many rows a page holds. Payments and Members
  // share a row of the layout, so they page alike and stand the same height.
  var PAGE = { bills: 1, pay: 1, mem: 1 };
  var SIZE = { bills: 10, pay: 5, mem: 5 };
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
  function gmoneyHtml(minor) { return moneyHtml(minor, G().currency, G().dp); }

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
  S.canAddMember = function () {
    return !S.offline && isOpen() && S.view.is_owner;
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
    var owner = S.view.is_owner && !S.offline;
    document.title = g.name + ' · Split Bill';
    $('g-name').textContent = g.name;
    $('g-chips').innerHTML = g.status === 'settled'
      ? '<span class="chip chip-settled">' + esc(t('status.settled')) + '</span>'
      : '<span class="chip chip-open">' + esc(t('status.not_settled')) + '</span>';

    var miss = $('missing-banner');
    // A missing rate is fetched, not asked for; the banner is only for a
    // provider that could not answer.
    if (!S.view.complete && S.view.missing.length && isOpen() && !S.offline && !S.filling) {
      S.filling = true;
      miss.hidden = true;
      api('rate/fill', { body: { group_id: GID } }).then(function (r) {
        if (r.ok && r.data.added) return S.reload().then(function () { S.filling = false; });
        S.filling = 'failed';
        render();
      });
    } else if (!S.view.complete && S.view.missing.length && S.filling !== true) {
      var m0 = S.view.missing[0];
      miss.innerHTML = esc(t('rate.missing_banner', m0.currency, fmtDate(m0.date))) +
        (owner && isOpen() ? ' <button type="button" class="btn btn-ghost btn-compact" id="banner-add-rate">+ ' + esc(t('rate.add')) + '</button>' : '');
      miss.hidden = false;
    } else miss.hidden = true;

    $('btn-add-bill').hidden = !S.canAddBill();
    $('btn-rates').hidden = !isTravel();
    $('btn-manage').hidden = !owner;
    renderBills();
    renderBalances();
    renderPayments();
    renderMembers();
    renderRates();
    renderManage();
    $('btn-add-payment').hidden = S.offline || !isOpen();
    $('btn-add-member').hidden = !S.canAddMember();
  }

  function renderBalances() {
    var v = S.view;
    // Nothing to balance yet: the card would only say so.
    $('card-balances').hidden = !v.bills.length && !v.payments.length;
    var mine = null;
    for (var i = 0; i < v.balances.length; i++) if (v.balances[i].id === v.me) mine = v.balances[i];
    var tiles = '<div class="tool-tile"><div class="lbl">' + esc(t('bal.spent')) + '</div><div class="val">' + gmoneyHtml(v.spent) + '</div></div>';
    if (mine) {
      var n = BigInt(mine.net);
      tiles += '<div class="tool-tile"><div class="lbl">' + esc(t(n > 0n ? 'bal.you_get' : n < 0n ? 'bal.you_owe' : 'bal.mine')) + '</div>' +
        '<div class="val ' + (n > 0n ? 'pos' : n < 0n ? 'neg' : '') + '">' + gmoneyHtml((n < 0n ? -n : n).toString()) + '</div></div>';
    }
    $('bal-tiles').innerHTML = tiles;

    var rows = v.balances.filter(function (b) {
      var m = member(b.id);
      return m && (m.active || BigInt(b.net) !== 0n || BigInt(b.paid) !== 0n || BigInt(b.share) !== 0n);
    });
    $('bal-body').innerHTML = rows.map(function (b) {
      var n = BigInt(b.net);
      return '<tr><td>' + esc(nameOf(b.id)) + '</td>' +
        '<td class="num">' + moneyHtml(b.paid, G().currency, G().dp, { plain: true }) + '</td>' +
        '<td class="num">' + moneyHtml(b.share, G().currency, G().dp, { plain: true }) + '</td>' +
        '<td class="num ' + (n > 0n ? 'pos' : n < 0n ? 'neg' : '') + '">' + signedMoneyHtml(b.net, G().currency, G().dp) + '</td></tr>';
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
          '<span class="amt">' + gmoneyHtml(x.amount) + '</span>' + btn + '</div>';
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

  /* The rows of one page of a list, with its pager drawn (and the page kept
     in range when the list shrinks). */
  function pageOf(key, rows, pagerId, redraw) {
    PAGE[key] = renderPager($(pagerId), PAGE[key], rows.length, SIZE[key], function (p) { PAGE[key] = p; redraw(); });
    return rows.slice((PAGE[key] - 1) * SIZE[key], PAGE[key] * SIZE[key]);
  }

  /* A row opens its bill: the editor when you may change it, else read-only. */
  function renderBills() {
    var v = S.view;
    var wrap = $('bills-wrap');
    if (!v.bills.length) { setTableEmpty(wrap, t('bill.empty')); $('bills-pager').hidden = true; return; }
    setTableEmpty(wrap, '');
    var list = v.bills.slice().sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : Number(b.id) - Number(a.id); });
    list = pageOf('bills', list, 'bills-pager', renderBills);
    $('bills-body').innerHTML = list.map(function (b) {
      var mine = v.me && b.shares[v.me] ? b.shares[v.me][0] : null;
      var conv = b.currency !== G().currency && b.converted != null ? '<div class="tool-sub">' + gmoneyHtml(b.converted) + '</div>' : '';
      var err = b.error ? '<div class="tool-sub neg">' + esc(errMsg(b.error.code, b.error.params)) + '</div>' : '';
      return '<tr class="row-link" tabindex="0" data-bill="' + esc(b.id) + '"><td>' + esc(b.description) +
        '<div class="tool-sub">' + esc(fmtDate(b.date)) + ' · ' + esc(t('bill.paid_by_x', nameOf(b.payer))) + '</div>' + err + '</td>' +
        '<td class="num">' + moneyHtml(b.total, b.currency, b.dp) + conv + '</td>' +
        '<td class="num">' + (mine == null ? '<span class="muted">-</span>' : moneyHtml(mine, b.currency, b.dp, { plain: true })) + '</td></tr>';
    }).join('');
  }

  function renderPayments() {
    var v = S.view;
    var wrap = $('pay-wrap');
    if (!v.payments.length) { setTableEmpty(wrap, t('pay.empty')); $('pay-pager').hidden = true; return; }
    setTableEmpty(wrap, '');
    $('pay-body').innerHTML = pageOf('pay', v.payments.slice().reverse(), 'pay-pager', renderPayments).map(function (p) {
      var canDel = !S.offline && isOpen() && !p.transfer_id && (S.canRecord(p.from, p.to) || p.created_by === S.me.user_id);
      var conv = p.currency !== G().currency && p.converted != null ? '<div class="tool-sub">' + gmoneyHtml(p.converted) + '</div>' : '';
      var tag = p.transfer_id ? ' · ' + esc(t('pay.from_settle')) : '';
      return '<tr><td>' + esc(nameOf(p.from)) + ' ' + icon('arrow-right') + ' ' + esc(nameOf(p.to)) +
        '<div class="tool-sub">' + esc(fmtDate(p.date)) + tag + (p.note ? ' · ' + esc(p.note) : '') + '</div></td>' +
        '<td class="num">' + moneyHtml(p.amount, p.currency, p.dp) + conv + '</td>' +
        '<td class="act">' + (canDel ? '<div class="tool-row-actions"><button type="button" class="btn btn-danger btn-compact btn-icon" data-delpay="' + esc(p.id) + '" aria-label="' + esc(t('common.delete')) + '">' + icon('trash') + '</button></div>' : '') + '</td></tr>';
    }).join('');
  }

  function renderMembers() {
    var v = S.view;
    var owner = v.is_owner && !S.offline;
    $('mem-body').innerHTML = pageOf('mem', v.members, 'mem-pager', renderMembers).map(function (m) {
      var sub = [];
      if (m.username) sub.push('@' + esc(m.username));
      if (m.user_id === G().owner) sub.push(esc(t('mem.owner')));
      if (!m.user_id) sub.push(esc(t('mem.no_app')));
      if (!m.active) sub.push(esc(t('mem.inactive')));
      var acts = [];
      if (owner || m.id === v.me) acts.push('<button type="button" class="btn btn-ghost btn-compact btn-icon" data-mren="' + esc(m.id) + '" aria-label="' + esc(t('mem.rename')) + '">' + icon('pencil') + '</button>');
      if (owner && !m.user_id && isTravel()) acts.push('<button type="button" class="btn btn-ghost btn-compact btn-icon" data-mlink="' + esc(m.id) + '" aria-label="' + esc(t('mem.link')) + '" title="' + esc(t('mem.link')) + '">' + icon('link') + '</button>');
      if (owner && !m.active) acts.push('<button type="button" class="btn btn-ghost btn-compact btn-icon" data-mact="' + esc(m.id) + '" aria-label="' + esc(t('mem.reactivate')) + '">' + icon('undo') + '</button>');
      if (owner && m.active && m.user_id !== G().owner) acts.push('<button type="button" class="btn btn-danger btn-compact btn-icon" data-mdel="' + esc(m.id) + '" aria-label="' + esc(t('mem.remove')) + '">' + icon('trash') + '</button>');
      return '<tr><td' + (m.active ? '' : ' class="muted"') + '>' + esc(nameOf(m.id)) + (sub.length ? '<div class="tool-sub">' + sub.join(' · ') + '</div>' : '') + '</td>' +
        '<td class="act"><div class="tool-row-actions">' + acts.join('') + '</div></td></tr>';
    }).join('');
    $('btn-invite').hidden = !(isTravel() && G().invite_code && !S.offline);
  }

  function renderManage() {
    var owner = S.view.is_owner && !S.offline;
    // A one-off is named after its bill, so only a trip has a name of its own.
    $('btn-rename').hidden = !(owner && isTravel());
    $('btn-currency').hidden = !(owner && isTravel() && isOpen());
    $('btn-tg-bind').hidden = !(owner && isTravel());
    $('invite-reset').hidden = !(owner && isTravel() && G().invite_code);
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
  function openBillRow(ev) {
    var tr = ev.target.closest('tr[data-bill]');
    if (!tr || !S.view || !window.openBill) return;
    var b = S.view.bills.filter(function (x) { return x.id === tr.dataset.bill; })[0];
    if (b) window.openBill(b.id, !S.canEditBill(b));
  }
  $('bills-body').addEventListener('click', openBillRow);
  $('bills-body').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') openBillRow(ev); });

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
    } else if (el.id === 'banner-add-rate') {
      if (window.openRate) window.openRate();
    } else if (d.paid) {
      S.act('transfer/paid', { transfer_id: d.paid }, t('xfer.paid_toast'), el);
    } else if (d.unpaid) {
      S.act('transfer/unpaid', { transfer_id: d.unpaid }, null, el);
    } else if (d.del) {
      confirmDialog(t('bill.delete_confirm'), { okLabel: t('common.delete') }).then(function (yes) {
        if (yes) S.act('bill/delete', { bill_id: d.del }, t('bill.deleted')).then(function (r) { if (r.ok) closeModal('modal-bill'); });
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

  $('btn-add-bill').addEventListener('click', function () { if (window.openBill) window.openBill(null); });
  $('btn-add-member').addEventListener('click', function () { openMember('add', null); });
  $('btn-add-payment').addEventListener('click', function () { openPayment(); });
  $('btn-add-rate').addEventListener('click', function () { if (window.openRate) window.openRate(); });
  $('btn-rates').addEventListener('click', function () { openModal('modal-rates'); });
  $('btn-details').addEventListener('click', function () { openModal('modal-details'); });
  $('btn-manage').addEventListener('click', function () { openModal('modal-manage'); });

  /* One tap: the share sheet on a phone, else the link is copied. */
  $('btn-invite').addEventListener('click', function () {
    var url = location.origin + '/app/join/' + G().invite_code;
    if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
      navigator.share({ title: G().name, url: url }).catch(function () {});
    } else copyText(url, t('grp.invite_copied'));
  });

  /* Manage lists rare actions; each closes it and does its own thing. */
  function fromManage(fn) {
    return function (ev) { closeModal('modal-manage'); fn(ev); };
  }
  $('invite-reset').addEventListener('click', fromManage(function () {
    confirmDialog(t('mem.invite_reset_confirm'), { okLabel: t('mem.invite_reset'), danger: false }).then(function (yes) {
      if (yes) S.act('group/invite-reset', {}, t('common.saved'));
    });
  }));
  $('btn-rename').addEventListener('click', fromManage(function () { openMember('group', null); }));
  $('btn-tg-bind').addEventListener('click', function (ev) {
    var btn = ev.currentTarget;
    setBusy(btn, true);
    api('telegram/bind-code', { body: { group_id: GID } }).then(function (r) {
      setBusy(btn, false);
      if (!r.ok) return showToast(errMsg(r.code, r.params), 'error');
      closeModal('modal-manage');
      window.open(r.data.url, '_blank', 'noopener');
      showToast(t('tg.bind_hint'));
    });
  });
  $('btn-delete-group').addEventListener('click', fromManage(function () {
    confirmDialog(t('grp.delete_confirm', G().name), { okLabel: t('grp.delete') }).then(function (yes) {
      if (!yes) return;
      api('group/delete', { body: { group_id: GID } }).then(function (r) {
        if (!r.ok) return showToast(errMsg(r.code, r.params), 'error');
        location.href = '/app';
      });
    });
  }));

  /* A one-off is its bill. Left without one (closed before saving, or its
     bill deleted), it is gone too: nothing was split. */
  S.discardEmpty = function () {
    var v = S.view;
    if (!v || isTravel() || !isOpen() || !v.is_owner || S.offline || v.bills.length || v.payments.length) return;
    api('group/delete', { body: { group_id: GID } }).then(function () { location.href = '/app'; });
  };

  function copyText(txt, msg) {
    var done = function () { showToast(msg || t('common.copied')); };
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
    S.ai = r.data.ai !== false;
    setView(r.data, r.offline, r.at);
    var addHash = location.hash === '#add-bill';
    if (addHash) history.replaceState(null, '', location.pathname);
    // An empty one-off only exists to take its bill: open the editor straight away.
    var emptyOneOff = !isTravel() && !S.view.bills.length;
    if ((addHash || emptyOneOff) && S.canAddBill() && !/^#draft=/.test(location.hash)) {
      if (window.openBill) window.openBill(null);
    }
    // "Edit in app" from Telegram: open the saved draft in the bill form.
    var dm = /^#draft=([A-Za-z0-9_-]+)$/.exec(location.hash);
    if (dm && S.canAddBill()) {
      history.replaceState(null, '', location.pathname);
      api('draft?id=' + dm[1]).then(function (d) {
        if (!d.ok) return showToast(errMsg(d.code, d.params), 'error');
        window.openBill(null);
        window.fillBillFromDraft(d.data);
      });
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

  /* One rate per currency in use, each prefilled with today's market rate. */
  function renderRates() {
    var to = $('ccy-new').value;
    var need = used().filter(function (c) { return c !== to; });
    $('ccy-rates').innerHTML = need.map(function (c) {
      return '<div class="pct-row"><span class="who">1 ' + esc(c) + ' =</span>' +
        '<input type="text" class="ccy-rate" data-c="' + esc(c) + '" inputmode="decimal" aria-label="' + esc(c) + '">' +
        '<span class="muted">' + esc(to) + '</span></div>';
    }).join('');
    need.forEach(function (c) {
      api('rate/auto', { body: { group_id: S.gid, currency: c, to: to } }).then(function (r) {
        var inp = $('ccy-rates').querySelector('.ccy-rate[data-c="' + c + '"]');
        if (!r.ok || !inp || inp.value || $('ccy-new').value !== to) return;
        // Stored big side first; this box always reads "1 <c> = ? <to>".
        var v = r.data.inverted ? 1 / Number(r.data.rate) : Number(r.data.rate);
        inp.value = localNum(Number(v.toPrecision(10)).toString());
      });
    });
  }
  function localNum(text) { return window.__LANG__ === 'id' ? String(text).replace('.', ',') : String(text); }

  $('btn-currency').addEventListener('click', function () {
    closeModal('modal-manage');
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
