/* currency.js: currency <select> options. Codes come from the engine's
 * allow-list (the same one the server validates); names from Intl in the
 * viewer's language, so nothing here needs translating. */
(function () {
  var COMMON = ['IDR', 'USD', 'SGD', 'MYR', 'THB', 'JPY', 'KRW', 'AUD', 'EUR', 'GBP', 'CNY', 'HKD', 'VND', 'PHP'];

  function fillCurrencySelect(sel, selected) {
    var codes = window.SBEngine.FIAT_CODES;
    var html = COMMON.map(function (c) { return '<option value="' + c + '">' + c + ' · ' + esc(ccyName(c)) + '</option>'; }).join('');
    html += '<option disabled>──────</option>';
    html += codes.filter(function (c) { return COMMON.indexOf(c) < 0; })
      .map(function (c) { return '<option value="' + c + '">' + c + ' · ' + esc(ccyName(c)) + '</option>'; }).join('');
    sel.innerHTML = html;
    if (selected) sel.value = selected;
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
  window.setAmountAffix = setAmountAffix;
}());
