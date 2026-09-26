/* sb.js: one split held in the browser, for every page that edits it.
 * window.SB carries the view the server computed (GET group), the viewer's
 * permissions and the write helper. The group page renders it; home opens
 * the bill editor (bill.js) on it without leaving the page.
 *
 *   S.onView()           called after every (re)load, to redraw the page
 *   S.afterWrite(path)   optional: replaces the reload after a write
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

  S.member = member;
  S.nameOf = nameOf;
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

  /* Run a write, toast its error, reload on success. */
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
      return (S.afterWrite ? S.afterWrite(path) : S.reload()).then(function () { return r; });
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
