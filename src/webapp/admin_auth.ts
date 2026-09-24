/**
 * webapp/admin_auth.ts — the admin console's own sign-in, separate from
 * member accounts. Adapted from finance-tracker admin/routes.ts.
 *
 * One password, ADMIN_PASSWORD (env). Unset = the console is off. The session
 * cookie `sb_admin` is `<expiry>.<hmac>` keyed with the password, so changing
 * ADMIN_PASSWORD signs every admin out. It is HttpOnly, SameSite=Strict and
 * scoped to /app/api/admin, the only place it is read. `sb_admin_hint` grants
 * nothing: it only lets the static /admin page pick its first view.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { parseCookies } from "./http";

export const ADMIN_COOKIE = "sb_admin";
export const ADMIN_HINT = "sb_admin_hint";
export const ADMIN_TTL_S = 12 * 60 * 60;

function _key(): string | null {
  return process.env.ADMIN_PASSWORD || null;
}

export function adminConfigured(): boolean {
  return !!_key();
}

function _sig(exp: string, key: string): string {
  return createHmac("sha256", key).update(`sb-admin-v1:${exp}`, "utf8").digest("hex");
}

function _eq(a: string, b: string): boolean {
  // Hash first so the compare is constant-time whatever the lengths.
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function checkAdminPassword(password: unknown): boolean {
  const key = _key();
  if (!key || typeof password !== "string" || !password) return false;
  return _eq(password, key);
}

export function adminToken(now = Date.now()): string {
  const key = _key();
  if (!key) throw new Error("ADMIN_PASSWORD is not set");
  const exp = String(Math.floor(now / 1000) + ADMIN_TTL_S);
  return `${exp}.${_sig(exp, key)}`;
}

export function verifyAdminToken(token: string | undefined | null, now = Date.now()): boolean {
  const key = _key();
  if (!key || !token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) * 1000 <= now) return false;
  return _eq(sig, _sig(exp, key));
}

export function isAdmin(req: Request): boolean {
  return verifyAdminToken(parseCookies(req.headers.get("cookie"))[ADMIN_COOKIE]);
}

export function adminCookies(token: string): string[] {
  return [
    `${ADMIN_COOKIE}=${token}; Path=/app/api/admin; Max-Age=${ADMIN_TTL_S}; HttpOnly; SameSite=Strict; Secure`,
    `${ADMIN_HINT}=1; Path=/; Max-Age=${ADMIN_TTL_S}; SameSite=Strict; Secure`,
  ];
}

export function clearAdminCookies(): string[] {
  return [
    `${ADMIN_COOKIE}=; Path=/app/api/admin; Max-Age=0; HttpOnly; SameSite=Strict; Secure`,
    `${ADMIN_HINT}=; Path=/; Max-Age=0; SameSite=Strict; Secure`,
  ];
}
