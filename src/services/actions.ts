/**
 * services/actions.ts — the ONLY entry point for Split Bill operations.
 *
 * Web API, Telegram and any future client normalize their input into a plain
 * params object and call a function here. Every write:
 *
 *   1. runs inside atomic() and locks the group row first (FOR UPDATE), so a
 *      bill save and a settle can never interleave;
 *   2. checks permissions and the group status after the lock;
 *   3. validates through the engine (the same code the browser previews with);
 *   4. writes, logs a group_event, bumps groups.revision;
 *   5. reloads the group and recomputes it, and refuses to commit unless every
 *      bill and payment still converts and the books balance.
 *
 * Postgres re-checks each bill again at COMMIT (deferred triggers).
 */
import { atomic, execute, fetchall, fetchone } from "../db";
import { ActionError, err, fail, ok, type Result } from "../errors";
import {
  ADJ_KINDS, allocate, EngineError, ENGINE_VERSION, isCurrency, minorUnits, normCurrency, parseMinor,
  type AdjKind, type BillIn,
} from "../engine";
import { newGroupId, newInviteCode } from "../ids";
import { addDays, cleanText, isDate, localDate, safeTimezone, DEFAULT_TZ } from "../utils";
import { compute, viewOf, type GroupView } from "./ledger";
import { loadGroup, loadGroups, lockGroup, type GroupState, type MemberRow } from "./repo";
import { findUserByUsername, getMe } from "./user_service";

export type Params = Record<string, unknown>;

// ── plumbing ────────────────────────────────────────────────────────────────

const PG_UNIQUE: Record<string, string> = {
  members_name: "member_name_taken",
  members_user: "member_already",
  payments_one_per_transfer: "already_paid",
  users_username_lower: "username_taken",
  users_email_lower: "email_taken",
};

/** Run an action, turning every known failure into an Err result. */
export async function run<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof ActionError) return err(e.code, e.params, e.status);
    if (e instanceof __AuthError) return err("login_required", {}, 401);
    if (e instanceof EngineError) return err(e.code, e.params, e.code.startsWith("internal") ? 500 : 400);
    const pg = e as { code?: string; hint?: string; constraint?: string };
    if (pg && pg.code === "P0001" && pg.hint) return err(pg.hint, {}, pg.hint === "group_settled" ? 409 : 400);
    if (pg && pg.code === "23505" && pg.constraint && PG_UNIQUE[pg.constraint]) return err(PG_UNIQUE[pg.constraint], {}, 409);
    if (pg && pg.code === "23503") return err("member_unknown");
    console.error("[action]", e);
    return err("internal", {}, 500);
  }
}

interface Ctx {
  userId: string;
  s: GroupState;
  me: MemberRow | null;
  isOwner: boolean;
  log: (action: string, entity: string, entityId: string | null, data?: unknown) => Promise<void>;
}

async function _event(groupId: string, userId: string | null, action: string, entity: string, entityId: string | null, data?: unknown) {
  await execute(
    "INSERT INTO group_events (group_id, user_id, action, entity, entity_id, data) VALUES ($1, $2, $3, $4, $5, $6)",
    [groupId, userId, action, entity, entityId, data === undefined ? null : JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v))],
  );
}

function _meOf(s: GroupState, userId: string): MemberRow | null {
  return s.members.find((m) => m.user_id === userId) ?? null;
}

/** Lock, load, check membership, run `fn`, bump revision, re-verify books. */
async function write<T>(userId: string, groupId: unknown, fn: (c: Ctx) => Promise<T>, opts: { expectedRevision?: unknown } = {}): Promise<T> {
  const gid = String(groupId ?? "");
  return atomic(async () => {
    const lock = await lockGroup(gid);
    if (!lock) fail("group_not_found", {}, 404);
    if (opts.expectedRevision !== undefined && String(opts.expectedRevision) !== lock.revision) fail("stale_revision", {}, 409);
    const s = (await loadGroup(gid))!;
    const me = _meOf(s, userId);
    if (!me) fail("group_not_found", {}, 404);
    const ctx: Ctx = {
      userId, s, me, isOwner: s.group.owner === userId,
      log: (action, entity, entityId, data) => _event(gid, userId, action, entity, entityId, data),
    };
    const result = await fn(ctx);
    await execute("UPDATE groups SET revision = revision + 1 WHERE group_id = $1", [gid]);
    await _verify(gid);
    return result;
  });
}

