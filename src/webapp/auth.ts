/**
 * webapp/auth.ts — signed session cookie. Adapted from finance-tracker.
 *
 * `sb_session` = base64(JSON {uid, u, t, lang}), where t = HMAC-SHA256 over
 * `${uid}:${username}` keyed with SETUP_SECRET. `lang` is outside the HMAC on
 * purpose: it only picks a translation.
 *
 * Two readable HINT cookies ride along: `sb_auth=1` and `sb_lang`. Static
 * pages read them before first paint (redirect to login, pick the language).
 * They grant nothing; every API call still verifies `sb_session`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "sb_session";
export const HINT_AUTH = "sb_auth";
export const HINT_LANG = "sb_lang";
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

export interface SessionUser {
  user_id: string;
  username: string;
  lang: string | null;
}

function _secret(): string {
  const s = process.env.SETUP_SECRET;
  if (!s) throw new Error("SETUP_SECRET is not set, cannot sign or verify session cookies");
  return s;
}

function _sign(uid: string, username: string): string {
  return createHmac("sha256", _secret()).update(`${uid}:${username}`, "utf8").digest("hex");
}

function _eq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function sessionValue(uid: string, username: string, lang: string | null): string {
  const t = _sign(uid, username);
  return Buffer.from(JSON.stringify(lang ? { uid, u: username, t, lang } : { uid, u: username, t })).toString("base64");
}

export function readSession(cookie: string | undefined | null): SessionUser | null {
  if (!cookie) return null;
  try {
    const d = JSON.parse(Buffer.from(cookie, "base64").toString("utf8"));
    if (typeof d.uid !== "string" || typeof d.u !== "string" || typeof d.t !== "string") return null;
    if (!_eq(d.t, _sign(d.uid, d.u))) return null;
    return { user_id: d.uid, username: d.u, lang: typeof d.lang === "string" ? d.lang : null };
  } catch {
    return null;
  }
}
