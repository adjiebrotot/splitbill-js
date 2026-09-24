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
  ADJ_KINDS, allocate, EngineError, ENGINE_VERSION, isCurrency, minorUnits, normCurrency, parseMinor, parseRate,
  type AdjKind, type BillIn,
} from "../engine";
import { newGroupId, newInviteCode } from "../ids";
import { addDays, cleanText, isDate, localDate, safeTimezone, DEFAULT_TZ } from "../utils";
import { compute, viewOf, type GroupView } from "./ledger";
import { loadGroup, loadGroups, lockGroup, type GroupState, type MemberRow } from "./repo";
import { findUserByUsername, getMe } from "./user_service";
import { AiUnavailable } from "./llm_client";

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
    if (!existing && c.s.group.kind === "one_off" && c.s.bills.length && !p.client_key) fail("one_off_single_bill");

    // A double tap sends the same client_key twice: the second is a no-op.
    const clientKey = p.client_key ? cleanText(p.client_key, 64) : null;
    if (!existing && clientKey) {
      const dup = await fetchone("SELECT bill_id::text FROM bills WHERE group_id = $1 AND client_key = $2", [gid, clientKey]);
      if (dup) return { bill_id: String(dup[0]), duplicate: true };
    }
    if (!existing && c.s.group.kind === "one_off" && c.s.bills.length) fail("one_off_single_bill");

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

// ── admin: ownership handover before an account is deleted ──────────────────

/**
 * The member who takes over each group `userId` owns: the linked, active
 * member with the lowest position other than `userId`. `to` is null when the
 * group has nobody to hand over to (deleting the account is then refused).
 * Soft-deleted groups count too: their owner row still points at the user.
 */
export async function ownershipHandover(userId: string) {
  const rows = await fetchall(
    `SELECT g.group_id, g.name, g.deleted_at IS NOT NULL,
            (SELECT m.member_id::text FROM members m
              WHERE m.group_id = g.group_id AND m.active AND m.user_id IS NOT NULL AND m.user_id <> $1
              ORDER BY m.position LIMIT 1),
            (SELECT m.user_id::text FROM members m
              WHERE m.group_id = g.group_id AND m.active AND m.user_id IS NOT NULL AND m.user_id <> $1
              ORDER BY m.position LIMIT 1),
            (SELECT m.display_name FROM members m
              WHERE m.group_id = g.group_id AND m.active AND m.user_id IS NOT NULL AND m.user_id <> $1
              ORDER BY m.position LIMIT 1)
       FROM groups g WHERE g.owner_user_id = $1 ORDER BY g.created_at`,
    [userId],
  );
  return rows.map((r) => ({
    group_id: String(r[0]),
    name: String(r[1]),
    deleted: r[2] === true || r[2] === "t",
    to: r[4] === null ? null : { member_id: String(r[3]), user_id: String(r[4]), name: String(r[5]) },
  }));
}

/**
 * Admin only (no member acts): move ownership of every group `userId` owns to
 * its handover member. Same gate as write(): lock, log, bump revision,
 * re-verify the books. Runs inside the caller's atomic() so the account
 * delete and the handovers commit together.
 */
export async function adminHandOverGroups(userId: string) {
  const plan = await ownershipHandover(userId);
  const blocked = plan.filter((g) => !g.to);
  if (blocked.length) fail("admin_delete_blocked", { groups: blocked.map((g) => g.name).join(", ") }, 409);
  for (const g of plan) {
    const r = await fetchone("SELECT owner_user_id::text FROM groups WHERE group_id = $1 FOR UPDATE", [g.group_id]);
    if (!r || String(r[0]) !== userId) continue;
    await execute("UPDATE groups SET owner_user_id = $1 WHERE group_id = $2", [g.to!.user_id, g.group_id]);
    await _event(g.group_id, null, "admin_transfer_owner", "group", g.group_id, { from_user: userId, to_user: g.to!.user_id, to_member: g.to!.member_id });
    await execute("UPDATE groups SET revision = revision + 1 WHERE group_id = $1", [g.group_id]);
    if (!g.deleted) await _verify(g.group_id);
  }
  return plan;
}

/** Thrown by the web layer when a route needs a signed-in user. */
export class __AuthError extends Error {
  constructor() {
    super("login_required");
  }
}