/**
 * The post-write gate. Every bill and payment must convert, balances must sum
 * to zero, and a settled group's balances must equal its unpaid transfers.
 */
async function _verify(gid: string): Promise<void> {
  const s = await loadGroup(gid);
  if (!s) return;
  const out = compute(s);
  for (const b of out.bills) if (b.error) throw b.error;
  for (const p of out.payments) if (p.error) throw p.error;
  if (s.group.status === "settled") {
    const pending = new Map<string, bigint>();
    for (const t of s.transfers) {
      if (t.status !== "pending") continue;
      pending.set(t.from, (pending.get(t.from) ?? 0n) - BigInt(t.amount));
      pending.set(t.to, (pending.get(t.to) ?? 0n) + BigInt(t.amount));
    }
    for (const b of out.balances) {
      if (b.net !== (pending.get(b.id) ?? 0n)) fail("internal_settled_mismatch", {}, 500);
    }
  }
}

function _requireOwner(c: Ctx): void {
  if (!c.isOwner) fail("owner_only", {}, 403);
}

function _requireOpen(c: Ctx): void {
  if (c.s.group.status !== "open") fail("group_settled", {}, 409);
}

function _member(c: Ctx, id: unknown): MemberRow {
  const m = c.s.members.find((x) => x.id === String(id ?? ""));
  if (!m) fail("member_unknown");
  return m;
}

function _today(c: Ctx): string {
  return localDate(c.s.group.timezone);
}

// ── reads ───────────────────────────────────────────────────────────────────

export async function getGroupView(p: { user_id: string; group_id: unknown }): Promise<GroupView> {
  const s = await loadGroup(String(p.group_id ?? ""));
  if (!s || !_meOf(s, p.user_id)) fail("group_not_found", {}, 404);
  return viewOf(s, compute(s), p.user_id);
}

export async function listMyGroups(p: { user_id: string }) {
  const rows = await fetchall(
    `SELECT g.group_id FROM groups g JOIN members m ON m.group_id = g.group_id
      WHERE m.user_id = $1 AND g.deleted_at IS NULL ORDER BY g.created_at DESC LIMIT 200`,
    [p.user_id],
  );
  const states = await loadGroups(rows.map((r) => String(r[0])));
  const out = [];
  for (const r of rows) {
    const s = states.get(String(r[0]));
    if (!s) continue;
    const c = compute(s);
    const me = _meOf(s, p.user_id)!;
    out.push({
      group_id: s.group.group_id,
      kind: s.group.kind,
      name: s.group.name,
      currency: s.group.currency,
      dp: s.group.dp,
      status: s.group.status,
      members: s.members.filter((m) => m.active).length,
      bills: s.bills.length,
      spent: c.spent,
      my_net: c.balances.find((b) => b.id === me.id)?.net ?? 0n,
      created_at: s.group.created_at,
    });
  }
  return out;
}

// ── groups ──────────────────────────────────────────────────────────────────

