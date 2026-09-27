/* sb.js: one split held in the browser, for every page that edits it.
 * window.SB carries the view the server computed (GET group), the viewer's
 * permissions and the write helper. The group page renders it; home opens
 * the bill editor (bill.js) on it without leaving the page.
 *
 *   S.onView()           called after every (re)load, to redraw the page
 *   S.afterWrite(path, fresh, r)  optional: replaces the reload after a write
 *                        (fresh: the write's answer carried the new view; r is
 *                        that answer, with the group's home-list row)
 *   S.onDiscarded()      called once an empty one-off is deleted
 *   S.onEditorView()     bill.js: a new view reached the open editor
 *   S.onReal(map)        bill.js: a draft one-off now exists; map swaps
 *                        its placeholder member id for the real one
 */
(function () {
  var S = { view: null, me: null, offline: false, stale: false, draft: null, ai: true, gid: '', onView: null, afterWrite: null, onDiscarded: null };
  window.SB = S;

  function G() { return S.view.group; }
  function isOpen() { return G().status === 'open'; }
  function isTravel() { return G().kind === 'travel'; }

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
  function myMember() { return S.view.me ? member(S.view.me) : null; }

  /* Avatars in one split: each member's colour, worked out once per view.
     An app user keeps their own colour (keyed by user, as in Settings); when
     two members would wear the same letters on the same colour, the later
     one takes the next free colour, so no two faces in a split look alike. */
  var _avView = null, _av = {};
  function avatarInfo(id) {
    if (_avView !== S.view) {
      _avView = S.view;
      _av = {};
      var taken = {};
      S.view.members.forEach(function (m) {
        var ini = initials(m.name).toLowerCase();
        var c = avatarColor(m.user_id ? 'u' + m.user_id : 'm' + m.id);
        var used = taken[ini] || (taken[ini] = {});
        for (var i = 0; i < AVATAR_COLORS && used[c]; i++) c = (c + 1) % AVATAR_COLORS;
        used[c] = true;
        _av[m.id] = { name: m.name, url: m.avatar || null, color: c };
      });
    }
    return _av[id] || { name: '?', url: null, color: 0 };
  }
  /* A member's avatar. size: 'sm' | 'lg'; label when no name stands beside it. */
  function avatar(id, size, label) {
    var a = avatarInfo(id);
    return avatarHtml({ name: a.name, url: a.url, color: a.color, size: size, label: label ? nameOf(id) : '' });
  }
  /* Avatar and name, for a list row or a sentence. */
  function who(id, size) {
    return '<span class="who-av">' + avatar(id, size) + '<span>' + esc(nameOf(id)) + '</span></span>';
  }
  /* The name a picker chip shows: the first word, unless another member of
     the split starts with the same word ("Jack Mo" and "Jack Li" stay whole). */
  function shortName(id) {
    var m = member(id);
    if (!m) return '?';
    var first = m.name.trim().split(/\s+/)[0];
    var key = first.toLowerCase();
    var clash = S.view.members.some(function (o) { return o.id !== id && o.name.trim().split(/\s+/)[0].toLowerCase() === key; });
    return clash ? m.name : first;
  }

  S.member = member;
  S.nameOf = nameOf;
  S.avatar = avatar;
  S.who = who;
  S.shortName = shortName;
  S.isTravel = isTravel;
  S.isOpen = isOpen;

  S.canAddBill = function () {
    var me = myMember();
    if (S.offline || !isOpen() || !me || !me.active) return false;
    return isTravel() || (S.view.is_owner && !S.view.bills.length);
  };
  /* The server's rule (actions.ts _canEditBill): a one-off is its owner's; on
     a trip, whoever paid and whoever wrote it; the owner only for a payer
     without an account. */
  S.canEditBill = function (b) {
    if (S.offline || !isOpen()) return false;
    if (!isTravel()) return S.view.is_owner;
    if (b.created_by === S.me.user_id) return true;
    var payer = member(b.payer);
    var pu = payer ? payer.user_id : null;
    return pu === S.me.user_id || (pu === null && S.view.is_owner);
  };
  /* Someone with an account paid: only they move who paid. */
  S.payerLocked = function (b) {
    if (!b || !isTravel()) return false;
    var payer = member(b.payer);
    return !!(payer && payer.user_id && payer.user_id !== S.me.user_id);
  };
  /* How far a custom rate sits from the market it was set against, as a
     signed percent ("+6.3%"), or null when it is close (under 3%) or there is
     no market figure. Display only: no money is computed from it. */
  S.marketGap = function (r) {
    if (!r || r.source !== 'manual' || !r.market) return null;
    var v = Number(r.rate), m = Number(r.market);
    if (!(v > 0) || !(m > 0)) return null;
    var per = r.inverted ? 1 / v : v; // settlement units per foreign unit, as the market is kept
    var gap = per / m - 1;
    if (Math.abs(gap) < 0.03) return null;
    return (gap > 0 ? '+' : '-') + (Math.abs(gap) * 100).toFixed(1) + '%';
  };
  S.marketChip = function (r) {
    var gap = S.marketGap(r);
    if (!gap) return '';
    // Big side first, as the rate itself reads (S.rateText).
    var m = Number(r.market);
    var big = m >= 1 ? m : 1 / m;
    var txt = fmtRate(big >= 1000 ? big.toFixed(0) : big.toFixed(2).replace(/\.?0+$/, ''));
    var tip = t('rate.market_tip', m >= 1 ? '1 ' + r.currency + ' = ' + txt + ' ' + G().currency : '1 ' + G().currency + ' = ' + txt + ' ' + r.currency);
    return ' <span class="chip chip-warn" tabindex="0" data-tip="' + esc(tip) + '">' + esc(t('rate.off_market', gap)) + '</span>';
  };

  // ── activity: who changed what (GET activity) ──
  function when(iso) {
    var d = new Date(iso);
    var time = '';
    try { time = d.toLocaleTimeString(window.__LANG__ === 'id' ? 'id-ID' : 'en-GB', { hour: '2-digit', minute: '2-digit' }); } catch (e) {}
    return fmtDate(iso) + (time ? ' ' + time : '');
  }
  function receiptLink(id, key) {
    return '<a href="' + esc(S.receiptUrl(id)) + '" target="_blank" rel="noopener">' + esc(t(key)) + '</a>';
  }
  function changeLine(c) {
    var name = function (id) { return id ? nameOf(id) : '-'; };
    var dp = function (ccy) { return window.SBEngine.minorUnits(ccy); };
    if (c.field === 'total') return esc(t('act.ch.total', money(c.from, c.from_currency, dp(c.from_currency)), money(c.to, c.currency, dp(c.currency))));
    if (c.field === 'payer') return esc(t('act.ch.payer', name(c.from), name(c.to)));
    if (c.field === 'description') return esc(t('act.ch.description', c.from || '-', c.to || '-'));
    if (c.field === 'date') return esc(t('act.ch.date', fmtDate(c.from), fmtDate(c.to)));
    if (c.field === 'split') return esc(t('act.ch.split'));
    if (c.field === 'receipt') {
      if (!c.to) return receiptLink(c.from, 'act.ch.receipt_removed');
      return receiptLink(c.to, c.from ? 'act.ch.receipt_replaced' : 'act.ch.receipt_added');
    }
    return '';
  }
  function sentence(r) {
    var by = r.by ? nameOf(r.by) : r.by_name || t(r.kind === 'group.admin_transfer_owner' ? 'act.admin' : 'act.someone');
    var name = function (id) { return id ? nameOf(id) : '-'; };
    var key = 'act.' + r.kind;
    if (t(key) === key) return t('act.other', by);
    if (/^(payment|transfer)\./.test(r.kind)) return t(key, by, name(r.from), name(r.to));
    if (r.kind === 'member.rename') return t(key, by, r.from || '-', r.to || '-');
    if (r.kind === 'rate.set' && r.rate) return t(key, by, S.rateText(r.rate));
    return t(key, by, r.subject || '-');
  }
  /* Table rows, one per logged change: the sentence, when, what moved; the
     money it concerns on the right. */
  S.activityRows = function (rows) {
    return rows.map(function (r) {
      var lines = (r.changes || []).map(changeLine).filter(Boolean);
      if (r.kind === 'bill.create' && r.receipt) lines.push(receiptLink(r.receipt, 'act.ch.receipt_added'));
      var chip = r.kind === 'rate.set' && r.rate ? S.marketChip(r.rate) : '';
      return '<tr><td>' + esc(sentence(r)) + chip +
        lines.map(function (l) { return '<div class="tool-sub">' + l + '</div>'; }).join('') +
        '<div class="tool-sub">' + esc(when(r.at)) + '</div></td>' +
        '<td class="num">' + (r.money ? moneyHtml(r.money.amount, r.money.currency, r.money.dp) : '') + '</td></tr>';
    }).join('');
  };

  /* A kept photo, through the members-only route. */
  S.receiptUrl = function (id) {
    return '/app/api/receipt?group_id=' + encodeURIComponent(S.gid) + '&id=' + encodeURIComponent(id);
  };
  /* The scan read another total than the bill now says ("Receipt read ..."). */
  S.scanDiff = function (b) {
    var sc = b && b.scan;
    return !!(sc && (sc.total !== String(b.total) || sc.currency !== b.currency));
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

  function fmtRate(text) {
    var parts = String(text).split('.');
    var id = window.__LANG__ === 'id';
    return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, id ? '.' : ',') + (parts[1] ? (id ? ',' : '.') + parts[1] : '');
  }
  /* Big side first, meaningful decimals: inverted means 1 settlement unit = rate foreign. */
  S.rateText = function (r) {
    var d = window.SBEngine.displayRate(r.rate, r.inverted);
    return d.inverted
      ? '1 ' + G().currency + ' = ' + fmtRate(d.text) + ' ' + r.currency
      : '1 ' + r.currency + ' = ' + fmtRate(d.text) + ' ' + G().currency;
  };

  /* This browser keeps each split's last view (boot.js cache, same key as the
     split page's boot), so the next open draws at once. Live views only:
     never a draft, a cached paint or an offline copy. */
  function keep(view) {
    if (!window.sbCachePut || !view || !view.group.group_id) return;
    window.sbCachePut('group&id=' + view.group.group_id, { me: S.me, group: view, ai: S.ai });
  }
  S.cachedView = function (gid) {
    var d = window.sbCacheGet ? window.sbCacheGet('group&id=' + gid) : null;
    return d && d.group ? d.group : null;
  };

  /* Take a view: from the page's boot payload, or a load. stale: a kept copy
     drawn before the live one arrives (nothing is fetched or written on it). */
  S.setView = function (view, me, offline, stale) {
    S.view = view;
    S.gid = view.group.group_id || S.gid;
    if (me) S.me = me;
    S.offline = !!offline;
    S.stale = !!stale;
    if (!offline && !stale && !S.draft) keep(view);
    if (S.onView) S.onView();
    if (S.onEditorView) S.onEditorView();
  };

  /* Fetch one split's view. Resolves to the api answer. */
  S.load = function (gid) {
    S.gid = gid;
    return api('group?id=' + encodeURIComponent(gid)).then(function (r) {
      if (r.ok && S.gid === gid) S.setView(r.data, null, false);
      return r;
    });
  };

  /* Warm a split's view without showing it (home, before a tap). One request
     per split at a time; resolves to the view or null. */
  var _warming = {};
  S.prefetch = function (gid) {
    if (!_warming[gid]) {
      _warming[gid] = api('group?id=' + encodeURIComponent(gid)).then(function (r) {
        delete _warming[gid];
        if (!r.ok) return null;
        keep(r.data);
        return r.data;
      });
    }
    return _warming[gid];
  };

  /* Show a split now: its kept view at once when there is one, then the live
     one. Resolves to the api answer once live (so callers can check rights). */
  S.open = function (gid) {
    if (S.draft) S.discardEmpty();
    S.gid = gid;
    var kept = S.cachedView(gid);
    if (kept) S.setView(kept, null, false, true);
    return S.prefetch(gid).then(function (view) {
      if (S.gid !== gid) return { ok: false, code: 'generic', params: {} };
      if (!view) return api('group?id=' + encodeURIComponent(gid));
      S.setView(view, null, false);
      return { ok: true, data: view };
    });
  };

  S.reload = function () {
    return S.load(S.gid).then(function (r) {
      if (!r.ok) showToast(errMsg(r.code, r.params), 'error');
    });
  };

  /* A write's answer carries the group's new view: take it instead of a
     second request. Resolves true when it did. */
  S.takeView = function (r) {
    if (!r.ok || !r.view || r.view.group.group_id !== S.gid) return false;
    S.setView(r.view, null, false);
    return true;
  };

  /* A one-off drawn before it exists, so its bill opens with no wait. The
     split is created at the same moment; every write waits for it (S.ready)
     and then runs on the real split. Its one member (the viewer) carries a
     placeholder id until then; S.onReal(map) swaps it for the real one. */
  var DRAFT_ME = '0';
  S.startOneOff = function (me, name, currency) {
    var view = {
      group: {
        group_id: '', kind: 'one_off', name: name, currency: currency, dp: window.SBEngine.minorUnits(currency),
        status: 'open', owner: me.user_id, timezone: me.timezone, round: 1, revision: '0', invite_code: null,
        settled_at: null, created_at: new Date().toISOString(),
      },
      stage: 'open', me: DRAFT_ME, is_owner: true,
      members: [{ id: DRAFT_ME, name: me.display_name, user_id: me.user_id, username: me.username, avatar: me.avatar || null, position: 1, active: true }],
      bills: [], payments: [], rates: [], balances: [], transfers: [],
      spent: '0', complete: true, missing: [], optimal: true,
    };
    S.gid = '';
    S.draft = api('groups', { body: { kind: 'one_off', name: name, currency: currency, members: [], view: true } }).then(function (r) {
      if (S.draft !== pending) return r.ok ? { ok: true, gone: true, gid: r.data.group_id } : r;
      if (!r.ok) { S.draft = null; return r; }
      var gid = r.data.group_id;
      return (r.view ? Promise.resolve({ ok: true, data: r.view }) : api('group?id=' + encodeURIComponent(gid))).then(function (g) {
        S.draft = null;
        if (!g.ok) return g;
        S.gid = gid;
        var map = {};
        map[DRAFT_ME] = g.data.me;
        S.setView(g.data, null, false);
        if (S.onReal) S.onReal(map);
        return { ok: true };
      });
    });
    var pending = S.draft;
    S.setView(view, me, false, false);
    return pending;
  };
  /* Resolves once the split being edited exists on the server: true, or
     false (its error toasted) when it could not be created. */
  S.ready = function () {
    if (!S.draft) return Promise.resolve(true);
    return S.draft.then(function (r) {
      if (r.ok) return true;
      showToast(errMsg(r.code, r.params), 'error');
      return false;
    });
  };

  /* A write answer's home-list row keeps home's kept list current, so going
     back draws the new figures at once. */
  function keepRow(row) {
    if (!row || !window.sbCachePut) return;
    window.sbCachePut('home', function (d) {
      if (!d || !d.groups) return null;
      return Object.assign({}, d, { groups: d.groups.filter(function (g) { return g.group_id !== row.group_id; }).concat([row]) });
    });
  }
  /* A deleted split leaves home's kept list (and its own kept view). */
  S.forget = function (gid) {
    if (!window.sbCachePut) return;
    window.sbCachePut('home', function (d) {
      if (!d || !d.groups) return null;
      return Object.assign({}, d, { groups: d.groups.filter(function (g) { return g.group_id !== gid; }) });
    });
    try { localStorage.removeItem('sb_boot:group&id=' + gid); } catch (e) {}
  };

  /* Run a write, toast its error, redraw from its view (else reload) on success. */
  S.act = function (path, body, okMsg, btn) {
    if (btn) setBusy(btn, true);
    return S.ready().then(function (ready) {
      if (!ready) {
        if (btn) setBusy(btn, false);
        return { ok: false, code: 'generic', params: {} };
      }
      return api(path, { body: Object.assign({ group_id: S.gid }, body) }).then(function (r) {
        if (btn) setBusy(btn, false);
        if (!r.ok) {
          showToast(errMsg(r.code, r.params), 'error');
          if (r.status === 409) S.reload();
          return r;
        }
        if (okMsg) showToast(okMsg);
        keepRow(r.row);
        var fresh = S.takeView(r);
        return (S.afterWrite ? S.afterWrite(path, fresh, r) : fresh ? Promise.resolve() : S.reload()).then(function () { return r; });
      });
    });
  };

  /* A one-off is its bill. Left without one (closed before saving, or its
     bill deleted), it is gone too: nothing was split. A draft closed before
     it was even created is deleted once it is. */
  S.discardEmpty = function () {
    var draft = S.draft;
    if (draft) {
      S.draft = null;
      draft.then(function (r) {
        if (r.ok && r.gone) api('group/delete', { body: { group_id: r.gid } });
      });
      return;
    }
    var v = S.view;
    if (!v || !S.gid || isTravel() || !isOpen() || !v.is_owner || S.offline || v.bills.length || v.payments.length) return;
    var gid = S.gid;
    S.forget(gid);
    api('group/delete', { body: { group_id: gid } }).then(function () { if (S.onDiscarded) S.onDiscarded(); });
  };
}());
