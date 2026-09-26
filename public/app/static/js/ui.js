/* ui.js: shared UI primitives for every Split Bill page.
 *
 * Dialogs (confirmDialog, openModal/closeModal), setTableEmpty and the global
 * tooltip are inherited from finance-tracker-js ui.js unchanged in behaviour.
 * Split Bill adds, ONCE, the helpers finance-tracker copied per page: esc(),
 * showToast(), api(), errMsg(), icon(), money formatting.
 *
 * Depends on t() from i18n.js and on window.SBEngine (engine.js) for money.
 */
(function () {
  /* ── Shared dialog stack ───────────────────────────────────────────────
     Every open dialog pushes a closer. Esc and backdrop clicks act on the
     topmost only, and the page scroll lock is released by depth, not by
     whichever dialog happens to close first — otherwise cancelling a confirm
     raised from inside a modal would unlock scrolling behind the modal that is
     still open. */
  var _stack = [];
  var _lockDepth = 0;

  function _lockScroll() {
    if (_lockDepth === 0) document.body.style.overflow = 'hidden';
    _lockDepth += 1;
  }

  function _unlockScroll() {
    _lockDepth = Math.max(0, _lockDepth - 1);
    if (_lockDepth === 0) document.body.style.overflow = '';
  }

  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]),' +
    ' select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';


  function _trapTab(e, card) {
    var f = card.querySelectorAll(FOCUSABLE);
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function _tr(key) {
    return (typeof window.t === 'function') ? window.t(key) : key;
  }

  function _build() {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.id = 'confirm-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'confirm-title');
    overlay.setAttribute('aria-describedby', 'confirm-msg');
    overlay.innerHTML =
      '<div class="confirm-card" role="document">' +
        '<h2 class="confirm-title" id="confirm-title"></h2>' +
        '<p class="confirm-msg" id="confirm-msg"></p>' +
        '<div class="confirm-actions">' +
          // Ghost, not mint: a green Cancel beside a red Delete reads as the
          // "go" button. Neutral keeps the choice legible.
          '<button type="button" class="btn btn-ghost" id="confirm-cancel"></button>' +
          '<button type="button" class="btn" id="confirm-ok"></button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    return overlay;
  }

  /* Ask the user to confirm an action.
   *
   *   confirmDialog(msg)                        → neutral confirm
   *   confirmDialog(msg, { danger: true })      → red confirm button
   *   confirmDialog(msg, { okLabel: t('...') }) → name the actual action
   *
   * Resolves true when confirmed, false on cancel / Esc / backdrop click.
   * Cancel takes focus on open, so a stray Enter dismisses rather than
   * destroys. */
  function confirmDialog(message, opts) {
    opts = opts || {};
    // All confirms share one overlay node, so a second one must retire the
    // first rather than fight it for the same DOM. Form modals underneath are
    // left alone — only the confirm layer is replaced.
    for (var s = _stack.length - 1; s >= 0; s--) {
      if (_stack[s].overlay.id === 'confirm-overlay') _stack[s].close(false);
    }

    var overlay = document.getElementById('confirm-overlay') || _build();
    var card    = overlay.querySelector('.confirm-card');
    var okBtn   = overlay.querySelector('#confirm-ok');
    var noBtn   = overlay.querySelector('#confirm-cancel');
    var titleEl = overlay.querySelector('#confirm-title');
    var msgEl   = overlay.querySelector('#confirm-msg');

    titleEl.textContent = opts.title || _tr('confirm.title');
    // Messages carry their own newlines; keep them as line breaks.
    msgEl.textContent = String(message == null ? '' : message);
    okBtn.textContent = opts.okLabel || _tr('confirm.proceed');
    noBtn.textContent = opts.cancelLabel || _tr('common.cancel');
    okBtn.className = 'btn ' + (opts.danger === false ? 'btn-primary' : 'btn-danger');

    var prevFocus = document.activeElement;
    overlay.classList.add('open');
    _lockScroll();
    noBtn.focus();

    return new Promise(function (resolve) {
      var entry = { close: close, card: card, overlay: overlay };

      function close(result) {
        var i = _stack.indexOf(entry);
        if (i === -1) return;
        _stack.splice(i, 1);
        overlay.classList.remove('open');
        _unlockScroll();
        document.removeEventListener('keydown', onKey, true);
        overlay.removeEventListener('mousedown', onBackdrop);
        okBtn.onclick = noBtn.onclick = null;
        // Send focus back where it came from, so keyboard users are not
        // dropped at the top of the document.
        try { prevFocus && prevFocus.focus && prevFocus.focus(); } catch (e) {}
        resolve(result);
      }
      _stack.push(entry);

      function onKey(e) {
        if (_stack[_stack.length - 1] !== entry) return;
        if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
        if (e.key !== 'Tab') return;
        // Trap focus: the dialog is modal, so Tab must not reach the page.
        _trapTab(e, card);
      }
      function onBackdrop(e) { if (e.target === overlay) close(false); }

      document.addEventListener('keydown', onKey, true);
      overlay.addEventListener('mousedown', onBackdrop);
      okBtn.onclick = function () { close(true); };
      noBtn.onclick = function () { close(false); };
    });
  }

  /* Show the `.modal-overlay` with this id.
   *
   *   openModal('modal-edit-account')
   *   openModal(id, { initialFocus: '#ebkt-name', onOpen: fn, onClose: fn })
   *
   * Closes on Esc, backdrop click, or closeModal(id). Reopening an already-open
   * modal is a no-op apart from re-running onOpen, so a double click on a row
   * cannot stack two copies of the same form. */
  function openModal(id, opts) {
    opts = opts || {};
    var overlay = document.getElementById(id);
    if (!overlay) return;
    if (isModalOpen(id)) { if (opts.onOpen) opts.onOpen(overlay); return; }

    var card = overlay.querySelector('.modal-card') || overlay;
    var prevFocus = document.activeElement;

    if (opts.onOpen) opts.onOpen(overlay);

    overlay.classList.add('open');
    _lockScroll();

    var focusEl = opts.initialFocus ? overlay.querySelector(opts.initialFocus) : null;
    if (!focusEl) {
      var body = overlay.querySelector('.modal-body') || card;
      focusEl = body.querySelector(FOCUSABLE);
    }
    if (focusEl) focusEl.focus({ preventScroll: true });

    var entry = { id: id, close: close, card: card, overlay: overlay };

    function close() {
      var i = _stack.indexOf(entry);
      if (i === -1) return;
      _stack.splice(i, 1);
      overlay.classList.remove('open');
      _unlockScroll();
      document.removeEventListener('keydown', onKey, true);
      overlay.removeEventListener('mousedown', onBackdrop);
      try { prevFocus && prevFocus.focus && prevFocus.focus(); } catch (e) {}
      if (opts.onClose) opts.onClose();
    }

    function onKey(e) {
      if (_stack[_stack.length - 1] !== entry) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      _trapTab(e, card);
    }
    function onBackdrop(e) { if (e.target === overlay) close(); }

    _stack.push(entry);
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', onBackdrop);
  }

  function closeModal(id) {
    for (var i = _stack.length - 1; i >= 0; i--) {
      if (_stack[i].id === id) { _stack[i].close(); return; }
    }
  }

  function isModalOpen(id) {
    for (var i = 0; i < _stack.length; i++) if (_stack[i].id === id) return true;
    return false;
  }
  window.confirmDialog = confirmDialog;
  window.openModal     = openModal;
  window.closeModal    = closeModal;
  window.isModalOpen   = isModalOpen;
}());