export async function createGroup(p: { user_id: string } & Params) {
  const kind = p.kind === "travel" ? "travel" : p.kind === "one_off" ? "one_off" : fail("kind_invalid");
  const name = cleanText(p.name, 80);
  if (!name) fail("name_required");
  const currency = normCurrency(p.currency);
  if (!isCurrency(currency)) fail("currency_invalid");
  const me = await getMe(p.user_id);
  if (!me) fail("login_required", {}, 401);
  const tz = safeTimezone(p.timezone) ?? me.timezone ?? DEFAULT_TZ;
  const people = Array.isArray(p.members) ? (p.members as unknown[]).slice(0, 50) : [];

  return atomic(async () => {
    const gid = newGroupId();
    await execute(
      `INSERT INTO groups (group_id, kind, name, owner_user_id, currency, minor_units, timezone, invite_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [gid, kind, name, p.user_id, currency, minorUnits(currency), tz, kind === "travel" ? newInviteCode() : null],
    );
    await execute("INSERT INTO members (group_id, display_name, user_id, position) VALUES ($1, $2, $3, 1)", [gid, me.display_name, p.user_id]);
    let pos = 1;
    const taken = new Set([me.display_name.toLowerCase()]);
    for (const raw of people) {
      const entry = (typeof raw === "object" && raw ? raw : { name: raw }) as Params;
      let userId: string | null = null;
      let display = cleanText(entry.name, 40);
      if (entry.username) {
        const u = await findUserByUsername(entry.username);
        if (!u) fail("user_not_found", { username: String(entry.username) });
        if (u.user_id === p.user_id) continue;
        userId = u.user_id;
        display = display || u.display_name;
      }
      if (!display) continue;
      if (taken.has(display.toLowerCase())) fail("member_name_taken", { name: display });
      taken.add(display.toLowerCase());
      pos += 1;
      await execute("INSERT INTO members (group_id, display_name, user_id, position) VALUES ($1, $2, $3, $4)", [gid, display, userId, pos]);
    }
    await _event(gid, p.user_id, "create", "group", gid, { kind, name, currency });
    return { group_id: gid };
  });
}

export async function renameGroup(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    _requireOwner(c);
    const name = cleanText(p.name, 80);
    if (!name) fail("name_required");
    await execute("UPDATE groups SET name = $1 WHERE group_id = $2", [name, c.s.group.group_id]);
    await c.log("rename", "group", c.s.group.group_id, { from: c.s.group.name, to: name });
    return { name };
  });
}

export async function deleteGroup(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    _requireOwner(c);
    await execute("UPDATE groups SET deleted_at = NOW(), invite_code = NULL WHERE group_id = $1", [c.s.group.group_id]);
    await execute("DELETE FROM telegram_chats WHERE group_id = $1", [c.s.group.group_id]);
    await c.log("delete", "group", c.s.group.group_id);
    return { deleted: true };
  });
}

export async function resetInvite(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    _requireOwner(c);
    if (c.s.group.kind !== "travel") fail("kind_invalid");
    const code = newInviteCode();
    await execute("UPDATE groups SET invite_code = $1 WHERE group_id = $2", [code, c.s.group.group_id]);
    await c.log("reset_invite", "group", c.s.group.group_id);
    return { invite_code: code };
  });
}

/** Look up an invite before joining (shows the group name). */
export async function peekInvite(p: { user_id: string; code: unknown }) {
  const r = await fetchone(
    "SELECT group_id, name, status FROM groups WHERE invite_code = $1 AND deleted_at IS NULL AND kind = 'travel'",
    [String(p.code ?? "")],
  );
  if (!r) fail("invite_invalid", {}, 404);
  const member = await fetchone("SELECT 1 FROM members WHERE group_id = $1 AND user_id = $2", [r[0], p.user_id]);
  return { group_id: String(r[0]), name: String(r[1]), status: String(r[2]), already: !!member };
}

export async function joinByInvite(p: { user_id: string; code: unknown }) {
  const me = await getMe(p.user_id);
  if (!me) fail("login_required", {}, 401);
  const r = await fetchone("SELECT group_id FROM groups WHERE invite_code = $1 AND deleted_at IS NULL AND kind = 'travel'", [String(p.code ?? "")]);
  if (!r) fail("invite_invalid", {}, 404);
  const gid = String(r[0]);
  return atomic(async () => {
    const lock = await lockGroup(gid);
    if (!lock) fail("invite_invalid", {}, 404);
    const s = (await loadGroup(gid))!;
    if (_meOf(s, p.user_id)) return { group_id: gid, already: true };
    const names = new Set(s.members.filter((m) => m.active).map((m) => m.name.toLowerCase()));
    let display = me.display_name;
    for (let i = 2; names.has(display.toLowerCase()); i++) display = `${me.display_name.slice(0, 36)} ${i}`;
    const pos = Math.max(0, ...s.members.map((m) => m.position)) + 1;
    const m = await fetchone(
      "INSERT INTO members (group_id, display_name, user_id, position) VALUES ($1, $2, $3, $4) RETURNING member_id::text",
      [gid, display, p.user_id, pos],
    );
    await execute("UPDATE groups SET revision = revision + 1 WHERE group_id = $1", [gid]);
    await _event(gid, p.user_id, "join", "member", String(m![0]));
    return { group_id: gid, already: false };
  });
}

// ── members ─────────────────────────────────────────────────────────────────

export async function addMember(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    _requireOwner(c);
    let userId: string | null = null;
    let display = cleanText(p.name, 40);
    if (p.username) {
      const u = await findUserByUsername(p.username);
      if (!u) fail("user_not_found", { username: String(p.username) });
      if (c.s.members.some((m) => m.user_id === u.user_id)) fail("member_already");
      userId = u.user_id;
      display = display || u.display_name;
    }
    if (!display) fail("name_required");
    const pos = Math.max(0, ...c.s.members.map((m) => m.position)) + 1;
    const r = await fetchone(
      "INSERT INTO members (group_id, display_name, user_id, position) VALUES ($1, $2, $3, $4) RETURNING member_id::text",
      [c.s.group.group_id, display, userId, pos],
    );
    await c.log("add", "member", String(r![0]), { name: display, user_id: userId });
    return { member_id: String(r![0]) };
  });
}

export async function renameMember(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    const m = _member(c, p.member_id);
    if (!c.isOwner && m.user_id !== c.userId) fail("owner_only", {}, 403);
    const name = cleanText(p.name, 40);
    if (!name) fail("name_required");
    await execute("UPDATE members SET display_name = $1 WHERE member_id = $2", [name, m.id]);
    await c.log("rename", "member", m.id, { from: m.name, to: name });
    return { name };
  });
}

async function _hasActivity(groupId: string, memberId: string): Promise<boolean> {
  const r = await fetchone(
    `SELECT EXISTS (SELECT 1 FROM bills WHERE group_id = $1 AND payer_member_id = $2)
         OR EXISTS (SELECT 1 FROM bill_item_members WHERE group_id = $1 AND member_id = $2)
         OR EXISTS (SELECT 1 FROM bill_participants WHERE group_id = $1 AND member_id = $2)
         OR EXISTS (SELECT 1 FROM payments WHERE group_id = $1 AND (from_member = $2 OR to_member = $2))
         OR EXISTS (SELECT 1 FROM settlement_transfers WHERE group_id = $1 AND (from_member = $2 OR to_member = $2))`,
    [groupId, memberId],
  );
  return r?.[0] === true || r?.[0] === "t";
}

/** No history: deleted. History: deactivated (hidden, still in the books). */
export async function removeMember(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    _requireOwner(c);
    const m = _member(c, p.member_id);
    if (m.user_id === c.s.group.owner) fail("owner_cannot_leave");
    if (await _hasActivity(c.s.group.group_id, m.id)) {
      await execute("UPDATE members SET active = FALSE WHERE member_id = $1", [m.id]);
      await c.log("deactivate", "member", m.id);
      return { removed: false, deactivated: true };
    }
    await execute("DELETE FROM members WHERE member_id = $1", [m.id]);
    await c.log("remove", "member", m.id, { name: m.name });
    return { removed: true, deactivated: false };
  });
}

export async function reactivateMember(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    _requireOwner(c);
    const m = _member(c, p.member_id);
    await execute("UPDATE members SET active = TRUE WHERE member_id = $1", [m.id]);
    await c.log("reactivate", "member", m.id);
    return { active: true };
  });
}

/**
 * Link a dummy to the app user behind another member row of this group. The
 * dummy keeps its member id, so no amount moves. The user's own row must have
 * no history (a merge could put one person twice on one item).
 */
export async function linkMember(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    _requireOwner(c);
    const dummy = _member(c, p.member_id);
    const target = _member(c, p.target_member_id);
    if (dummy.user_id) fail("link_not_dummy");
    if (!target.user_id || target.id === dummy.id) fail("link_target_invalid");
    if (target.user_id === c.s.group.owner) fail("link_target_invalid");
    if (await _hasActivity(c.s.group.group_id, target.id)) fail("link_target_has_history");
    await execute("DELETE FROM members WHERE member_id = $1", [target.id]);
    await execute("UPDATE members SET user_id = $1, active = TRUE WHERE member_id = $2", [target.user_id, dummy.id]);
    await c.log("link", "member", dummy.id, { user_id: target.user_id, dropped: target.id });
    return { member_id: dummy.id };
  });
}

// ── bills ───────────────────────────────────────────────────────────────────

interface CleanBill {
  description: string;
  date: string;
  currency: string;
  dp: number;
  mode: "items" | "even" | "percent";
  payer: string;
  total: bigint;
  stated: bigint | null;
  items: { name: string; qty: string; amount: bigint; members: string[] }[];
  adjustments: { kind: AdjKind; amount: bigint }[];
  participants: { member: string; bp: number | null }[];
  source: "form" | "chat" | "photo" | "telegram";
}

function _qty(v: unknown): string {
  const s = String(v ?? "1").trim().replace(",", ".");
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(s) || Number(s) <= 0) fail("qty_invalid");
  return s;
}

/** Normalize API/bot input into a bill and validate it with the engine. */
export function cleanBill(p: Params, c: { s: GroupState; today: string }): { bill: CleanBill; engine: BillIn } {
  const description = cleanText(p.description, 120);
  if (!description) fail("description_required");
  const date = String(p.date ?? "");
  if (!isDate(date)) fail("date_invalid");
  if (date > addDays(c.today, 1)) fail("date_future");
  const currency = normCurrency(p.currency ?? c.s.group.currency);
  if (!isCurrency(currency)) fail("currency_invalid");
  const dp = minorUnits(currency);
  const mode = p.mode === "items" || p.mode === "even" || p.mode === "percent" ? p.mode : fail("mode_invalid");
  const payer = String(p.payer ?? "");
  const src = String(p.source ?? "form");
  const source = (["form", "chat", "photo", "telegram"].includes(src) ? src : "form") as CleanBill["source"];

  const rawItems = Array.isArray(p.items) ? (p.items as Params[]) : [];
  const rawAdj = Array.isArray(p.adjustments) ? (p.adjustments as Params[]) : [];
  const rawParts = Array.isArray(p.participants) ? (p.participants as Params[]) : [];
  if (rawItems.length > 200 || rawAdj.length > 20 || rawParts.length > 200) fail("bill_too_big");

  const items = mode === "items"
    ? rawItems.map((it, i) => ({
        name: cleanText(it.name, 120) || `#${i + 1}`,
        qty: _qty(it.qty),
        amount: parseMinor(it.amount, { allowZero: true }),
        members: (Array.isArray(it.members) ? it.members : []).map((m) => String(m)),
      }))
    : [];
  const adjustments = mode === "items"
    ? rawAdj.map((a) => {
        const kind = String(a.kind) as AdjKind;
        if (!ADJ_KINDS.includes(kind)) fail("adjustment_invalid");
        return { kind, amount: parseMinor(a.amount, { allowNegative: true }) };
      })
    : [];
  const participants = mode === "items"
    ? []
    : rawParts.map((x) => ({ member: String(x.member ?? ""), bp: mode === "percent" ? Number(x.bp) : null }));

  const engine: BillIn = {
    payer,
    mode,
    total: mode === "items" ? undefined : parseMinor(p.total),
    items: items.map((i) => ({ name: i.name, amount: i.amount, members: i.members })),
    adjustments,
    participants: participants.map((x) => ({ member: x.member, bp: x.bp ?? undefined })),
  };
  const order = new Map(c.s.members.map((m) => [m.id, m.position]));
  const alloc = allocate(engine, order);
  const stated = p.stated_total === null || p.stated_total === undefined || p.stated_total === "" ? null : parseMinor(p.stated_total);
  if (stated !== null && stated !== alloc.total) {
    fail("stated_total_mismatch", { diff: (stated - alloc.total).toString(), dp });
  }
  return {
    bill: { description, date, currency, dp, mode, payer, total: alloc.total, stated, items, adjustments, participants, source },
    engine,
  };
}

