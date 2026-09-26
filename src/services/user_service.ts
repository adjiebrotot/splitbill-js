/**
 * services/user_service.ts — accounts: register, sign in, verify email,
 * settings. Adapted from finance-tracker registration_service without the
 * family model, and with an attempt limit on email codes.
 */
import { randomInt } from "node:crypto";
import { atomic, execute, fetchone } from "../db";
import { fail } from "../errors";
import { sha256 } from "../ids";
import { hashPassword, passwordProblem, verifyPassword } from "../password";
import { isCurrency, normCurrency } from "../engine";
import { cleanText, safeTimezone, DEFAULT_TZ } from "../utils";
import { emailConfigured, sendVerificationEmail } from "./email_service";
import { avatarStore, normalizeAvatar } from "./avatar";

export const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const RESEND_GAP_MS = 60 * 1000;

export interface Me {
  user_id: string;
  username: string;
  display_name: string;
  email: string | null;
  email_verified: boolean;
  /** false while no email provider is set up: nothing to confirm with. */
  email_sending: boolean;
  has_password: boolean;
  language: string;
  timezone: string;
  default_currency: string;
  telegram_linked: boolean;
  /** Uploaded photo (Vercel Blob URL); null draws initials. */
  avatar: string | null;
  /** false while no Blob store is set up: nowhere to keep a photo. */
  avatar_upload: boolean;
}

const ME_SQL = `SELECT user_id::text, username, display_name, email, email_verified, password IS NOT NULL,
  language, timezone, default_currency, telegram_id IS NOT NULL, avatar_url FROM users WHERE user_id = $1`;

function _me(r: unknown[]): Me {
  return {
    user_id: String(r[0]),
    username: String(r[1]),
    display_name: String(r[2]),
    email: r[3] === null ? null : String(r[3]),
    email_verified: r[4] === true || r[4] === "t",
    email_sending: emailConfigured(),
    has_password: r[5] === true || r[5] === "t",
    language: String(r[6]),
    timezone: String(r[7]),
    default_currency: String(r[8]),
    telegram_linked: r[9] === true || r[9] === "t",
    avatar: r[10] === null || r[10] === undefined ? null : String(r[10]),
    avatar_upload: avatarStore() !== null,
  };
}

export async function getMe(userId: string): Promise<Me | null> {
  const r = await fetchone(ME_SQL, [userId]);
  return r ? _me(r) : null;
}

let _dummy: string | null = null;
function _dummyHash(): string {
  return (_dummy ??= hashPassword(sha256(String(Math.random()))));
}

function _lang(v: unknown): "en" | "id" {
  return v === "id" ? "id" : "en";
}

async function _issueCode(userId: string, email: string, name: string, lang: "en" | "id", tz: string): Promise<void> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expires = new Date(Date.now() + CODE_TTL_MS);
  await execute(
    `INSERT INTO email_verifications (user_id, code_hash, expires_at, attempts, sent_at)
     VALUES ($1, $2, $3, 0, NOW())
     ON CONFLICT (user_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, sent_at = NOW()`,
    [userId, sha256(`${userId}:${code}`), expires],
  );
  if (!process.env.RESEND_API_KEY) console.log(`[email] verification code for ${email}: ${code}`);
  await sendVerificationEmail(email, code, name, lang, expires, tz);
}

export async function register(p: {
  username: unknown; display_name: unknown; email: unknown; password: unknown;
  language?: unknown; timezone?: unknown; currency?: unknown;
}): Promise<Me> {
  const username = String(p.username ?? "").trim();
  if (!USERNAME_RE.test(username)) fail("username_invalid");
  const display = cleanText(p.display_name, 40) || username;
  const email = String(p.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 200) fail("email_invalid");
  const pw = String(p.password ?? "");
  const weak = passwordProblem(pw);
  if (weak) fail(weak.replace(/^err\./, ""));
  const lang = _lang(p.language);
  const tz = safeTimezone(p.timezone) ?? DEFAULT_TZ;
  const ccy = isCurrency(p.currency) ? normCurrency(p.currency) : "IDR";

  const r = await atomic(async () => {
    if (await fetchone("SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)", [username])) fail("username_taken");
    if (await fetchone("SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)", [email])) fail("email_taken");
    return fetchone(
      `INSERT INTO users (username, display_name, email, password, language, timezone, default_currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING user_id::text`,
      [username, display, email, hashPassword(pw), lang, tz, ccy],
    );
  });
  const userId = String(r![0]);
  await _issueCode(userId, email, display, lang, tz);
  return (await getMe(userId))!;
}

