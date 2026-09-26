/**
 * services/admin_actions.ts — the admin console's one entry point, as
 * actions.ts is for members. Adapted from finance-tracker admin_actions.ts.
 *
 * The admin routes (webapp/admin_routes.ts) call only this file. Anything
 * that touches a group's books goes through actions.ts (ownership handover
 * on delete), so the same lock / log / revision / verify gate applies.
 *
 *   - Database: read-only browsing. Bearer secrets are masked.
 *   - Users: list, create, edit, reset password, unlink Telegram, delete.
 *   - System: migrations, Telegram webhook, cleanup, books check, env.
 */
import { atomic, execute, fetchall, fetchone } from "../db";
import { fail } from "../errors";
import { randomCode } from "../ids";
import { hashPassword, passwordProblem } from "../password";
import { isCurrency, normCurrency } from "../engine";
import { cleanText, safeTimezone, DEFAULT_TZ } from "../utils";
import { t } from "../i18n";
import * as A from "./actions";
import { USERNAME_RE } from "./user_service";
import { avatarStore } from "./avatar";
import { MigrationError, migrationStatus, runMigrations } from "./migrate";
import { loadGroups } from "./repo";
import { compute, stageFor, type Stage } from "./ledger";

type Dict = Record<string, unknown>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function _bool(v: unknown): boolean {
  return v === true || v === "t" || v === "true" || v === 1 || v === "1";
}

