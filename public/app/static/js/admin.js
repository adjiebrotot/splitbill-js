/* admin.js: the admin console at /admin. English only, by decision: the page
 * is for the operator, so its labels are plain strings, not i18n keys. Error
 * codes still read through errMsg() (the English bundle; boot.js forces "en"
 * on this page).
 *
 * Three tabs, in the hash: #users, #db, #system. Every call goes to
 * /app/api/admin/*, which checks the admin session itself; a 401 brings the
 * sign-in card back. Nothing here decides anything the server does not check.
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var TABS = ['users', 'db', 'system'];
  var loaded = {};
  var users = { q: '', page: 1, list: [] };
  var db = { table: '', page: 1, perPage: 50 };
  var editing = null;
  var deleting = null;

  // ── plumbing ──

  function call(path, opts) {
    opts = opts || {};
    opts.allow401 = true;
    return api('admin/' + path, opts).then(function (r) {
      if (r.status === 401 && r.code === 'admin_login_required') showLogin();
      return r;
    });
  }

  function fail(r) {
    showToast(errMsg(r.code, r.params), 'error');
  }

  function dateOnly(iso) {
    return iso ? String(iso).slice(0, 10) : '-';
  }

  function stamp(iso) {
    return iso ? String(iso).slice(0, 16).replace('T', ' ') : '-';
  }

  function chip(text, kind) {
    return '<span class="chip' + (kind ? ' chip-' + kind : '') + '">' + esc(text) + '</span>';
  }

  function show(id, on) {
    $(id).hidden = !on;
  }

  function pager(el, d, go) {
    if (d.pages <= 1) { el.hidden = true; el.innerHTML = ''; return; }
    var from = (d.page - 1) * d.per_page + 1;
    var to = Math.min(d.total, d.page * d.per_page);
    el.hidden = false;
    el.innerHTML =
      '<div class="tool-pagination-top"><span class="tool-page-info">' + from + '-' + to + ' of ' + d.total + '</span></div>' +
      '<div class="tool-page-btns">' +
        '<button type="button" class="btn btn-ghost btn-compact" data-go="' + (d.page - 1) + '"' + (d.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
        '<span class="tool-page-num">Page ' + d.page + ' of ' + d.pages + '</span>' +
        '<button type="button" class="btn btn-ghost btn-compact" data-go="' + (d.page + 1) + '"' + (d.page >= d.pages ? ' disabled' : '') + '>Next</button>' +
      '</div>';
    el.onclick = function (ev) {
      var b = ev.target.closest('[data-go]');
      if (b && !b.disabled) go(Number(b.getAttribute('data-go')));
    };
  }

  // ── session & tabs ──

  function showLogin(message) {
    TABS.forEach(function (t) { show('view-' + t, false); });
    show('admin-nav', false);
    show('admin-tabs', false);
    show('admin-signout', false);
    show('view-login', true);
    loaded = {};
    var e = $('login-error');
    e.hidden = !message;
    e.textContent = message || '';
    $('admin-password').focus();
  }

  function currentTab() {
    var h = (location.hash || '').replace('#', '');
    return TABS.indexOf(h) >= 0 ? h : 'users';
  }

  function showTab() {
    var tab = currentTab();
    show('view-login', false);
    show('admin-nav', true);
    show('admin-tabs', true);
    show('admin-signout', true);
    TABS.forEach(function (t) { show('view-' + t, t === tab); });
    document.querySelectorAll('[data-tab]').forEach(function (a) {
      var on = a.getAttribute('data-tab') === tab;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (loaded[tab]) return;
    loaded[tab] = true;
    if (tab === 'users') loadUsers();
    if (tab === 'db') loadTables();
    if (tab === 'system') loadSystem();
  }

  window.addEventListener('hashchange', function () {
    if ($('view-login').hidden) showTab();
  });

  $('login-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var btn = $('login-btn');
    setBusy(btn, true);
    call('login', { body: { password: $('admin-password').value } }).then(function (r) {
      setBusy(btn, false);
      if (!r.ok) {
        $('login-error').hidden = false;
        $('login-error').textContent = errMsg(r.code, r.params);
        return;
      }
      $('admin-password').value = '';
      showTab();
    });
  });

  $('admin-signout').addEventListener('click', function () {
    call('logout', { body: {} }).then(function () { showLogin(); });
  });

  // ── users ──

  function loadUsers() {
    call('users?q=' + encodeURIComponent(users.q) + '&page=' + users.page).then(function (r) {
      if (!r.ok) return fail(r);
      var d = r.data;
      users.page = d.page;
      users.list = d.users;
      $('users-count').textContent = d.total === 1 ? '1 User' : d.total + ' Users';
      if (!d.users.length) {
        setTableEmpty($('users-wrap'), users.q ? 'No users match.' : 'No users yet.');
      } else {
        setTableEmpty($('users-wrap'), '');
        $('users-body').innerHTML = d.users.map(userRow).join('');
      }
      pager($('users-pager'), d, function (p) { users.page = p; loadUsers(); });
    });
  }

  function userRow(u) {
    var email = u.email
      ? esc(u.email) + ' ' + (u.email_verified ? chip('Verified', 'settled') : chip('Unverified', 'open'))
      : '<span class="muted">-</span>';
    return '<tr>' +
      '<td><strong>' + esc(u.display_name) + '</strong><div class="tool-sub">@' + esc(u.username) + ' · #' + esc(u.user_id) +
        (u.has_password ? '' : ' · Google only') + '</div></td>' +
      '<td>' + email + '</td>' +
      '<td class="mid">' + (u.telegram_id ? chip('Linked', 'settled') : '<span class="muted">-</span>') + '</td>' +
      '<td class="num nowrap">' + u.groups + (u.owned ? ' <span class="muted">(' + u.owned + ' own)</span>' : '') + '</td>' +
      '<td class="nowrap">' + dateOnly(u.created_at) + '</td>' +
      '<td class="act"><div class="tool-row-actions">' +
        '<button type="button" class="btn btn-ghost btn-compact btn-icon" data-edit="' + esc(u.user_id) + '" aria-label="Edit" title="Edit">' + icon('pencil') + '</button>' +
        '<button type="button" class="btn btn-ghost btn-compact btn-icon" data-reset="' + esc(u.user_id) + '" aria-label="Reset password" title="Reset password">' + icon('lock') + '</button>' +
        '<button type="button" class="btn btn-danger btn-compact btn-icon" data-del="' + esc(u.user_id) + '" aria-label="Delete" title="Delete">' + icon('trash') + '</button>' +
      '</div></td>' +
    '</tr>';
  }

  function findUser(id) {
    for (var i = 0; i < users.list.length; i++) if (users.list[i].user_id === id) return users.list[i];
    return null;
  }

  $('users-body').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-edit')) openEdit(b.getAttribute('data-edit'), b);
    if (b.hasAttribute('data-reset')) resetPassword(findUser(b.getAttribute('data-reset')));
    if (b.hasAttribute('data-del')) openDelete(b.getAttribute('data-del'), b);
  });

  var searchTimer = null;
  $('user-q').addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      users.q = $('user-q').value.trim();
      users.page = 1;
      loadUsers();
    }, 300);
  });

  function fillZones() {
    if ($('tz-list').options.length) return;
    try {
      var zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [];
      $('tz-list').innerHTML = zones.map(function (z) { return '<option value="' + esc(z) + '">'; }).join('');
    } catch (e) {}
  }

  function fillForm(u) {
    fillZones();
    $('u-username').value = u ? u.username : '';
    $('u-name').value = u ? u.display_name : '';
    $('u-email').value = u && u.email ? u.email : '';
    $('u-verified').checked = u ? u.email_verified : true;
    $('u-password').value = '';
    $('u-lang').value = u ? u.language : 'en';
    fillCurrencySelect($('u-currency'), u ? u.default_currency : 'IDR');
    $('u-tz').value = u ? u.timezone : '';
    show('u-username-field', !u);
    show('u-password-field', !u);
    show('u-tg-field', !!(u && u.telegram_id));
    $('u-tg').value = u && u.telegram_id ? 'Telegram id ' + u.telegram_id : '';
  }

  $('btn-add-user').addEventListener('click', function () {
    editing = null;
    $('user-title').textContent = 'Add User';
    fillForm(null);
    show('u-groups', false);
    show('u-groups-title', false);
    openModal('modal-user', { initialFocus: '#u-username' });
  });

  function openEdit(id, btn) {
    setBusy(btn, true);
    call('user?id=' + encodeURIComponent(id)).then(function (r) {
      setBusy(btn, false);
      if (!r.ok) return fail(r);
      editing = r.data.user;
      $('user-title').textContent = 'Edit @' + editing.username;
      fillForm(editing);
      var gs = r.data.groups;
      show('u-groups', gs.length > 0);
      show('u-groups-title', gs.length > 0);
      $('u-groups-body').innerHTML = gs.map(function (g) {
        var st = g.deleted ? chip('Deleted', 'muted') : g.status === 'settled' ? chip('Settled', 'settled') : chip('Open', 'open');
        return '<tr><td>' + esc(g.name) + '<div class="tool-sub">' + esc(g.group_id) + (g.owner ? ' · owner' : '') + '</div></td>' +
          '<td>' + esc(g.member_name) + (g.active ? '' : ' <span class="muted">(inactive)</span>') + '</td>' +
          '<td class="mid">' + st + '</td></tr>';
      }).join('');
      openModal('modal-user', { initialFocus: '#u-name' });
    });
  }

  $('user-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var btn = $('user-save');
    var body = {
      display_name: $('u-name').value,
      email: $('u-email').value,
      email_verified: $('u-verified').checked,
      language: $('u-lang').value,
      default_currency: $('u-currency').value,
    };
    var tz = $('u-tz').value.trim();
    if (tz || editing) body.timezone = tz;
    var path = 'user/update';
    if (editing) body.user_id = editing.user_id;
    else {
      path = 'user/create';
      body.username = $('u-username').value.trim();
      body.password = $('u-password').value;
    }
    setBusy(btn, true);
    call(path, { body: body }).then(function (r) {
      setBusy(btn, false);
      if (!r.ok) return fail(r);
      closeModal('modal-user');
      loadUsers();
      if (!editing && r.data.password) {
        showPassword(r.data.user, r.data.password, null);
      } else {
        showToast(editing ? 'Saved.' : 'User added.');
      }
    });
  });

  $('u-tg-unlink').addEventListener('click', function () {
    if (!editing) return;
    var u = editing;
    confirmDialog('Unlink Telegram from @' + u.username + '? The bot stops recognising them until they connect again.', { okLabel: 'Unlink', danger: true }).then(function (yes) {
      if (!yes) return;
      call('user/unlink-telegram', { body: { user_id: u.user_id } }).then(function (r) {
        if (!r.ok) return fail(r);
        editing = r.data;
        show('u-tg-field', false);
        loadUsers();
        showToast('Telegram unlinked.');
      });
    });
  });

  function showPassword(u, password, telegram) {
    $('pw-desc').textContent = 'New password for @' + u.username + '. Shown once: copy it now. Their old password no longer works.';
    $('pw-value').value = password;
    var tg = $('pw-tg');
    tg.hidden = !telegram || telegram === 'not_linked';
    tg.className = 'banner' + (telegram === 'failed' ? ' warn' : '');
    tg.textContent = telegram === 'sent' ? 'Also sent to their Telegram.' : telegram === 'failed' ? 'Could not send it to their Telegram. Pass it on yourself.' : '';
    openModal('modal-pw', { initialFocus: '#pw-copy' });
  }

  $('pw-copy').addEventListener('click', function () {
    var v = $('pw-value').value;
    (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(function () {
      showToast('Copied.');
    }, function () {
      $('pw-value').select();
    });
  });

  function resetPassword(u) {
    if (!u) return;
    var msg = 'Reset the password for @' + u.username + '? Their current password stops working at once.' +
      (u.telegram_id ? ' The new one is also sent to their Telegram.' : '');
    confirmDialog(msg, { okLabel: 'Reset Password', danger: true }).then(function (yes) {
      if (!yes) return;
      call('user/reset-password', { body: { user_id: u.user_id } }).then(function (r) {
        if (!r.ok) return fail(r);
        showPassword(u, r.data.password, r.data.telegram);
      });
    });
  }

  function openDelete(id, btn) {
    setBusy(btn, true);
    call('user?id=' + encodeURIComponent(id)).then(function (r) {
      setBusy(btn, false);
      if (!r.ok) return fail(r);
      deleting = r.data.user;
      var plan = r.data.handover;
      var memberOf = r.data.groups.length;
      $('del-desc').textContent = 'Deletes @' + deleting.username + ' (' + deleting.display_name + '). ' +
        (memberOf ? 'In ' + memberOf + (memberOf === 1 ? ' split' : ' splits') + ' they stay as a name without an account; no amount changes.' : 'They are in no split.');
      var blocked = plan.filter(function (g) { return !g.to; });
      show('del-blocked', blocked.length > 0);
      $('del-blocked').textContent = blocked.length
        ? 'Nobody can take over: ' + blocked.map(function (g) { return g.name; }).join(', ') + '. Another member must join with an account first.'
        : '';
      show('del-plan-wrap', plan.length > 0);
      $('del-plan-body').innerHTML = plan.map(function (g) {
        return '<tr><td>' + esc(g.name) + (g.deleted ? ' <span class="muted">(deleted)</span>' : '') + '</td>' +
          '<td>' + (g.to ? esc(g.to.name) : '<span class="neg">Nobody</span>') + '</td></tr>';
      }).join('');
      $('del-confirm').placeholder = deleting.username;
      $('del-confirm').value = '';
      $('del-go').disabled = blocked.length > 0;
      openModal('modal-del', { initialFocus: '#del-confirm' });
    });
  }

  $('del-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (!deleting) return;
    var u = deleting;
    var typed = $('del-confirm').value.trim();
    if (typed.toLowerCase() !== u.username.toLowerCase()) {
      showToast(errMsg('admin_confirm_mismatch'), 'error');
      return;
    }
    confirmDialog('Delete @' + u.username + ' for good? This cannot be undone.', { okLabel: 'Delete', danger: true }).then(function (yes) {
      if (!yes) return;
      var btn = $('del-go');
      setBusy(btn, true);
      call('user/delete', { body: { user_id: u.user_id, confirm: typed } }).then(function (r) {
        setBusy(btn, false);
        if (!r.ok) return fail(r);
        closeModal('modal-del');
        deleting = null;
        loadUsers();
        showToast('@' + r.data.deleted + ' deleted.');
      });
    });
  });

  // ── database ──

  function loadTables() {
    call('db/tables').then(function (r) {
      if (!r.ok) return fail(r);
      var sel = $('db-table');
      sel.innerHTML = '<option value="">All tables</option>' + r.data.map(function (x) {
        return '<option value="' + esc(x.table) + '">' + esc(x.table) + '</option>';
      }).join('');
      sel.value = db.table;
      $('db-index-body').innerHTML = r.data.map(function (x) {
        return '<tr class="row-link" data-table="' + esc(x.table) + '"><td>' + esc(x.table) + '</td><td class="num">' + x.rows + '</td></tr>';
      }).join('');
    });
  }

  function pickTable(name) {
    db.table = name;
    db.page = 1;
    $('db-table').value = name;
    show('db-index-card', !name);
    show('db-rows-card', !!name);
    if (name) loadRows(); else loadTables();
  }

  $('db-table').addEventListener('change', function () { pickTable(this.value); });
  $('db-index-body').addEventListener('click', function (ev) {
    var tr = ev.target.closest('[data-table]');
    if (tr) pickTable(tr.getAttribute('data-table'));
  });
  $('db-refresh').addEventListener('click', function () { loadRows(); });

  function loadRows() {
    call('db/rows?table=' + encodeURIComponent(db.table) + '&page=' + db.page + '&per_page=' + db.perPage).then(function (r) {
      if (!r.ok) return fail(r);
      var d = r.data;
      db.page = d.page;
      $('db-rows-title').textContent = d.table + ' (' + d.total + ')';
      $('db-rows-head').innerHTML = '<tr>' + d.columns.map(function (c) {
        return '<th>' + esc(c) + (d.pk.indexOf(c) >= 0 ? ' <span class="muted">PK</span>' : '') + '</th>';
      }).join('') + '</tr>';
      if (!d.rows.length) {
        setTableEmpty($('db-rows-wrap'), 'No rows.');
      } else {
        setTableEmpty($('db-rows-wrap'), '');
        $('db-rows-body').innerHTML = d.rows.map(function (row) {
          return '<tr>' + row.map(function (v, i) {
            if (v === null) return '<td class="muted">NULL</td>';
            if (d.masked.indexOf(d.columns[i]) >= 0) return '<td class="muted">' + esc(v) + '</td>';
            return '<td class="clip mono" title="' + esc(v) + '">' + esc(v) + '</td>';
          }).join('') + '</tr>';
        }).join('');
      }
      pager($('db-pager'), d, function (p) { db.page = p; loadRows(); });
    });
  }

  // ── system ──

  function renderMigrations(list) {
    var pending = list.filter(function (m) { return !m.applied_at; }).length;
    $('btn-migrate').disabled = pending === 0;
    $('btn-migrate').textContent = pending ? 'Apply ' + pending + ' Pending' : 'Up to Date';
    $('mig-body').innerHTML = list.map(function (m) {
      return '<tr><td class="mono">' + esc(m.name) + '</td><td>' + (m.applied_at ? esc(stamp(m.applied_at)) : chip('Pending', 'open')) + '</td></tr>';
    }).join('');
  }

  function loadSystem() {
    call('system').then(function (r) {
      if (!r.ok) return fail(r);
      renderMigrations(r.data.migrations);
      $('env-body').innerHTML = r.data.env.map(function (e) {
        return '<tr><td class="mono">' + esc(e.name) + '</td><td class="mid">' + (e.set ? chip('Yes', 'settled') : chip('No', 'muted')) + '</td></tr>';
      }).join('');
    });
  }

  function output(text) {
    var o = $('sys-output');
    o.hidden = false;
    o.value = text;
  }

  function runSystem(btn, path, confirmText, okLabel, format) {
    var go = function () {
      setBusy(btn, true);
      call(path, { body: {} }).then(function (r) {
        setBusy(btn, false);
        if (!r.ok) { fail(r); output(errMsg(r.code, r.params)); return; }
        output(format(r.data));
      });
    };
    if (!confirmText) return go();
    confirmDialog(confirmText, { okLabel: okLabel, danger: false }).then(function (yes) { if (yes) go(); });
  }

  $('btn-migrate').addEventListener('click', function () {
    var btn = this;
    confirmDialog('Apply the pending migrations to the live database now? Each runs in its own transaction.', { okLabel: 'Apply', danger: false }).then(function (yes) {
      if (!yes) return;
      setBusy(btn, true);
      call('system/migrate', { body: {} }).then(function (r) {
        setBusy(btn, false);
        if (!r.ok) { fail(r); output(errMsg(r.code, r.params)); loadSystem(); return; }
        renderMigrations(r.data.migrations);
        output(r.data.applied.length ? 'Applied:\n' + r.data.applied.join('\n') : 'Nothing to apply.');
        showToast(r.data.applied.length ? 'Migrations applied.' : 'Already up to date.');
      });
    });
  });

  $('btn-integrity').addEventListener('click', function () {
    runSystem(this, 'system/integrity', null, null, function (d) {
      if (!d.problems.length) return 'Checked ' + d.checked + ' splits. Every book balances.';
      return 'Checked ' + d.checked + ' splits. ' + d.problems.length + ' problem(s):\n\n' + d.problems.map(function (p) {
        return p.group_id + '  ' + p.name + ' [' + p.status + ']\n  ' + p.issue;
      }).join('\n');
    });
  });

  $('btn-cleanup').addEventListener('click', function () {
    runSystem(this, 'system/cleanup', 'Run the daily cleanup now? It deletes expired drafts, link codes, old Telegram updates and old AI usage rows.', 'Run Cleanup', function (d) {
      return 'Deleted rows:\n' + Object.keys(d).map(function (k) { return '  ' + k + ': ' + d[k]; }).join('\n');
    });
  });

  $('btn-telegram').addEventListener('click', function () {
    runSystem(this, 'system/telegram', 'Register the Telegram webhook and command menus? Pending updates Telegram holds are dropped.', 'Register', function (d) {
      return JSON.stringify(d, null, 2);
    });
  });

  // ── start ──

  call('session').then(function (r) {
    if (!r.ok) return showLogin(errMsg(r.code, r.params));
    if (!r.data.configured) {
      showLogin(errMsg('admin_unconfigured'));
      $('login-btn').disabled = true;
      return;
    }
    if (r.data.signed_in) showTab(); else showLogin();
  });
}());
