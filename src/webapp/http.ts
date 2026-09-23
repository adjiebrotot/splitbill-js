/**
 * webapp/http.ts — request/response helpers for the route handlers.
 */
import { COOKIE_MAX_AGE, COOKIE_NAME, HINT_AUTH, HINT_LANG, readSession, sessionValue, type SessionUser } from "./auth";
import { jsonReplacer } from "../num";

export type User = SessionUser;

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function getUser(req: Request): User | null {
  return readSession(parseCookies(req.headers.get("cookie"))[COOKIE_NAME]);
}

/** JSON response; bigint values serialize as strings. */
export function json(obj: unknown, status = 200, headers: Record<string, string> | Headers = {}): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/json");
  if (!h.has("cache-control")) h.set("cache-control", "no-store");
  return new Response(JSON.stringify(obj, jsonReplacer), { status, headers: h });
}

export function binResponse(body: Uint8Array, headers: Record<string, string>, status = 200): Response {
  return new Response(body as unknown as BodyInit, { status, headers });
}

function _cookie(name: string, value: string, opts: { httpOnly?: boolean; maxAge?: number | null }): string {
  const parts = [`${name}=${value}`, "Path=/", "SameSite=Lax", "Secure"];
  if (opts.maxAge !== null && opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  return parts.join("; ");
}

/** Set-Cookie headers for a signed-in user. `remember=false` = browser session. */
export function sessionCookies(uid: string, username: string, lang: string, remember = true): string[] {
  const maxAge = remember ? COOKIE_MAX_AGE : null;
  return [
    _cookie(COOKIE_NAME, sessionValue(uid, username, lang), { httpOnly: true, maxAge }),
    _cookie(HINT_AUTH, "1", { maxAge }),
    _cookie(HINT_LANG, lang, { maxAge: COOKIE_MAX_AGE }),
  ];
}

export function langCookie(lang: string): string {
  return _cookie(HINT_LANG, lang, { maxAge: COOKIE_MAX_AGE });
}

export function clearSessionCookies(): string[] {
  return [COOKIE_NAME, HINT_AUTH].map((n) => `${n}=; Path=/; Max-Age=0; SameSite=Lax; Secure`);
}

export function withCookies(res: Response, cookies: string[]): Response {
  for (const c of cookies) res.headers.append("set-cookie", c);
  return res;
}

export function redirect(location: string, cookies: string[] = []): Response {
  const res = new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
  return withCookies(res, cookies);
}

/** Only same-site absolute paths; never "//host" or "/\\host". */
export function safeNext(next: string | null | undefined, fallback = "/app"): string {
  if (!next || typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