/** Username or email + password. Same answer for "no such user" and "wrong password". */
export async function login(identifier: unknown, password: unknown): Promise<Me> {
  const id = String(identifier ?? "").trim();
  const pw = String(password ?? "");
  if (!id || !pw) fail("login_failed", {}, 401);
  const r = await fetchone(
    "SELECT user_id::text, password FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1) LIMIT 1",
    [id],
  );
  // Burn the same bcrypt time when the user is unknown, so timing reveals nothing.
  const hash = r && r[1] ? String(r[1]) : _dummyHash();
  const good = verifyPassword(pw, hash);
  if (!r || !r[1] || !good) fail("login_failed", {}, 401);
  return (await getMe(String(r[0])))!;
}

export async function verifyEmail(userId: string, code: unknown): Promise<Me> {
  const c = String(code ?? "").replace(/\D/g, "");
  // Spend an attempt FIRST, in its own auto-committed statement, so a wrong
  // guess can never be rolled back and five guesses lock the code for good.
  const r = await fetchone(
    `UPDATE email_verifications SET attempts = attempts + 1
      WHERE user_id = $1 AND attempts < $2 RETURNING code_hash, expires_at`,
    [userId, MAX_CODE_ATTEMPTS],
  );
  if (!r) {
    const exists = await fetchone("SELECT 1 FROM email_verifications WHERE user_id = $1", [userId]);
    fail(exists ? "code_locked" : "code_invalid");
  }
  if (new Date(r[1] as string).getTime() < Date.now()) fail("code_expired");
  if (c.length !== 6 || sha256(`${userId}:${c}`) !== String(r[0])) fail("code_invalid");
  await atomic(async () => {
    await execute("UPDATE users SET email_verified = TRUE WHERE user_id = $1", [userId]);
    await execute("DELETE FROM email_verifications WHERE user_id = $1", [userId]);
  });
  return (await getMe(userId))!;
}

export async function resendCode(userId: string): Promise<void> {
  const me = await getMe(userId);
  if (!me || !me.email) fail("email_invalid");
  if (me.email_verified) return;
  const r = await fetchone("SELECT sent_at FROM email_verifications WHERE user_id = $1", [userId]);
  if (r && Date.now() - new Date(r[0] as string).getTime() < RESEND_GAP_MS) fail("code_wait");
  await _issueCode(userId, me.email, me.display_name, _lang(me.language), me.timezone);
}

export async function updateSettings(userId: string, p: Record<string, unknown>): Promise<Me> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (p.display_name !== undefined) {
    const d = cleanText(p.display_name, 40);
    if (!d) fail("name_required");
    vals.push(d);
    sets.push(`display_name = $${vals.length}`);
  }
  if (p.language !== undefined) {
    vals.push(_lang(p.language));
    sets.push(`language = $${vals.length}`);
  }
  if (p.timezone !== undefined) {
    const tz = safeTimezone(p.timezone);
    if (!tz) fail("timezone_invalid");
    vals.push(tz);
    sets.push(`timezone = $${vals.length}`);
  }
  if (p.default_currency !== undefined) {
    if (!isCurrency(p.default_currency)) fail("currency_invalid");
    vals.push(normCurrency(p.default_currency));
    sets.push(`default_currency = $${vals.length}`);
  }
  if (sets.length) {
    vals.push(userId);
    await execute(`UPDATE users SET ${sets.join(", ")} WHERE user_id = $${vals.length}`, vals);
  }
  return (await getMe(userId))!;
}