// ── rates (trip groups) ─────────────────────────────────────────────────────

function _effective(v: unknown): string {
  const s = String(v ?? "");
  if (s === "-infinity" || s === "") return "-infinity";
  if (!isDate(s)) fail("date_invalid");
  return s;
}

function _requireTravel(c: Ctx): void {
  if (c.s.group.kind !== "travel") fail("kind_invalid");
}

/**
 * Add or replace one rate row. `replace` names the row being edited (its
 * currency and date may change). The post-write gate refuses the change when
 * any bill or payment would lose its rate.
 */
export async function setRate(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    _requireOwner(c);
    _requireOpen(c);
    _requireTravel(c);
    const currency = normCurrency(p.currency);
    if (!isCurrency(currency)) fail("currency_invalid");
    if (currency === c.s.group.currency) fail("rate_not_allowed");
    const effective = _effective(p.effective);
    const rate = parseRate(p.rate);
    const inverted = p.inverted === true;
    const source = p.source === "auto" ? "auto" : "manual";
    const gid = c.s.group.group_id;
    const rep = p.replace as Params | undefined;
    if (rep && rep.currency) {
      await execute("DELETE FROM fx_rates WHERE group_id = $1 AND currency = $2 AND effective_date = $3::date",
        [gid, normCurrency(rep.currency), _effective(rep.effective)]);
    }
    await execute(
      `INSERT INTO fx_rates (group_id, currency, effective_date, rate, inverted, source, set_by)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7)
       ON CONFLICT (group_id, currency, effective_date)
       DO UPDATE SET rate = EXCLUDED.rate, inverted = EXCLUDED.inverted, source = EXCLUDED.source, set_by = EXCLUDED.set_by, set_at = NOW()`,
      [gid, currency, effective, rate.text, inverted, source, c.userId],
    );
    await c.log("set", "rate", `${currency}|${effective}`, { rate: rate.text, inverted, source, replaced: rep ?? null });
    await _coverageOr("rate_needed", gid);
    return { currency, effective, rate: rate.text, inverted };
  });
}

export async function deleteRate(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    _requireOwner(c);
    _requireOpen(c);
    const currency = normCurrency(p.currency);
    const effective = _effective(p.effective);
    const n = await execute("DELETE FROM fx_rates WHERE group_id = $1 AND currency = $2 AND effective_date = $3::date",
      [c.s.group.group_id, currency, effective]);
    if (n < 1) fail("rate_not_found", {}, 404);
    await c.log("delete", "rate", `${currency}|${effective}`);
    await _coverageOr("rate_needed", c.s.group.group_id);
    return { deleted: true };
  });
}

/** Refuse (roll back) with `code` when any bill or payment lost its rate. */
async function _coverageOr(code: string, gid: string): Promise<void> {
  const s = await loadGroup(gid);
  if (!s) return;
  const out = compute(s);
  if (!out.complete) {
    const m = out.missing[0];
    fail(code, m ? { currency: m.currency, date: m.date } : {});
  }
}

/** A market rate to prefill the form. Saves nothing. */
export async function suggestRate(p: { user_id: string } & Params) {
  const s = await loadGroup(String(p.group_id ?? ""));
  if (!s || !_meOf(s, p.user_id)) fail("group_not_found", {}, 404);
  const currency = normCurrency(p.currency);
  if (!isCurrency(currency) || currency === s.group.currency) fail("currency_invalid");
  const date = p.effective && p.effective !== "-infinity" && isDate(String(p.effective)) ? String(p.effective) : null;
  const today = localDate(s.group.timezone);
  const { fetchFxratesBest, bigSideFirst } = await import("../fx_providers");
  const r = await fetchFxratesBest(currency, s.group.currency, date && date < today ? date : null);
  if (!r) fail("rate_unavailable", {}, 502);
  return bigSideFirst(r);
}

/**
 * Change a trip's settlement currency. One request carries the complete new
 * rate table (one row per currency in use); the gate refuses it unless every
 * bill and payment converts afterwards.
 */