function _billMembers(b: CleanBill): Set<string> {
  const s = new Set<string>([b.payer]);
  for (const i of b.items) for (const m of i.members) s.add(m);
  for (const x of b.participants) s.add(x.member);
  return s;
}

async function _writeLines(gid: string, billId: string, b: CleanBill): Promise<void> {
  let pos = 0;
  for (const it of b.items) {
    pos += 1;
    const r = await fetchone(
      "INSERT INTO bill_items (group_id, bill_id, position, name, qty, amount_minor) VALUES ($1, $2, $3, $4, $5, $6) RETURNING item_id::text",
      [gid, billId, pos, it.name, it.qty, it.amount.toString()],
    );
    for (const m of it.members) {
      await execute("INSERT INTO bill_item_members (group_id, item_id, member_id) VALUES ($1, $2, $3)", [gid, r![0], m]);
    }
  }
  pos = 0;
  for (const a of b.adjustments) {
    pos += 1;
    await execute(
      "INSERT INTO bill_adjustments (group_id, bill_id, position, kind, amount_minor) VALUES ($1, $2, $3, $4, $5)",
      [gid, billId, pos, a.kind, a.amount.toString()],
    );
  }
  for (const x of b.participants) {
    await execute("INSERT INTO bill_participants (group_id, bill_id, member_id, bp) VALUES ($1, $2, $3, $4)", [gid, billId, x.member, x.bp]);
  }
}

