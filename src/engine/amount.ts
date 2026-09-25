/**
 * engine/amount.ts — strict parsing and formatting of money, percents, rates.
 *
 * The browser parses what a person types into canonical values; the API only
 * accepts canonical values (minor-unit integer strings, basis points, plain
 * decimal rate strings) and the server re-validates them here.
 *
 * Nothing is ever guessed. An input that could mean two amounts, or carries
 * more decimals than its currency has, is refused with a reason code.
 */

import { fail } from "./errors";
import { pow10, frac, roundHalfEven, type Frac } from "./rational";

/** Largest amount accepted anywhere, in minor units. */
export const MAX_MINOR = 10n ** 15n;
/** Largest rate accepted, and its max decimal places. */
export const MAX_RATE = 1_000_000_000n;
export const RATE_DECIMALS = 12;

const SPACES = /[\s  '’]/g;

function _checkGroups(intPart: string, sep: string): string {
  if (!sep || !intPart.includes(sep)) return intPart;
  const groups = intPart.split(sep);
  if (!/^\d{1,3}$/.test(groups[0])) fail("amount_invalid");
  for (let i = 1; i < groups.length; i++) {
    if (!/^\d{3}$/.test(groups[i])) fail("amount_invalid");
  }
  return groups.join("");
}

/**
 * Parse a typed amount into minor units.
 *
 *   "25.000" / "25,000" in IDR  -> 25000   (one separator + 3 digits = thousands)
 *   "12.50"  / "12,50"  in USD  -> 1250    (one separator + <= 2 digits = decimal)
 *   "1,234.5" / "1.234,5"       -> 123450  (both: the LAST one is the decimal)
 *   "12.5" in IDR               -> refused, amount_too_precise
 *
 * A single separator followed by exactly 3 digits is thousands unless the
 * currency itself has 3 decimals (KWD "1.234" is one dinar and 234 fils).
 */
export function parseAmount(input: unknown, dp: number, opts: { allowNegative?: boolean; allowZero?: boolean } = {}): bigint {
  let s = String(input ?? "").replace(SPACES, "");
  let neg = false;
  if (s.startsWith("-") || s.startsWith("−")) {
    if (!opts.allowNegative) fail("amount_negative");
    neg = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (!/^[0-9.,]+$/.test(s) || !/\d/.test(s)) fail("amount_invalid");
  if (/^[.,]|[.,]$/.test(s)) fail("amount_invalid");

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let intPart = s;
  let fracPart = "";

  if (lastDot >= 0 && lastComma >= 0) {
    const decSep = lastDot > lastComma ? "." : ",";
    const thouSep = decSep === "." ? "," : ".";
    const at = s.lastIndexOf(decSep);
    if (s.indexOf(decSep) !== at) fail("amount_invalid");
    intPart = _checkGroups(s.slice(0, at), thouSep);
    fracPart = s.slice(at + 1);
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const count = s.split(sep).length - 1;
    if (count > 1) {
      intPart = _checkGroups(s, sep);
    } else {
      const at = s.indexOf(sep);
      const after = s.length - at - 1;
      const isThousands = after === 3 && dp !== 3;
      if (isThousands) {
        intPart = _checkGroups(s, sep);
      } else {
        intPart = s.slice(0, at);
        fracPart = s.slice(at + 1);
      }
    }
  }

  if (!/^\d+$/.test(intPart) || !/^\d*$/.test(fracPart)) fail("amount_invalid");
  if (fracPart.length > dp) fail("amount_too_precise", { dp });
  const minor = BigInt(intPart) * pow10(dp) + BigInt((fracPart + "0".repeat(dp)).slice(0, dp) || "0");
  if (minor > MAX_MINOR) fail("amount_too_large");
  if (minor === 0n && !opts.allowZero) fail("amount_zero");
  return neg ? -minor : minor;
}

/** Parse a canonical minor-unit integer string from the API. */
export function parseMinor(input: unknown, opts: { allowNegative?: boolean; allowZero?: boolean } = {}): bigint {
  const s = typeof input === "bigint" ? input.toString() : String(input ?? "").trim();
  if (!/^-?\d{1,19}$/.test(s)) fail("amount_invalid");
  const v = BigInt(s);
  if (v < 0n && !opts.allowNegative) fail("amount_negative");
  if (v === 0n && !opts.allowZero) fail("amount_zero");
  if (v > MAX_MINOR || v < -MAX_MINOR) fail("amount_too_large");
  return v;
}

function _group(digits: string, sep: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/** 123450n, 2 -> "1,234.50" (en) / "1.234,50" (id). */
export function formatAmount(minor: bigint, dp: number, lang = "en"): string {
  const neg = minor < 0n;
  const a = neg ? -minor : minor;
  const base = pow10(dp);
  const whole = (a / base).toString();
  const part = dp ? (a % base).toString().padStart(dp, "0") : "";
  const [thou, dec] = lang === "id" ? [".", ","] : [",", "."];
  return (neg ? "-" : "") + _group(whole, thou) + (dp ? dec + part : "");
}

/** Minor units as a plain decimal string for inputs: 123450n, 2 -> "1234.50". */
export function toPlain(minor: bigint, dp: number): string {
  const neg = minor < 0n;
  const a = neg ? -minor : minor;
  const base = pow10(dp);
  const s = (a / base).toString() + (dp ? "." + (a % base).toString().padStart(dp, "0") : "");
  return (neg ? "-" : "") + s;
}

/**
 * Percent text -> basis points. "33.33" / "33,33" -> 3333. Max 2 decimals.
 * Zero is allowed here; the split rules decide whether 0% may appear.
 */
export function parsePercent(input: unknown): number {
  const s = String(input ?? "").replace(SPACES, "").replace(/%$/, "").replace(",", ".");
  if (!/^\d{1,3}(\.\d+)?$/.test(s)) fail("percent_invalid");
  const [i, f = ""] = s.split(".");
  if (f.length > 2) fail("percent_too_precise");
  const bp = Number(i) * 100 + Number((f + "00").slice(0, 2));
  if (bp > 10000) fail("percent_invalid");
  return bp;
}

export function formatPercent(bp: number, lang = "en"): string {
  const f = bp % 100;
  const s = String(Math.floor(bp / 100)) + (f ? "." + String(f).padStart(2, "0").replace(/0$/, "") : "");
  return lang === "id" ? s.replace(".", ",") : s;
}

export interface Rate {
  /** Canonical decimal string, e.g. "16000" or "0.0625". */
  text: string;
  value: Frac;
}

/** Canonical rate string from the API: digits with an optional "." part. */
export function parseRate(input: unknown): Rate {
  const s = String(input ?? "").trim();
  if (!/^\d{1,10}(\.\d+)?$/.test(s)) fail("rate_invalid");
  const [i, f = ""] = s.split(".");
  if (f.length > RATE_DECIMALS) fail("rate_too_precise");
  const num = BigInt(i + f);
  const den = pow10(f.length);
  if (num === 0n) fail("rate_invalid");
  if (num > MAX_RATE * den) fail("rate_too_large");
  const value = frac(num, den);
  const trimmed = f.replace(/0+$/, "");
  return { text: BigInt(i).toString() + (trimmed ? "." + trimmed : ""), value };
}

/**
 * A rate typed by a person. `lang` picks the decimal mark: "en" uses ".",
 * "id" uses ",", and the other mark is a thousands separator (validated).
 */
export function parseLocaleRate(input: unknown, lang = "en"): Rate {
  let s = String(input ?? "").replace(SPACES, "");
  const [dec, thou] = lang === "id" ? [",", "."] : [".", ","];
  const at = s.indexOf(dec);
  if (at !== s.lastIndexOf(dec)) fail("rate_invalid");
  let intPart = at >= 0 ? s.slice(0, at) : s;
  const fracPart = at >= 0 ? s.slice(at + 1) : "";
  if (!intPart) intPart = "0";
  try {
    intPart = _checkGroups(intPart, thou);
  } catch {
    fail("rate_invalid");
  }
  s = intPart + (fracPart ? "." + fracPart : "");
  return parseRate(s);
}

/** num/den (>= 1) as decimal text with `dp` decimals, half-even, trailing zeros trimmed. */
function _fixed(num: bigint, den: bigint, dp: number): string {
  const n = roundHalfEven(num * pow10(dp), den).toString().padStart(dp + 1, "0");
  const i = n.slice(0, n.length - dp);
  const f = dp ? n.slice(n.length - dp).replace(/0+$/, "") : "";
  return i + (f ? "." + f : "");
}

/** Digits before the decimal point of num/den (>= 1). */
function _intDigits(num: bigint, den: bigint): number {
  return (num / den).toString().length;
}

/**
 * The stored "big side first" form: 1 AUD = 12,655.79 IDR, never
 * 1 IDR = 0.0000790152 AUD, whose tail the 12-decimal column would cut. A rate
 * under 1 is kept as its reciprocal (10 significant digits) with `inverted`
 * flipped. A reciprocal past MAX_RATE stays as given.
 */
export function bigSideRate(r: Rate, inverted: boolean): { rate: Rate; inverted: boolean } {
  const { num, den } = r.value;
  if (num >= den || den > MAX_RATE * num) return { rate: r, inverted };
  const dp = Math.max(0, 10 - _intDigits(den, num));
  return { rate: parseRate(_fixed(den, num, dp)), inverted: !inverted };
}

/**
 * A rate as people read it: big side first, then the decimals that mean
 * something (21624.09938 -> "21624", 12.151245533 -> "12.15"). Display only;
 * every conversion uses the stored rate.
 */
export function displayRate(text: string, inverted: boolean): { text: string; inverted: boolean } {
  let { num, den } = parseRate(text).value;
  if (num < den) {
    [num, den] = [den, num];
    inverted = !inverted;
  }
  return { text: _fixed(num, den, num >= 1000n * den ? 0 : 2), inverted };
}
