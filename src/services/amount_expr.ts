/**
 * services/amount_expr.ts: exact arithmetic for amounts an AI copied out of
 * a message ("3*45000", "60000+12500"). The model never computes; this does,
 * on exact fractions (no floats), then rounds half-even ONCE to the
 * currency's minor unit. Grammar and preprocessing follow finance-tracker's
 * evalAmountExpr (+ - * / ( ), unary sign, postfix %, "3x15").
 */
import { frac, roundHalfEven, pow10, type Frac } from "../engine";

const CCY = /(?:US\$|AU\$|S\$|A\$|Rp\.?|RM|¥|\$|£|€|₩|₹|\b[A-Z]{3}\b)/g;

function add(a: Frac, b: Frac): Frac { return frac(a.num * b.den + b.num * a.den, a.den * b.den); }
function sub(a: Frac, b: Frac): Frac { return frac(a.num * b.den - b.num * a.den, a.den * b.den); }
function mul(a: Frac, b: Frac): Frac { return frac(a.num * b.num, a.den * b.den); }
function div(a: Frac, b: Frac): Frac | null { return b.num === 0n ? null : frac(a.num * b.den, a.den * b.num); }

type Tok = { t: "n"; v: Frac } | { t: "o"; v: string };

function preprocess(raw: string): string {
  let s = raw.replace(/[×✕]/g, "*").replace(/÷/g, "/").replace(/[−–]/g, "-").replace(CCY, " ");
  while (/(\d),(?=\d{3}(?!\d))/.test(s)) s = s.replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  s = s.replace(/(\d),(?=\d)/g, "$1.");
  s = s.replace(/(?<=[\d)%])\s*[xX]\s*(?=[\d(.])/g, "*");
  return s;
}

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if ("+-*/()%".includes(c)) { out.push({ t: "o", v: c }); i++; continue; }
    const m = /^\d+(?:\.\d+)?|^\.\d+/.exec(src.slice(i));
    if (!m) return null;
    const [ip, fp = ""] = m[0].split(".");
    out.push({ t: "n", v: frac(BigInt((ip || "0") + fp), pow10(fp.length)) });
    i += m[0].length;
  }
  return out;
}

/** Exact value of an expression, or null. */
export function evalExact(raw: unknown): Frac | null {
  if (typeof raw === "number") raw = String(raw);
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 200) return null;
  const toks = tokenize(preprocess(s));
  if (!toks || !toks.length) return null;
  let pos = 0;
  const take = (ops: string) => {
    const t = toks[pos];
    if (t && t.t === "o" && ops.includes(t.v)) { pos++; return t.v; }
    return null;
  };
  const primary = (): Frac | null => {
    const t = toks[pos];
    if (!t) return null;
    if (t.t === "n") { pos++; return t.v; }
    if (t.v === "(") { pos++; const v = expr(); return v && take(")") ? v : null; }
    return null;
  };
  const postfix = (): Frac | null => {
    let v = primary();
    while (v && take("%")) v = mul(v, frac(1n, 100n));
    return v;
  };
  const unary = (): Frac | null => {
    let neg = false, o: string | null;
    while ((o = take("+-"))) if (o === "-") neg = !neg;
    const v = postfix();
    return v && neg ? frac(-v.num, v.den) : v;
  };
  const term = (): Frac | null => {
    let v = unary(), o: string | null;
    while (v && (o = take("*/"))) {
      const r = unary();
      if (!r) return null;
      v = o === "*" ? mul(v, r) : div(v, r);
    }
    return v;
  };
  const expr = (): Frac | null => {
    let v = term(), o: string | null;
    while (v && (o = take("+-"))) {
      const r = term();
      if (!r) return null;
      v = o === "+" ? add(v, r) : sub(v, r);
    }
    return v;
  };
  const v = expr();
  if (!v || pos !== toks.length) return null;
  return v;
}

/** Expression -> minor units (half-even once), or null. Positive only unless allowed. */
export function exprToMinor(raw: unknown, dp: number, allowZero = false): bigint | null {
  const v = evalExact(raw);
  if (!v) return null;
  const minor = roundHalfEven(v.num * pow10(dp), v.den);
  if (minor < 0n || (!allowZero && minor === 0n) || minor > 10n ** 15n) return null;
  return minor;
}