function _canEditBill(c: Ctx, createdBy: string | null): boolean {
  if (c.isOwner) return true;
  if (c.s.group.kind === "one_off") return false;
  return createdBy === c.userId;
}

/** Create (no bill_id) or replace (bill_id + version) a bill. */
export async function saveBill(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    _requireOpen(c);
    if (!c.me!.active) fail("member_inactive", {}, 403);
    const gid = c.s.group.group_id;
    const existing = p.bill_id ? c.s.bills.find((b) => b.id === String(p.bill_id)) : null;
    if (p.bill_id && !existing) fail("bill_not_found", {}, 404);
    if (existing && !_canEditBill(c, existing.created_by)) fail("bill_edit_forbidden", {}, 403);
    if (existing && Number(p.version) !== existing.version) fail("stale_version", {}, 409);
    if (!existing && c.s.group.kind === "one_off" && !c.isOwner) fail("owner_only", {}, 403);

    // A double tap sends the same client_key twice: the second is a no-op.
    const clientKey = p.client_key ? cleanText(p.client_key, 64) : null;
    if (!existing && clientKey) {
      const dup = await fetchone("SELECT bill_id::text FROM bills WHERE group_id = $1 AND client_key = $2", [gid, clientKey]);
      if (dup) return { bill_id: String(dup[0]), duplicate: true };
    }

    const { bill } = cleanBill(p, { s: c.s, today: _today(c) });

    // New references must be active members; old ones may stay as they were.
    const before = new Set<string>();
    if (existing) {
      before.add(existing.payer);
      for (const i of existing.items) for (const m of i.members) before.add(m);
      for (const x of existing.participants) before.add(x.member);
    }
    for (const id of _billMembers(bill)) {
      const m = c.s.members.find((x) => x.id === id)!;
      if (!m.active && !before.has(id)) fail("member_inactive_pick", { name: m.name });
    }

    if (c.s.group.kind === "one_off" && bill.currency !== c.s.group.currency) {
      if (c.s.payments.length) fail("currency_locked");
      await execute("UPDATE groups SET currency = $1, minor_units = $2 WHERE group_id = $3", [bill.currency, bill.dp, gid]);
    }

    let billId: string;
    if (existing) {
      billId = existing.id;
      await execute(
        `UPDATE bills SET description = $1, bill_date = $2, currency = $3, minor_units = $4, mode = $5, total_minor = $6,
           stated_total = $7, payer_member_id = $8, updated_by = $9, updated_at = NOW(), version = version + 1
         WHERE bill_id = $10`,
        [bill.description, bill.date, bill.currency, bill.dp, bill.mode, bill.total.toString(), bill.stated?.toString() ?? null, bill.payer, c.userId, billId],
      );
      await execute("DELETE FROM bill_items WHERE bill_id = $1", [billId]);
      await execute("DELETE FROM bill_adjustments WHERE bill_id = $1", [billId]);
      await execute("DELETE FROM bill_participants WHERE bill_id = $1", [billId]);
    } else {
      const r = await fetchone(
        `INSERT INTO bills (group_id, description, bill_date, currency, minor_units, mode, total_minor, stated_total,
           payer_member_id, source, created_by, updated_by, client_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12) RETURNING bill_id::text`,
        [gid, bill.description, bill.date, bill.currency, bill.dp, bill.mode, bill.total.toString(), bill.stated?.toString() ?? null,
          bill.payer, bill.source, c.userId, clientKey],
      );
      billId = String(r![0]);
    }
    await _writeLines(gid, billId, bill);
    if (p.draft_id) {
      await execute("UPDATE drafts SET status = 'used' WHERE draft_id = $1 AND group_id = $2 AND status = 'pending'", [String(p.draft_id), gid]);
    }
    await c.log(existing ? "edit" : "create", "bill", billId, { before: existing ?? null, after: bill });
    return { bill_id: billId, duplicate: false };
  });
}