export async function changeCurrency(p: { user_id: string } & Params) {
  return write(p.user_id, p.group_id, async (c) => {
    _requireOwner(c);
    _requireOpen(c);
    _requireTravel(c);
    const currency = normCurrency(p.currency);
    if (!isCurrency(currency)) fail("currency_invalid");
    const gid = c.s.group.group_id;
    const rows = Array.isArray(p.rates) ? (p.rates as Params[]) : [];
    await execute("DELETE FROM fx_rates WHERE group_id = $1", [gid]);
    await execute("UPDATE groups SET currency = $1, minor_units = $2 WHERE group_id = $3", [currency, minorUnits(currency), gid]);
    for (const r of rows) {
      const rc = normCurrency(r.currency);
      if (!isCurrency(rc)) fail("currency_invalid");
      if (rc === currency) continue;
      const rate = parseRate(r.rate);
      await execute(
        `INSERT INTO fx_rates (group_id, currency, effective_date, rate, inverted, source, set_by)
         VALUES ($1, $2, $3::date, $4, $5, 'manual', $6)`,
        [gid, rc, _effective(r.effective), rate.text, r.inverted === true, c.userId],
      );
    }
    await c.log("currency", "group", gid, { from: c.s.group.currency, to: currency, rates: rows });
    await _coverageOr("rate_missing", gid);
    return { currency };
  });
}

// ── reports ─────────────────────────────────────────────────────────────────

/**
 * Group or individual report, as text, PNG or PDF. `member` defaults to the
 * caller's own member row. Every figure comes from the group view (engine).
 */
export async function getReport(p: { user_id: string; group_id: unknown; type?: unknown; member?: unknown; format?: unknown; lang?: unknown }) {
  const v = await getGroupView({ user_id: p.user_id, group_id: p.group_id });
  const { groupReport, memberReport, renderText } = await import("./report");
  const { normalizeLang } = await import("../i18n");
  const lang = normalizeLang(String(p.lang ?? ""));
  let doc;
  if (p.type === "member") {
    const mid = String(p.member ?? v.me ?? "");
    if (!v.members.some((m) => m.id === mid)) fail("member_unknown");
    doc = memberReport(v, mid, lang);
  } else if (p.type === "group" || p.type === undefined) {
    doc = groupReport(v, lang);
  } else fail("report_invalid");
  const slug = (v.group.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "split").slice(0, 40);
  const base = `${slug}-${p.type === "member" ? "individual" : "group"}${v.group.status === "settled" ? "" : "-not-settled"}`;
  if (p.format === "png" || p.format === "pdf") {
    const bin = await import("./report_binary");
    const bytes = p.format === "png" ? await bin.renderPng(doc) : await bin.renderPdf(doc);
    return { kind: "file" as const, bytes, filename: `${base}.${p.format}`, type: p.format === "png" ? "image/png" : "application/pdf" };
  }
  return { kind: "text" as const, text: renderText(doc), filename: `${base}.txt` };
}

// ── AI drafts (chat text, receipt photo) ────────────────────────────────────

const AI_LIMIT = Number(process.env.AI_DAILY_LIMIT || 50);

/** Count one AI read BEFORE calling the model; refuse past the daily cap. */
async function _spendAi(userId: string, today: string): Promise<void> {
  const r = await fetchone(
    `INSERT INTO ai_usage (user_id, day, count) VALUES ($1, $2, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET count = ai_usage.count + 1 RETURNING count`,
    [userId, today],
  );
  if (Number(r?.[0] ?? 0) > AI_LIMIT) fail("ai_limit", {}, 429);
}

async function _draftCtx(userId: string, groupId: unknown) {
  const s = await loadGroup(String(groupId ?? ""));
  if (!s) fail("group_not_found", {}, 404);
  const me = _meOf(s, userId);
  if (!me) fail("group_not_found", {}, 404);
  if (s.group.status !== "open") fail("group_settled", {}, 409);
  if (!me.active) fail("member_inactive", {}, 403);
  const today = localDate(s.group.timezone);
  return { s, me, today, ctx: { members: s.members, sender: me.id, currency: s.group.currency, today } };
}