/* ── EMPTY STATE FOR A SCROLLING TABLE ─────────────────────────────────────
   A `<td colspan="…">` centred across a table that is wider than the phone
   centres the message off the side of the screen: the user sees an empty card
   and no explanation, which is exactly what an empty state exists to prevent.

   So the message is not a row. The table is hidden and a block takes its place
   in the card, the way the Goal Tool's "No goals yet" line already reads.
   `wrapEl` is the table's own `.pf-tbl-wrap` / `.bgt-tbl-wrap`; a falsy
   message puts the table back. */
(function () {
  function setTableEmpty(wrapEl, message) {
    if (!wrapEl) return;
    let box = wrapEl._ftEmptyEl;
    if (!box) {
      box = document.createElement('div');
      box.className = 'table-empty';
      wrapEl.parentNode.insertBefore(box, wrapEl.nextSibling);
      wrapEl._ftEmptyEl = box;
    }
    box.textContent = message || '';
    box.style.display = message ? '' : 'none';
    wrapEl.style.display = message ? 'none' : '';
  }

  window.setTableEmpty = setTableEmpty;
}());

/* ── PAGINATION FOR A CARD'S TABLE ─────────────────────────────────────────
   One pager for every paged list: "1-10 of 23" and ‹ Page 1 of 3 › in the
   card's own .tool-pagination (the chrome is shared.css). The caller slices
   its rows; this draws the controls, clamps the page and calls go(page).
   A list that fits on one page shows no pager at all.

     var page = renderPager(el, page, rows.length, 10, function (p) { ...; });
     rows.slice((page - 1) * 10, page * 10) */