export async function deleteBill(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    _requireOpen(c);
    const b = c.s.bills.find((x) => x.id === String(p.bill_id ?? ""));
    if (!b) fail("bill_not_found", {}, 404);
    if (!_canEditBill(c, b.created_by)) fail("bill_edit_forbidden", {}, 403);
    await execute("UPDATE bills SET deleted_at = NOW(), updated_by = $1, version = version + 1 WHERE bill_id = $2", [c.userId, b.id]);
    await c.log("delete", "bill", b.id, { before: b });
    return { deleted: true };
  });
}

// ── payments ────────────────────────────────────────────────────────────────

/** Receiver or owner; the sender too when the receiver is a dummy. */
function _canRecordPayment(c: Ctx, from: MemberRow, to: MemberRow): boolean {
  if (c.isOwner) return true;
  if (to.user_id === c.userId) return true;
  return to.user_id === null && from.user_id === c.userId;
}

export async function recordPayment(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    _requireOpen(c);
    const from = _member(c, p.from);
    const to = _member(c, p.to);
    if (from.id === to.id) fail("payment_self");
    if (!_canRecordPayment(c, from, to)) fail("payment_forbidden", {}, 403);
    if (!from.active || !to.active) fail("member_inactive_pick", { name: !from.active ? from.name : to.name });
    const currency = normCurrency(p.currency ?? c.s.group.currency);
    if (!isCurrency(currency)) fail("currency_invalid");
    if (c.s.group.kind === "one_off" && currency !== c.s.group.currency) fail("currency_invalid");
    const amount = parseMinor(p.amount);
    const date = String(p.date ?? _today(c));
    if (!isDate(date) || date > addDays(_today(c), 1)) fail("date_invalid");
    const note = p.note ? cleanText(p.note, 120) : null;
    const r = await fetchone(
      `INSERT INTO payments (group_id, from_member, to_member, currency, minor_units, amount_minor, pay_date, note, round, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING payment_id::text`,
      [c.s.group.group_id, from.id, to.id, currency, minorUnits(currency), amount.toString(), date, note, c.s.group.round, c.userId],
    );
    await c.log("create", "payment", String(r![0]), { from: from.id, to: to.id, currency, amount });
    return { payment_id: String(r![0]) };
  });
}