export async function changePassword(userId: string, current: unknown, next: unknown): Promise<void> {
  const r = await fetchone("SELECT password FROM users WHERE user_id = $1", [userId]);
  if (!r) fail("login_failed", {}, 401);
  if (r[0] && !verifyPassword(String(current ?? ""), String(r[0]))) fail("password_wrong");
  const weak = passwordProblem(String(next ?? ""));
  if (weak) fail(weak.replace(/^err\./, ""));
  await execute("UPDATE users SET password = $1 WHERE user_id = $2", [hashPassword(String(next)), userId]);
}

/**
 * A new photo. The normalised square goes to Blob first; only once the row
 * points at it is the old file deleted (best effort: a leftover file costs
 * storage, a missing one would break the avatar).
 */
export async function setAvatar(userId: string, bytes: Uint8Array, mime: string): Promise<Me> {
  const store = avatarStore();
  if (!store) fail("avatar_unavailable");
  const webp = await normalizeAvatar(bytes, mime);
  const url = await store.put(`avatars/${userId}.webp`, webp, "image/webp");
  const r = await fetchone(
    `UPDATE users u SET avatar_url = $1 FROM (SELECT avatar_url FROM users WHERE user_id = $2 FOR UPDATE) old
      WHERE u.user_id = $2 RETURNING old.avatar_url`,
    [url, userId],
  );
  if (!r) {
    await store.del(url).catch(() => {});
    fail("login_failed", {}, 401);
  }
  if (r[0]) await store.del(String(r[0])).catch((e) => console.error("[avatar] delete", e));
  return (await getMe(userId))!;
}

/** Back to initials. */
export async function removeAvatar(userId: string): Promise<Me> {
  const r = await fetchone(
    `UPDATE users u SET avatar_url = NULL FROM (SELECT avatar_url FROM users WHERE user_id = $1 FOR UPDATE) old
      WHERE u.user_id = $1 RETURNING old.avatar_url`,
    [userId],
  );
  if (!r) fail("login_failed", {}, 401);
  const store = avatarStore();
  if (r[0] && store) await store.del(String(r[0])).catch((e) => console.error("[avatar] delete", e));
  return (await getMe(userId))!;
}

export async function findUserByUsername(username: unknown): Promise<{ user_id: string; username: string; display_name: string } | null> {
  const u = String(username ?? "").trim().replace(/^@/, "");
  if (!USERNAME_RE.test(u)) return null;
  const r = await fetchone("SELECT user_id::text, username, display_name FROM users WHERE LOWER(username) = LOWER($1)", [u]);
  return r ? { user_id: String(r[0]), username: String(r[1]), display_name: String(r[2]) } : null;
}


/**
 * Sign in with a Google-verified email. An existing account with that email
 * signs in (and counts as verified); a new email gets an account at once,
 * with a username made from the email and no password (Google only).
 */
export async function googleSignIn(p: { email: string; name: string; lang: unknown; timezone?: unknown }): Promise<Me> {
  const email = p.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) fail("email_invalid");
  const found = await fetchone("SELECT user_id::text FROM users WHERE LOWER(email) = $1", [email]);
  if (found) {
    await execute("UPDATE users SET email_verified = TRUE WHERE user_id = $1", [found[0]]);
    await execute("DELETE FROM email_verifications WHERE user_id = $1", [found[0]]);
    return (await getMe(String(found[0])))!;
  }
  const base = (email.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 24) || "user").padEnd(3, "_");
  const display = cleanText(p.name, 40) || base;
  const lang = _lang(p.lang);
  const tz = safeTimezone(p.timezone) ?? DEFAULT_TZ;
  return atomic(async () => {
    let username = base;
    for (let i = 2; await fetchone("SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)", [username]); i++) username = `${base.slice(0, 28)}${i}`;
    const r = await fetchone(
      `INSERT INTO users (username, display_name, email, email_verified, password, language, timezone)
       VALUES ($1, $2, $3, TRUE, NULL, $4, $5) RETURNING user_id::text`,
      [username, display, email, lang, tz],
    );
    return (await getMe(String(r![0])))!;
  });
}