async function _saveDraft(groupId: string, userId: string, source: string, draft: unknown): Promise<string> {
  const { newToken } = await import("../ids");
  const id = newToken(12);
  await execute(
    `INSERT INTO drafts (draft_id, group_id, user_id, source, payload, expires_at) VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '1 day')`,
    [id, groupId, userId, source === "photo" ? "photo" : source === "telegram" ? "telegram" : "chat", JSON.stringify(draft)],
  );
  return id;
}

function _aiError(e: unknown): never {
  if (e instanceof ActionError) throw e;
  if (e instanceof AiUnavailable) fail("ai_unavailable", {}, 503);
  console.error("[ai]", e);
  fail("ai_failed", {}, 502);
}

export async function aiDraftFromText(p: { user_id: string; group_id: unknown; text: unknown; source?: "chat" | "telegram" }) {
  const text = String(p.text ?? "").trim();
  if (!text) fail("description_required");
  const { s, today, ctx } = await _draftCtx(p.user_id, p.group_id);
  await _spendAi(p.user_id, today);
  const { parseChat } = await import("./ai_parse");
  try {
    const { draft } = await parseChat(text, ctx, p.source ?? "chat");
    const draft_id = await _saveDraft(s.group.group_id, p.user_id, draft.source, draft);
    return { draft_id, ...draft };
  } catch (e) {
    _aiError(e);
  }
}

export async function aiDraftFromImage(p: { user_id: string; group_id: unknown; bytes: Uint8Array; mime: string; caption?: unknown; source?: "photo" | "telegram" }) {
  if (!p.bytes?.length || p.bytes.length > 10 * 1024 * 1024 || !/^image\/(jpeg|png|webp|heic|heif)$/.test(p.mime)) fail("image_invalid");
  const { s, today, ctx } = await _draftCtx(p.user_id, p.group_id);
  await _spendAi(p.user_id, today);
  const { normalizeImage } = await import("./llm_client");
  const { parseReceipt } = await import("./ai_parse");
  try {
    const img = await normalizeImage(p.bytes, p.mime);
    const { draft } = await parseReceipt({ b64: Buffer.from(img.bytes).toString("base64"), mime: img.mime }, String(p.caption ?? ""), ctx, p.source ?? "photo");
    const draft_id = await _saveDraft(s.group.group_id, p.user_id, draft.source, draft);
    return { draft_id, ...draft };
  } catch (e) {
    _aiError(e);
  }
}

/** A saved draft (Telegram confirm, "Edit in app" link). */
export async function getDraft(p: { user_id: string; draft_id: unknown }) {
  const r = await fetchone(
    "SELECT group_id, payload, status FROM drafts WHERE draft_id = $1 AND user_id = $2 AND expires_at > NOW()",
    [String(p.draft_id ?? ""), p.user_id],
  );
  if (!r) fail("draft_not_found", {}, 404);
  const payload = typeof r[1] === "string" ? JSON.parse(r[1] as string) : r[1];
  return { draft_id: String(p.draft_id), group_id: String(r[0]), status: String(r[2]), ...(payload as object) };
}

// ── Telegram ────────────────────────────────────────────────────────────────

const TG_CODE_MINUTES = 15;

async function _tgCode(userId: string, purpose: "link" | "bind", groupId: string | null): Promise<string> {
  const { randomCode } = await import("../ids");
  const code = (purpose === "link" ? "L" : "B") + randomCode(15);
  await execute(
    `INSERT INTO telegram_link_codes (code, user_id, purpose, group_id, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::interval)`,
    [code, userId, purpose, groupId, String(TG_CODE_MINUTES)],
  );
  return code;
}

function _botName(): string {
  const b = (process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "");
  if (!b || !process.env.TELEGRAM_BOT_TOKEN) fail("telegram_unavailable", {}, 503);
  return b;
}

/** Deep link that proves the Telegram account belongs to this user. */
export async function telegramLinkCode(p: { user_id: string }) {
  const bot = _botName();
  const code = await _tgCode(p.user_id, "link", null);
  return { url: `https://t.me/${bot}?start=${code}` };
}

/** Deep link that adds the bot to a Telegram group bound to this trip (owner). */
export async function telegramBindCode(p: { user_id: string; group_id: unknown }) {
  const bot = _botName();
  const s = await loadGroup(String(p.group_id ?? ""));
  if (!s || !_meOf(s, p.user_id)) fail("group_not_found", {}, 404);
  if (s.group.owner !== p.user_id) fail("owner_only", {}, 403);
  if (s.group.kind !== "travel") fail("kind_invalid");
  const code = await _tgCode(p.user_id, "bind", s.group.group_id);
  return { url: `https://t.me/${bot}?startgroup=${code}` };
}

