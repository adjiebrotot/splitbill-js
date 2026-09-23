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

  window.fillCurrencySelect = fillCurrencySelect;
}());
