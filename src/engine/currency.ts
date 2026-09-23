/**
 * engine/currency.ts — ISO 4217 fiat allow-list and minor units.
 *
 * Lives in the engine (not src/) so the browser bundle carries the same table
 * the server validates against. Names are NOT stored here: the UI asks
 * `Intl.DisplayNames` for them in the viewer's language.
 *
 * Minor units are stored on every bill and group at write time (see
 * migrations), so changing this table can never rescale a stored amount.
 */

export const FIAT_CODES: readonly string[] = [
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL",
  "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY",
  "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP",
  "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD",
  "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR",
  "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF",
  "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL",
  "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR",
  "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR",
  "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR",
  "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD",
  "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB",
  "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX",
  "USD", "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XOF",
  "XPF", "YER", "ZAR", "ZMW", "ZWG",
];

/**
 * No minor unit in practice. ISO lists IDR with 2, but nobody pays in sen, and
 * a 2-dp rupiah would make every receipt 100x longer to type.
 */
export const ZERO_DP: readonly string[] = [
  "BIF", "CLP", "DJF", "GNF", "IDR", "ISK", "JPY", "KMF", "KRW", "PYG",
  "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
];

export const THREE_DP: readonly string[] = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];

const _FIAT = new Set(FIAT_CODES);
const _ZERO = new Set(ZERO_DP);
const _THREE = new Set(THREE_DP);

export function normCurrency(code: unknown): string {
  return String(code ?? "").trim().toUpperCase();
}

export function isCurrency(code: unknown): boolean {
  return _FIAT.has(normCurrency(code));
}

/** Decimal places of one minor unit. Unknown codes get 2; callers validate first. */
export function minorUnits(code: string): number {
  const c = normCurrency(code);
  if (_ZERO.has(c)) return 0;
  if (_THREE.has(c)) return 3;
  return 2;
}