function _int(v: unknown, def: number, min: number, max: number): number {
  const n = parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// ── database viewer (read-only) ─────────────────────────────────────────────

/** Core tables first, in the order a reader follows the schema. */
const TABLE_ORDER = [
  "users", "groups", "members", "bills", "bill_items", "bill_item_members", "bill_adjustments",
  "bill_participants", "payments", "settlement_transfers", "settlement_rounds", "fx_rates",
  "group_events", "drafts", "ai_usage", "email_verifications", "telegram_link_codes",
  "telegram_chats", "telegram_pending", "telegram_updates", "schema_migrations",
];

/** Columns that hold a password hash or a bearer secret: shown as set / empty only. */
const MASKED: Record<string, string[]> = {
  users: ["password"],
  email_verifications: ["code_hash"],
  telegram_link_codes: ["code"],
  groups: ["invite_code"],
};

export const MASK = "(hidden)";

async function _tables(): Promise<string[]> {
  const rows = await fetchall(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
  );
  const names = rows.map((r) => String(r[0]));
  const known = TABLE_ORDER.filter((n) => names.includes(n));
  return [...known, ...names.filter((n) => !TABLE_ORDER.includes(n)).sort()];
}

function _ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export async function dbTables() {
  const tables = await _tables();
  const out: Array<{ table: string; rows: number }> = [];
  for (const tb of tables) {
    const r = await fetchone(`SELECT COUNT(*) FROM ${_ident(tb)}`);
    out.push({ table: tb, rows: Number(r?.[0] ?? 0) });
  }
  return out;
}

function _cell(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export async function dbRows(p: { table: unknown; page?: unknown; per_page?: unknown }) {
  const table = String(p.table ?? "");
  // Whitelist against the live schema: the name is interpolated below.
  if (!(await _tables()).includes(table)) fail("not_found", {}, 404);
  const perPage = [25, 50, 100, 250].includes(Number(p.per_page)) ? Number(p.per_page) : 50;
  const cols = (await fetchall(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  )).map((r) => String(r[0]));
  const pk = (await fetchall(
    `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey::int2[], a.attnum)`,
    [_ident(table)],
  )).map((r) => String(r[0]));
  const total = Number((await fetchone(`SELECT COUNT(*) FROM ${_ident(table)}`))?.[0] ?? 0);
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = _int(p.page, 1, 1, pages);
  const order = pk.length ? pk.map((c) => `${_ident(c)} DESC`).join(", ") : "ctid DESC";
  const rows = await fetchall(
    `SELECT ${cols.map(_ident).join(", ")} FROM ${_ident(table)} ORDER BY ${order} LIMIT $1 OFFSET $2`,
    [perPage, (page - 1) * perPage],
  );
  const masked = new Set(MASKED[table] ?? []);
  return {
    table,
    columns: cols,
    masked: [...masked],
    pk,
    rows: rows.map((r) => r.map((v, i) => (masked.has(cols[i]) ? (v === null ? null : MASK) : _cell(v)))),
    total,
    page,
    pages,
    per_page: perPage,
  };
}

// ── users ───────────────────────────────────────────────────────────────────

const USER_COLS = `u.user_id::text, u.username, u.display_name, u.email, u.email_verified, u.password IS NOT NULL,
  u.telegram_id::text, u.language, u.timezone, u.default_currency, u.created_at,
  (SELECT COUNT(*) FROM members m JOIN groups g ON g.group_id = m.group_id
    WHERE m.user_id = u.user_id AND g.deleted_at IS NULL),
  (SELECT COUNT(*) FROM groups g WHERE g.owner_user_id = u.user_id AND g.deleted_at IS NULL)`;

function _user(r: unknown[]) {
  return {
    user_id: String(r[0]),
    username: String(r[1]),
    display_name: String(r[2]),
    email: r[3] === null ? null : String(r[3]),
    email_verified: _bool(r[4]),
    has_password: _bool(r[5]),
    telegram_id: r[6] === null ? null : String(r[6]),
    language: String(r[7]),
    timezone: String(r[8]),
    default_currency: String(r[9]).trim(),
    created_at: _cell(r[10]),
    groups: Number(r[11]),
    owned: Number(r[12]),
  };
}

export type AdminUser = ReturnType<typeof _user>;

async function _getUser(userId: unknown): Promise<AdminUser> {
  const id = String(userId ?? "");
  if (!/^\d{1,19}$/.test(id)) fail("admin_user_missing", {}, 404);
  const r = await fetchone(`SELECT ${USER_COLS} FROM users u WHERE u.user_id = $1`, [id]);
  if (!r) fail("admin_user_missing", {}, 404);
  return _user(r);
}

export async function listUsers(p: { q?: unknown; page?: unknown }) {
  const perPage = 50;
  const q = String(p.q ?? "").trim().slice(0, 100);
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%` : "";
  const where = q ? "WHERE u.username ILIKE $1 OR u.display_name ILIKE $1 OR u.email ILIKE $1 OR u.user_id::text = $2" : "";
  const args = q ? [like, q] : [];
  const total = Number((await fetchone(`SELECT COUNT(*) FROM users u ${where}`, args))?.[0] ?? 0);
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = _int(p.page, 1, 1, pages);
  const n = args.length;
  const rows = await fetchall(
    `SELECT ${USER_COLS} FROM users u ${where} ORDER BY u.user_id DESC LIMIT $${n + 1} OFFSET $${n + 2}`,
    [...args, perPage, (page - 1) * perPage],
  );
  return { users: rows.map(_user), total, page, pages, per_page: perPage };
}

/** One user, with the splits they are in and what a delete would do. */
export async function getUser(p: { user_id: unknown }) {
  const user = await _getUser(p.user_id);
  const groups = (await fetchall(
    `SELECT g.group_id, g.name, g.kind, g.status, g.owner_user_id = $1, m.display_name, m.active, g.deleted_at IS NOT NULL
       FROM members m JOIN groups g ON g.group_id = m.group_id
      WHERE m.user_id = $1 ORDER BY g.created_at DESC LIMIT 200`,
    [user.user_id],
  )).map((r) => ({
    group_id: String(r[0]), name: String(r[1]), kind: String(r[2]), status: String(r[3]),
    owner: _bool(r[4]), member_name: String(r[5]), active: _bool(r[6]), deleted: _bool(r[7]),
    stage: "open" as Stage,
  }));
  // The same stage the member sees (open / final / settled).
  const states = await loadGroups(groups.filter((g) => !g.deleted).map((g) => g.group_id));
  for (const g of groups) {
    const s = states.get(g.group_id);
    if (s) g.stage = stageFor(s, compute(s));
  }
  return { user, groups, handover: await A.ownershipHandover(user.user_id) };
}

/** Readable, meets passwordProblem() (the dashes are the symbol). */
function _tempPassword(): string {
  return `${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;
}

function _email(v: unknown): string | null {
  const e = String(v ?? "").trim().toLowerCase();
  if (!e) return null;
  if (!EMAIL_RE.test(e) || e.length > 200) fail("email_invalid");
  return e;
}

export async function createUser(p: Dict) {
  const username = String(p.username ?? "").trim();
  if (!USERNAME_RE.test(username)) fail("username_invalid");
  const display = cleanText(p.display_name, 40) || username;
  const email = _email(p.email);
  let password = String(p.password ?? "");
  const generated = !password;
  if (generated) password = _tempPassword();
  const weak = passwordProblem(password);
  if (weak) fail(weak.replace(/^err\./, ""));
  const lang = p.language === "id" ? "id" : "en";
  let tz = DEFAULT_TZ;
  if (p.timezone) tz = safeTimezone(p.timezone) ?? fail("timezone_invalid");
  let ccy = "IDR";
  if (p.default_currency) {
    if (!isCurrency(p.default_currency)) fail("currency_invalid");
    ccy = normCurrency(p.default_currency);
  }
  const verified = !!email && _bool(p.email_verified);
  const r = await atomic(async () => {
    if (await fetchone("SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)", [username])) fail("username_taken");
    if (email && (await fetchone("SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)", [email]))) fail("email_taken");
    return fetchone(
      `INSERT INTO users (username, display_name, email, email_verified, password, language, timezone, default_currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING user_id::text`,
      [username, display, email, verified, hashPassword(password), lang, tz, ccy],
    );
  });
  return { user: await _getUser(r![0]), password: generated ? password : null };
}

export async function updateUser(p: Dict) {
  const user = await _getUser(p.user_id);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (p.display_name !== undefined) {
    const d = cleanText(p.display_name, 40);
    if (!d) fail("name_required");
    set("display_name", d);
  }
  let email = user.email;
  if (p.email !== undefined) {
    email = _email(p.email);
    if (email && email !== user.email) {
      const dup = await fetchone("SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) AND user_id <> $2", [email, user.user_id]);
      if (dup) fail("email_taken");
    }
    set("email", email);
  }
  if (p.email_verified !== undefined || p.email !== undefined) {
    set("email_verified", !!email && _bool(p.email_verified ?? (email === user.email && user.email_verified)));
  }
  if (p.language !== undefined) set("language", p.language === "id" ? "id" : "en");
  if (p.timezone !== undefined) set("timezone", safeTimezone(p.timezone) ?? fail("timezone_invalid"));
  if (p.default_currency !== undefined) {
    if (!isCurrency(p.default_currency)) fail("currency_invalid");
    set("default_currency", normCurrency(p.default_currency));
  }
  if (sets.length) {
    vals.push(user.user_id);
    await execute(`UPDATE users SET ${sets.join(", ")} WHERE user_id = $${vals.length}`, vals);
    if (!email || (p.email_verified !== undefined && _bool(p.email_verified))) {
      await execute("DELETE FROM email_verifications WHERE user_id = $1", [user.user_id]);
    }
  }
  return _getUser(user.user_id);
}

/**
 * New random password, shown once to the admin and, when the account has
 * Telegram linked, sent there in the user's language.
 */
export async function resetPassword(p: { user_id: unknown }) {
  const user = await _getUser(p.user_id);
  const password = _tempPassword();
  await execute("UPDATE users SET password = $1 WHERE user_id = $2", [hashPassword(password), user.user_id]);
  let telegram: "sent" | "failed" | "not_linked" = "not_linked";
  if (user.telegram_id) {
    const { sendMessage } = await import("../telegram/api");
    const r = await sendMessage(Number(user.telegram_id), t("tg.admin_pw_reset", user.language, { password }));
    telegram = r && r.ok ? "sent" : "failed";
  }
  return { password, telegram };
}

export async function unlinkTelegram(p: { user_id: unknown }) {
  const user = await _getUser(p.user_id);
  await A.telegramUnlink({ user_id: user.user_id });
  return _getUser(user.user_id);
}

/**
 * Delete an account. Its member rows stay as plain names (the books do not
 * change); each split it owns passes to its next linked, active member, and
 * the delete is refused when a split has nobody to take over.
 */
export async function deleteUser(p: { user_id: unknown; confirm: unknown }) {
  const user = await _getUser(p.user_id);
  if (String(p.confirm ?? "").trim().toLowerCase() !== user.username.toLowerCase()) fail("admin_confirm_mismatch");
  const out = await atomic(async () => {
    const handover = await A.adminHandOverGroups(user.user_id);
    const r = await fetchone("DELETE FROM users WHERE user_id = $1 RETURNING avatar_url", [user.user_id]);
    return { deleted: user.username, handover, avatar: r?.[0] ? String(r[0]) : null };
  });
  // The photo goes with the account, once the delete has committed.
  const store = avatarStore();
  if (out.avatar && store) await store.del(out.avatar).catch((e) => console.error("[avatar] delete", e));
  return { deleted: out.deleted, handover: out.handover };
}

// ── system ──────────────────────────────────────────────────────────────────

/** Names only. A value is never read out, only whether it is set. */
const ENV_VARS = [
  "DATABASE_URL", "DB_DRIVER", "SETUP_SECRET", "ADMIN_PASSWORD", "PUBLIC_BASE_URL", "CRON_SECRET",
  "LLM_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "RESEND_API_KEY", "EMAIL_FROM",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "USER_TIMEZONE", "AI_DAILY_LIMIT", "BLOB_READ_WRITE_TOKEN",
];

export async function systemStatus() {
  return {
    migrations: await migrationStatus(),
    env: ENV_VARS.map((name) => ({ name, set: !!process.env[name] })),
  };
}

export async function applyMigrations() {
  const applied = await runMigrations().catch((e) => {
    // Admin-only screen: show Postgres's own message so the cause is visible.
    if (e instanceof MigrationError) {
      console.error("[migrate]", e.cause);
      fail("migration_failed", { name: e.migration, detail: e.detail }, 500);
    }
    throw e;
  });
  return { applied, migrations: await migrationStatus() };
}

export async function telegramSetup() {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!base) fail("admin_no_base_url");
  if (!process.env.TELEGRAM_BOT_TOKEN) fail("telegram_unavailable");
  const { setup } = await import("../telegram/api");
  return setup(`${base}/webhook`);
}

export async function runCleanup() {
  return A.cleanup();
}

/**
 * Read-only books check over every live split: each bill and payment
 * converts, balances sum to zero, and a settled split's balances equal its
 * unpaid transfers. The same rules actions.ts enforces after every write.
 */
export async function integrityCheck() {
  const ids = (await fetchall("SELECT group_id FROM groups WHERE deleted_at IS NULL ORDER BY created_at")).map((r) => String(r[0]));
  const problems: Array<{ group_id: string; name: string; status: string; issue: string }> = [];
  for (let i = 0; i < ids.length; i += 100) {
    const states = await loadGroups(ids.slice(i, i + 100));
    for (const s of states.values()) {
      const add = (issue: string) => problems.push({ group_id: s.group.group_id, name: s.group.name, status: s.group.status, issue });
      let out;
      try {
        out = compute(s);
      } catch (e) {
        add(`engine: ${(e as Error).message}`);
        continue;
      }
      for (const b of out.bills) if (b.error) add(`bill ${b.id}: ${b.error.code}`);
      for (const p of out.payments) if (p.error) add(`payment ${p.id}: ${p.error.code}`);
      const sum = out.balances.reduce((a, b) => a + b.net, 0n);
      if (sum !== 0n) add(`balances sum to ${sum}, not 0`);
      if (s.group.status === "settled") {
        const pending = new Map<string, bigint>();
        for (const tr of s.transfers) {
          if (tr.status !== "pending") continue;
          pending.set(tr.from, (pending.get(tr.from) ?? 0n) - BigInt(tr.amount));
          pending.set(tr.to, (pending.get(tr.to) ?? 0n) + BigInt(tr.amount));
        }
        for (const b of out.balances) {
          if (b.net !== (pending.get(b.id) ?? 0n)) add(`member ${b.id}: balance ${b.net} but unpaid transfers ${pending.get(b.id) ?? 0n}`);
        }
      }
    }
  }
  return { checked: ids.length, problems };
}