export async function deletePayment(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    const pay = c.s.payments.find((x) => x.id === String(p.payment_id ?? ""));
    if (!pay) fail("payment_not_found", {}, 404);
    if (pay.transfer_id) fail("payment_is_transfer");
    _requireOpen(c);
    const from = _member(c, pay.from);
    const to = _member(c, pay.to);
    if (!_canRecordPayment(c, from, to) && pay.created_by !== c.userId) fail("payment_forbidden", {}, 403);
    await execute("UPDATE payments SET voided_at = NOW(), voided_by = $1 WHERE payment_id = $2", [c.userId, pay.id]);
    await c.log("void", "payment", pay.id, { before: pay });
    return { deleted: true };
  });
}

// ── settle / pay / reopen ───────────────────────────────────────────────────

/** Lock the numbers the owner saw (expected_revision) as this round's plan. */
export async function settleGroup(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    _requireOwner(c);
    _requireOpen(c);
    const out = compute(c.s);
    if (!out.complete) fail("settle_incomplete");
    const gid = c.s.group.group_id;
    const round = c.s.group.round + 1;
    for (const t of out.transfers) {
      await execute(
        "INSERT INTO settlement_transfers (group_id, round, from_member, to_member, amount_minor) VALUES ($1, $2, $3, $4, $5)",
        [gid, round, t.from, t.to, t.amount.toString()],
      );
    }
    const snapshot = {
      bills: out.bills.map((b) => ({ id: b.id, total: b.total, converted: b.converted, rate: b.rate, shares: [...b.shares] })),
      payments: out.payments.map((x) => ({ id: x.id, converted: x.converted, rate: x.rate })),
      balances: out.balances,
      transfers: out.transfers,
    };
    await execute(
      "INSERT INTO settlement_rounds (group_id, round, settled_by, engine_version, snapshot) VALUES ($1, $2, $3, $4, $5)",
      [gid, round, c.userId, ENGINE_VERSION, JSON.stringify(snapshot, (_k, v) => (typeof v === "bigint" ? v.toString() : v))],
    );
    await execute(
      "UPDATE groups SET status = 'settled', round = $1, settled_at = NOW(), settled_by = $2 WHERE group_id = $3",
      [round, c.userId, gid],
    );
    await c.log("settle", "group", gid, { round, transfers: out.transfers.length });
    return { round, transfers: out.transfers.length };
  }, { expectedRevision: p.expected_revision });
}