async function _useCode(code: string, purpose: "link" | "bind") {
  return fetchone(
    `UPDATE telegram_link_codes SET used_at = NOW()
      WHERE code = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > NOW()
      RETURNING user_id::text, group_id`,
    [code, purpose],
  );
}

export interface TgUser {
  user_id: string;
  username: string;
  display_name: string;
  language: string;
  telegram_group: string | null;
}

export async function telegramUser(telegramId: number): Promise<TgUser | null> {
  const r = await fetchone(
    "SELECT user_id::text, username, display_name, language, telegram_group FROM users WHERE telegram_id = $1",
    [telegramId],
  );
  return r ? { user_id: String(r[0]), username: String(r[1]), display_name: String(r[2]), language: String(r[3]), telegram_group: r[4] ? String(r[4]) : null } : null;
}

/** Consume a link code: this Telegram account now belongs to the code's user. */
export async function telegramLink(p: { code: string; telegram_id: number }) {
  return atomic(async () => {
    const r = await _useCode(p.code, "link");
    if (!r) fail("code_invalid");
    await execute("UPDATE users SET telegram_id = NULL WHERE telegram_id = $1", [p.telegram_id]);
    await execute("UPDATE users SET telegram_id = $1 WHERE user_id = $2", [p.telegram_id, r[0]]);
    return (await telegramUser(p.telegram_id))!;
  });
}

export async function telegramUnlink(p: { user_id: string }) {
  await execute("UPDATE users SET telegram_id = NULL, telegram_group = NULL WHERE user_id = $1", [p.user_id]);
  return { unlinked: true };
}

/** Bind a Telegram group chat to the trip named by a bind code. Owner only. */
export async function telegramBind(p: { code: string; chat_id: number; telegram_id: number }) {
  return atomic(async () => {
    const me = await telegramUser(p.telegram_id);
    if (!me) fail("login_required", {}, 401);
    const r = await _useCode(p.code, "bind");
    if (!r || String(r[0]) !== me.user_id) fail("code_invalid");
    const gid = String(r[1]);
    const lock = await lockGroup(gid);
    if (!lock) fail("group_not_found", {}, 404);
    if (lock.owner !== me.user_id) fail("owner_only", {}, 403);
    await execute(
      `INSERT INTO telegram_chats (chat_id, group_id, bound_by) VALUES ($1, $2, $3)
       ON CONFLICT (chat_id) DO UPDATE SET group_id = EXCLUDED.group_id, bound_by = EXCLUDED.bound_by, bound_at = NOW()`,
      [p.chat_id, gid, me.user_id],
    );
    await _event(gid, me.user_id, "bind", "telegram", String(p.chat_id));
    return { group_id: gid };
  });
}

export async function telegramUnbind(p: { chat_id: number; user_id: string }) {
  const gid = await telegramChatGroup(p.chat_id);
  if (!gid) return { unbound: false };
  const r = await fetchone("SELECT owner_user_id::text FROM groups WHERE group_id = $1", [gid]);
  if (!r || String(r[0]) !== p.user_id) fail("owner_only", {}, 403);
  await execute("DELETE FROM telegram_chats WHERE chat_id = $1", [p.chat_id]);
  return { unbound: true };
}

export async function telegramChatGroup(chatId: number): Promise<string | null> {
  const r = await fetchone(
    "SELECT c.group_id FROM telegram_chats c JOIN groups g USING (group_id) WHERE c.chat_id = $1 AND g.deleted_at IS NULL",
    [chatId],
  );
  return r ? String(r[0]) : null;
}

/** A group the bot was removed from, or a group that became a supergroup. */
export async function telegramChatGone(chatId: number): Promise<void> {
  await execute("DELETE FROM telegram_chats WHERE chat_id = $1", [chatId]);
}

export async function telegramChatMigrated(from: number, to: number): Promise<void> {
  await execute("UPDATE telegram_chats SET chat_id = $2 WHERE chat_id = $1", [from, to]);
}