(function () {
  function renderPager(el, page, total, size, go) {
    var pages = Math.max(1, Math.ceil(total / size));
    page = Math.min(Math.max(1, page || 1), pages);
    if (!el) return page;
    if (pages <= 1) { el.hidden = true; el.innerHTML = ''; return page; }
    var from = (page - 1) * size + 1;
    var to = Math.min(total, page * size);
    el.hidden = false;
    el.innerHTML =
      '<div class="tool-pagination-top"><span class="tool-page-info">' + esc(t('common.page_info', from, to, total)) + '</span>' +
      '<div class="tool-page-btns">' +
        '<button type="button" class="btn btn-ghost btn-compact btn-icon" data-go="' + (page - 1) + '" aria-label="' + esc(t('common.prev')) + '"' + (page <= 1 ? ' disabled' : '') + '>' + icon('arrow-left') + '</button>' +
        '<span class="tool-page-num">' + esc(t('common.page_of', page, pages)) + '</span>' +
        '<button type="button" class="btn btn-ghost btn-compact btn-icon" data-go="' + (page + 1) + '" aria-label="' + esc(t('common.next')) + '"' + (page >= pages ? ' disabled' : '') + '>' + icon('arrow-right') + '</button>' +
      '</div></div>';
    el.onclick = function (ev) {
      var b = ev.target.closest('[data-go]');
      if (b && !b.disabled) go(Number(b.getAttribute('data-go')));
    };
    return page;
  }
  window.renderPager = renderPager;
}());

/* ── GLOBAL TOOLTIP ────────────────────────────────────────────────────────
   One driver for every `[data-tip]` on the page, anchored to a single fixed
   #globalTooltip overlay so a tooltip is never clipped by a scrolling table
   or an overflow:hidden card. Lives here because three pages need it; two
   copies of it had already drifted apart before it moved. */
(function () {
  const TIP_W  = 220;
  const MARGIN = 8;
  const tip = document.getElementById('globalTooltip');
  if (!tip) return;
  let hideTimer = null;
  let activeIcon = null;   // icon currently anchoring the tooltip

  // Recompute from the live rect each call so it stays attached while the page
  // scrolls (touch momentum, capture-phase scroll on inner scrollers).
  function position() {
    if (!activeIcon || !activeIcon.isConnected) { hide(); return; }
    const r    = activeIcon.getBoundingClientRect();
    // Icon scrolled out of the viewport -> drop it rather than let it fly.
    if (r.bottom < 0 || r.top > window.innerHeight) { hide(); return; }
    const tipH = tip.offsetHeight || 56;
    tip.classList.remove('arrow-below');
    let left = r.left + r.width / 2 - TIP_W / 2;
    let top  = r.top  - tipH - MARGIN;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - TIP_W - MARGIN));
    if (top < MARGIN) { top = r.bottom + MARGIN; tip.classList.add('arrow-below'); }
    tip.style.left = left + 'px';
    tip.style.top  = top  + 'px';
    const arrowLeft = r.left + r.width / 2 - left;
    tip.style.setProperty('--arrow-left', Math.max(14, Math.min(arrowLeft, TIP_W - 14)) + 'px');
  }
  function hide() {
    activeIcon = null;
    tip.classList.remove('visible');
  }

  document.addEventListener('mouseover', function (e) {
    const icon = e.target.closest('[data-tip]');
    if (!icon) return;
    clearTimeout(hideTimer);
    activeIcon = icon;
    tip.textContent = icon.dataset.tip;
    tip.classList.add('visible');
    position();
  });
  document.addEventListener('mouseout', function (e) {
    if (!e.target.closest('[data-tip]')) return;
    hideTimer = setTimeout(hide, 80);
  });
  // Keep glued while scrolling/resizing; capture phase catches inner scrollers.
  window.addEventListener('scroll', function () { if (activeIcon) position(); }, true);
  window.addEventListener('resize', function () { if (activeIcon) position(); });
}());


