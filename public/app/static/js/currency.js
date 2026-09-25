/* currency.js: the currency picker and the money box's code.
 *
 * Picker: a searchable combo (finance-tracker .combo-wrap), Recommended on
 * top, Other Currencies under it. The page's <select> stays in the form as the
 * value holder (hidden), so `.value`, `disabled` and "change" work as before;
 * the combo writes to it and fires "change". Codes come from the engine's
 * allow-list (the same one the server validates); names from Intl in the
 * viewer's language, so nothing here needs translating.
 *
 * Recommended is built at open time, in this order: what the page says is in
 * use (setCurrencyHints: the user's default, the split's currency, the ones
 * its bills use), the currency of the device's time zone, then a short base.
 */
(function () {
  var BASE = ['IDR', 'USD', 'SGD', 'MYR', 'EUR', 'AUD', 'CNY'];
  var TZ_CCY = {
    'Asia/Singapore':'SGD','Asia/Kuala_Lumpur':'MYR','Asia/Kuching':'MYR',
    'Asia/Jakarta':'IDR','Asia/Makassar':'IDR','Asia/Jayapura':'IDR',
    'Asia/Shanghai':'CNY','Asia/Urumqi':'CNY','Asia/Chongqing':'CNY','Asia/Harbin':'CNY',
    'Asia/Hong_Kong':'HKD','Asia/Taipei':'TWD','Asia/Macau':'MOP',
    'Asia/Tokyo':'JPY','Asia/Seoul':'KRW',
    'Asia/Bangkok':'THB','Asia/Phnom_Penh':'KHR','Asia/Vientiane':'LAK',
    'Asia/Ho_Chi_Minh':'VND','Asia/Saigon':'VND',
    'Asia/Rangoon':'MMK','Asia/Yangon':'MMK',
    'Asia/Kolkata':'INR','Asia/Calcutta':'INR','Asia/Colombo':'LKR',
    'Asia/Kathmandu':'NPR','Asia/Katmandu':'NPR','Asia/Dhaka':'BDT','Asia/Dacca':'BDT',
    'Asia/Karachi':'PKR','Asia/Kabul':'AFN','Asia/Tehran':'IRR',
    'Asia/Dubai':'AED','Asia/Muscat':'OMR','Asia/Riyadh':'SAR',
    'Asia/Kuwait':'KWD','Asia/Bahrain':'BHD','Asia/Qatar':'QAR',
    'Asia/Baghdad':'IQD','Asia/Amman':'JOD','Asia/Beirut':'LBP',
    'Asia/Jerusalem':'ILS','Asia/Tel_Aviv':'ILS',
    'Asia/Tbilisi':'GEL','Asia/Yerevan':'AMD','Asia/Baku':'AZN',
    'Asia/Almaty':'KZT','Asia/Bishkek':'KGS','Asia/Dushanbe':'TJS','Asia/Ashgabat':'TMT',
    'Asia/Ulaanbaatar':'MNT','Asia/Ulan_Bator':'MNT','Asia/Manila':'PHP','Asia/Brunei':'BND',
    'Australia/Sydney':'AUD','Australia/Melbourne':'AUD','Australia/Brisbane':'AUD',
    'Australia/Adelaide':'AUD','Australia/Perth':'AUD','Australia/Darwin':'AUD',
    'Australia/Hobart':'AUD','Australia/Lord_Howe':'AUD',
    'Europe/London':'GBP','Europe/Jersey':'GBP','Europe/Guernsey':'GBP','Europe/Isle_of_Man':'GBP',
    'Europe/Paris':'EUR','Europe/Berlin':'EUR','Europe/Rome':'EUR','Europe/Madrid':'EUR',
    'Europe/Amsterdam':'EUR','Europe/Brussels':'EUR','Europe/Vienna':'EUR',
    'Europe/Lisbon':'EUR','Europe/Helsinki':'EUR','Europe/Athens':'EUR',
    'Europe/Dublin':'EUR','Europe/Luxembourg':'EUR','Europe/Malta':'EUR',
    'Europe/Tallinn':'EUR','Europe/Riga':'EUR','Europe/Vilnius':'EUR',
    'Europe/Bratislava':'EUR','Europe/Ljubljana':'EUR','Europe/Valletta':'EUR',
    'Europe/Vatican':'EUR','Europe/San_Marino':'EUR','Europe/Monaco':'EUR','Europe/Andorra':'EUR',
    'Europe/Zagreb':'EUR','Europe/Nicosia':'EUR','Europe/Famagusta':'EUR','Europe/Podgorica':'EUR',
    'Europe/Moscow':'RUB','Europe/Kaliningrad':'RUB','Europe/Samara':'RUB',
    'Europe/Istanbul':'TRY','Europe/Warsaw':'PLN','Europe/Prague':'CZK',
    'Europe/Budapest':'HUF','Europe/Bucharest':'RON','Europe/Sofia':'BGN',
    'Europe/Belgrade':'RSD','Europe/Copenhagen':'DKK','Europe/Faroe':'DKK',
    'Europe/Stockholm':'SEK','Europe/Oslo':'NOK','Arctic/Longyearbyen':'NOK',
    'Europe/Kiev':'UAH','Europe/Kyiv':'UAH','Europe/Minsk':'BYN','Europe/Chisinau':'MDL',
    'Europe/Zurich':'CHF','Europe/Vaduz':'CHF','Europe/Reykjavik':'ISK',
    'Europe/Skopje':'MKD','Europe/Sarajevo':'BAM','Europe/Tirane':'ALL','Europe/Tirana':'ALL',
    'America/New_York':'USD','America/Chicago':'USD','America/Los_Angeles':'USD',
    'America/Denver':'USD','America/Phoenix':'USD','America/Anchorage':'USD',
    'America/Honolulu':'USD','America/Detroit':'USD',
    'America/Indiana/Indianapolis':'USD','America/Kentucky/Louisville':'USD',
    'America/Toronto':'CAD','America/Vancouver':'CAD','America/Montreal':'CAD',
    'America/Calgary':'CAD','America/Edmonton':'CAD','America/Winnipeg':'CAD',
    'America/Halifax':'CAD','America/St_Johns':'CAD',
    'America/Sao_Paulo':'BRL','America/Manaus':'BRL','America/Belem':'BRL',
    'America/Fortaleza':'BRL','America/Recife':'BRL','America/Maceio':'BRL',
    'America/Bahia':'BRL','America/Cuiaba':'BRL','America/Campo_Grande':'BRL',
    'America/Porto_Velho':'BRL','America/Rio_Branco':'BRL','America/Boa_Vista':'BRL',
    'America/Argentina/Buenos_Aires':'ARS','America/Buenos_Aires':'ARS',
    'America/Mexico_City':'MXN','America/Cancun':'MXN','America/Monterrey':'MXN',
    'America/Bogota':'COP','America/Lima':'PEN','America/Santiago':'CLP',
    'America/Caracas':'VES','America/Asuncion':'PYG','America/La_Paz':'BOB',
    'America/Guatemala':'GTQ','America/Tegucigalpa':'HNL','America/Managua':'NIO',
    'America/Port-au-Prince':'HTG','America/Santo_Domingo':'DOP','America/Havana':'CUP',
    'America/Jamaica':'JMD','America/Nassau':'BSD','America/Barbados':'BBD',
    'America/Curacao':'ANG','America/Guyana':'GYD','America/Paramaribo':'SRD',
    'Africa/Johannesburg':'ZAR','Africa/Maseru':'LSL','Africa/Mbabane':'SZL',
    'Africa/Nairobi':'KES','Africa/Kampala':'UGX','Africa/Dar_es_Salaam':'TZS',
    'Africa/Lagos':'NGN','Africa/Accra':'GHS','Africa/Cairo':'EGP',
    'Africa/Casablanca':'MAD','Africa/El_Aaiun':'MAD','Africa/Tunis':'TND',
    'Africa/Algiers':'DZD','Africa/Tripoli':'LYD','Africa/Khartoum':'SDG',
    'Africa/Addis_Ababa':'ETB','Africa/Mogadishu':'SOS','Africa/Djibouti':'DJF',
    'Africa/Asmara':'ERN','Africa/Lusaka':'ZMW','Africa/Harare':'ZWG',
    'Africa/Antananarivo':'MGA','Africa/Kinshasa':'CDF','Africa/Luanda':'AOA',
    'Africa/Windhoek':'NAD','Africa/Gaborone':'BWP','Africa/Bujumbura':'BIF',
    'Africa/Kigali':'RWF','Africa/Conakry':'GNF','Africa/Freetown':'SLE',
    'Africa/Monrovia':'LRD','Africa/Banjul':'GMD','Africa/Nouakchott':'MRU',
    'Africa/Sao_Tome':'STN','Africa/Blantyre':'MWK',
    'Pacific/Auckland':'NZD','Pacific/Chatham':'NZD','Pacific/Apia':'WST',
    'Pacific/Tongatapu':'TOP','Pacific/Fiji':'FJD','Pacific/Port_Moresby':'PGK',
    'Pacific/Guadalcanal':'SBD','Pacific/Efate':'VUV',
    'Indian/Maldives':'MVR','Indian/Mauritius':'MUR',
    'Indian/Cocos':'AUD','Indian/Christmas':'AUD'
  };

  var hintsFn = null;
  function setCurrencyHints(fn) { hintsFn = fn; }

  function localCurrency() {
    try { return TZ_CCY[Intl.DateTimeFormat().resolvedOptions().timeZone] || null; } catch (e) { return null; }
  }

  function recommended() {
    var fiat = window.SBEngine.FIAT_CODES;
    var out = [];
    function add(c) {
      c = String(c || '').toUpperCase();
      if (c && fiat.indexOf(c) >= 0 && out.indexOf(c) < 0) out.push(c);
    }
    var hints = [];
    try { hints = hintsFn ? hintsFn() || [] : []; } catch (e) {}
    hints.forEach(add);
    add(localCurrency());
    BASE.forEach(add);
    return out;
  }

  function label(c) { return c ? c + ' · ' + ccyName(c) : ''; }
  function tr(key, fallback) {
    var v = typeof window.t === 'function' ? window.t(key) : key;
    return v && v !== key ? v : fallback;
  }

  /* Upgrade a <select> to the combo once; later calls only re-sync it. */
  function comboFor(sel) {
    if (sel._combo) return sel._combo;
    var wrap = document.createElement('div');
    wrap.className = 'combo-wrap';
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.id = sel.id + '-q';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.setAttribute('role', 'combobox');
    inp.setAttribute('aria-expanded', 'false');
    inp.placeholder = tr('combo.search', 'Search currency');
    wrap.appendChild(inp);
    sel.hidden = true;
    sel.parentNode.insertBefore(wrap, sel.nextSibling);
    // The field's label names the box a person actually types in.
    var lbl = sel.id ? document.querySelector('label[for="' + sel.id + '"]') : null;
    if (lbl) lbl.htmlFor = inp.id;

    var list = document.createElement('div');
    list.className = 'combo-list';
    list.setAttribute('role', 'listbox');
    document.body.appendChild(list);
    var hl = -1;

    function items() { return list.querySelectorAll('.combo-item'); }
    function mark(i) {
      var all = items();
      if (!all.length) { hl = -1; return; }
      hl = (i + all.length) % all.length;
      for (var k = 0; k < all.length; k++) all[k].classList.toggle('highlighted', k === hl);
      all[hl].scrollIntoView({ block: 'nearest' });
    }
    function close() {
      list.classList.remove('open');
      inp.setAttribute('aria-expanded', 'false');
      hl = -1;
    }
    function sync() {
      inp.value = label(sel.value);
      inp.disabled = sel.disabled;
    }
    function pick(code) {
      var changed = sel.value !== code;
      sel.value = code;
      sync();
      close();
      if (changed) {
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    function render(q) {
      var f = String(q || '').trim().toLowerCase();
      var rec = recommended();
      var rest = window.SBEngine.FIAT_CODES.filter(function (c) { return rec.indexOf(c) < 0; });
      var hit = function (c) { return !f || label(c).toLowerCase().indexOf(f) >= 0; };
      var sections = [
        { label: tr('combo.recommended', 'Recommended'), codes: rec.filter(hit) },
        { label: tr('combo.other_currencies', 'Other Currencies'), codes: rest.filter(hit) },
      ].filter(function (s) { return s.codes.length; });
      var html = '';
      sections.forEach(function (s) {
        if (sections.length > 1) html += '<div class="combo-sep">' + esc(s.label) + '</div>';
        html += s.codes.map(function (c) {
          return '<div class="combo-item" role="option" data-code="' + c + '"' + (c === sel.value ? ' aria-selected="true"' : '') + '>' + esc(label(c)) + '</div>';
        }).join('');
      });
      list.innerHTML = html || '<div class="combo-empty">' + esc(tr('combo.no_results', 'No results')) + '</div>';
      // Opened first, placed second: placeDropdown measures the list.
      list.classList.add('open');
      inp.setAttribute('aria-expanded', 'true');
      placeDropdown(list, inp);
      hl = -1;
      if (f) mark(0);
    }

    // mousedown, not click: focus stays in the box, so blur does not close the list mid-pick.
    list.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      var it = ev.target.closest('.combo-item');
      if (it) pick(it.getAttribute('data-code'));
    });
    inp.addEventListener('focus', function () { inp.select(); render(''); });
    inp.addEventListener('click', function () { if (!list.classList.contains('open')) render(''); });
    inp.addEventListener('input', function () { render(inp.value); });
    inp.addEventListener('blur', function () { close(); sync(); });
    inp.addEventListener('keydown', function (ev) {
      var open = list.classList.contains('open');
      if (ev.key === 'ArrowDown') { ev.preventDefault(); if (!open) render(''); mark(hl + 1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); if (!open) render(''); mark(hl - 1); }
      else if (ev.key === 'Enter') {
        ev.preventDefault();
        var all = items();
        if (open && hl >= 0 && all[hl]) pick(all[hl].getAttribute('data-code'));
        else if (open && all.length === 1) pick(all[0].getAttribute('data-code'));
      }
    });
    inp._comboClose = function () { close(); sync(); };
    // `disabled` set on the <select> (read-only bill, one-off payment) reaches the box.
    new MutationObserver(sync).observe(sel, { attributes: true, attributeFilter: ['disabled'] });

    sel._combo = { sync: sync, input: inp };
    return sel._combo;
  }

  // Esc with the list open closes the list, not the modal around it
  // (window capture runs before the modal's document listener).
  window.addEventListener('keydown', function (ev) {
    var el = document.activeElement;
    if (ev.key !== 'Escape' || !el || !el._comboClose || el.getAttribute('aria-expanded') !== 'true') return;
    ev.stopPropagation();
    ev.preventDefault();
    el._comboClose();
  }, true);

  function fillCurrencySelect(sel, selected) {
    var codes = window.SBEngine.FIAT_CODES;
    sel.innerHTML = codes.map(function (c) { return '<option value="' + c + '">' + c + '</option>'; }).join('');
    if (selected) sel.value = selected;
    comboFor(sel).sync();
  }

  /* Set a picker's value from code (an AI draft's currency). */
  function setCurrencyValue(sel, code) {
    sel.value = code;
    if (sel._combo) sel._combo.sync();
  }

  /* What the number in a money box is counted in, printed where it is typed
     (finance-tracker .amount-wrap has-prefix): "IDR  120,000". Every
     .amount-wrap under `root` gets `code`. --amt-affix is the code's own
     width, so the digits clear it; offsetWidth is 0 in a closed modal, and
     the character estimate stands in there. */
  function setAmountAffix(root, code) {
    if (!root) return;
    var wraps = root.querySelectorAll('.amount-wrap');
    for (var i = 0; i < wraps.length; i++) {
      var w = wraps[i];
      var a = w.querySelector('.amount-affix');
      if (!a) continue;
      var txt = code || '';
      if (a.textContent !== txt) a.textContent = txt;
      a.classList.add('is-prefix');
      w.classList.toggle('has-prefix', !!txt);
      w.style.setProperty('--amt-affix', (a.offsetWidth || Math.round(txt.length * 7.5)) + 'px');
    }
  }

  window.fillCurrencySelect = fillCurrencySelect;
  window.setCurrencyValue = setCurrencyValue;
  window.setCurrencyHints = setCurrencyHints;
  window.setAmountAffix = setAmountAffix;
}());
