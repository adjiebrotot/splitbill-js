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
 */
(function () {
  var S = { view: null, me: null, offline: false, ai: true, gid: '', onView: null, afterWrite: null, onDiscarded: null };
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

  /* Take a view: from the page's boot payload, or a load. */
  S.setView = function (view, me, offline) {
    S.view = view;
    S.gid = view.group.group_id || S.gid;
    if (me) S.me = me;
    S.offline = !!offline;
    if (S.onView) S.onView();
  };

  /* Fetch one split's view. Resolves to the api answer. */
  S.load = function (gid) {
    S.gid = gid;
    return api('group?id=' + encodeURIComponent(gid)).then(function (r) {
      if (r.ok && S.gid === gid) S.setView(r.data, null, false);
      return r;
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

  /* Run a write, toast its error, redraw from its view (else reload) on success. */
  S.act = function (path, body, okMsg, btn) {
    if (btn) setBusy(btn, true);
    return api(path, { body: Object.assign({ group_id: S.gid }, body) }).then(function (r) {
      if (btn) setBusy(btn, false);
      if (!r.ok) {
        showToast(errMsg(r.code, r.params), 'error');
        if (r.status === 409) S.reload();
        return r;
      }
      if (okMsg) showToast(okMsg);
      var fresh = S.takeView(r);
      return (S.afterWrite ? S.afterWrite(path, fresh, r) : fresh ? Promise.resolve() : S.reload()).then(function () { return r; });
    });
  };

  /* A one-off is its bill. Left without one (closed before saving, or its
     bill deleted), it is gone too: nothing was split. */
  S.discardEmpty = function () {
    var v = S.view;
    if (!v || isTravel() || !isOpen() || !v.is_owner || S.offline || v.bills.length || v.payments.length) return;
    api('group/delete', { body: { group_id: S.gid } }).then(function () { if (S.onDiscarded) S.onDiscarded(); });
  };
}());
