/**
 * num.ts — reading Postgres values safely.
 *
 * pg / Neon return BIGINT and NUMERIC columns as STRINGS, and BOOLEAN can
 * arrive as 't'/'f'. Raw `+` on two money strings concatenates. Every money
 * read goes through toMinor(); nothing adds DB values any other way.
 */

/** BIGINT column -> bigint. Throws on anything that is not an integer. */
export function toMinor(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new TypeError(`toMinor: unsafe number ${v}`);
    return BigInt(v);
  }
  const s = String(v ?? "").trim();
  if (!/^-?\d+$/.test(s)) throw new TypeError(`toMinor: not an integer: ${JSON.stringify(v)}`);
  return BigInt(s);
}

export function toMinorOrNull(v: unknown): bigint | null {
  return v === null || v === undefined ? null : toMinor(v);
}

/** INT / small counts -> number. */
export function toInt(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new TypeError(`toInt: not an integer: ${JSON.stringify(v)}`);
  return n;
}

export function toBool(v: unknown): boolean {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  return s === "t" || s === "true" || s === "1" || s === "yes";
}

/** BIGSERIAL ids travel as strings end to end (JSON has no bigint). */
export function toId(v: unknown): string {
  return String(v);
}

/** JSON.stringify replacer: bigint -> string. */
export function jsonReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}