/** First sight of an update id: true. A retry: false (insert-first dedup). */
export async function telegramFirstSeen(updateId: number): Promise<boolean> {
  const n = await execute("INSERT INTO telegram_updates (update_id) VALUES ($1) ON CONFLICT DO NOTHING", [updateId]);
  return n > 0;
}

export async function telegramGroups(p: { user_id: string }) {
  const rows = await fetchall(
    `SELECT g.group_id, g.name, g.kind FROM groups g JOIN members m ON m.group_id = g.group_id
      WHERE m.user_id = $1 AND m.active AND g.deleted_at IS NULL AND g.status = 'open'
      ORDER BY g.created_at DESC LIMIT 20`,
    [p.user_id],
  );
  return rows.map((r) => ({ group_id: String(r[0]), name: String(r[1]), kind: String(r[2]) }));
}

export async function telegramSetGroup(p: { user_id: string; group_id: string }) {
  const s = await loadGroup(p.group_id);
  if (!s || !_meOf(s, p.user_id)) fail("group_not_found", {}, 404);
  await execute("UPDATE users SET telegram_group = $1 WHERE user_id = $2", [p.group_id, p.user_id]);
  return { group_id: p.group_id, name: s.group.name };
}

export async function telegramSetPending(chatId: number, tgUserId: number, kind: string, data: unknown): Promise<void> {
  await execute(
    `INSERT INTO telegram_pending (chat_id, tg_user_id, kind, data, expires_at) VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 minutes')
     ON CONFLICT (chat_id, tg_user_id) DO UPDATE SET kind = EXCLUDED.kind, data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
    [chatId, tgUserId, kind, JSON.stringify(data)],
  );
}

export async function telegramTakePending(chatId: number, tgUserId: number): Promise<{ kind: string; data: any } | null> {
  const r = await fetchone(
    "DELETE FROM telegram_pending WHERE chat_id = $1 AND tg_user_id = $2 AND expires_at > NOW() RETURNING kind, data",
    [chatId, tgUserId],
  );
  return r ? { kind: String(r[0]), data: typeof r[1] === "string" ? JSON.parse(r[1] as string) : r[1] } : null;
}

/** Save a draft as a bill (the draft's owner only). A second tap is a no-op. */
export async function saveDraftAsBill(p: { user_id: string; draft_id: string }) {
  const d = await getDraft({ user_id: p.user_id, draft_id: p.draft_id }) as Record<string, any>;
  if (d.status === "cancelled") fail("draft_not_found", {}, 404);
  return saveBill({
    user_id: p.user_id,
    group_id: d.group_id,
    description: d.description,
    date: d.date,
    currency: d.currency,
    mode: d.mode,
    payer: d.payer,
    total: d.total ?? undefined,
    stated_total: d.stated_total ?? null,
    items: (d.items ?? []).map((i: any) => ({ ...i, amount: i.amount ?? "" })),
    adjustments: d.adjustments ?? [],
    participants: d.participants ?? [],
    source: "telegram",
    client_key: "draft:" + p.draft_id,
    draft_id: p.draft_id,
  });
}

export async function cancelDraft(p: { user_id: string; draft_id: string }) {
  await execute("UPDATE drafts SET status = 'cancelled' WHERE draft_id = $1 AND user_id = $2 AND status = 'pending'", [p.draft_id, p.user_id]);
  return { cancelled: true };
}

// ── housekeeping (daily cron) ───────────────────────────────────────────────

/** Prune short-lived rows. Never touches bills, payments or the audit log. */
export async function cleanup() {
  const n = async (sql: string) => execute(sql);
  return {
    drafts: await n("DELETE FROM drafts WHERE expires_at < NOW() - INTERVAL '7 days'"),
    link_codes: await n("DELETE FROM telegram_link_codes WHERE expires_at < NOW() - INTERVAL '1 day'"),
    updates: await n("DELETE FROM telegram_updates WHERE received_at < NOW() - INTERVAL '7 days'"),
    pending: await n("DELETE FROM telegram_pending WHERE expires_at < NOW()"),
    ai_usage: await n("DELETE FROM ai_usage WHERE day < CURRENT_DATE - 60"),
  };
}