export async function reopenGroup(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    _requireOwner(c);
    if (c.s.group.status !== "settled") fail("group_open", {}, 409);
    const gid = c.s.group.group_id;
    await execute("UPDATE settlement_transfers SET status = 'superseded' WHERE group_id = $1 AND status = 'pending'", [gid]);
    await execute("UPDATE groups SET status = 'open', settled_at = NULL, settled_by = NULL WHERE group_id = $1", [gid]);
    await c.log("reopen", "group", gid, { round: c.s.group.round });
    return { status: "open" };
  });
}

export async function markTransferPaid(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    if (c.s.group.status !== "settled") fail("group_open", {}, 409);
    const t = c.s.transfers.find((x) => x.id === String(p.transfer_id ?? ""));
    if (!t) fail("transfer_not_found", {}, 404);
    const from = _member(c, t.from);
    const to = _member(c, t.to);
    if (!_canRecordPayment(c, from, to)) fail("payment_forbidden", {}, 403);
    if (t.status === "paid") return { already: true };
    const g = c.s.group;
    await execute(
      `INSERT INTO payments (group_id, from_member, to_member, currency, minor_units, amount_minor, pay_date, transfer_id, round, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [g.group_id, t.from, t.to, g.currency, g.dp, t.amount, _today(c), t.id, g.round, c.userId],
    );
    await execute("UPDATE settlement_transfers SET status = 'paid' WHERE transfer_id = $1", [t.id]);
    await c.log("paid", "transfer", t.id);
    return { already: false };
  });
}

export async function unmarkTransferPaid(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    if (c.s.group.status !== "settled") fail("group_open", {}, 409);
    const t = c.s.transfers.find((x) => x.id === String(p.transfer_id ?? ""));
    if (!t) fail("transfer_not_found", {}, 404);
    const from = _member(c, t.from);
    const to = _member(c, t.to);
    if (!_canRecordPayment(c, from, to)) fail("payment_forbidden", {}, 403);
    if (t.status !== "paid") return { already: true };
    await execute("UPDATE payments SET voided_at = NOW(), voided_by = $1 WHERE transfer_id = $2 AND voided_at IS NULL", [c.userId, t.id]);
    await execute("UPDATE settlement_transfers SET status = 'pending' WHERE transfer_id = $1", [t.id]);
    await c.log("unpaid", "transfer", t.id);
    return { already: false };
  });
}

/** The day a new bill defaults to, in the group's time zone. */
export function groupToday(tz: string): string {
  return localDate(tz);
}

/** Thrown by the web layer when a route needs a signed-in user. */
export class __AuthError extends Error {
  constructor() {
    super("login_required");
  }
}