/* ── Split Bill helpers ────────────────────────────────────────────────────
   One copy each. finance-tracker carried esc()/showToast() per page and the
   copies drifted (one used innerHTML with user text). */
(function () {
  var ICONS = '/app/static/assets/icons.svg?v=17f4531f';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* A split's stage chip: open, final (locked, someone still owes) or settled.
     The stage comes from the server (stageOf in services/ledger.ts). */
  function stageChip(stage) {
    var st = stage === 'final' || stage === 'settled' ? stage : 'open';
    return '<span class="chip chip-' + st + '">' + esc(t('status.' + st)) + '</span>';
  }

  function icon(name, cls) {
    return '<svg class="icon' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="' + ICONS + '#i-' + name + '"></use></svg>';
  }

  var _toastTimer = null;
  function showToast(msg, kind) {
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = String(msg == null ? '' : msg);
    el.className = 'toast show ' + (kind === 'error' ? 'error' : 'success');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { el.className = 'toast'; }, kind === 'error' ? 4200 : 2400);
  }

  /* An error code from the API (or the engine) as a sentence. Params fill
     {name} placeholders; money params are formatted by the caller first. */
  function errMsg(code, params) {
    var key = 'err.' + code;
    var s = window.t(key);
    if (s === key) s = window.t('err.generic');
    params = params || {};
    return s.replace(/\{(\w+)\}/g, function (_m, k) { return params[k] != null ? String(params[k]) : ''; });
  }

  /* fetch JSON. Resolves {ok:true,data} or {ok:false,code,params,status}.
     A 401 sends the browser to login. Never throws. */
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: {}, credentials: 'same-origin' };
    if (opts.body !== undefined) {
      if (opts.body instanceof FormData) init.body = opts.body;
      else { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    }
    return fetch('/app/api/' + path, init).then(function (r) {
      if (r.status === 401 && !opts.allow401) {
        goLogin();
        return { ok: false, code: 'login_required', params: {}, status: 401 };
      }
      return r.json().catch(function () { return { ok: false, code: 'generic', params: {} }; }).then(function (j) {
        if (j && typeof j.ok === 'boolean') { j.status = r.status; return j; }
        return { ok: r.ok, data: j, status: r.status };
      });
    }).catch(function () {
      return { ok: false, code: navigator.onLine === false ? 'offline' : 'network', params: {}, status: 0 };
    });
  }

  function goLogin() {
    var next = location.pathname + location.search + location.hash;
    location.href = '/login?next=' + encodeURIComponent(next);
  }

  /* Busy state on a button without changing its size. */
  function setBusy(btn, busy) {
    if (!btn) return;
    if (busy) {
      if (btn._label == null) btn._label = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
    } else {
      btn.disabled = false;
      if (btn._label != null) { btn.innerHTML = btn._label; btn._label = null; }
    }
  }

  // ── money, through the engine (never floats) ──
  function E() { return window.SBEngine; }
  function lang() { return window.__LANG__ || 'en'; }

  /* "USD 1,234.50" from a minor-unit string: the currency always leads.
     Plain text, for sentences and titles. */
  function money(minor, ccy, dp, opts) {
    if (minor == null) return '-';
    var s = E().formatAmount(BigInt(minor), dp, lang());
    return (opts && opts.plain) ? s : ccy + ' ' + s;
  }

  /* Signed version: "USD +1,234.50" / "USD -1,234.50". */
  function signed(minor, ccy, dp) {
    var v = BigInt(minor);
    var s = E().formatAmount(v < 0n ? -v : v, dp, lang());
    return ccy + ' ' + (v > 0n ? '+' : v < 0n ? '-' : '') + s;
  }

  /* The same as markup: the code in the text font, quieter than the figure
     it labels (.ccy), because the figure is what is read. Escaped. */
  function ccyTag(ccy) { return '<span class="ccy">' + esc(ccy) + '</span>'; }
  function moneyHtml(minor, ccy, dp, opts) {
    if (minor == null) return '-';
    var s = E().formatAmount(BigInt(minor), dp, lang());
    return (opts && opts.plain) ? esc(s) : ccyTag(ccy) + esc(s);
  }
  function signedHtml(minor, ccy, dp) {
    var v = BigInt(minor);
    var s = E().formatAmount(v < 0n ? -v : v, dp, lang());
    return ccyTag(ccy) + (v > 0n ? '+' : v < 0n ? '-' : '') + esc(s);
  }

  /* Typed text -> minor-unit string, or throws EngineError. */
  function parseMoney(text, dp, opts) {
    return E().parseAmount(text, dp, opts || {}).toString();
  }

  /* Minor units -> text for an input box ("1234.50"). */
  function plainMoney(minor, dp) {
    return minor == null || minor === '' ? '' : E().toPlain(BigInt(minor), dp);
  }

  function ccyName(code) {
    try { return new Intl.DisplayNames([lang()], { type: 'currency' }).of(code) || code; } catch (e) { return code; }
  }

  function fmtDate(iso) {
    if (!iso) return '-';
    if (iso === '-infinity') return window.t('rate.from_start');
    var d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
    try {
      return d.toLocaleDateString(lang() === 'id' ? 'id-ID' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) { return iso; }
  }

  function today(tz) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch (e) { return new Date().toISOString().slice(0, 10); }
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      var s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function randomKey() {
    try { return crypto.randomUUID(); } catch (e) { return String(Date.now()) + Math.random().toString(36).slice(2); }
  }

  /* ── Avatars ──
     A photo when the person uploaded one, else two letters on a colour:
     "Jack Mo" JM, "Dwiki" Dw. The colour comes from a stable key (the user
     for an app user, so they look the same in every split), one of
     AVATAR_COLORS pastel/ink pairs in shared.css (.av-0 ... .av-7). */
  var AVATAR_COLORS = 8;
  function initials(name) {
    var words = String(name || '').trim().split(/\s+/).map(function (w) {
      return Array.from(w.replace(/[^\p{L}\p{N}]/gu, ''));
    }).filter(function (w) { return w.length; });
    if (!words.length) return Array.from(String(name || '').trim())[0] || '?';
    if (words.length === 1) return words[0][0].toUpperCase() + (words[0][1] || '').toLowerCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }
  function avatarColor(key) {
    var h = 2166136261, k = String(key || '');
    for (var i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) % AVATAR_COLORS;
  }
  /* p: { name, url, color (index) or key, size: 'sm' | 'lg' }. Decorative
     next to the name it stands for; pass label when it stands alone. */
  function avatarHtml(p) {
    var cls = 'av' + (p.size ? ' av-' + p.size : '');
    var aria = p.label ? ' role="img" aria-label="' + esc(p.label) + '" title="' + esc(p.label) + '"' : ' aria-hidden="true"';
    if (p.url) return '<img class="' + cls + '" src="' + esc(p.url) + '" alt="' + esc(p.label || '') + '" loading="lazy" decoding="async"' + (p.label ? ' title="' + esc(p.label) + '"' : '') + '>';
    var c = p.color != null ? p.color : avatarColor(p.key != null ? p.key : p.name);
    return '<span class="' + cls + ' av-' + c + '"' + aria + '>' + esc(initials(p.name)) + '</span>';
  }

  /* ── Dropdown placement (finance-tracker ui.js placeDropdown) ──
     A combo's list lives on document.body so no modal or card clips it.
     Call with the list already `.open` (a display:none list measures zero).
     It sits under the field, above it when below has no room, clamped to the
     viewport. One capture-phase listener follows every open list on scroll
     and resize, and closes it once its field is mostly out of view. */
  var EDGE = 8, GAP = 4;
  function placeDropdown(listEl, anchorEl) {
    if (!listEl || !anchorEl) return;
    listEl._anchor = anchorEl;
    var r = anchorEl.getBoundingClientRect();
    var cap = Math.max(120, window.innerWidth - EDGE * 2);
    listEl.style.maxWidth = cap + 'px';
    listEl.style.minWidth = Math.min(r.width, cap) + 'px';
    var w = listEl.offsetWidth || r.width;
    listEl.style.left = Math.max(EDGE, Math.min(r.left, window.innerWidth - EDGE - w)) + 'px';
    var h = listEl.offsetHeight;
    var below = window.innerHeight - EDGE - (r.bottom + GAP);
    var above = r.top - GAP - EDGE;
    listEl.style.top = (h > below && above > below) ? Math.max(EDGE, r.top - GAP - h) + 'px' : (r.bottom + GAP) + 'px';
  }
  function _anchorUsable(el) {
    if (!el || !document.body.contains(el)) return false;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    var box = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    for (var p = el.parentElement; p; p = p.parentElement) {
      var st = getComputedStyle(p);
      if (st.overflowX === 'visible' && st.overflowY === 'visible') continue;
      var pr = p.getBoundingClientRect();
      box.left = Math.max(box.left, pr.left); box.top = Math.max(box.top, pr.top);
      box.right = Math.min(box.right, pr.right); box.bottom = Math.min(box.bottom, pr.bottom);
    }
    var visW = Math.min(r.right, box.right) - Math.max(r.left, box.left);
    var visH = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
    return visW >= r.width / 2 && visH >= r.height / 2;
  }
  function _reflowLists(e) {
    var open = document.querySelectorAll('.combo-list.open');
    for (var i = 0; i < open.length; i++) {
      var l = open[i];
      if (e && e.type === 'scroll' && l.contains(e.target)) continue;
      if (_anchorUsable(l._anchor)) placeDropdown(l, l._anchor);
      else l.classList.remove('open');
    }
  }
  window.addEventListener('scroll', _reflowLists, true);
  window.addEventListener('resize', _reflowLists);

  window.placeDropdown = placeDropdown;

  /* No browser "saved info" list under our fields: it offers old entries
     (names, amounts, notes) that have nothing to do with this bill and covers
     the form. Every field without its own autocomplete gets "off", including
     ones built later (bill lines, the "+" name box). Fields that ask for one
     on purpose (username, current-password, new-password) keep it. */
  function _noAutofill(el) {
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'FORM') && !el.hasAttribute('autocomplete')) {
      el.setAttribute('autocomplete', 'off');
    }
  }
  Array.prototype.forEach.call(document.querySelectorAll('form, input, textarea'), _noAutofill);
  document.addEventListener('focusin', function (e) { _noAutofill(e.target); }, true);
  window.esc = esc;
  window.icon = icon;
  window.stageChip = stageChip;
  window.showToast = showToast;
  window.errMsg = errMsg;
  window.api = api;
  window.goLogin = goLogin;
  window.setBusy = setBusy;
  window.money = money;
  window.signedMoney = signed;
  window.moneyHtml = moneyHtml;
  window.signedMoneyHtml = signedHtml;
  window.parseMoney = parseMoney;
  window.plainMoney = plainMoney;
  window.ccyName = ccyName;
  window.fmtDate = fmtDate;
  window.todayIn = today;
  window.loadScript = loadScript;
  window.randomKey = randomKey;
  window.initials = initials;
  window.avatarColor = avatarColor;
  window.avatarHtml = avatarHtml;
  window.AVATAR_COLORS = AVATAR_COLORS;
}());
