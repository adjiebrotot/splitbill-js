/**
 * webapp/google_auth.ts: "Sign in with Google" (OAuth 2.0 code flow).
 * Adapted from finance-tracker: signed `state` (HMAC + expiry) so the
 * callback validates even when the browser drops the state cookie, id_token
 * claims checked (aud, iss, exp, email_verified). Split Bill has no setup
 * wizard: a new Google email gets its account immediately (user_service).
 *
 *   GET /app/api/auth/google/start?next=/app/...
 *   GET /app/api/auth/google/callback
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as U from "../services/user_service";
import { redirect, parseCookies, safeNext, sessionCookies } from "./http";
import { HINT_LANG } from "./auth";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const CALLBACK = "/app/api/auth/google/callback";
const STATE_COOKIE = "sb_oauth";
const TTL = 600;

const cid = () => (process.env.GOOGLE_CLIENT_ID || "").trim();
const csecret = () => (process.env.GOOGLE_CLIENT_SECRET || "").trim();

function hmac(s: string): string {
  const k = process.env.SETUP_SECRET;
  if (!k) throw new Error("SETUP_SECRET is not set");
  return createHmac("sha256", k).update(s, "utf8").digest("hex");
}

function eq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function baseUrl(req: Request): string {
  const env = (process.env.PUBLIC_BASE_URL || "").trim();
  if (env) return env.replace(/\/+$/, "");
  const h = req.headers;
  return `${h.get("x-forwarded-proto") || "https"}://${h.get("x-forwarded-host") || h.get("host")}`;
}

function signState(nonce: string, next: string): string {
  const payload = Buffer.from(JSON.stringify({ n: nonce, x: next, e: Math.floor(Date.now() / 1000) + TTL })).toString("base64url");
  return `${payload}.${hmac(payload)}`;
}

function readState(state: string): { nonce: string; next: string } | null {
  const i = state.lastIndexOf(".");
  if (i < 0) return null;
  const payload = state.slice(0, i);
  if (!eq(state.slice(i + 1), hmac(payload))) return null;
  try {
    const b = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof b.e !== "number" || b.e * 1000 < Date.now() || !b.n) return null;
    return { nonce: String(b.n), next: safeNext(String(b.x || "")) };
  } catch {
    return null;
  }
}

const fail = (code: string) => redirect(`/login?error=${code}`);

export async function googleStart(req: Request): Promise<Response> {
  if (!cid() || !csecret()) return fail("google_unavailable");
  const next = safeNext(new URL(req.url).searchParams.get("next"));
  const nonce = randomBytes(16).toString("hex");
  const q = new URLSearchParams({
    client_id: cid(), redirect_uri: baseUrl(req) + CALLBACK, response_type: "code",
    scope: "openid email profile", state: signState(nonce, next), prompt: "select_account",
  });
  return redirect(`${AUTH}?${q}`, [`${STATE_COOKIE}=${nonce}; Path=/; Max-Age=${TTL}; SameSite=Lax; HttpOnly; Secure`]);
}

export async function googleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const st = readState(url.searchParams.get("state") || "");
  if (!st) return fail("google_failed");
  const cookie = parseCookies(req.headers.get("cookie"))[STATE_COOKIE];
  if (cookie && !eq(cookie, st.nonce)) return fail("google_failed");
  const code = url.searchParams.get("code");
  if (!code) return fail("google_failed");
  let claims: Record<string, any>;
  try {
    const resp = await fetch(TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: cid(), client_secret: csecret(), redirect_uri: baseUrl(req) + CALLBACK, grant_type: "authorization_code" }),
      signal: AbortSignal.timeout(10000),
    });
    const tok = (await resp.json()) as Record<string, any>;
    // The id_token came straight from Google's token endpoint over TLS; its
    // claims are checked, the signature need not be.
    claims = JSON.parse(Buffer.from(String(tok.id_token).split(".")[1], "base64url").toString("utf8"));
  } catch {
    return fail("google_failed");
  }
  const okIss = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (claims.aud !== cid() || !okIss || Number(claims.exp) * 1000 < Date.now() || claims.email_verified !== true || !claims.email) {
    return fail("google_failed");
  }
  const lang = parseCookies(req.headers.get("cookie"))[HINT_LANG] || (String(claims.locale || "").startsWith("id") ? "id" : "en");
  try {
    const me = await U.googleSignIn({ email: String(claims.email), name: String(claims.name || ""), lang });
    return redirect(st.next, [...sessionCookies(me.user_id, me.username, me.language, true), `${STATE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`]);
  } catch {
    return fail("google_failed");
  }
}
